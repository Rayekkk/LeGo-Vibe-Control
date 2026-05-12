import commonjs from "@rollup/plugin-commonjs";
import resolve from "@rollup/plugin-node-resolve";
import replace from "@rollup/plugin-replace";
import typescript from "@rollup/plugin-typescript";

// Injects @decky/manifest as a virtual module (required by @decky/api at build time)
function deckyManifest() {
  const virtualId = "@decky/manifest";
  const resolvedId = "\0" + virtualId;
  return {
    name: "decky-manifest",
    resolveId(id) {
      if (id === virtualId) return resolvedId;
    },
    load(id) {
      if (id === resolvedId)
        return `export default ${JSON.stringify({ name: "Legion Vibe Control" })};`;
    },
  };
}

// Maps all `import { x } from '@decky/ui'` to the runtime DFL global.
// Working Decky plugins (HueSync, SteamGridDB, CSS Loader) all use DFL as an
// external global rather than bundling @decky/ui inline. Bundling @decky/ui
// triggers initModuleCache() → webpackChunksteamui.push() at module load time,
// which causes a SyntaxError in Steam's CEF JavaScript engine.
function dflShim() {
  const SHIM_ID = "\0dfl-shim";
  return {
    name: "dfl-shim",
    resolveId(id) {
      if (id === "@decky/ui") return SHIM_ID;
    },
    load(id) {
      if (id === SHIM_ID) {
        return `
const _DFL = DFL;
export default _DFL;
export const ButtonItem = _DFL.ButtonItem;
export const PanelSection = _DFL.PanelSection;
export const PanelSectionRow = _DFL.PanelSectionRow;
export const SliderField = _DFL.SliderField;
export const ToggleField = _DFL.ToggleField;
`;
      }
    },
  };
}

// Maps all `import { x } from 'react'` / `import { x } from 'react-dom'` to
// window.SP_REACT / window.SP_REACTDOM — the globals that Steam/Decky provides.
function reactShim() {
  const REACT_SHIM = "\0react-shim";
  const REACTDOM_SHIM = "\0react-dom-shim";
  return {
    name: "react-shim",
    resolveId(id) {
      if (id === "react") return REACT_SHIM;
      if (id === "react-dom") return REACTDOM_SHIM;
    },
    load(id) {
      if (id === REACT_SHIM) {
        return `
const _r = window.SP_REACT;
export default _r;
export const Children = _r.Children;
export const Component = _r.Component;
export const Fragment = _r.Fragment;
export const PureComponent = _r.PureComponent;
export const StrictMode = _r.StrictMode;
export const Suspense = _r.Suspense;
export const cloneElement = _r.cloneElement;
export const createContext = _r.createContext;
export const createElement = _r.createElement;
export const createRef = _r.createRef;
export const forwardRef = _r.forwardRef;
export const isValidElement = _r.isValidElement;
export const lazy = _r.lazy;
export const memo = _r.memo;
export const startTransition = _r.startTransition;
export const use = _r.use;
export const useCallback = _r.useCallback;
export const useContext = _r.useContext;
export const useDebugValue = _r.useDebugValue;
export const useDeferredValue = _r.useDeferredValue;
export const useEffect = _r.useEffect;
export const useId = _r.useId;
export const useImperativeHandle = _r.useImperativeHandle;
export const useLayoutEffect = _r.useLayoutEffect;
export const useMemo = _r.useMemo;
export const useReducer = _r.useReducer;
export const useRef = _r.useRef;
export const useState = _r.useState;
export const useTransition = _r.useTransition;
export const version = _r.version;
`;
      }
      if (id === REACTDOM_SHIM) {
        return `
const _rd = window.SP_REACTDOM;
export default _rd;
export const render = _rd?.render;
export const createPortal = _rd?.createPortal;
`;
      }
    },
  };
}

export default {
  input: "index.tsx",
  output: {
    file: "../dist/index.js",
    format: "es",
  },
  // react/react-dom → window.SP_REACT/SP_REACTDOM (reactShim)
  // @decky/ui → runtime DFL global (dflShim)
  // @decky/api is bundled inline (handles WebSocket callables)
  external: [],
  plugins: [
    dflShim(),
    reactShim(),
    deckyManifest(),
    resolve(),
    commonjs(),
    replace({
      preventAssignment: true,
      "process.env.NODE_ENV": JSON.stringify("production"),
    }),
    typescript(),
  ],
};
