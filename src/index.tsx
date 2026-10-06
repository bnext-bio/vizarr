import { Link, Typography } from "@material-ui/core";
import { StylesProvider, ThemeProvider, jssPreset, makeStyles } from "@material-ui/styles";
import { type PrimitiveAtom, Provider, atom } from "jotai";
import { useAtomValue, useSetAtom } from "jotai";
import { create as createJss } from "jss";
import * as React from "react";
import ReactDOM from "react-dom/client";

import Menu from "./components/Menu";
import Viewer from "./components/Viewer";
import "./codecs/register";
import { ViewStateContext } from "./hooks";
import {
  type ImageLayerConfig,
  type SourceData,
  type ViewState,
  addImageAtom,
  layerFamilyAtom,
  redirectObjAtom,
  setAxisSelectionAtom,
  sourceErrorAtom,
  sourceInfoAtom,
  viewStateAtom,
  viewportSizeAtom,
} from "./state";
import theme from "./theme";
import { assert, defer, typedEmitter } from "./utils";
import { type NavigateOptions, type ViewportInfo, getViewportInfo, resolveNavigation } from "./viewport";

export { version } from "../package.json";

type Events = {
  viewStateChange: ViewState;
  /** What is in view (well, field, position, axis selection, ...) of the first image. */
  viewportChange: ViewportInfo;
};

export type { ViewState, ImageLayerConfig, NavigateOptions, ViewportInfo };

export interface VizarrViewer {
  addImage(config: ImageLayerConfig): void;
  setViewState(viewState: ViewState): void;
  /**
   * Moves the view to a well/field and/or position of the first image. Waits for
   * the image to load, and rejects if the well/field doesn't exist.
   */
  navigate(options: NavigateOptions): Promise<void>;
  /**
   * Sets the index of non-channel axes (e.g. `{ t: 3, z: 10 }`) on every image that
   * has them. Waits for the first image to load, like `navigate`.
   */
  setSelection(selection: Record<string, number>): Promise<void>;
  on<E extends keyof Events>(event: E, cb: (data: Events[E]) => void): void;
  destroy(): void;
}

/**
 * When the viewer is mounted inside a Shadow DOM (e.g. the MyST `{anywidget}`
 * directive), styles injected into `document.head` and popovers portaled to
 * `document.body` don't reach it. Inject JSS styles into the shadow root and
 * portal popovers into it instead.
 */
function ShadowRootStyles({ shadowRoot, children }: { shadowRoot: ShadowRoot; children: React.ReactNode }) {
  const [{ jss, viewerTheme }] = React.useState(() => {
    const insertionPoint = document.createComment("vizarr-jss");
    shadowRoot.prepend(insertionPoint);
    const portalContainer = document.createElement("div");
    shadowRoot.append(portalContainer);
    return {
      jss: createJss({ ...jssPreset(), insertionPoint }),
      viewerTheme: {
        ...theme,
        props: {
          ...theme.props,
          // Focus enforcement relies on document.activeElement (the shadow host), and
          // the scroll lock expects the container to have a parent element.
          MuiPopover: { container: portalContainer, disableEnforceFocus: true, disableScrollLock: true },
        },
      },
    };
  });
  return (
    <StylesProvider jss={jss}>
      <ThemeProvider theme={viewerTheme}>{children}</ThemeProvider>
    </StylesProvider>
  );
}

/** Emits a description of the view of the first image whenever it (or its axis selection) changes. */
function ViewportReporter({ onChange }: { onChange: (info: ViewportInfo) => void }) {
  const source = useAtomValue(sourceInfoAtom)[0];
  const viewState = useAtomValue(viewStateAtom);
  const viewport = useAtomValue(viewportSizeAtom);
  if (!source || !viewState || !viewport) {
    return null;
  }
  return <SourceViewportReporter source={source} viewState={viewState} viewport={viewport} onChange={onChange} />;
}

function SourceViewportReporter(props: {
  source: SourceData & { id: string };
  viewState: ViewState;
  viewport: { width: number; height: number };
  onChange: (info: ViewportInfo) => void;
}) {
  const { source, viewState, viewport, onChange } = props;
  const layer = useAtomValue(layerFamilyAtom(source));
  React.useEffect(() => {
    onChange(getViewportInfo({ source, layer, viewState, viewport }));
  }, [source, layer, viewState, viewport, onChange]);
  return null;
}

const useStyles = makeStyles({
  errorContainer: {
    position: "fixed",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    color: "#fff",
    display: "flex",
    alignItems: "center",
    textAlign: "center",
    justifyContent: "center",
    fontSize: "120%",
  },
});

export function createViewer(element: HTMLElement, options: { menuOpen?: boolean } = {}): Promise<VizarrViewer> {
  const ref = React.createRef<VizarrViewer>();
  const emitter = typedEmitter<Events>();
  const viewStateAtomWithEffect: PrimitiveAtom<ViewState | null> = atom(
    (get) => get(viewStateAtom),
    (get, set, update) => {
      const viewState = typeof update === "function" ? update(get(viewStateAtom)) : update;
      if (viewState)
        emitter.emit("viewStateChange", {
          target: viewState.target,
          zoom: viewState.zoom,
        });
      set(viewStateAtom, update);
    },
  );
  const navigateAtom = atom(null, (get, set, options: NavigateOptions) => {
    const source = get(sourceInfoAtom)[0];
    const viewport = get(viewportSizeAtom);
    assert(source && viewport, "Cannot navigate before an image has loaded.");
    const layer = get(layerFamilyAtom(source));
    set(
      viewStateAtomWithEffect,
      resolveNavigation(options, { source, layer, viewState: get(viewStateAtom), viewport }),
    );
  });
  // Navigation & selection requests wait until the first image has loaded and been laid out.
  const canNavigateAtom = atom((get) => get(sourceInfoAtom).length > 0 && get(viewportSizeAtom) !== null);
  const emitViewportChange = (info: ViewportInfo) => emitter.emit("viewportChange", info);
  const { promise, resolve } = defer<VizarrViewer>();

  function App() {
    const sourceError = useAtomValue(sourceErrorAtom);
    const redirectObj = useAtomValue(redirectObjAtom);
    const addImage = useSetAtom(addImageAtom);
    const setViewState = useSetAtom(viewStateAtomWithEffect);
    const setSelection = useSetAtom(setAxisSelectionAtom);
    const navigate = useSetAtom(navigateAtom);
    const canNavigate = useAtomValue(canNavigateAtom);
    const [pending, setPending] = React.useState<
      Array<{ run: () => void; resolve: () => void; reject: (err: unknown) => void }>
    >([]);
    React.useEffect(() => {
      if (!canNavigate || pending.length === 0) return;
      setPending([]);
      for (const { run, resolve, reject } of pending) {
        try {
          run();
          resolve();
        } catch (err) {
          reject(err);
        }
      }
    }, [canNavigate, pending]);
    const enqueue = React.useCallback(
      (run: () => void) =>
        new Promise<void>((resolve, reject) => setPending((queue) => [...queue, { run, resolve, reject }])),
      [],
    );
    React.useImperativeHandle(
      ref,
      () => ({
        addImage,
        setViewState,
        navigate: (options) => enqueue(() => navigate(options)),
        setSelection: (selection) => enqueue(() => setSelection(selection)),
        on: emitter.on.bind(emitter),
        destroy: () => root.unmount(),
      }),
      [setViewState, addImage, setSelection, navigate, enqueue],
    );
    React.useEffect(() => {
      if (ref.current) {
        resolve(ref.current);
      }
    }, []);
    const classes = useStyles();
    return (
      <>
        {sourceError === null && redirectObj === null && (
          <ViewStateContext.Provider value={viewStateAtomWithEffect}>
            <Menu open={options.menuOpen ?? true} />
            <Viewer />
            <ViewportReporter onChange={emitViewportChange} />
          </ViewStateContext.Provider>
        )}
        {sourceError !== null && (
          <div className={classes.errorContainer}>
            <p>{`Error: server replied with "${sourceError}" when loading the resource`}</p>
          </div>
        )}
        {redirectObj !== null && (
          <div className={classes.errorContainer}>
            <Typography variant="h5">
              {redirectObj.message}
              <Link href={redirectObj.url}> {redirectObj.url} </Link>
            </Typography>
          </div>
        )}
      </>
    );
  }
  let root = ReactDOM.createRoot(element);
  const app = (
    <Provider>
      <ViewStateContext.Provider value={viewStateAtomWithEffect}>
        <App />
      </ViewStateContext.Provider>
    </Provider>
  );
  // `element` must already be attached for its shadow root (if any) to be found.
  const rootNode = element.getRootNode();
  root.render(
    rootNode instanceof ShadowRoot ? (
      <ShadowRootStyles shadowRoot={rootNode}>{app}</ShadowRootStyles>
    ) : (
      <ThemeProvider theme={theme}>{app}</ThemeProvider>
    ),
  );
  return promise;
}
