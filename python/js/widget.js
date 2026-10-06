import debounce from "just-debounce-it";
import * as vizarr from "../../src/index";

/**
 * @typedef StoreOperation
 * @property {"has" | "get"} method
 * @property {[number, string]} target
 */

/**
 * @typedef StoreResult
 * @property {boolean} success
 */

/**
 * @template T
 * @typedef Message
 * @property {string} uuid
 * @property {T} payload
 */

/**
 * @template T
 * @param {import("npm:@anywidget/types").AnyModel} model
 * @param {StoreOperation} payload
 * @param {{ timeout?: number }} [options]
 * @returns {Promise<{ data: T, buffers: DataView[] }>}
 */
function send(model, payload, { timeout = 3000 } = {}) {
	let uuid = globalThis.crypto.randomUUID();
	return new Promise((resolve, reject) => {
		let timer = setTimeout(() => {
			reject(new Error(`Promise timed out after ${timeout} ms`));
			model.off("msg:custom", handler);
		}, timeout);
		/**
		 * @param {Message<T>} msg
		 * @param {DataView[]} buffers
		 */
		function handler(msg, buffers) {
			if (!(msg.uuid === uuid)) return;
			clearTimeout(timer);
			resolve({ data: msg.payload, buffers });
			model.off("msg:custom", handler);
		}
		model.on("msg:custom", handler);
		model.send({ payload, uuid });
	});
}

/**
 * @param {import("npm:@anywidget/types").AnyModel} model
 * @param {string | { id: number }} source
 */
function get_source(model, source) {
	if (typeof source === "string") {
		return source;
	}
	return {
		/**
		 * @param {string} key
		 * @return {Promise<boolean>}
		 */
		async has(key) {
			const { data } = await send(model, {
				method: "has",
				target: [source.id, key],
			});
			return data.success;
		},
		/**
		 * @param {string} key
		 * @return {Promise<Uint8Array | undefined>}
		 */
		async get(key) {
			const { data, buffers } = await send(model, {
				method: "get",
				target: [source.id, key],
			});
			if (!data.success) {
				return undefined;
			}
			return new Uint8Array(buffers[0].buffer);
		},
	};
}

/**
 * @typedef Model
 * @property {string} height
 * @property {ViewState=} view_state
 * @property {vizarr.ViewportInfo=} viewport
 * @property {{ source: string | { id: number }}[]} _configs
 */

/**
 * Image config keys read from a static model, e.g. the JSON body of a MyST
 * `{anywidget}` directive (whose model can't enumerate its keys).
 */
const IMAGE_CONFIG_KEYS = [
	"source",
	"name",
	"axis_labels",
	"colormap",
	"opacity",
	"acquisition",
	"model_matrix",
	"disable_well_links",
	"scalebar",
	"overlay",
	"description",
	"color",
	"contrast_limits",
	"visibility",
	"colors",
	"channel_axis",
	"names",
	"visibilities",
];

/**
 * Image configs for a model without `_configs` (i.e. not the Python widget):
 * either an `images` array of configs, or a single config at the top level.
 *
 * @param {import("npm:@anywidget/types").AnyModel} model
 * @returns {Record<string, unknown>[]}
 */
function get_static_configs(model) {
	/** @type {Record<string, unknown>[]} */
	const images = [...(model.get("images") ?? [])];
	if (images.length === 0 && model.get("source") !== undefined) {
		/** @type {Record<string, unknown>} */
		const config = {};
		for (const key of IMAGE_CONFIG_KEYS) {
			const value = model.get(key);
			if (value !== undefined) config[key] = value;
		}
		images.push(config);
	}
	// Default to no click-to-open-well links, which would point at the host page.
	return images.map((config) => ({ disable_well_links: true, ...config }));
}

/**
 * @typedef ViewState
 * @property {number} zoom
 * @property {[x: number, y: number]} target
 */

/**
 * Commands sent from Python (`Viewer.go_to`, `Viewer.select`).
 *
 * @typedef {{ type: "navigate", options: vizarr.NavigateOptions } | { type: "select", selection: Record<string, number> }} Command
 */

/**
 * Routes commands from Python to a model's viewers. Commands are buffered until a
 * viewer exists: e.g. with "Run All", `go_to` arrives while the widget is rendering.
 *
 * @typedef {{ viewers: Set<vizarr.VizarrViewer>, pending: Command[] }} Commands
 */

/**
 * @param {vizarr.VizarrViewer} viewer
 * @param {Command} msg
 */
function runCommand(viewer, msg) {
	const done =
		msg.type === "navigate" ? viewer.navigate(msg.options) : viewer.setSelection(msg.selection);
	done.catch((err) => console.error(`vizarr: ${msg.type} failed:`, err));
}

/**
 * @param {Parameters<import("npm:@anywidget/types").Render<Model>>[0]} context
 * @param {Commands=} commands - Absent on static hosts, which have no Python.
 */
async function render({ model, el }, commands) {
	let div = document.createElement("div");
	{
		div.style.height = model.get("height") ?? "500px";
		div.style.position = "relative";
		div.style.backgroundColor = "black";
		model.on("change:height", () => {
			div.style.height = model.get("height");
		});
	}
	// Attach before creating the viewer so it can detect a Shadow DOM host.
	el.appendChild(div);
	let viewer = await vizarr.createViewer(div, { menuOpen: model.get("menuOpen") ?? true });
	{
		const view_state = model.get("view_state");
		if (view_state?.target) viewer.setViewState(view_state);
		model.on("change:view_state", () => {
			viewer.setViewState(model.get("view_state"));
		});
		viewer.on(
			"viewStateChange",
			debounce((/** @type {ViewState} */ update) => {
				model.set("view_state", update);
				model.save_changes?.();
			}, 200),
		);
	}
	{
		let last = "";
		viewer.on(
			"viewportChange",
			debounce((/** @type {vizarr.ViewportInfo} */ info) => {
				// Layer changes (e.g. contrast) also trigger updates; only sync real changes.
				const json = JSON.stringify(info);
				if (json === last) return;
				last = json;
				model.set("viewport", info);
				model.save_changes?.();
			}, 200),
		);
	}
	if (commands) {
		commands.viewers.add(viewer);
		for (const msg of commands.pending.splice(0)) runCommand(viewer, msg);
	}
	const cleanup = () => {
		commands?.viewers.delete(viewer);
	};
	if (model.get("_configs") === undefined) {
		// Static host (e.g. MyST): configs come from the model's initial JSON.
		for (const config of get_static_configs(model)) {
			viewer.addImage(/** @type {any} */ (config));
		}
		return cleanup;
	}
	{
		// sources are append-only now
		for (const config of model.get("_configs")) {
			const source = get_source(model, config.source);
			viewer.addImage({ ...config, source });
		}
		model.on("change:_configs", () => {
			const last = model.get("_configs").at(-1);
			if (!last) return;
			const source = get_source(model, last.source);
			viewer.addImage({ ...last, source });
		});
	}
	return cleanup;
}

/**
 * A factory, so that each model gets its own command routing (anywidget calls it
 * once per model; `initialize` and `render` receive different model proxies).
 */
function widget() {
	/** @type {Commands} */
	const commands = { viewers: new Set(), pending: [] };
	return {
		/** @type {import("npm:@anywidget/types").Initialize<Model>} */
		initialize({ model }) {
			// anywidget holds back comm messages until this has run, so none are missed.
			model.on("msg:custom", (/** @type {Command} */ msg) => {
				if (msg?.type !== "navigate" && msg?.type !== "select") return;
				if (commands.viewers.size === 0) commands.pending.push(msg);
				for (const viewer of commands.viewers) runCommand(viewer, msg);
			});
		},
		/** @type {import("npm:@anywidget/types").Render<Model>} */
		render: (context) => render(context, commands),
	};
}
// For hosts that use the default export as the widget object itself.
widget.render = /** @type {import("npm:@anywidget/types").Render<Model>} */ (context) => render(context);

export default widget;
