import deckyPlugin from "@decky/rollup";

// The official Decky preset externalises react, react/jsx-runtime, react-dom and
// @decky/ui onto the globals Steam injects (SP_REACT, SP_JSX, SP_REACTDOM, DFL)
// and inlines plugin.json as @decky/manifest. This replaces the hand-written
// shims this project used to carry, which existed to stop @decky/ui being
// bundled - bundling it trips a SyntaxError in Steam's CEF engine.
export default deckyPlugin();
