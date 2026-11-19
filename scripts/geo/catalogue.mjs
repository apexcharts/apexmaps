/**
 * The pack ids the library declares, read out of `src/core/GeoCatalogue.ts`.
 *
 * Pack rows, layouts included, are declared there as `{ id: '...', file: '...' }`
 * literals. Reading them out of the reviewed source is deliberate: that file is
 * the authority on ids, which are public API. Shared by the geo build and the
 * pre-publish check so the two cannot read the catalogue differently; when the
 * build matched bare `'x/y@10m'` strings instead, it missed every `@hex` layout
 * and failed on them.
 *
 * @param {string} source the text of `src/core/GeoCatalogue.ts`
 * @returns {Map<string, string>} pack id to file name
 */
export function declaredPacks(source) {
  const declared = new Map()
  for (const m of source.matchAll(/id:\s*'([^']+)',\s*\n\s*file:\s*'([^']+)'/g)) {
    declared.set(m[1], m[2])
  }
  return declared
}
