/**
 * The `apexmaps/ignite-ui` add-on in a real browser, against the real Ignite UI
 * 7.4.1 sheets (and 7.5.0-beta.0 material, which adds the surface roles), each
 * in the light DOM and inside an open shadow root. The fixtures in
 * `fixtures/ignite-ui/` are the sheets' `:root` tokens as shipped, relative
 * colour syntax included, so the colours here are resolved by Chromium.
 *
 * Per sheet and root it checks plan 36's acceptance criteria:
 *   - without the add-on the sheet changes nothing
 *   - series 1 is the theme's primary colour; text and lines are the theme's
 *     and readable on its surface; region outlines stand out from the basemap
 *     and the no-data grey (plan 36 OPEN-14, at least 1.1:1, the contrast the
 *     built-in light look gives its no-data borders being 1.16:1)
 *   - a dark sheet turns an unset mode dark, tooltips and controls included,
 *     with the map's own paper transparent
 *   - a passed mode, `--apx-*` tokens (in the chrome too, dark included) and a
 *     named palette beat the theme
 *   - `designSystem: false` and `tokens: false` restore the built-in look
 *   - the font follows the theme
 * and once: the add-on loaded before the core, and a late import.
 *
 * Standalone, like `shadow-maps.spec.pw.mjs`. Uses the built files in dist/.
 *
 *   node e2e/ignite-ui.spec.pw.mjs
 *
 * PLAYWRIGHT_DIR overrides where the `playwright` package is loaded from
 * (default: the sibling apexcharts-js checkout).
 */
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const pwDir =
  process.env.PLAYWRIGHT_DIR || path.resolve(here, '../../apexcharts-js/node_modules/playwright')
const { chromium } = createRequire(import.meta.url)(pwDir)
const BUNDLE = path.resolve(here, '../dist/apexmaps.min.js')
const ADDON = path.resolve(here, '../dist/apexmaps.ignite-ui.min.js')
const FIXTURES = path.resolve(here, 'fixtures/ignite-ui')
const SHEETS = readdirSync(FIXTURES).filter((f) => f.endsWith('.css'))
const ROOTS = ['light', 'shadow']

// Four squares, one without data, and three marker categories.
const square = (iso, x) => ({
  type: 'Feature',
  properties: { iso_a3: iso, name: iso },
  geometry: {
    type: 'Polygon',
    coordinates: [[[x, 0], [x, 20], [x + 20, 20], [x + 20, 0], [x, 0]]],
  },
})
const GEO = {
  type: 'FeatureCollection',
  features: [square('AAA', -60), square('BBB', -30), square('CCC', 0), square('DDD', 30)],
}
const OPTIONS = {
  chart: { animations: { enabled: false }, height: 320 },
  geo: { map: GEO, projection: 'mercator' },
  series: [
    {
      name: 'Score',
      joinBy: ['iso_a3', 'code'],
      data: [
        { code: 'AAA', value: 10 },
        { code: 'BBB', value: 20 },
        { code: 'CCC', value: 30 },
      ],
    },
    {
      type: 'marker',
      name: 'Sites',
      colorBy: 'kind',
      data: [
        { lon: -50, lat: 10, kind: 'a' },
        { lon: -20, lat: 10, kind: 'b' },
        { lon: 10, lat: 10, kind: 'c' },
      ],
    },
  ],
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:var(--ig-surface-500, #fff)">
<script>
customElements.define('x-host', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }) }
})
</script></body></html>`

async function open(browser, { sheet, addon }) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setContent(PAGE)
  if (sheet) await page.addStyleTag({ path: path.join(FIXTURES, sheet) })
  if (addon === 'before') await page.addScriptTag({ path: ADDON })
  await page.addScriptTag({ path: BUNDLE })
  if (addon === 'after') await page.addScriptTag({ path: ADDON })
  return { page, errors }
}

/** Mount, render and read everything the checks need. All in the page. */
function look(page, root, options) {
  return page.evaluate(
    async ({ root, options }) => {
      const box = document.createElement('div')
      box.style.cssText = 'width:600px'
      const holder = root === 'shadow' ? document.createElement('x-host') : document.createElement('div')
      document.body.appendChild(holder)
      ;(root === 'shadow' ? holder.shadowRoot : holder).appendChild(box)
      const map = new window.ApexMaps(box, options)
      window.map = map
      window.box = box
      await map.render()
      map.setSelection(['AAA'])
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

      const rgb = (text) => {
        const s = document.createElement('span')
        s.style.color = text
        box.appendChild(s)
        const c = getComputedStyle(s).color
        s.remove()
        const m = c.match(/^rgba?\(([^)]+)\)$/) || c.match(/^color\(srgb ([^)]+)\)$/)
        if (!m) return null
        const n = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
        const k = c.startsWith('color') ? 255 : 1
        return [n[0] * k, n[1] * k, n[2] * k, n.length > 3 ? n[3] : 1]
      }
      const hex = (c) =>
        c && '#' + c.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')
      const lum = (c) => {
        const f = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
      }
      const contrast = (a, b) => {
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
        return (x + 0.05) / (y + 0.05)
      }
      const cs = getComputedStyle(box)
      // Each region's fill and outline, as painted, with their contrast.
      const regions = [...box.querySelectorAll('path.apexmaps-feature')].map((p) => {
        const fill = rgb(getComputedStyle(p).fill)
        const stroke = rgb(getComputedStyle(p).stroke)
        return {
          key: p.getAttribute('data-key'),
          fill: hex(fill),
          stroke: hex(stroke),
          contrast: fill && stroke ? contrast(fill, stroke) : null,
        }
      })
      const chrome = Object.fromEntries(
        ['fg', 'border', 'focus', 'surface'].map((k) => [k, hex(rgb(cs.getPropertyValue(`--_apexmaps-${k}`)))]),
      )
      const legend = box.querySelector('.apexmaps-legend-label, .apexmaps-legend-title')
      const zoom = box.querySelector('.apexmaps-zoom')
      const paper = rgb(getComputedStyle(document.body).backgroundColor)
      const text = legend ? rgb(getComputedStyle(legend).color) : null
      const marks = [...box.querySelectorAll('.apexmaps-mark-shape')].map((p) => p.getAttribute('fill'))
      const svg = box.querySelector('svg.apexmaps-svg')
      const tidy = (s) => (s || '').replace(/apexmaps-[a-z0-9]{6,}-/g, 'ID-')
      return {
        dark: box.classList.contains('apexmaps--dark'),
        cls: box.className.replace(' apexmaps--untokened', ''),
        regions,
        chrome,
        style: (box.getAttribute('style') || '').split(';').map((d) => d.trim()).filter(Boolean).sort(),
        svg: tidy(svg && svg.outerHTML),
        legend: tidy(box.querySelector('.apexmaps-legend')?.outerHTML),
        marks,
        primary: hex(rgb('var(--ig-primary-seed, var(--ig-primary-500))')),
        gray300: hex(rgb('var(--ig-gray-300)')),
        gray800: hex(rgb('var(--ig-gray-800)')),
        border: hex(rgb(cs.getPropertyValue('--_apexmaps-border'))),
        fg: hex(rgb(cs.getPropertyValue('--_apexmaps-fg'))),
        textContrast: text && paper ? contrast(text, paper) : null,
        bgAlpha: rgb(cs.backgroundColor)?.[3] ?? 0,
        zoomLum: zoom ? lum(rgb(getComputedStyle(zoom).backgroundColor)) : null,
        font: cs.fontFamily,
      }
    },
    { root, options },
  )
}

const results = []
const check = (row, ok, note = '') => results.push({ row, ok: !!ok, note })
/** Outline-to-fill contrast per sheet, printed after the results. */
const outlines = []
/** The faintest outline the checks accept (see the header). */
const MIN_OUTLINE = 1.1
/** Family tokens a page might set, each different from every theme's colour. */
const APX = {
  '--apx-fore': 'rgb(1, 2, 3)',
  '--apx-grid': 'rgb(4, 5, 6)',
  '--apx-accent': 'rgb(7, 8, 9)',
  '--apx-surface': 'rgb(10, 11, 12)',
}
const APX_HEX = { fg: '#010203', border: '#040506', focus: '#070809', surface: '#0a0b0c' }

const browser = await chromium.launch()
try {
  for (const root of ROOTS) {
    // The built-in look, once per root.
    const plainPage = await open(browser, {})
    const plain = await look(plainPage.page, root, OPTIONS)
    await plainPage.page.close()
    const same = (a) =>
      ['cls', 'style', 'svg', 'legend'].every((k) => JSON.stringify(a[k]) === JSON.stringify(plain[k]))

    for (const sheet of SHEETS) {
      const id = `${sheet.replace('.css', '')}/${root}`
      const isDark = sheet.includes('dark')

      const without = await open(browser, { sheet })
      check(`${id}: no add-on, no change`, same(await look(without.page, root, OPTIONS)))
      await without.page.close()

      const { page, errors } = await open(browser, { sheet, addon: 'after' })
      const got = await look(page, root, OPTIONS)
      check(`${id}: series 1 is the primary`, got.marks[0] === got.primary, `${got.marks[0]} vs ${got.primary}`)
      check(`${id}: lines are the theme's gray-300`, got.border === got.gray300, `${got.border} vs ${got.gray300}`)
      check(`${id}: text is gray-800 and readable`, got.fg === got.gray800 && got.textContrast >= 4.5, `${got.fg} ${got.textContrast?.toFixed(2)}:1`)
      check(`${id}: ${isDark ? 'dark, paper transparent, controls dark' : 'stays light'}`,
        isDark ? got.dark && got.bgAlpha === 0 && got.zoomLum < 0.2 : !got.dark && got.zoomLum > 0.6,
        `dark=${got.dark} bgAlpha=${got.bgAlpha} zoomLum=${got.zoomLum?.toFixed(3)}`)
      check(`${id}: font follows the theme`, /Titillium|Open Sans|Nunito|apple-system/i.test(got.font), got.font.slice(0, 40))

      const explicit = await look(page, root, { ...OPTIONS, theme: { mode: isDark ? 'light' : 'dark' } })
      check(`${id}: a passed mode wins`, explicit.dark === !isDark)

      // The basemap under a point map, and the no-data region of a choropleth,
      // each away from the selected AAA.
      const basemap = (await look(page, root, { ...OPTIONS, series: [OPTIONS.series[1]] })).regions.find(
        (r) => r.key === 'BBB',
      )
      const noData = got.regions.find((r) => r.key === 'DDD')
      outlines.push({ id, basemap, noData })
      check(`${id}: basemap outlines stand out`, basemap.contrast >= MIN_OUTLINE,
        `${basemap.stroke} on ${basemap.fill} ${basemap.contrast.toFixed(2)}:1`)
      check(`${id}: no-data outlines stand out`, noData && noData.contrast >= MIN_OUTLINE,
        noData && `${noData.stroke} on ${noData.fill} ${noData.contrast.toFixed(2)}:1`)

      // --apx-* in the chrome beats the theme, in its own mode (dark included).
      await page.evaluate((apx) => {
        for (const [k, v] of Object.entries(apx)) document.documentElement.style.setProperty(k, v)
      }, APX)
      const fam = await look(page, root, OPTIONS)
      for (const role of Object.keys(APX_HEX)) {
        check(`${id}: --apx-* beats the theme for ${role}`, fam.dark === isDark && fam.chrome[role] === APX_HEX[role],
          `dark=${fam.dark} ${fam.chrome[role]}`)
      }
      await page.evaluate((apx) => {
        for (const k of Object.keys(apx)) document.documentElement.style.removeProperty(k)
      }, APX)
      const apx = await look(page, root, OPTIONS)
      // --apx-* on the page beats the theme: set it now and update.
      await page.evaluate(() => {
        document.documentElement.style.setProperty('--apx-series-1', '#123456')
        return window.map.updateOptions({})
      })
      const marks = await page.evaluate(() =>
        [...window.box.querySelectorAll('.apexmaps-mark-shape')].map((p) => p.getAttribute('fill')),
      )
      check(`${id}: --apx-series-1 beats the theme`, apx.marks[0] === got.primary && marks[0] === '#123456')
      await page.evaluate(() => document.documentElement.style.removeProperty('--apx-series-1'))
      const named = await look(page, root, {
        ...OPTIONS,
        series: [OPTIONS.series[0], { ...OPTIONS.series[1], palette: 'okabeIto' }],
      })
      check(`${id}: a named palette beats the theme`, named.marks[0] === '#0072B2')
      for (const off of [{ designSystem: false }, { tokens: false }]) {
        const o = await look(page, root, { ...OPTIONS, theme: off })
        check(`${id}: ${JSON.stringify(off)} is the built-in look`, same(o))
      }
      check(`${id}: no page errors`, !errors.length, errors.join(' | '))
      await page.close()
    }
  }

  // Script order and a late import, once.
  const before = await open(browser, { sheet: 'dark-material.css', addon: 'before' })
  const b = await look(before.page, 'light', OPTIONS)
  check('add-on loaded before the core', b.dark && b.marks[0] === b.primary)
  await before.page.close()

  const late = await open(browser, { sheet: 'dark-material.css' })
  const l0 = await look(late.page, 'light', OPTIONS)
  await late.page.addScriptTag({ path: ADDON })
  await late.page.evaluate(() => window.map.updateOptions({}))
  const l1 = await late.page.evaluate(() => ({
    dark: document.querySelector('.apexmaps').classList.contains('apexmaps--dark'),
  }))
  check('a late import is picked up by updateOptions', !l0.dark && l1.dark)
  await late.page.close()
} finally {
  await browser.close()
}

let failed = 0
for (const { row, ok, note } of results) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${row}${note && !ok ? `  (${note})` : ''}`)
}
console.log('\nOutline contrast (outline on fill):')
for (const { id, basemap, noData } of outlines) {
  const f = (r) => (r ? `${r.stroke} on ${r.fill} ${r.contrast.toFixed(2)}:1` : 'n/a')
  console.log(`  ${id.padEnd(26)} basemap ${f(basemap)}   no-data ${f(noData)}`)
}
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
