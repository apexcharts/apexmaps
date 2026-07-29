import babel from '@rollup/plugin-babel'
import resolve from '@rollup/plugin-node-resolve'
import terser from '@rollup/plugin-terser'

const production = !process.env.ROLLUP_WATCH

/**
 * `react` and `apexmaps` are peers and must stay external: bundling either one
 * gives the consumer a second copy of React (hooks throw across copies) or a
 * second ApexMaps, whose registries live on `globalThis` and would then be
 * populated in one copy and read from the other. The shared change detection is
 * `apexmaps/wrappers`, a subpath of the peer, so the same rule covers it.
 */
const external = [/^react(\/.*)?$/, /^apexmaps(\/.*)?$/]

/**
 * Next.js's App Router treats a module with no `'use client'` as a server
 * component, so a build that loses the directive fails on the first `useRef`, in
 * the consumer's app, with nothing wrong on this side. It gets lost twice over:
 * rollup drops a module-level directive when bundling (it warns, then ignores),
 * and terser then strips it from the banner as a redundant directive. Hence a
 * banner *and* `compress.directives: false`, with `npm run check:wrappers`
 * asserting the built file still starts with it.
 */
const banner = `'use client';`

const plugins = [
  // Only here to resolve extensionless relative imports to `.ts`. Nothing from
  // node_modules is bundled: both dependencies are peers and listed as external.
  resolve({ extensions: ['.ts'] }),
  babel({
    babelHelpers: 'bundled',
    exclude: 'node_modules/**',
    extensions: ['.ts'],
    // Type-stripping only, matching the core build. Type checking is `npm run
    // typecheck`, so there is one source of truth for diagnostics.
    presets: [['@babel/preset-typescript', { allowDeclareFields: true }]],
  }),
  production && terser({ compress: { directives: false } }),
].filter(Boolean)

export default {
  input: 'src/index.ts',
  external,
  output: [
    {
      file: 'dist/react-apexmaps.esm.js',
      format: 'es',
      exports: 'named',
      banner,
      sourcemap: !production,
    },
    {
      // `.cjs` rather than `.js`: package.json sets "type": "module", so a `.js`
      // file here would be parsed as ESM and `require('react-apexmaps')` would
      // resolve to an empty object.
      file: 'dist/react-apexmaps.cjs',
      format: 'cjs',
      exports: 'named',
      banner,
      sourcemap: !production,
    },
  ],
  plugins,
}
