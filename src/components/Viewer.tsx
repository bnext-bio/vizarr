import DeckGL from "deck.gl";
import { OrthographicView } from "deck.gl";
import { useAtom, useAtomValue } from "jotai";
import * as React from "react";
import { useViewState } from "../hooks";
import { DEFAULT_GRID_SPACER } from "../layers/grid-layer";
import { layerAtoms, viewportSizeAtom } from "../state";
import { fitImageToViewport, isGridLayerProps, isInterleaved, resolveLoaderFromLayerProps } from "../utils";
import { defaultFitPadding } from "../viewport";

import type { DeckGLRef, OrthographicViewState } from "deck.gl";
import type { VizarrLayer } from "../state";
import Overlays from "./Overlays";

export default function Viewer() {
  const deckRef = React.useRef<DeckGLRef>(null);
  const [viewState, setViewState] = useViewState();
  const layers = useAtomValue(layerAtoms);
  const firstLayer = layers[0];
  const [viewport, setViewport] = useAtom(viewportSizeAtom);

  // If viewState hasn't been updated, use the first loader to guess viewState
  // TODO: There is probably a better place / way to set the intital view and this is a hack.
  if (deckRef.current?.deck && !viewState && firstLayer) {
    const { deck } = deckRef.current;
    setViewState(
      fitImageToViewport({
        image: getLayerSize(firstLayer),
        viewport: deck,
        padding: defaultFitPadding(deck), // Adjust depending on viewport width.
        matrix: firstLayer.props.modelMatrix,
      }),
    );
  }

  const deck = deckRef.current?.deck;
  return (
    <>
      <DeckGL
        ref={deckRef}
        layers={layers}
        viewState={viewState && { ortho: viewState }}
        onViewStateChange={(e: { viewState: OrthographicViewState }) =>
          // @ts-expect-error - deck doesn't know this should be ok
          setViewState(e.viewState)
        }
        onResize={({ width, height }) => setViewport({ width, height })}
        views={[new OrthographicView({ id: "ortho", controller: true })]}
      />
      <Overlays
        viewState={viewState}
        viewport={viewport ?? (deck ? { width: deck.width, height: deck.height } : null)}
      />
    </>
  );
}

function getLayerSize({ props }: VizarrLayer) {
  const loader = resolveLoaderFromLayerProps(props);
  const [baseResolution, maxZoom] = Array.isArray(loader) ? [loader[0], loader.length] : [loader, 0];
  const interleaved = isInterleaved(baseResolution.shape);
  let [height, width] = baseResolution.shape.slice(interleaved ? -3 : -2);
  if (isGridLayerProps(props)) {
    // TODO: Don't hardcode spacer size. Probably best to inspect the deck.gl Layers rather than
    // the Layer Props.
    const spacer = DEFAULT_GRID_SPACER;
    height = (height + spacer) * props.rows;
    width = (width + spacer) * props.columns;
  }
  return { height, width, maxZoom };
}
