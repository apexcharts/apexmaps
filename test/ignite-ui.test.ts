// @vitest-environment jsdom
/**
 * The `apexmaps/ignite-ui` add-on and the design-system layer it switches on.
 *
 * Without the add-on an Ignite UI theme on the page changes nothing. With it
 * the theme ranks fifth (below the page's options, the map's own tokens, the
 * `--apx-*` family tokens and a named palette), its variant fills an unset
 * mode, and its text, line and surface colours apply only while the map's mode
 * is the variant. jsdom resolves no stylesheet cascade, so the tokens are set
 * on the container itself, as hex: the commons reader resolves those the way a
 * browser resolves the `hsl(from ...)` values the real sheets ship.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'

import ApexMaps from '../src/ApexMaps'
import { MAP_DESIGN_SYSTEM_SLOT } from '../src/core/Theme'
import type { ChoroplethSeries } from '../src/series/Choropleth'

const COMMONS_SLOT = '__apex_design_systems_v1__'
const g = globalThis as Record<string, unknown>

const LIGHT: Record<string, string> = {
  '--ig-theme-variant': 'light',
  '--ig-primary-seed': '#0099ff',
  '--ig-secondary-seed': '#ff6600',
  '--ig-info-seed': '#00bcd4',
  '--ig-success-seed': '#4caf50',
  '--ig-warn-seed': '#fbb13c',
  '--ig-error-seed': '#ff134a',
  '--ig-gray-100': '#f5f5f5',
  '--ig-gray-200': '#e9e9e9',
  '--ig-gray-300': '#cccccc',
  '--ig-gray-600': '#666666',
  '--ig-gray-800': '#333333',
  '--ig-surface-500': '#fafafa',
  '--ig-font-family': "'Titillium Web', sans-serif",
}

const DARK: Record<string, string> = {
  ...LIGHT,
  '--ig-theme-variant': 'dark',
  '--ig-gray-100': '#2a2a2a',
  '--ig-gray-200': '#303030',
  '--ig-gray-300': '#444444',
  '--ig-gray-600': '#aaaaaa',
  '--ig-gray-800': '#e0e0e0',
  '--ig-surface-500': '#1a1a1a',
}

const BOXES = {
  type: 'FeatureCollection',
  features: [box('AAA', -30), box('BBB', -10), box('CCC', 10)],
}

function box(key: string, lon: number) {
  return {
    type: 'Feature',
    properties: { iso_a3: key, name: key },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [lon, 0],
          [lon + 8, 0],
          [lon + 8, 8],
          [lon, 8],
          [lon, 0],
        ],
      ],
    },
  }
}

const CHOROPLETH = {
  name: 'Score',
  joinBy: ['iso_a3', 'code'],
  data: [
    { code: 'AAA', value: 10 },
    { code: 'BBB', value: 100 },
  ],
}

const MARKERS = {
  type: 'marker',
  name: 'Sites',
  colorBy: 'kind',
  data: [
    { lon: -26, lat: 4, kind: 'a' },
    { lon: -6, lat: 4, kind: 'b' },
    { lon: 14, lat: 4, kind: 'c' },
  ],
}

const BUBBLE = { type: 'bubble', name: 'B', data: [{ lon: 0, lat: 4, value: 3 }] }

let el: HTMLDivElement
let map: ApexMaps | null
let slots: [unknown, unknown]

beforeAll(async () => {
  await import('../src/ignite-ui')
  slots = [g[COMMONS_SLOT], g[MAP_DESIGN_SYSTEM_SLOT]]
})

afterAll(withoutAddon)

/** As if the add-on had never been imported. */
function withoutAddon() {
  delete g[COMMONS_SLOT]
  delete g[MAP_DESIGN_SYSTEM_SLOT]
}

beforeEach(() => {
  ;[g[COMMONS_SLOT], g[MAP_DESIGN_SYSTEM_SLOT]] = slots
  el = document.createElement('div')
  document.body.appendChild(el)
  vi.stubGlobal('requestAnimationFrame', ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame)
  vi.stubGlobal('cancelAnimationFrame', ((id: number) =>
    clearTimeout(id)) as unknown as typeof cancelAnimationFrame)
})

afterEach(() => {
  map?.destroy?.()
  map = null
  el.remove()
  vi.unstubAllGlobals()
})

function sheet(tokens: Record<string, string>) {
  for (const [k, v] of Object.entries(tokens)) el.style.setProperty(k, v)
}

async function render(options: Record<string, unknown> = {}) {
  map = new ApexMaps(el, {
    chart: { width: 400, height: 300, animations: { enabled: false } },
    geo: { map: BOXES, projection: 'equirectangular' },
    debug: { enabled: false },
    series: [CHOROPLETH],
    ...options,
  } as never)
  await map.render()
  return map
}

const path = (key: string) =>
  [...el.querySelectorAll<SVGPathElement>('path')].find((p) => p.getAttribute('data-key') === key)!
const nullColor = () => (map!.series[0] as ChoroplethSeries).scale.nullColor
const markFills = () =>
  [...el.querySelectorAll('.apexmaps-mark-shape')].map((p) => p.getAttribute('fill'))
const bubbleFill = () => el.querySelector('.apexmaps-bubble, circle')?.getAttribute('fill')
const dsVar = (name: string) => el.style.getPropertyValue(`--_apexmaps-ds-${name}`)
const dark = () => el.classList.contains('apexmaps--dark')
const dsChrome = () => el.classList.contains('apexmaps--design-system')

/** Everything a page sees of the theme, for "renders as with no sheet". */
async function look(options: Record<string, unknown> = {}) {
  await render({ series: [CHOROPLETH, MARKERS], ...options })
  map!.setSelection(['AAA'])
  const out = {
    cls: el.className,
    // Declaration order is not a look: compare the set, without the sheet.
    style: (el.getAttribute('style') ?? '')
      .split(';')
      .map((d) => d.trim())
      .filter((d) => d && !d.startsWith('--ig-'))
      .sort(),
    svg: el.querySelector('svg')?.outerHTML,
    legend: el.querySelector('.apexmaps-legend')?.outerHTML,
  }
  map!.destroy()
  map = null
  return out
}

describe('the add-on', () => {
  it('registers the shared Ignite UI adapter and the maps greys', () => {
    expect((g[COMMONS_SLOT] as Record<string, unknown>).igniteui).toBeTruthy()
    expect(g[MAP_DESIGN_SYSTEM_SLOT]).toEqual({
      igniteui: { basemap: ['--ig-gray-100'], noData: ['--ig-gray-200'] },
    })
  })

  it('without it an Ignite UI theme changes nothing', async () => {
    withoutAddon()
    const plain = await look()
    sheet(DARK)
    const themed = await look()
    expect(themed).toEqual(plain)
    expect(dsVar('fg')).toBe('')
  })

  it('a map rendered before the import follows the theme on its next update', async () => {
    withoutAddon()
    sheet(LIGHT)
    await render({ series: [MARKERS] })
    expect(markFills()[0]).toBe('#008FFB')
    ;[g[COMMONS_SLOT], g[MAP_DESIGN_SYSTEM_SLOT]] = slots
    await map!.updateOptions({})
    expect(markFills()[0]).toBe('#0099ff')
  })
})

describe('a light Ignite UI theme', () => {
  beforeEach(() => sheet(LIGHT))

  it('colours the series from the seeds, row 1 first', async () => {
    await render({ series: [MARKERS] })
    expect(markFills()).toEqual(['#0099ff', '#ff6600', '#00bcd4'])
    map!.destroy()
    await render({ series: [BUBBLE] })
    expect(bubbleFill()).toBe('#0099ff')
  })

  it('writes the chrome steps for the stylesheet, and the font', async () => {
    await render()
    expect(dark()).toBe(false)
    expect(dsVar('fg')).toBe('#333333')
    expect(dsVar('muted')).toBe('#666666')
    expect(dsVar('grid')).toBe('#cccccc')
    expect(dsVar('focus')).toBe('#0099ff')
    expect(dsVar('paper')).toBe('')
    // No 7.5 surface roles in this theme: the tooltip keeps its default.
    expect(dsVar('overlay')).toBe('')
    expect(el.style.fontFamily).toContain('Titillium Web')
  })

  it('paints the basemap, no-data, outlines and selection from the greys and paper', async () => {
    await render()
    map!.setSelection(['AAA'])
    expect(nullColor()).toBe('#e9e9e9')
    expect(path('BBB').getAttribute('stroke')).toBe('#fafafa')
    expect(path('AAA').getAttribute('stroke')).toBe('#333333')
    map!.destroy()
    await render({ series: [] })
    expect(path('AAA').getAttribute('fill')).toBe('#f5f5f5')
    map!.destroy()
    // The paper beside gray-100 would draw no borders: the basemap under a
    // point series takes the lines instead.
    await render({ series: [MARKERS] })
    expect(path('AAA').getAttribute('fill')).toBe('#f5f5f5')
    expect(path('AAA').getAttribute('stroke')).toBe('#cccccc')
    // The markers keep the paper as their halo.
    expect(el.querySelector('.apexmaps-mark-shape')?.getAttribute('stroke')).toBe('#fafafa')
  })

  it('marks the map while the theme paints its chrome', async () => {
    await render()
    expect(dsChrome()).toBe(true)
    map!.destroy()
    expect(dsChrome()).toBe(false)
    await render({ theme: { designSystem: false } })
    expect(dsChrome()).toBe(false)
  })

  it('--apx-grid and --apx-fore rank above the basemap outline and selection it paints', async () => {
    el.style.setProperty('--apx-grid', '#0a0a0a')
    el.style.setProperty('--apx-fore', '#0b0b0b')
    await render()
    map!.setSelection(['AAA'])
    expect(path('AAA').getAttribute('stroke')).toBe('#0b0b0b')
    // Data regions keep the paper.
    expect(path('BBB').getAttribute('stroke')).toBe('#fafafa')
    map!.destroy()
    await render({ series: [MARKERS] })
    expect(path('AAA').getAttribute('stroke')).toBe('#0a0a0a')
    map!.destroy()
    // The map's own outline token and a passed stroke rank above both.
    el.style.setProperty('--apexmaps-outline', '#0c0c0c')
    await render({ series: [MARKERS] })
    expect(path('AAA').getAttribute('stroke')).toBe('#0c0c0c')
    map!.destroy()
    await render({ series: [{ ...MARKERS, stroke: { color: '#0d0d0d' } }] })
    expect(path('AAA').getAttribute('stroke')).toBe('#0d0d0d')
  })

  it('ranks below the options, the map tokens and the family tokens', async () => {
    el.style.setProperty('--apexmaps-no-data', '#010101')
    el.style.setProperty('--apx-font-family', 'Georgia')
    await render({ series: [{ ...CHOROPLETH, stroke: { color: '#ffffff' } }] })
    expect(nullColor()).toBe('#010101')
    expect(path('BBB').getAttribute('stroke')).toBe('#ffffff')
    expect(el.style.fontFamily).toBe('Georgia')
    map!.destroy()

    el.style.setProperty('--apx-series-1', '#111111')
    await render({ series: [MARKERS] })
    // Taken whole: no Ignite UI row fills in after the family list.
    expect(markFills()).toEqual(['#111111', '#111111', '#111111'])
    map!.destroy()

    el.style.removeProperty('--apx-series-1')
    await render({ series: [{ ...MARKERS, palette: 'okabeIto' }] })
    expect(markFills()[0]).toBe('#0072B2')
    map!.destroy()
    await render({ series: [MARKERS], theme: { palette: 'blues' } })
    expect(markFills()[0]).toBe('#008FFB')
  })

  it('--apx-accent alone is row 1, and the theme fills the rest', async () => {
    el.style.setProperty('--apx-accent', '#123456')
    await render({ series: [MARKERS] })
    expect(markFills()).toEqual(['#123456', '#ff6600', '#00bcd4'])
  })

  it('designSystem: false and tokens: false restore the built-in look', async () => {
    withoutAddon()
    el.removeAttribute('style')
    const plain = await look()
    ;[g[COMMONS_SLOT], g[MAP_DESIGN_SYSTEM_SLOT]] = slots
    sheet(DARK)
    expect(await look({ theme: { designSystem: false } })).toEqual(plain)
    const off = await look({ theme: { tokens: false } })
    expect({ ...off, cls: off.cls.replace(' apexmaps--untokened', '') }).toEqual(plain)
  })
})

describe('a dark Ignite UI theme', () => {
  beforeEach(() => sheet(DARK))

  it('turns an unset mode dark, with a transparent paper', async () => {
    await render()
    expect(dark()).toBe(true)
    expect(map!.toSpec().theme?.mode).toBeUndefined()
    expect(dsVar('paper')).toBe('transparent')
    expect(dsVar('fg')).toBe('#e0e0e0')
    expect(dsVar('focus')).toBe('#0099ff')
    expect(nullColor()).toBe('#303030')
    expect(path('BBB').getAttribute('stroke')).toBe('#1a1a1a')
    // The stylesheet then ranks --apx-* above the design system in dark too.
    expect(dsChrome()).toBe(true)
    map!.destroy()
    await render({ series: [MARKERS] })
    expect(path('AAA').getAttribute('fill')).toBe('#2a2a2a')
    expect(path('AAA').getAttribute('stroke')).toBe('#444444')
  })

  it('goes light again when the theme does', async () => {
    await render()
    for (const k of Object.keys(DARK)) el.style.removeProperty(k)
    sheet(LIGHT)
    await map!.updateOptions({})
    expect(dark()).toBe(false)
    expect(dsVar('paper')).toBe('')
    expect(dsVar('fg')).toBe('#333333')
  })

  it('never darkens a map the page made light, and keeps its chrome built in', async () => {
    await render({ theme: { mode: 'light' } })
    expect(dark()).toBe(false)
    expect(dsChrome()).toBe(false)
    expect(dsVar('fg')).toBe('')
    expect(dsVar('grid')).toBe('')
    expect(nullColor()).toBe('#eeeeee')
    // The brand colours do not change with the variant.
    expect(dsVar('focus')).toBe('#0099ff')
    map!.destroy()
    await render({ series: [MARKERS], theme: { mode: 'light' } })
    expect(markFills()[0]).toBe('#0099ff')
  })

  it('a light theme leaves a map the page made dark on its own dark palette', async () => {
    for (const k of Object.keys(DARK)) el.style.removeProperty(k)
    sheet(LIGHT)
    await render({ theme: { mode: 'dark' } })
    expect(dark()).toBe(true)
    // So the dark palette stays self-contained, --apx-* tokens and all.
    expect(dsChrome()).toBe(false)
    expect(dsVar('fg')).toBe('')
    expect(dsVar('focus')).toBe('')
    expect(dsVar('paper')).toBe('')
    expect(nullColor()).toBe('#374151')
  })

  it('takes its custom properties off the container on destroy', async () => {
    await render()
    map!.destroy()
    map = null
    expect(dsVar('fg')).toBe('')
    expect(dsVar('paper')).toBe('')
    expect(el.style.fontFamily).toBe('')
    expect(dsChrome()).toBe(false)
  })
})
