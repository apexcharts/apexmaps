import babel from '@rollup/plugin-babel'
import resolve from '@rollup/plugin-node-resolve'
import terser from '@rollup/plugin-terser'

const production = !process.env.ROLLUP_WATCH

/**
 * `vue` and `apexmaps` are peers and must stay external. Two copies of Vue means
 * two reactivity systems, so a ref created by one is inert to the other's
 * watchers; two copies of ApexMaps means two registries, so `registerMap`
 * populates one and the map reads the other.
 *
 * The shared change detection is `apexmaps/wrappers`, a subpath of the peer, so
 * the same pattern covers it: external, resolved at the consumer's install.
 */
const external = [/^vue(\/.*)?$/, /^apexmaps(\/.*)?$/]

/**
 * No `'use client'` banner, unlike the React build. The directive is a React
 * Server Components marker and means nothing to Vue: Nuxt decides client-only
 * rendering with `<ClientOnly>` or a `.client.vue` suffix, at the call site rather
 * than in the library. `check-wrappers` requires the directive only of a bundle
 * whose peers include React, for exactly this reason.
 */
const plugins = [
  // Only here to resolve extensionless relative imports and the internals
  // workspace to `.ts`. Nothing from node_modules is bundled except that package.
  resolve({ extensions: ['.ts'] }),
  babel({
    babelHelpers: 'bundled',
    exclude: 'node_modules/**',
    extensions: ['.ts'],
    // Type-stripping only, matching the core build. Type checking is `npm run
    // typecheck`, so there is one source of truth for diagnostics.
    presets: [['@babel/preset-typescript', { allowDeclareFields: true }]],
  }),
  production && terser(),
].filter(Boolean)

export default {
  input: 'src/index.ts',
  external,
  output: [
    {
      file: 'dist/vue-apexmaps.esm.js',
      format: 'es',
      exports: 'named',
      sourcemap: !production,
    },
    {
      // `.cjs` rather than `.js`: package.json sets "type": "module", so a `.js`
      // file here would be parsed as ESM and `require('vue-apexmaps')` would
      // resolve to an empty object.
      file: 'dist/vue-apexmaps.cjs',
      format: 'cjs',
      exports: 'named',
      sourcemap: !production,
    },
  ],
  plugins,
}
