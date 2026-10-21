/**
 * Ambient declarations.
 *
 * The CSS shim exists because `src/ApexMaps.ts` imports its stylesheet's text;
 * the rollup `css-inline` plugin turns that import into a string at build time,
 * but `tsc` still needs to know the module resolves.
 */
declare module '*.css' {
  const content: string
  export default content
}
