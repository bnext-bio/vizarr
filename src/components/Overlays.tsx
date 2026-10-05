import { makeStyles } from "@material-ui/styles";
import { useAtomValue } from "jotai";
import * as React from "react";

import { DEFAULT_GRID_SPACER } from "../layers/grid-layer";
import { computeScaleBar, getGridCellAt, getMatrixScaleX } from "../overlay-utils";
import { type SourceData, type ViewState, layerFamilyAtom, sourceInfoAtom } from "../state";
import { isGridLayerProps, isInterleaved } from "../utils";

/** Show the grid cell name once a cell spans at least this fraction of the viewport (its smaller side). */
const CELL_ZOOM_THRESHOLD = 0.5;

const useStyles = makeStyles({
  box: {
    zIndex: 1,
    position: "absolute",
    bottom: "5px",
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    borderRadius: "5px",
    padding: "4px 8px",
    color: "#fff",
    fontFamily: "sans-serif",
    fontSize: "12px",
    lineHeight: 1.4,
    pointerEvents: "none",
    userSelect: "none",
  },
  info: {
    left: "5px",
    maxWidth: "50%",
  },
  description: {
    opacity: 0.8,
    whiteSpace: "pre-wrap",
  },
  scalebar: {
    right: "5px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  },
  bar: {
    height: "4px",
    marginTop: "2px",
    backgroundColor: "#fff",
  },
});

type Viewport = { width: number; height: number };

export default function Overlays(props: { viewState: ViewState | null; viewport: Viewport | null }) {
  const sources = useAtomValue(sourceInfoAtom);
  const source = sources[0];
  if (!source || !props.viewState || !props.viewport) {
    return null;
  }
  return <SourceOverlays source={source} viewState={props.viewState} viewport={props.viewport} />;
}

function SourceOverlays({
  source,
  viewState,
  viewport,
}: { source: SourceData & { id: string }; viewState: ViewState; viewport: Viewport }) {
  const classes = useStyles();
  const { layerProps } = useAtomValue(layerFamilyAtom(source));
  const { scalebar: showScalebar = true, overlay: showOverlay = true, description } = source.display ?? {};

  const pixelsPerWorldUnit = 2 ** viewState.zoom;
  const matrixScale = getMatrixScaleX(layerProps.modelMatrix);

  let scalebar = undefined;
  if (showScalebar) {
    // World units are base-resolution pixels scaled by the model matrix.
    const pixelSize = source.pixel_size ?? { size: 1, unit: "px" };
    scalebar = computeScaleBar(pixelSize.size / matrixScale / pixelsPerWorldUnit, pixelSize.unit);
  }

  let cellName = undefined;
  if (showOverlay && isGridLayerProps(layerProps) && layerProps.loaders.length > 0) {
    const { shape } = layerProps.loaders[0].loader[0];
    const [height, width] = shape.slice(isInterleaved(shape) ? -3 : -2);
    const cellScreenSize = Math.min(width, height) * matrixScale * pixelsPerWorldUnit;
    if (cellScreenSize >= CELL_ZOOM_THRESHOLD * Math.min(viewport.width, viewport.height)) {
      const cell = getGridCellAt(viewState.target, {
        modelMatrix: layerProps.modelMatrix,
        cell: { width, height },
        spacer: layerProps.spacer ?? DEFAULT_GRID_SPACER,
      });
      const match = cell && layerProps.loaders.find((d) => d.row === cell.row && d.col === cell.column);
      if (match) {
        cellName = `${source.cell_label ?? "Cell"} ${match.name}`;
      }
    }
  }

  return (
    <>
      {showOverlay && (
        <div className={`${classes.box} ${classes.info}`}>
          <div>
            {source.name}
            {cellName && <strong>{` · ${cellName}`}</strong>}
          </div>
          {description && <div className={classes.description}>{description}</div>}
        </div>
      )}
      {scalebar && (
        <div className={`${classes.box} ${classes.scalebar}`}>
          <span>{scalebar.label}</span>
          <div className={classes.bar} style={{ width: `${scalebar.width}px` }} />
        </div>
      )}
    </>
  );
}
