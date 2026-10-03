import { CompositeLayer, SolidPolygonLayer, TextLayer } from "deck.gl";
import { Matrix4 } from "math.gl";

import type { CompositeLayerProps, Layer, PickingInfo, SolidPolygonLayerProps, TextLayerProps } from "deck.gl";
import type { ZarrPixelSource } from "../ZarrPixelSource";
import { assert, isInterleaved } from "../utils";
import { MultiscaleImageLayer } from "./viv-layers";
import type { BaseLayerProps } from "./viv-layers";

export interface GridLoader {
  /** Full resolution pyramid (highest → lowest) for a single grid cell. */
  loader: ZarrPixelSource[];
  row: number;
  col: number;
  name: string;
}

type Polygon = Array<[number, number]>;

export interface GridLayerProps
  extends Omit<CompositeLayerProps, "loaders" | "modelMatrix" | "opacity" | "onClick" | "id">,
    BaseLayerProps {
  loaders: GridLoader[];
  rows: number;
  columns: number;
  spacer?: number;
  text?: boolean;
}

/** Base (highest-resolution) pixel dimensions of a grid cell. */
function getCellSize(loader: ZarrPixelSource[]): { width: number; height: number } {
  const { shape } = loader[0];
  const interleaved = isInterleaved(shape);
  const [height, width] = shape.slice(interleaved ? -3 : -2);
  return { width, height };
}

function validateCellSize(loaders: GridLoader[]): { width: number; height: number } {
  const { width, height } = getCellSize(loaders[0].loader);
  // All cells must share the same base dimensions so the grid lines up.
  for (const { loader } of loaders) {
    const size = getCellSize(loader);
    assert(size.width === width && size.height === height, "Grid cells are not the same shape.");
  }
  return { width, height };
}

class GridLayer extends CompositeLayer<CompositeLayerProps & GridLayerProps> {
  static layerName = "VizarrGridLayer";
  static defaultProps = {
    // @ts-expect-error - MultiscaleImageLayer props are not typed
    ...MultiscaleImageLayer.defaultProps,
    // Special grid props
    loaders: { type: "array", value: [], compare: true },
    spacer: { type: "number", value: 5, compare: true },
    rows: { type: "number", value: 0, compare: true },
    columns: { type: "number", value: 0, compare: true },
    text: { type: "boolean", value: false, compare: true },
    // Deck.gl
    onClick: { type: "function", value: null, compare: true },
    onHover: { type: "function", value: null, compare: true },
  };

  getPickingInfo({ info }: { info: PickingInfo }) {
    // provide Grid row and column info for mouse events (hover & click)
    if (!info.coordinate || this.props.loaders.length === 0) {
      return info;
    }
    const spacer = this.props.spacer || 0;
    const loaders = this.props.loaders as GridLoader[];
    const { width, height } = getCellSize(loaders[0].loader);
    const [x, y] = info.coordinate;
    const row = Math.floor(y / (height + spacer));
    const column = Math.floor(x / (width + spacer));
    return {
      ...info,
      gridCoord: { row, column },
    };
  }

  renderLayers() {
    const { rows, columns, spacer = 0, id = "" } = this.props;
    const loaders = this.props.loaders as GridLoader[];
    if (loaders.length === 0) return null; // early return if no data

    const { width, height } = validateCellSize(loaders);
    const baseModelMatrix = this.props.modelMatrix ?? new Matrix4();

    // Each cell is its own multiscale image, translated into its grid position.
    // Viv/deck.gl handle viewport culling and per-cell resolution selection, so
    // zooming in fetches higher-resolution tiles only for the cells in view.
    const layers: Layer[] = loaders.map((d) => {
      const x = d.col * (width + spacer);
      const y = d.row * (height + spacer);
      const modelMatrix = baseModelMatrix.clone().translate([x, y, 0]);
      const layer = new MultiscaleImageLayer({
        id: `${id}-GridLayer-${d.row}-${d.col}`,
        loader: d.loader,
        modelMatrix,
        contrastLimits: this.props.contrastLimits,
        contrastLimitsRange: this.props.contrastLimitsRange,
        colors: this.props.colors,
        channelsVisible: this.props.channelsVisible,
        selections: this.props.selections,
        opacity: this.props.opacity,
        colormap: this.props.colormap,
      });
      // Viv layers only nominally implement deck's Layer interface.
      return layer as unknown as Layer;
    });

    if (this.props.pickable) {
      type Data = { polygon: Polygon };
      const bottom = rows * (height + spacer);
      const right = columns * (width + spacer);
      const polygon = [
        [0, 0],
        [right, 0],
        [right, bottom],
        [0, bottom],
      ] satisfies Polygon;
      const layerProps = {
        data: [{ polygon }],
        getPolygon: (d) => d.polygon,
        getFillColor: [0, 0, 0, 0], // transparent
        getLineColor: [0, 0, 0, 0],
        modelMatrix: baseModelMatrix,
        pickable: true, // enable picking
        id: `${id}-GridLayer-picking`,
      } satisfies SolidPolygonLayerProps<Data>;
      const layer = new SolidPolygonLayer<Data, SolidPolygonLayerProps<Data>>(layerProps);
      layers.push(layer);
    }

    if (this.props.text) {
      type Data = { col: number; row: number; name: string };
      const layer = new TextLayer<Data, TextLayerProps<Data>>({
        id: `${id}-GridLayer-text`,
        data: loaders,
        modelMatrix: baseModelMatrix,
        getPosition: (d) => [d.col * (width + spacer), d.row * (height + spacer)],
        getText: (d) => d.name,
        getColor: [255, 255, 255, 255],
        getSize: 16,
        getAngle: 0,
        getTextAnchor: "start",
        getAlignmentBaseline: "top",
      });
      layers.push(layer);
    }

    return layers;
  }
}

export { GridLayer };
