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
  type ViewState,
  addImageAtom,
  redirectObjAtom,
  sourceErrorAtom,
  viewStateAtom,
} from "./state";
import theme from "./theme";
import { defer, typedEmitter } from "./utils";

export { version } from "../package.json";

type Events = {
  viewStateChange: ViewState;
};

export type { ViewState, ImageLayerConfig };

export interface VizarrViewer {
  addImage(config: ImageLayerConfig): void;
  setViewState(viewState: ViewState): void;
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
  const { promise, resolve } = defer<VizarrViewer>();

  function App() {
    const sourceError = useAtomValue(sourceErrorAtom);
    const redirectObj = useAtomValue(redirectObjAtom);
    const addImage = useSetAtom(addImageAtom);
    const setViewState = useSetAtom(viewStateAtomWithEffect);
    React.useImperativeHandle(
      ref,
      () => ({
        addImage,
        setViewState,
        on: emitter.on.bind(emitter),
        destroy: () => root.unmount(),
      }),
      [setViewState, addImage],
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
