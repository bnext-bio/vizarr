import pMap from "p-map";
import * as zarr from "zarrita";
import type { ImageLabels, ImageLayerConfig, OnClickData, SourceData } from "./state";

import type { Matrix4 } from "math.gl";
import { ZarrPixelSource } from "./ZarrPixelSource";
import type { GridCellLabel, GridLoader } from "./layers/grid-layer";
import type { OmeColor } from "./layers/label-layer";
import * as utils from "./utils";

export async function loadWell(
  config: ImageLayerConfig,
  grp: zarr.Group<zarr.Readable>,
  wellAttrs: Ome.Well,
): Promise<SourceData> {
  // Can filter Well fields by URL query ?acquisition=ID
  const acquisitionId: number | undefined = config.acquisition ? Number.parseInt(config.acquisition) : undefined;
  let acquisitions: Ome.Acquisition[] = [];

  utils.assert(wellAttrs?.images, "Well .zattrs missing images");
  utils.assert(grp.path, "Cannot inspect zarr path to open well.");

  const [row, col] = grp.path.split("/").filter(Boolean).slice(-2);

  let { images } = wellAttrs;

  // Do we have more than 1 Acquisition?
  const acqIds = images.flatMap((img) => (img.acquisition ? [img.acquisition] : []));

  if (acqIds.length > 1) {
    // Need to get acquisitions metadata from parent Plate
    const platePath = grp.path.replace(`${row}/${col}`, "");
    const plate = await zarr.open(grp.resolve(platePath));
    const plateAttrs = utils.resolveAttrs(plate.attrs) as { plate: Ome.Plate };
    acquisitions = plateAttrs.plate.acquisitions ?? [];
    // filter imagePaths by acquisition
    if (acquisitionId && acqIds.includes(acquisitionId)) {
      images = images.filter((img) => img.acquisition === acquisitionId);
    }
  }

  const imgPaths = images.map((img) => img.path);
  const cols = Math.ceil(Math.sqrt(imgPaths.length));
  const rows = Math.ceil(imgPaths.length / cols);

  // Use first image for rendering settings, resolutions etc.
  const first = await zarr.open(grp.resolve(imgPaths[0]), { kind: "group" });
  const imgAttrs = utils.resolveAttrs(first.attrs);

  utils.assert(utils.isMultiscales(imgAttrs), "Path for image is not valid.");
  // Full resolution pyramid: every 'dataset' path from the first multiscales (highest → lowest)
  const resolutions = imgAttrs.multiscales[0].datasets.map((dataset) => dataset.path);

  // Open the full resolution pyramid for every Image (field).
  const data = await Promise.all(
    imgPaths.map((p) =>
      Promise.all(
        resolutions.map(
          (resolution) =>
            // @ts-expect-error - ok flag to avoid loading unused attrs
            zarr.open(grp.resolve(utils.join(p, resolution)), { kind: "array", attrs: false }) as Promise<
              zarr.Array<zarr.DataType, zarr.Readable>
            >,
        ),
      ),
    ),
  );
  const axes = utils.getNgffAxes(imgAttrs.multiscales);
  const axis_labels = utils.getNgffAxisLabels(axes);

  // Labels: metadata from the first field, label pyramids for every field.
  const labelSpecs = await loadGridLabelSpecs(first, imgAttrs.multiscales);
  const fieldLabels = await Promise.all(imgPaths.map((p) => openGridCellLabels(grp.resolve(p), labelSpecs)));

  const tileSize = utils.guessTileSize(data[0][0]);
  const loaders: GridLoader[] = utils.range(rows).flatMap((row) => {
    // filter to remove any empty row/col position
    return utils
      .range(cols)
      .filter((col) => col + row * cols < data.length)
      .map((col) => {
        const offset = col + row * cols;
        return {
          name: String(offset),
          row,
          col,
          loader: data[offset].map((arr) => new ZarrPixelSource(arr, { labels: axis_labels, tileSize })),
          labels: fieldLabels[offset],
        };
      });
  });

  let meta: Meta;
  if (utils.isOmeMultiscales(imgAttrs)) {
    meta = parseOmeroMeta(imgAttrs.omero, axes);
  } else {
    const lowres = loaders.at(-1)?.loader.at(-1);
    utils.assert(lowres, "Expected at least one resolution, found none.");
    meta = await defaultMeta(lowres, axis_labels);
  }

  const sourceData: SourceData = {
    loaders,
    ...meta,
    axis_labels,
    loader: loaders[0].loader,
    model_matrix: utils.parseMatrix(config.model_matrix),
    defaults: {
      selection: meta.defaultSelection,
      colormap: config.colormap ?? "",
      opacity: config.opacity ?? 1,
    },
    name: `Well ${row}${col}`,
    pixel_size: utils.getPhysicalPixelSize(imgAttrs.multiscales),
    cell_label: "Field",
    well: `${row}${col}`,
    labels: resolveGridLabels(labelSpecs, loaders),
  };

  if (acquisitions.length > 0) {
    // To show acquisition chooser in UI
    sourceData.acquisitions = acquisitions;
    sourceData.acquisitionId = acquisitionId || -1;
  }

  sourceData.rows = rows;
  sourceData.columns = cols;
  // Attach a click handler only if a custom one is provided or the default
  // open-in-new-window links are enabled (see `disable_well_links`).
  if (config.onClick || !utils.coerceBoolean(config.disable_well_links)) {
    sourceData.onClick = (info: OnClickData) => {
      let gridCoord = info.gridCoord;
      if (!gridCoord) {
        return;
      }
      const { row, column } = gridCoord;
      let imgSource = undefined;
      if (typeof config.source === "string" && grp.path && !Number.isNaN(row) && !Number.isNaN(column)) {
        const field = row * cols + column;
        imgSource = utils.join(config.source, imgPaths[field]);
      }
      if (config.onClick) {
        info.layer = undefined;
        info.imageSource = imgSource;
        config.onClick(info);
      } else if (imgSource) {
        window.open(`${window.location.origin + window.location.pathname}?source=${imgSource}`);
      }
    };
  }

  return sourceData;
}

export async function loadPlate(
  config: ImageLayerConfig,
  grp: zarr.Group<zarr.Readable>,
  plateAttrs: Ome.Plate,
): Promise<SourceData> {
  utils.assert(plateAttrs?.rows || plateAttrs?.columns, "Plate .zattrs missing rows, columns or wells");

  // Can filter Plate wells by URL query ?acquisition=ID
  const acquisitionId: number | undefined = config.acquisition ? Number.parseInt(config.acquisition) : undefined;

  const rows = plateAttrs.rows.map((row) => row.name);
  const columns = plateAttrs.columns.map((row) => row.name);

  // Fields are by index and we assume at least 1 per Well
  const wellPaths = plateAttrs.wells.map((well) => well.path);
  const zarrVersion = await utils.guessZarrVersion(grp);

  // Use first image as proxy for others.
  const wellAttrs = await utils.getAttrsOnly<{ well: Ome.Well }>(grp, {
    path: wellPaths[0],
    zarrVersion,
  });
  utils.assert("well" in wellAttrs, "Path for image is not valid, not a well.");

  const imgPath = wellAttrs.well.images[0].path;
  const imgAttrs = await utils.getAttrsOnly<Ome.Attrs>(grp, {
    path: utils.join(wellPaths[0], imgPath),
    zarrVersion,
  });
  utils.assert("multiscales" in imgAttrs, "Path for image is not valid.");

  // Full resolution pyramid: the 'path' of every 'dataset' from the first multiscales (highest → lowest)
  const { datasets } = imgAttrs.multiscales[0];
  const resolutions = datasets.map((dataset) => dataset.path);

  async function getWellImageInfo(wellPath: string) {
    const wellAttrs = await utils.getAttrsOnly<{ well: Ome.Well }>(grp, {
      path: wellPath,
      zarrVersion,
    });
    utils.assert("well" in wellAttrs, "Path for image is not valid, not a well.");

    const images = wellAttrs.well.images;
    const acqIds = images.flatMap((img) => (img.acquisition ? [img.acquisition] : []));

    let selected = images[0];
    if (Number.isInteger(acquisitionId)) {
      const match = images.find((img) => img.acquisition === acquisitionId);
      if (match) {
        selected = match;
      }
    }

    return {
      imagePath: utils.join(wellPath, selected.path),
      acqIds,
    };
  }
  // Labels: metadata from the first well's image (like the resolutions above).
  const labelSpecs = await loadGridLabelSpecs(grp.resolve(utils.join(wellPaths[0], imgPath)), imgAttrs.multiscales);

  const wellImageInfos = await Promise.all(wellPaths.map(getWellImageInfo));
  const wellImagePaths = wellImageInfos.map((info) => info.imagePath);
  const acquisitionIds = Array.from(new Set(wellImageInfos.flatMap((info) => info.acqIds)));

  // Open the full resolution pyramid for every Well.
  const mapper = async (imagePath: string) => {
    const arrs = await Promise.all(
      resolutions.map(
        (resolution) =>
          // @ts-expect-error - we don't need the meta for these arrays
          zarr.open(grp.resolve(utils.join(imagePath, resolution)), {
            kind: "array",
            attrs: false,
          }) as Promise<zarr.Array<zarr.DataType, zarr.Readable>>,
      ),
    );
    const labels = await openGridCellLabels(grp.resolve(imagePath), labelSpecs);
    return [imagePath, arrs, labels] as const;
  };

  const data = await pMap(wellImagePaths, mapper, { concurrency: 10 });
  const axes = utils.getNgffAxes(imgAttrs.multiscales);
  const axis_labels = utils.getNgffAxisLabels(axes);
  const tileSize = utils.guessTileSize(data[0][1][0]);
  const loaders: GridLoader[] = data.map(([imagePath, arrs, labels]) => {
    const [row, col] = imagePath.split("/");
    return {
      name: `${row}${col}`,
      row: rows.indexOf(row),
      col: columns.indexOf(col),
      loader: arrs.map((arr) => new ZarrPixelSource(arr, { labels: axis_labels, tileSize })),
      labels,
    };
  });
  let meta: Meta;
  if ("omero" in imgAttrs) {
    meta = parseOmeroMeta(imgAttrs.omero, axes);
  } else {
    const lowres = loaders.at(-1)?.loader.at(-1);
    utils.assert(lowres, "Expected at least one resolution, found none.");
    meta = await defaultMeta(lowres, axis_labels);
  }

  // Load Image to use for channel names, rendering settings, sizeZ, sizeT etc.
  const sourceData: SourceData = {
    loaders,
    ...meta,
    axis_labels,
    loader: loaders[0].loader,
    model_matrix: utils.parseMatrix(config.model_matrix),
    defaults: {
      selection: meta.defaultSelection,
      colormap: config.colormap ?? "",
      opacity: config.opacity ?? 1,
    },
    name: plateAttrs.name || "Plate",
    rows: rows.length,
    columns: columns.length,
    pixel_size: utils.getPhysicalPixelSize(imgAttrs.multiscales),
    cell_label: "Well",
    labels: resolveGridLabels(labelSpecs, loaders),
  };
  if ((plateAttrs.acquisitions?.length ?? 0) > 0 && acquisitionIds.length > 1) {
    // To show acquisition chooser in UI
    sourceData.acquisitions = plateAttrs.acquisitions;
    sourceData.acquisitionId = acquisitionId ?? -1;
  }
  // Use onClick from image config or Open Well in new window.
  // Attach a click handler only if a custom one is provided or the default
  // open-in-new-window links are enabled (see `disable_well_links`).
  if (config.onClick || !utils.coerceBoolean(config.disable_well_links)) {
    sourceData.onClick = (info: OnClickData) => {
      let gridCoord = info.gridCoord;
      if (!gridCoord) {
        return;
      }
      const { row, column } = gridCoord;
      let imgSource = undefined;
      if (typeof config.source === "string" && grp.path && !Number.isNaN(row) && !Number.isNaN(column)) {
        imgSource = utils.join(config.source, rows[row], columns[column]);
      }
      if (config.onClick) {
        info.layer = undefined;
        info.imageSource = imgSource;
        config.onClick(info);
      } else if (imgSource) {
        const url = new URL(window.location.href);
        url.searchParams.set("source", imgSource);
        if (Number.isInteger(acquisitionId)) {
          url.searchParams.set("acquisition", String(acquisitionId));
        }
        window.open(decodeURIComponent(url.href));
      }
    };
  }
  return sourceData;
}

export async function loadOmeMultiscales(
  config: ImageLayerConfig,
  grp: zarr.Group<zarr.Readable>,
  attrs: { multiscales: Ome.Multiscale[] },
): Promise<SourceData> {
  const { name, opacity = 1, colormap = "" } = config;
  const data = await utils.loadMultiscales(grp, attrs.multiscales);
  const hasExplicitAxes = !!attrs.multiscales[0]?.axes;
  const isOme = utils.isOmeMultiscales(attrs);
  // Use default 5D axes for OME-ZARR (has omero metadata), otherwise infer from shape
  const axes = hasExplicitAxes || isOme ? utils.getNgffAxes(attrs.multiscales) : undefined;
  const axis_labels = axes ? utils.getNgffAxisLabels(axes) : utils.getAxisLabels(data[0]);
  const tileSize = utils.guessTileSize(data[0]);
  let meta: Meta;
  if (isOme && axes) {
    meta = parseOmeroMeta(attrs.omero, axes);
  } else {
    const lowresArray = data.at(-1);
    utils.assert(lowresArray, "Expected at least one resolution in multiscales, found none.");
    const lowresSource = new ZarrPixelSource(lowresArray, { labels: axis_labels, tileSize });
    meta = await defaultMeta(lowresSource, axis_labels);
  }
  const loader = data.map((arr) => new ZarrPixelSource(arr, { labels: axis_labels, tileSize }));
  const labels = await resolveOmeLabelsFromMultiscales(grp);
  return {
    loader: loader,
    axis_labels,
    model_matrix: config.model_matrix
      ? utils.parseMatrix(config.model_matrix)
      : utils.coordinateTransformationsToMatrix(attrs.multiscales),
    defaults: {
      selection: meta.defaultSelection,
      colormap,
      opacity,
    },
    ...meta,
    name: meta.name ?? name,
    pixel_size: utils.getPhysicalPixelSize(attrs.multiscales),
    labels: await Promise.all(labels.map((name) => loadOmeImageLabel(grp.resolve("labels"), name))),
  };
}

async function loadOmeImageLabel(root: zarr.Location<zarr.Readable>, name: string): Promise<ImageLabels[number]> {
  const grp = await zarr.open(root.resolve(name), { kind: "group" });
  const attrs = utils.resolveAttrs(grp.attrs);
  utils.assert(utils.isOmeImageLabel(attrs), "No 'image-label' metadata.");
  const data = await utils.loadMultiscales(grp, attrs.multiscales);
  const baseResolution = data.at(0);
  utils.assert(baseResolution, "No base resolution found for multiscale labels.");
  const tileSize = utils.guessTileSize(baseResolution);
  const axes = utils.getNgffAxes(attrs.multiscales);
  const labels = utils.getNgffAxisLabels(axes);
  return {
    name,
    modelMatrix: utils.coordinateTransformationsToMatrix(attrs.multiscales),
    loader: data.map((arr) => new ZarrPixelSource(arr, { labels, tileSize })),
    colors: parseLabelColors(attrs["image-label"]),
  };
}

function parseLabelColors(imageLabel: Ome.ImageLabel): Array<OmeColor> | undefined {
  const colors = (imageLabel.colors ?? []).map((d) => ({ labelValue: d["label-value"], rgba: d.rgba }));
  return colors.length > 0 ? colors : undefined;
}

/** Label image metadata shared by every cell of a plate/well grid. */
type GridLabelSpec = {
  name: string;
  resolutions: Array<string>;
  axisLabels: [...string[], "y", "x"];
  colors?: Array<OmeColor>;
  /** Label pixels → image base-resolution pixels (the space grid cells are laid out in). */
  modelMatrix: Matrix4;
};

/**
 * Reads the labels of a representative grid image (e.g. a plate's first well).
 * Labels whose metadata can't be read are skipped rather than failing the grid.
 */
async function loadGridLabelSpecs(
  image: zarr.Location<zarr.Readable>,
  imageMultiscales: Ome.Multiscale[],
): Promise<Array<GridLabelSpec>> {
  const names = await resolveOmeLabelsFromMultiscales(image);
  const imageToPixels = utils.coordinateTransformationsToMatrix(imageMultiscales).invert();
  const specs = await Promise.all(
    names.map(async (name): Promise<GridLabelSpec | undefined> => {
      try {
        const grp = await zarr.open(image.resolve(utils.join("labels", name)), { kind: "group" });
        const attrs = utils.resolveAttrs(grp.attrs);
        utils.assert(utils.isOmeImageLabel(attrs), "No 'image-label' metadata.");
        return {
          name,
          resolutions: attrs.multiscales[0].datasets.map((dataset) => dataset.path),
          axisLabels: utils.getNgffAxisLabels(utils.getNgffAxes(attrs.multiscales)),
          colors: parseLabelColors(attrs["image-label"]),
          modelMatrix: imageToPixels.clone().multiplyRight(utils.coordinateTransformationsToMatrix(attrs.multiscales)),
        };
      } catch (err) {
        console.warn(`[vizarr] Skipping label "${name}":`, err);
        return undefined;
      }
    }),
  );
  return specs.filter((spec) => spec !== undefined);
}

/** Opens a grid cell's label pyramids, one entry per spec (undefined if the cell lacks it). */
async function openGridCellLabels(
  image: zarr.Location<zarr.Readable>,
  specs: Array<GridLabelSpec>,
): Promise<Array<GridCellLabel | undefined>> {
  return Promise.all(
    specs.map(async (spec) => {
      try {
        const arrs = await Promise.all(
          spec.resolutions.map(
            (resolution) =>
              // @ts-expect-error - ok flag to avoid loading unused attrs
              zarr.open(image.resolve(utils.join("labels", spec.name, resolution)), {
                kind: "array",
                attrs: false,
              }) as Promise<zarr.Array<zarr.DataType, zarr.Readable>>,
          ),
        );
        const tileSize = utils.guessTileSize(arrs[0]);
        return {
          loader: arrs.map((arr) => new ZarrPixelSource(arr, { labels: spec.axisLabels, tileSize })),
          modelMatrix: spec.modelMatrix,
        };
      } catch (err) {
        utils.rethrowUnless(err, zarr.NodeNotFoundError);
        return undefined;
      }
    }),
  );
}

/**
 * Source-level labels for a grid (used by the menu and for selection mapping),
 * taken from the first cell that has each label. Labels no cell has are dropped.
 */
function resolveGridLabels(specs: Array<GridLabelSpec>, loaders: Array<GridLoader>): ImageLabels {
  const labels: ImageLabels = [];
  const keep = specs.map((spec, i) => {
    const cell = loaders.find((d) => d.labels?.[i]);
    if (!cell?.labels?.[i]) return false;
    labels.push({ name: spec.name, loader: cell.labels[i].loader, modelMatrix: spec.modelMatrix, colors: spec.colors });
    return true;
  });
  for (const d of loaders) {
    d.labels = d.labels?.filter((_, i) => keep[i]);
  }
  return labels;
}

export async function resolveOmeLabelsFromMultiscales(grp: zarr.Location<zarr.Readable>): Promise<Array<string>> {
  return zarr
    .open(grp.resolve("labels"), { kind: "group" })
    .then(({ attrs }) => (utils.resolveAttrs(attrs).labels ?? []) as Array<string>)
    .catch((e) => {
      utils.rethrowUnless(e, zarr.NodeNotFoundError);
      return [];
    });
}

type Meta = {
  name: string | undefined;
  names: Array<string>;
  colors: Array<string>;
  contrast_limits: Array<[number, number] | undefined>;
  visibilities: Array<boolean>;
  channel_axis: number | null;
  defaultSelection: Array<number>;
};

async function defaultMeta(loader: ZarrPixelSource, axis_labels: string[]): Promise<Meta> {
  const channel_axis = axis_labels.indexOf("c");
  const channel_count = channel_axis === -1 ? 1 : loader.shape[channel_axis];
  const visibilities = utils.getDefaultVisibilities(channel_count);
  const contrast_limits = await utils.calcConstrastLimits(loader, channel_axis, visibilities);
  const colors = utils.getDefaultColors(channel_count, visibilities);
  return {
    name: "Image",
    names: utils.range(channel_count).map((i) => `channel_${i}`),
    colors,
    contrast_limits,
    visibilities,
    channel_axis: axis_labels.includes("c") ? axis_labels.indexOf("c") : null,
    defaultSelection: axis_labels.map(() => 0),
  };
}

export function parseOmeroMeta({ rdefs, channels, name }: Ome.Omero, axes: Ome.Axis[]): Meta {
  const t = rdefs?.defaultT ?? 0;
  const z = rdefs?.defaultZ ?? 0;
  const greyscale = rdefs?.model === "greyscale";

  const colors: string[] = [];
  const contrast_limits: [min: number, max: number][] = [];
  const visibilities: boolean[] = [];
  const names: string[] = [];

  channels.forEach((c, index) => {
    colors.push(c.color);
    contrast_limits.push([c.window.start, c.window.end]);
    visibilities.push(c.active);
    names.push(c.label || `${index}`);
  });

  if (greyscale && colors.length === 1) {
    colors[0] = "FFFFFF";
  }

  const defaultSelection = axes.map((axis) => {
    if (axis.type === "time") return t;
    if (axis.name === "z") return z;
    return 0;
  });
  const channel_axis = axes.findIndex((axis) => axis.type === "channel");

  return {
    name,
    names,
    colors,
    contrast_limits,
    visibilities,
    channel_axis,
    defaultSelection,
  };
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("resolveOmeLabelsFromMultiscales", () => {
    function imageWithLabelsGroup(labelsAttrs: Record<string, unknown>) {
      const store = new Map<string, Uint8Array>();
      const meta = { zarr_format: 3, node_type: "group", attributes: labelsAttrs };
      store.set("/labels/zarr.json", new TextEncoder().encode(JSON.stringify(meta)));
      return new zarr.Group(store, "/", { zarr_format: 3, node_type: "group", attributes: {} });
    }

    it("reads v0.4 labels (top-level attributes)", async () => {
      const grp = imageWithLabelsGroup({ labels: ["cells"] });
      expect(await resolveOmeLabelsFromMultiscales(grp)).toEqual(["cells"]);
    });

    it("reads v0.5 labels (nested under 'ome')", async () => {
      const grp = imageWithLabelsGroup({ ome: { version: "0.5", labels: ["cells"] } });
      expect(await resolveOmeLabelsFromMultiscales(grp)).toEqual(["cells"]);
    });

    it("returns no labels when there is no labels group", async () => {
      const grp = new zarr.Group(new Map(), "/", { zarr_format: 3, node_type: "group", attributes: {} });
      expect(await resolveOmeLabelsFromMultiscales(grp)).toEqual([]);
    });
  });

  describe("parseOmeroMeta", () => {
    const axes: Ome.Axis[] = [
      { name: "t", type: "time" },
      { name: "c", type: "channel" },
      { name: "z", type: "space" },
      { name: "y", type: "space" },
      { name: "x", type: "space" },
    ];

    it("extracts channel colors and contrast limits", () => {
      const omero: Ome.Omero = {
        id: 1,
        version: "0.1",
        channels: [
          {
            color: "0000FF",
            active: true,
            label: "LaminB1",
            coefficient: 1,
            family: "linear",
            inverted: false,
            window: { start: 0, end: 800, min: 0, max: 65535 },
          },
          {
            color: "FFFF00",
            active: true,
            label: "Dapi",
            coefficient: 1,
            family: "linear",
            inverted: false,
            window: { start: 100, end: 300, min: 0, max: 65535 },
          },
        ],
        rdefs: { model: "color" },
      };
      const meta = parseOmeroMeta(omero, axes);
      expect(meta.colors).toEqual(["0000FF", "FFFF00"]);
      expect(meta.contrast_limits).toEqual([
        [0, 800],
        [100, 300],
      ]);
      expect(meta.names).toEqual(["LaminB1", "Dapi"]);
      expect(meta.visibilities).toEqual([true, true]);
      expect(meta.channel_axis).toBe(1);
    });

    it("uses defaultT and defaultZ for selection", () => {
      const omero: Ome.Omero = {
        id: 1,
        version: "0.1",
        channels: [
          {
            color: "FF0000",
            active: true,
            label: "ch",
            coefficient: 1,
            family: "linear",
            inverted: false,
            window: { start: 0, end: 255, min: 0, max: 255 },
          },
        ],
        rdefs: { model: "color", defaultT: 3, defaultZ: 10 },
      };
      const meta = parseOmeroMeta(omero, axes);
      // t=3, c=0, z=10, y=0, x=0
      expect(meta.defaultSelection).toEqual([3, 0, 10, 0, 0]);
    });

    it("forces white for single greyscale channel", () => {
      const omero: Ome.Omero = {
        id: 1,
        version: "0.1",
        channels: [
          {
            color: "0000FF",
            active: true,
            label: "ch",
            coefficient: 1,
            family: "linear",
            inverted: false,
            window: { start: 0, end: 255, min: 0, max: 255 },
          },
        ],
        rdefs: { model: "greyscale" },
      };
      const meta = parseOmeroMeta(omero, axes);
      expect(meta.colors).toEqual(["FFFFFF"]);
    });

    it("keeps original colors for multi-channel greyscale", () => {
      const omero: Ome.Omero = {
        id: 1,
        version: "0.1",
        channels: [
          {
            color: "0000FF",
            active: true,
            label: "a",
            coefficient: 1,
            family: "linear",
            inverted: false,
            window: { start: 0, end: 255, min: 0, max: 255 },
          },
          {
            color: "FF0000",
            active: false,
            label: "b",
            coefficient: 1,
            family: "linear",
            inverted: false,
            window: { start: 0, end: 255, min: 0, max: 255 },
          },
        ],
        rdefs: { model: "greyscale" },
      };
      const meta = parseOmeroMeta(omero, axes);
      // greyscale override only applies to single-channel
      expect(meta.colors).toEqual(["0000FF", "FF0000"]);
    });

    it("falls back to index for unnamed channels", () => {
      const omero: Ome.Omero = {
        id: 1,
        version: "0.1",
        channels: [
          {
            color: "FF0000",
            active: true,
            label: "",
            coefficient: 1,
            family: "linear",
            inverted: false,
            window: { start: 0, end: 255, min: 0, max: 255 },
          },
        ],
        rdefs: { model: "color" },
      };
      const meta = parseOmeroMeta(omero, axes);
      expect(meta.names).toEqual(["0"]);
    });

    it("finds channel_axis from axes", () => {
      const yx: Ome.Axis[] = [
        { name: "y", type: "space" },
        { name: "x", type: "space" },
      ];
      const omero: Ome.Omero = {
        id: 1,
        version: "0.1",
        channels: [
          {
            color: "FF0000",
            active: true,
            label: "ch",
            coefficient: 1,
            family: "linear",
            inverted: false,
            window: { start: 0, end: 255, min: 0, max: 255 },
          },
        ],
        rdefs: { model: "color" },
      };
      const meta = parseOmeroMeta(omero, yx);
      // no channel axis in yx
      expect(meta.channel_axis).toBe(-1);
    });
  });
}
