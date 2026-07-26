import terser from '@rollup/plugin-terser'
import babel from '@rollup/plugin-babel'
import resolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import fs from 'fs'
import path from 'path'

const production = !process.env.ROLLUP_WATCH

/** Resolution order for extensionless imports. */
const EXTENSIONS = ['.ts', '.js', '.json']

/**
 * Inlines `import './ApexMaps.css'` as an injected <style> tag and also emits
 * the raw stylesheet to dist so consumers can import it separately.
 */
function cssInline(emitAsset = true) {
  let collected = ''
  return {
    name: 'css-inline',
    resolveId(source, importer) {
      if (!source.endsWith('.css')) return null
      if (path.isAbsolute(source)) return source
      return path.resolve(path.dirname(importer || './src'), source)
    },
    load(id) {
      if (!id.endsWith('.css')) return null
      const css = fs.readFileSync(id, 'utf8')
      collected += css
      const json = JSON.stringify(css)
      // Guard on `document`: the bundle must stay importable under SSR.
      return `
        if (typeof document !== 'undefined' && !document.getElementById('apexmaps-styles')) {
          var s = document.createElement('style')
          s.id = 'apexmaps-styles'
          s.textContent = ${json}
          document.head.appendChild(s)
        }
        export default ${json}
      `
    },
    generateBundle() {
      if (!collected || !emitAsset) return
      this.emitFile({ type: 'asset', fileName: 'apexmaps.css', source: collected })
    },
  }
}

/**
 * @param {boolean} emitCss Only one config emits the stylesheet asset.
 * @returns {import('rollup').Plugin[]}
 */
const plugins = (emitCss) =>
  /** @type {any} */ (
    [
      cssInline(emitCss),
      resolve({ browser: true, extensions: EXTENSIONS }),
      commonjs(),
      babel({
        babelHelpers: 'bundled',
        exclude: 'node_modules/**',
        extensions: EXTENSIONS,
        // Type-stripping only. Type *checking* is a separate step (`npm run
        // typecheck`), which keeps bundling fast and keeps one source of truth for
        // diagnostics.
        presets: [['@babel/preset-typescript', { allowDeclareFields: true }]],
      }),
      production && terser(),
    ].filter(Boolean)
  )

export default [
  {
    // Browser builds. The entry is default-only so `window.ApexMaps` is the class
    // itself rather than a module namespace object.
    input: 'src/ApexMaps.ts',
    output: [
      {
        file: 'dist/apexmaps.min.js',
        format: 'iife',
        name: 'ApexMaps',
        exports: 'default',
        sourcemap: !production,
      },
      {
        // `.cjs` is required: package.json sets "type": "module", so a `.js` file
        // here would be parsed as ESM and the UMD module.exports branch would
        // never run, making require('apexmaps') resolve to {}.
        file: 'dist/apexmaps.cjs',
        format: 'umd',
        name: 'ApexMaps',
        exports: 'default',
        sourcemap: !production,
      },
    ],
    plugins: plugins(true),
  },
  {
    // ESM build, via the re-export entry, so both `import ApexMaps` and
    // `import { ApexMaps }` resolve.
    input: 'src/index.ts',
    output: {
      file: 'dist/apexmaps.esm.js',
      format: 'es',
      exports: 'named',
      sourcemap: !production,
    },
    plugins: plugins(false),
  },
]
