import { Matrix4 } from "math.gl";

import { DEFAULT_GRID_SPACER, type GridLoader } from "./layers/grid-layer";
import type { LayerState, SourceData, ViewState } from "./state";
import { assert, fitImageToViewport, isGridLayerProps, isInterleaved } from "./utils";

type Size = { width: number; height: number };
type Point = [x: number, y: number];
type Box = [minX: number, minY: number, maxX: number, maxY: number];

/**
 * A description of what is in view, relative to the image (or plate/well grid cell)
 * under the center of the view. Field names are snake_case, matching the Python widget.
 */
export interface ViewportInfo {
  /** Same as the view state: deck.gl zoom (log2 screen pixels per world unit) and center in world coordinates. */
  zoom: number;
  target: Point;
  /** Size of the canvas, in screen pixels. */
  size: [width: number, height: number];
  /** Visible area in world coordinates. */
  bounds: Box;
  /** "plate" and "well" sources draw a grid of cells (wells or fields, respectively). */
  kind: "plate" | "well" | "image";
  name: string | null;
  /** Well under the center of the view (plates), or the well being viewed (well sources). */
  well: string | null;
  /** Field under the center of the view (well sources only). */
  field: string | null;
  /** Grid cell under the center of the view; null for images or when the center isn't over a cell. */
  cell: { name: string; row: number; column: number } | null;
  /** Index of each non-channel, non-spatial axis (e.g. t, z) of the first channel. */
  selection: Record<string, number>;
  /** Base-resolution size of every axis of the image (or of one grid cell). */
  sizes: Record<string, number>;
  /** Physical size of one base-resolution pixel along x and y, if the metadata has units. */
  pixel_size: Point | null;
  unit: string | null;
  /** Center of the view within the image or cell, in base-resolution pixels (and physical units). */
  position: { pixel: Point; physical: Point | null } | null;
  /** Visible area within the image or cell (unclipped, so it may extend beyond the image). */
  region: { pixel: Box; physical: Box | null } | null;
  /** Names of the grid cells that are (at least partly) in view. */
  visible_cells: string[];
}

/** Where to move the view. Coordinates are within the image, or within the given well/field. */
export interface NavigateOptions {
  /** Well to center on (plates). For a single well source, must match that well if given. */
  well?: string;
  /** Field to center on (well sources). */
  field?: string | number;
  x?: number;
  y?: number;
  /** Units of `x` and `y`: base-resolution pixels (default) or physical units from the OME-NGFF metadata. */
  units?: "pixel" | "physical";
  /** deck.gl zoom level. Defaults to fitting the well/field if one is given without coordinates, else the current zoom. */
  zoom?: number;
}

/** Padding (in screen pixels) when fitting an image into the viewport. */
export function defaultFitPadding(viewport: Size): number {
  return viewport.width < 400 ? 10 : viewport.width < 600 ? 30 : 50;
}

/** Geometry of what a source draws: one image, or a grid of equally sized cells. */
interface Layout {
  matrix: Matrix4;
  inverse: Matrix4;
  /** Base-resolution size of the image, or of each grid cell. */
  cell: Size;
  spacer: number;
  loaders?: GridLoader[];
}

function getLayout(source: SourceData, layer: LayerState): Layout {
  const { shape } = source.loader[0];
  const [height, width] = shape.slice(isInterleaved(shape) ? -3 : -2);
  const matrix = layer.layerProps.modelMatrix ?? new Matrix4();
  const grid = isGridLayerProps(layer.layerProps) ? layer.layerProps : undefined;
  return {
    matrix,
    inverse: matrix.clone().invert(),
    cell: { width, height },
    spacer: grid ? (grid.spacer ?? DEFAULT_GRID_SPACER) : 0,
    loaders: grid?.loaders,
  };
}

function toModelPoint(layout: Layout, [x, y]: Point): Point {
  const [mx, my] = layout.inverse.transformAsPoint([x, y, 0]);
  return [mx, my];
}

function getKind(source: SourceData): ViewportInfo["kind"] {
  if (!source.loaders) return "image";
  return source.well === undefined ? "plate" : "well";
}

/** Top-left corner of a grid cell, in model coordinates. */
function cellOrigin(layout: Layout, d: { row: number; col: number }): Point {
  return [d.col * (layout.cell.width + layout.spacer), d.row * (layout.cell.height + layout.spacer)];
}

/** The grid cell containing a point in model coordinates, if any. */
function cellAt(layout: Layout, [x, y]: Point): GridLoader | undefined {
  const { width, height } = layout.cell;
  return layout.loaders?.find((d) => {
    const [x0, y0] = cellOrigin(layout, d);
    return x >= x0 && x < x0 + width && y >= y0 && y < y0 + height;
  });
}

function toPhysical(source: SourceData, [x, y]: Point): Point | null {
  if (!source.pixel_size) return null;
  const { size, sizeY = size } = source.pixel_size;
  return [x * size, y * sizeY];
}

export function getViewportInfo(options: {
  source: SourceData;
  layer: LayerState;
  viewState: ViewState;
  viewport: Size;
}): ViewportInfo {
  const { source, layer, viewState, viewport } = options;
  const layout = getLayout(source, layer);
  const kind = getKind(source);

  const worldPerScreenPixel = 2 ** -viewState.zoom;
  const [cx, cy] = viewState.target;
  const halfWidth = (viewport.width / 2) * worldPerScreenPixel;
  const halfHeight = (viewport.height / 2) * worldPerScreenPixel;
  const bounds: Box = [cx - halfWidth, cy - halfHeight, cx + halfWidth, cy + halfHeight];

  const toModel = (point: Point) => toModelPoint(layout, point);
  const center = toModel(viewState.target);
  const [a, b] = [toModel([bounds[0], bounds[1]]), toModel([bounds[2], bounds[3]])];
  const modelBounds: Box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];

  let cell: ViewportInfo["cell"] = null;
  let origin: Point | null = [0, 0];
  let visibleCells: string[] = [];
  if (layout.loaders) {
    const { width, height } = layout.cell;
    const match = cellAt(layout, center);
    origin = match ? cellOrigin(layout, match) : null;
    cell = match ? { name: match.name, row: match.row, column: match.col } : null;
    visibleCells = layout.loaders
      .filter((d) => {
        const [x0, y0] = cellOrigin(layout, d);
        return (
          x0 < modelBounds[2] && x0 + width > modelBounds[0] && y0 < modelBounds[3] && y0 + height > modelBounds[1]
        );
      })
      .map((d) => d.name);
  }

  let position: ViewportInfo["position"] = null;
  let region: ViewportInfo["region"] = null;
  if (origin) {
    const [ox, oy] = origin;
    const pixel: Point = [center[0] - ox, center[1] - oy];
    position = { pixel, physical: toPhysical(source, pixel) };
    const regionPixel: Box = [modelBounds[0] - ox, modelBounds[1] - oy, modelBounds[2] - ox, modelBounds[3] - oy];
    const min = toPhysical(source, [regionPixel[0], regionPixel[1]]);
    const max = toPhysical(source, [regionPixel[2], regionPixel[3]]);
    region = { pixel: regionPixel, physical: min && max ? [...min, ...max] : null };
  }

  const { shape } = source.loader[0];
  const current = layer.layerProps.selections[0] ?? source.defaults.selection;
  const selection: Record<string, number> = {};
  const sizes: Record<string, number> = {};
  for (const [i, name] of source.axis_labels.entries()) {
    sizes[name] = shape[i];
    if (i !== source.channel_axis && name !== "x" && name !== "y") {
      selection[name] = current[i];
    }
  }

  const pixelSize = source.pixel_size;
  return {
    zoom: viewState.zoom,
    target: viewState.target,
    size: [viewport.width, viewport.height],
    bounds,
    kind,
    name: source.name ?? null,
    well: kind === "plate" ? (cell?.name ?? null) : (source.well ?? null),
    field: kind === "well" ? (cell?.name ?? null) : null,
    cell,
    selection,
    sizes,
    pixel_size: pixelSize ? [pixelSize.size, pixelSize.sizeY ?? pixelSize.size] : null,
    unit: pixelSize?.unit ?? null,
    position,
    region,
    visible_cells: visibleCells,
  };
}

/** Normalize well/field names so that e.g. "b3" matches "B03". */
function normalizeCellName(name: string | number): string {
  return String(name)
    .toUpperCase()
    .replace(/\d+/g, (digits) => String(Number(digits)));
}

/** Name of the grid cell to navigate to, if any. */
function resolveCellName(options: NavigateOptions, source: SourceData): string | undefined {
  const kind = getKind(source);
  if (kind === "image") {
    assert(options.well === undefined && options.field === undefined, "This image is not a plate or well.");
    return undefined;
  }
  if (kind === "plate") {
    assert(options.field === undefined, "A plate shows a single field per well; open the well to choose a field.");
    return options.well;
  }
  if (options.well !== undefined && source.well !== undefined) {
    assert(
      normalizeCellName(options.well) === normalizeCellName(source.well),
      `This viewer shows well ${source.well}, not ${options.well}.`,
    );
  }
  return options.field === undefined ? undefined : String(options.field);
}

/** The view state that shows the requested well/field and/or position. */
export function resolveNavigation(
  options: NavigateOptions,
  context: { source: SourceData; layer: LayerState; viewState: ViewState | null; viewport: Size },
): ViewState {
  const { source, layer, viewState, viewport } = context;
  const layout = getLayout(source, layer);
  const { x, y, units = "pixel" } = options;

  const hasPoint = x !== undefined || y !== undefined;
  const label = getKind(source) === "plate" ? "well" : "field";
  const current = viewState ? toModelPoint(layout, viewState.target) : undefined;

  const cellName = resolveCellName(options, source);
  let origin: Point = [0, 0];
  if (cellName !== undefined && layout.loaders) {
    const name = normalizeCellName(cellName);
    const match = layout.loaders.find((d) => normalizeCellName(d.name) === name);
    if (!match) {
      const names = layout.loaders.map((d) => d.name);
      const preview = names.slice(0, 10).join(", ") + (names.length > 10 ? ", ..." : "");
      throw new Error(`No ${label} named "${cellName}". Available: ${preview}`);
    }
    origin = cellOrigin(layout, match);
  } else if (layout.loaders && hasPoint) {
    // Coordinates without a well/field are within the one under the center of the view.
    const match = current && cellAt(layout, current);
    assert(match, `The center of the view is not over a ${label}; specify one to move to.`);
    origin = cellOrigin(layout, match);
  }
  const cellMatrix = layout.matrix.clone().translate([origin[0], origin[1], 0]);

  // Unspecified coordinates default to the cell's center when moving to a cell, else stay put.
  let point: Point = [layout.cell.width / 2, layout.cell.height / 2];
  if (cellName === undefined && current) {
    point = [current[0] - origin[0], current[1] - origin[1]];
  }
  if (hasPoint) {
    let scale: Point = [1, 1];
    if (units === "physical") {
      assert(source.pixel_size, "This image has no physical units; use units='pixel'.");
      scale = [source.pixel_size.size, source.pixel_size.sizeY ?? source.pixel_size.size];
    } else {
      assert(units === "pixel", `Unknown units "${units}"; expected "pixel" or "physical".`);
    }
    point = [x === undefined ? point[0] : x / scale[0], y === undefined ? point[1] : y / scale[1]];
  }
  const [tx, ty] = cellMatrix.transformAsPoint([point[0], point[1], 0]);

  let zoom = options.zoom;
  if (zoom === undefined) {
    zoom =
      (cellName !== undefined && !hasPoint) || !viewState
        ? fitImageToViewport({
            image: layout.cell,
            viewport,
            padding: defaultFitPadding(viewport),
            matrix: cellMatrix,
          }).zoom
        : viewState.zoom;
  }
  return { zoom, target: [tx, ty] };
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  // Only the parts of the source & layer that the viewport math reads.
  const shape = [2, 3, 10, 100, 200]; // t, c, z, y, x
  const loader = [{ shape }] as unknown as SourceData["loader"];
  const baseSource = {
    loader,
    axis_labels: ["t", "c", "z", "y", "x"],
    channel_axis: 1,
    defaults: { selection: [0, 0, 0, 0, 0], colormap: "", opacity: 1 },
    pixel_size: { size: 0.5, sizeY: 0.25, unit: "micrometer" },
  } as unknown as SourceData;
  const selections = [
    [1, 0, 4, 0, 0],
    [1, 2, 4, 0, 0],
  ];
  const imageLayer = { kind: "multiscale", on: true, layerProps: { selections, loader } } as unknown as LayerState;

  // A 2x3 plate with wells A1, A2, B3; cells are 200x100 with a 5px gap.
  const plateSource = {
    ...baseSource,
    name: "Plate",
    loaders: [
      { name: "A1", row: 0, col: 0, loader },
      { name: "A2", row: 0, col: 1, loader },
      { name: "B03", row: 1, col: 2, loader },
    ],
  } as unknown as SourceData;
  const gridLayer = {
    kind: "grid",
    on: true,
    layerProps: { selections, loaders: plateSource.loaders, rows: 2, columns: 3, spacer: 5 },
  } as unknown as LayerState;
  const viewport = { width: 400, height: 200 };

  describe("getViewportInfo", () => {
    it("describes the view of a single image", () => {
      const info = getViewportInfo({
        source: baseSource,
        layer: imageLayer,
        viewState: { zoom: 1, target: [100, 50] },
        viewport,
      });
      expect(info.kind).toBe("image");
      expect(info.bounds).toEqual([0, 0, 200, 100]);
      expect(info.selection).toEqual({ t: 1, z: 4 });
      expect(info.sizes).toEqual({ t: 2, c: 3, z: 10, y: 100, x: 200 });
      expect(info.position).toEqual({ pixel: [100, 50], physical: [50, 12.5] });
      expect(info.region).toEqual({ pixel: [0, 0, 200, 100], physical: [0, 0, 100, 25] });
      expect(info.pixel_size).toEqual([0.5, 0.25]);
      expect(info.well).toBeNull();
    });

    it("accounts for the model matrix", () => {
      const layer = {
        ...imageLayer,
        layerProps: { ...imageLayer.layerProps, modelMatrix: new Matrix4().scale([2, 2, 1]) },
      } as LayerState;
      const info = getViewportInfo({ source: baseSource, layer, viewState: { zoom: 0, target: [100, 50] }, viewport });
      expect(info.position?.pixel).toEqual([50, 25]);
    });

    it("finds the well under the center of a plate", () => {
      // Center on (10, 20) within well B03, whose origin is (410, 105).
      const info = getViewportInfo({
        source: plateSource,
        layer: gridLayer,
        viewState: { zoom: 2, target: [420, 125] },
        viewport,
      });
      expect(info.kind).toBe("plate");
      expect(info.well).toBe("B03");
      expect(info.cell).toEqual({ name: "B03", row: 1, column: 2 });
      expect(info.position?.pixel).toEqual([10, 20]);
      expect(info.region?.pixel).toEqual([-40, -5, 60, 45]);
      expect(info.visible_cells).toEqual(["B03"]);
    });

    it("has no well or position in the gap between wells", () => {
      const info = getViewportInfo({
        source: plateSource,
        layer: gridLayer,
        viewState: { zoom: -2, target: [202, 50] },
        viewport,
      });
      expect(info.well).toBeNull();
      expect(info.position).toBeNull();
      expect(info.visible_cells).toEqual(["A1", "A2", "B03"]);
    });

    it("reports the well and field of a single well source", () => {
      const source = { ...plateSource, well: "C04" } as SourceData;
      const info = getViewportInfo({ source, layer: gridLayer, viewState: { zoom: 0, target: [300, 50] }, viewport });
      expect(info.kind).toBe("well");
      expect(info.well).toBe("C04");
      expect(info.field).toBe("A2");
    });
  });

  describe("resolveNavigation", () => {
    const context = {
      source: plateSource,
      layer: gridLayer,
      viewState: { zoom: -1, target: [0, 0] } as ViewState,
      viewport,
    };

    it("fits a well into the view", () => {
      const view = resolveNavigation({ well: "b3" }, context);
      expect(view.target).toEqual([510, 155]);
      // 200x100 well into (400 - 2 * 30) x (200 - 2 * 30)
      expect(view.zoom).toBeCloseTo(Math.log2(140 / 100));
    });

    it("centers a point within a well at the current zoom", () => {
      const view = resolveNavigation({ well: "A2", x: 10, y: 20 }, context);
      expect(view).toEqual({ zoom: -1, target: [215, 20] });
    });

    it("converts physical units", () => {
      const view = resolveNavigation({ well: "A1", x: 5, y: 5, units: "physical", zoom: 3 }, context);
      expect(view).toEqual({ zoom: 3, target: [10, 20] });
    });

    it("moves within the well under the center of the view", () => {
      const view = resolveNavigation({ x: 10 }, { ...context, viewState: { zoom: 0, target: [420, 125] } });
      expect(view).toEqual({ zoom: 0, target: [420, 125] });
      const next = resolveNavigation({ x: 0, y: 0 }, { ...context, viewState: { zoom: 0, target: [420, 125] } });
      expect(next.target).toEqual([410, 105]);
      expect(() => resolveNavigation({ x: 0 }, { ...context, viewState: { zoom: 0, target: [202, 0] } })).toThrow(
        /not over a well/,
      );
    });

    it("keeps the current position when only zooming", () => {
      const view = resolveNavigation({ zoom: 4 }, { ...context, viewState: { zoom: 0, target: [42, 7] } });
      expect(view).toEqual({ zoom: 4, target: [42, 7] });
    });

    it("rejects unknown wells", () => {
      expect(() => resolveNavigation({ well: "H12" }, context)).toThrow(/No well named "H12"/);
      expect(() => resolveNavigation({ field: 1 }, context)).toThrow(/single field per well/);
    });

    it("moves within a single image", () => {
      const view = resolveNavigation({ x: 20, y: 30 }, { ...context, source: baseSource, layer: imageLayer });
      expect(view).toEqual({ zoom: -1, target: [20, 30] });
      expect(() => resolveNavigation({ well: "A1" }, { ...context, source: baseSource, layer: imageLayer })).toThrow();
    });
  });
}
