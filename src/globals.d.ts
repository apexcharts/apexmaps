/**
 * Ambient declarations.
 *
 * The CSS shim exists because `src/ApexMaps.js` imports its stylesheet as a
 * side effect; the rollup `css-inline` plugin turns that import into an injected
 * <style> tag at build time, but `tsc` still needs to know the module resolves.
 */
declare module '*.css' {
  const content: string
  export default content
}
