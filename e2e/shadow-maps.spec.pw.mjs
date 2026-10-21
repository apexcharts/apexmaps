/**
 * Shadow DOM audit (plans/34, rows M1 and M2): mounts the same map three ways
 * and runs each user-visible check in every mode.
 *
 *   light  : container in the light DOM, theme variables on a wrapper div
 *   shadow : container inside an open shadow root, variables on the host
 *   nested : container two open shadow roots deep, variables on the OUTER host
 *
 * Standalone (no @playwright/test in this repo, and `.spec.pw.mjs` keeps it out
 * of Vitest's default include). Uses the built IIFE bundle in dist/.
 *
 *   node e2e/shadow-maps.spec.pw.mjs
 *
 * PLAYWRIGHT_DIR overrides where the `playwright` package is loaded from
 * (default: the sibling apexcharts-js checkout).
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const pwDir =
  process.env.PLAYWRIGHT_DIR || path.resolve(here, '../../apexcharts-js/node_modules/playwright')
const { chromium } = createRequire(import.meta.url)(pwDir)
const BUNDLE = path.resolve(here, '../dist/apexmaps.min.js')

// light: theme vars on a wrapper div. shadow: vars on the host. nested: two
// open roots, vars on the OUTER host only.
const MODES = ['light', 'shadow', 'nested']
// Rows known to fail, each with the reason; empty means every row must pass.
const KNOWN_FAILING = new Set([])
const THEME = {
  '--apexmaps-surface': 'rgb(1, 2, 3)',
  '--apx-accent': 'rgb(10, 20, 30)',
}

// Four squares near the equator, wound clockwise as d3-geo expects.
const square = (name, x, y) => ({
  type: 'Feature',
  properties: { name },
  geometry: {
    type: 'Polygon',
    coordinates: [[[x, y], [x, y + 20], [x + 20, y + 20], [x + 20, y], [x, y]]],
  },
})
const GEO = {
  type: 'FeatureCollection',
  features: [square('A', -40, 0), square('B', -10, 0), square('C', 20, 0), square('D', -10, -30)],
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<script>
customElements.define('x-host', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }) }
})
window.mountIn = function (mode, theme) {
  const box = document.createElement('div')
  box.id = 'map'
  box.style.cssText = 'width:600px;height:400px'
  if (mode === 'light') {
    const wrap = document.createElement('div')
    for (const k in theme) wrap.style.setProperty(k, theme[k])
    wrap.appendChild(box)
    document.body.appendChild(wrap)
  } else if (mode.startsWith('shadow')) {
    const host = document.createElement('x-host')
    for (const k in theme) host.style.setProperty(k, theme[k])
    document.body.appendChild(host)
    host.shadowRoot.appendChild(box)
  } else {
    const outer = document.createElement('x-host')
    for (const k in theme) outer.style.setProperty(k, theme[k])
    document.body.appendChild(outer)
    const inner = document.createElement('x-host')
    outer.shadowRoot.appendChild(inner)
    inner.shadowRoot.appendChild(box)
  }
  window.box = box
  return box
}
</script></body></html>`

const OPTIONS = {
  chart: { animations: { enabled: false } },
  geo: { map: GEO, projection: 'mercator' },
  series: [
    {
      name: 'Index',
      joinBy: 'name',
      data: [
        { name: 'A', value: 10 },
        { name: 'B', value: 20 },
        { name: 'C', value: 30 },
        { name: 'D', value: 40 },
      ],
    },
  ],
  legend: { interactive: true },
  interaction: {
    zoom: { enabled: true, wheel: true },
    pan: { enabled: true, inertia: false },
    selection: { enabled: true, multiple: true, rectangle: true, modifier: 'shift' },
  },
  annotations: { areas: [{ bounds: [-60, 30, -45, 40] }] },
}

async function setup(browser, mode) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setContent(PAGE)
  await page.addScriptTag({ path: BUNDLE })
  await page.evaluate(
    async ({ mode, theme, options }) => {
      const box = window.mountIn(mode, theme)
      window.events = []
      const map = new window.ApexMaps(box, options)
      for (const ev of ['featureHover', 'featureClick', 'featureFocus', 'selectionChange',
        'legendToggle', 'zoom', 'panEnd']) {
        map.on(ev, (p) => window.events.push({ ev, key: p && p.key, ids: p && p.ids }))
      }
      window.map = map
      await map.render()
    },
    { mode, theme: THEME, options: OPTIONS },
  )
  return { page, errors }
}

// In-page helpers, all reached through window.box so they work in any root.
const centreOf = (page, sel, idx = 0) =>
  page.evaluate(
    ({ sel, idx }) => {
      const el = window.box.querySelectorAll(sel)[idx]
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    },
    { sel, idx },
  )
const eventsOf = (page, ev) => page.evaluate((ev) => window.events.filter((e) => e.ev === ev), ev)
const clearEvents = (page) => page.evaluate(() => (window.events.length = 0))
const viewTransform = (page) =>
  page.evaluate(() => {
    const f = window.box.querySelector('.apexmaps-feature')
    return f ? f.getScreenCTM().toString() + ':' + JSON.stringify(f.getBoundingClientRect()) : ''
  })

const CHECKS = {
  // Product stylesheet applies (class 1): the root is a flex column per ApexMaps.css.
  async stylesheet(page) {
    const r = await page.evaluate(() => {
      const root = window.box.getRootNode()
      return {
        display: getComputedStyle(window.box).display,
        inRoot: !!root.getElementById('apexmaps-styles'),
        // A map in a shadow root must not also leave a sheet in the page head.
        inHead: root !== document && !!document.getElementById('apexmaps-styles'),
      }
    })
    const ok = r.display === 'flex' && r.inRoot && !r.inHead
    return { ok, ev: `display=${r.display} inRoot=${r.inRoot} inHead=${r.inHead}` }
  },
  async render(page) {
    const n = await page.evaluate(() => window.box.querySelectorAll('.apexmaps-feature').length)
    return { ok: n === 4, ev: `features=${n}` }
  },
  async hoverTooltip(page) {
    const c = await centreOf(page, '.apexmaps-feature', 1)
    await page.mouse.move(c.x, c.y)
    await page.mouse.move(c.x + 2, c.y + 2)
    await page.waitForTimeout(100)
    const t = await page.evaluate(() => {
      const el = window.box.querySelector('.apexmaps-tooltip')
      if (!el) return null
      const cs = getComputedStyle(el)
      return { shown: el.style.display === 'block', pos: cs.position, text: el.textContent.trim() }
    })
    const hov = await eventsOf(page, 'featureHover')
    const ok = !!t && t.shown && t.pos === 'absolute' && hov.length > 0
    return { ok, ev: `tooltip=${JSON.stringify(t)} hoverEvents=${hov.length}` }
  },
  async clickSelect(page) {
    await clearEvents(page)
    const c = await centreOf(page, '.apexmaps-feature', 2)
    await page.mouse.click(c.x, c.y)
    await page.waitForTimeout(50)
    const sel = await eventsOf(page, 'selectionChange')
    const clicks = await eventsOf(page, 'featureClick')
    return { ok: sel.length > 0 && clicks.length > 0, ev: `featureClick=${clicks.length} sel=${JSON.stringify(sel.map((s) => s.ids))}` }
  },
  async rectSelect(page) {
    await page.evaluate(() => window.map.clearSelection())
    await clearEvents(page)
    const a = await centreOf(page, '.apexmaps-feature', 0)
    const b = await centreOf(page, '.apexmaps-feature', 2)
    await page.keyboard.down('Shift')
    await page.mouse.move(a.x - 40, a.y - 40)
    await page.mouse.down()
    await page.mouse.move(b.x, b.y, { steps: 6 })
    await page.mouse.move(b.x + 40, b.y + 40, { steps: 6 })
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await page.waitForTimeout(50)
    const sel = await eventsOf(page, 'selectionChange')
    const last = sel.at(-1)
    const ok = !!last && Array.isArray(last.ids) && last.ids.length >= 3
    return { ok, ev: `selection=${JSON.stringify(last && last.ids)}` }
  },
  async legendToggle(page) {
    await clearEvents(page)
    const c = await centreOf(page, 'button.apexmaps-legend-item', 0)
    if (!c) return { ok: false, ev: 'no interactive legend item' }
    await page.mouse.click(c.x, c.y)
    await page.waitForTimeout(50)
    const muted = await page.evaluate(() =>
      window.box.querySelector('button.apexmaps-legend-item').classList.contains('is-muted'),
    )
    const t = await eventsOf(page, 'legendToggle')
    await page.mouse.click(c.x, c.y)
    return { ok: muted && t.length > 0, ev: `muted=${muted} legendToggle=${t.length}` }
  },
  async keyboard(page) {
    await clearEvents(page)
    await page.evaluate(() => window.box.querySelector('.apexmaps-svg').focus())
    const focusedInside = await page.evaluate(() => {
      let a = document.activeElement
      while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement
      return a && a.classList && a.classList.contains('apexmaps-svg')
    })
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(50)
    const f = await eventsOf(page, 'featureFocus')
    const live = await page.evaluate(
      () => (window.box.querySelector('.apexmaps-sr-only[role=status]') || {}).textContent || '',
    )
    return {
      ok: focusedInside && f.length > 0 && live.length > 0,
      ev: `focused=${focusedInside} featureFocus=${f.length} live="${live.slice(0, 30)}"`,
    }
  },
  // The focus ring colour comes from --apexmaps-focus <- --apx-accent set on the host.
  async focusRingVar(page) {
    await page.evaluate(() => window.box.querySelector('.apexmaps-svg').blur())
    await page.keyboard.press('Tab') // ensure keyboard modality for :focus-visible
    await page.evaluate(() => window.box.querySelector('.apexmaps-svg').focus())
    const v = await page.evaluate(() => {
      const s = getComputedStyle(window.box.querySelector('.apexmaps-svg'))
      return { color: s.outlineColor, style: s.outlineStyle }
    })
    return { ok: v.color === THEME['--apx-accent'], ev: `outline=${v.style} ${v.color}` }
  },
  // --apx-* family token on the host reaches the tooltip-independent annotation fill (inline var()).
  async apxTokenAnnotation(page) {
    const fill = await page.evaluate(() => {
      const el = window.box.querySelector('.apexmaps-annotation-area')
      return el ? getComputedStyle(el).fill : null
    })
    return { ok: fill === THEME['--apx-accent'], ev: `annotation fill=${fill}` }
  },
  // --apexmaps-* set above the container, as the README Theming section says works.
  async apexmapsVarAbove(page) {
    const bg = await page.evaluate(() => {
      const el = window.box.querySelector('.apexmaps-tooltip')
      return el ? getComputedStyle(el).backgroundColor : null
    })
    return { ok: bg === THEME['--apexmaps-surface'], ev: `tooltip bg=${bg} (want ${THEME['--apexmaps-surface']})` }
  },
  // --apexmaps-* set inline on the container element itself.
  async apexmapsVarOnContainer(page) {
    const bg = await page.evaluate(() => {
      window.box.style.setProperty('--apexmaps-surface', 'rgb(4, 5, 6)')
      const el = window.box.querySelector('.apexmaps-tooltip')
      const v = el ? getComputedStyle(el).backgroundColor : null
      window.box.style.removeProperty('--apexmaps-surface')
      return v
    })
    return { ok: bg === 'rgb(4, 5, 6)', ev: `tooltip bg=${bg}` }
  },
  async exportSvg(page) {
    const r = await page.evaluate(() => {
      const s = window.map.getSvgString()
      return { len: s.length, accent: s.includes('rgb(10, 20, 30)') || s.includes('#0a141e'), features: (s.match(/apexmaps-feature"/g) || []).length }
    })
    return { ok: r.len > 500 && r.accent, ev: `len=${r.len} hostAccentBaked=${r.accent}` }
  },
  async panDrag(page) {
    await clearEvents(page)
    const c = await centreOf(page, '.apexmaps-svg')
    const before = await viewTransform(page)
    await page.mouse.move(c.x, c.y + 120)
    await page.mouse.down()
    await page.mouse.move(c.x + 40, c.y + 120, { steps: 4 })
    await page.mouse.move(c.x + 90, c.y + 140, { steps: 4 })
    await page.mouse.up()
    await page.waitForTimeout(50)
    const after = await viewTransform(page)
    // Released: further motion must not keep panning.
    await page.mouse.move(c.x + 200, c.y + 160, { steps: 4 })
    await page.waitForTimeout(50)
    const later = await viewTransform(page)
    const pans = await eventsOf(page, 'panEnd')
    const ok = before !== after && after === later && pans.length > 0
    return { ok, ev: `moved=${before !== after} stuckAfterUp=${after !== later} panEnd=${pans.length}` }
  },
  async wheelZoom(page) {
    const c = await centreOf(page, '.apexmaps-svg')
    const k0 = await page.evaluate(() => window.map.zoom)
    await page.mouse.move(c.x, c.y)
    await page.mouse.wheel(0, -300)
    await page.waitForTimeout(400)
    const k1 = await page.evaluate(() => window.map.zoom)
    return { ok: k1 > k0, ev: `zoom ${k0} -> ${k1}` }
  },
  async zoomButton(page) {
    const k0 = await page.evaluate(() => window.map.zoom)
    const c = await centreOf(page, '.apexmaps-zoom-button', 0)
    if (!c) return { ok: false, ev: 'no zoom button' }
    await page.mouse.click(c.x, c.y)
    await page.waitForTimeout(500)
    const k1 = await page.evaluate(() => window.map.zoom)
    return { ok: k1 > k0, ev: `zoom ${k0} -> ${k1}` }
  },
  async destroy(page, errors) {
    const c = await centreOf(page, '.apexmaps-svg')
    // Start a drag, destroy mid-drag, keep moving: window listeners must be gone.
    await page.mouse.move(c.x, c.y + 120)
    await page.mouse.down()
    await page.mouse.move(c.x + 20, c.y + 120, { steps: 2 })
    await page.evaluate(() => window.map.destroy())
    await page.mouse.move(c.x + 80, c.y + 140, { steps: 4 })
    await page.mouse.up()
    const left = await page.evaluate(() => window.box.childElementCount)
    // The last map in its root takes the stylesheet with it.
    const sheet = await page.evaluate(() => !!window.box.getRootNode().getElementById('apexmaps-styles'))
    return {
      ok: left === 0 && !sheet && errors.length === 0,
      ev: `children=${left} sheet=${sheet} errors=${errors.length}`,
    }
  },
}

const browser = await chromium.launch()
const results = {}
try {
  for (const mode of MODES) {
    const { page, errors } = await setup(browser, mode)
    for (const [name, fn] of Object.entries(CHECKS)) {
      let r
      try {
        r = await fn(page, errors)
      } catch (e) {
        r = { ok: false, ev: 'threw: ' + String(e).split('\n')[0] }
      }
      ;(results[name] ||= {})[mode] = r
    }
    if (errors.length) results.pageErrors = { ...(results.pageErrors || {}), [mode]: errors }
    await page.close()
  }
} finally {
  await browser.close()
}

let bad = 0
for (const [name, byMode] of Object.entries(results)) {
  if (name === 'pageErrors') continue
  const cell = (m) => (byMode[m]?.ok ? 'PASS' : 'FAIL')
  const verdict =
    !byMode.light.ok ? 'fails-everywhere'
      : !byMode.shadow.ok ? 'shadow-bug'
        : !byMode.nested.ok ? 'nested-only-bug'
          : 'passes'
  const known = KNOWN_FAILING.has(name)
  const note = known ? (verdict === 'passes' ? ' UNEXPECTED PASS: remove from KNOWN_FAILING' : ' (known)') : ''
  if (known ? verdict === 'passes' : verdict !== 'passes') bad++
  console.log(`${name.padEnd(22)} ${MODES.map((m) => `${m}=${cell(m)}`).join(' ')} ${verdict}${note}`)
  for (const m of MODES) console.log(`    ${m}: ${byMode[m]?.ev}`)
}
if (results.pageErrors) console.log('pageErrors', JSON.stringify(results.pageErrors))
process.exitCode = bad ? 1 : 0
