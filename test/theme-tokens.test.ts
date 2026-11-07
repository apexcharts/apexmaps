// @vitest-environment jsdom
/**
 * The colours the engine paints from JS, through their token chain: the page's
 * option, then the map's own `--apexmaps-*` token, then the `--apx-*` family
 * token, then the built-in default for the mode. Also the unset mode default,
 * `theme.tokens: false`, the family font and `'auto'` following the OS live.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { registerTheme, unregisterTheme } from 'apex-commons'

import ApexMaps from '../src/ApexMaps'
import { getPalette } from '../src/scales/Palettes'
import type { ChoroplethSeries } from '../src/series/Choropleth'

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

let el: HTMLDivElement
let map: ApexMaps | null

beforeEach(() => {
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

const featurePath = (key: string) =>
  el.querySelector<SVGPathElement>(`.apexmaps-features path[data-key="${key}"]`) ??
  [...el.querySelectorAll<SVGPathElement>('path')].find((p) => p.getAttribute('data-key') === key)!
const nullColor = () => (map!.series[0] as ChoroplethSeries).scale.nullColor
const markFills = () =>
  [...el.querySelectorAll('.apexmaps-mark-shape')].map((p) => p.getAttribute('fill'))

describe('theme.mode default', () => {
  it('is unset, and renders light', async () => {
    await render()
    expect(map!.toSpec().theme?.mode).toBeUndefined()
    expect(el.classList.contains('apexmaps--dark')).toBe(false)
    expect(nullColor()).toBe('#eeeeee')
  })
})

describe('the map tokens', () => {
  it('--apexmaps-no-data fills no-data, below a scale nullColor', async () => {
    el.style.setProperty('--apexmaps-no-data', '#123456')
    await render()
    expect(nullColor()).toBe('#123456')
    expect(featurePath('CCC').getAttribute('fill')).toBe('#123456')

    map!.destroy()
    await render({ series: [{ ...CHOROPLETH, scale: { nullColor: '#eeeeee' } }] })
    expect(nullColor()).toBe('#eeeeee')
  })

  it('--apexmaps-basemap fills the basemap, below geo.fill', async () => {
    el.style.setProperty('--apexmaps-basemap', 'rgb(1, 2, 3)')
    await render({ series: [] })
    expect(featurePath('AAA').getAttribute('fill')).toBe('rgb(1, 2, 3)')

    map!.destroy()
    await render({
      series: [],
      geo: { map: BOXES, projection: 'equirectangular', fill: '#dfe4ea' },
    })
    expect(featurePath('AAA').getAttribute('fill')).toBe('#dfe4ea')
  })

  it('--apexmaps-outline replaces the default outline, never a stroke the page set', async () => {
    el.style.setProperty('--apexmaps-outline', 'rgb(0, 0, 255)')
    await render()
    expect(featurePath('AAA').getAttribute('stroke')).toBe('rgb(0, 0, 255)')

    map!.destroy()
    // Passing the default value on purpose is a choice too.
    await render({ series: [{ ...CHOROPLETH, stroke: { color: '#ffffff' } }] })
    expect(featurePath('AAA').getAttribute('stroke')).toBe('#ffffff')
  })

  it('--apexmaps-selected rings a selection, below states.active.stroke', async () => {
    el.style.setProperty('--apexmaps-selected', 'rgb(255, 0, 255)')
    await render()
    map!.setSelection(['AAA'])
    expect(featurePath('AAA').getAttribute('stroke')).toBe('rgb(255, 0, 255)')

    map!.destroy()
    await render({ states: { active: { stroke: '#111111' } } })
    map!.setSelection(['AAA'])
    expect(featurePath('AAA').getAttribute('stroke')).toBe('#111111')
  })

  it('leaves every default as it was with no token', async () => {
    await render()
    map!.setSelection(['AAA'])
    expect(featurePath('AAA').getAttribute('stroke')).toBe('#111111')
    expect(featurePath('BBB').getAttribute('stroke')).toBe('#ffffff')
    expect(featurePath('CCC').getAttribute('fill')).toBe('#eeeeee')
  })
})

describe('--apx-series-N', () => {
  it('replaces the default categorical palette whole', async () => {
    el.style.setProperty('--apx-series-1', '#111111')
    el.style.setProperty('--apx-series-2', '#222222')
    await render({ series: [MARKERS] })
    expect(markFills()).toEqual(['#111111', '#222222', '#111111'])
  })

  it('gives a single-colour series row 1, below its own colour', async () => {
    el.style.setProperty('--apx-series-1', '#123456')
    await render({ series: [{ type: 'bubble', name: 'B', data: [{ lon: 0, lat: 4, value: 3 }] }] })
    expect(el.querySelector('.apexmaps-symbol, circle')?.getAttribute('fill')).toBe('#123456')

    map!.destroy()
    await render({
      series: [
        { type: 'bubble', name: 'B', color: '#008FFB', data: [{ lon: 0, lat: 4, value: 3 }] },
      ],
    })
    expect(el.querySelector('.apexmaps-symbol, circle')?.getAttribute('fill')).toBe('#008FFB')
  })

  it('yields to a series palette and to theme.palette', async () => {
    el.style.setProperty('--apx-series-1', '#111111')
    await render({ series: [{ ...MARKERS, palette: 'okabeIto' }] })
    expect(markFills()[0]).toBe('#0072B2')

    map!.destroy()
    await render({ series: [MARKERS], theme: { palette: 'blues' } })
    expect(markFills()[0]).toBe('#008FFB')
  })

  it('is ignored with theme.tokens: false', async () => {
    el.style.setProperty('--apx-series-1', '#111111')
    el.style.setProperty('--apx-font-family', 'Georgia')
    await render({ series: [MARKERS], theme: { tokens: false } })
    expect(markFills()[0]).toBe('#008FFB')
    expect(el.style.fontFamily).toBe('')
    expect(el.classList.contains('apexmaps--untokened')).toBe(true)
  })
})

describe('--apx-font-family', () => {
  it('sets the map font below chart.fontFamily, and only removes its own', async () => {
    el.style.setProperty('--apx-font-family', 'Georgia, serif')
    await render()
    expect(el.style.fontFamily).toBe('Georgia, serif')

    el.style.removeProperty('--apx-font-family')
    await map!.updateOptions({})
    expect(el.style.fontFamily).toBe('')

    el.style.setProperty('--apx-font-family', 'Georgia, serif')
    await map!.updateOptions({ chart: { fontFamily: 'inherit' } })
    expect(el.style.fontFamily).toBe('')
    await map!.updateOptions({ chart: { fontFamily: 'Verdana' } })
    expect(el.style.fontFamily).toBe('Verdana')
  })

  it('takes its font off the container on destroy', async () => {
    el.style.setProperty('--apx-font-family', 'Georgia, serif')
    await render()
    map!.destroy()
    map = null
    expect(el.style.fontFamily).toBe('')
  })
})

describe('palettes on the family registry', () => {
  afterEach(() => unregisterTheme('acme-brand'))

  it('reads a family theme with series as a categorical palette', async () => {
    registerTheme('acme-brand', { tokens: { series: ['#0a0a0a', '#0b0b0b'] } })
    expect(getPalette('acme-brand')).toMatchObject({
      kind: 'categorical',
      stops: ['#0a0a0a', '#0b0b0b'],
    })
    await render({ series: [{ ...MARKERS, palette: 'acme-brand' }] })
    expect(markFills()).toEqual(['#0a0a0a', '#0b0b0b', '#0a0a0a'])
    expect(map!.warnings.join()).not.toContain('unknown palette')
  })

  it('keeps the maps palettes first', () => {
    registerTheme('acme-brand', { tokens: { series: ['#0a0a0a'] } })
    expect(getPalette('blues')?.kind).toBe('sequential')
    expect(getPalette('nope-not-a-palette')).toBeUndefined()
  })
})

describe("theme.mode: 'auto'", () => {
  it('follows the OS scheme when it switches', async () => {
    const listeners = new Set<() => void>()
    const query = { matches: false }
    vi.stubGlobal('matchMedia', (q: string) => ({
      media: q,
      get matches() {
        return q.includes('dark') ? query.matches : false
      },
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    }))
    await render({ theme: { mode: 'auto' } })
    expect(el.classList.contains('apexmaps--dark')).toBe(false)

    query.matches = true
    for (const fn of listeners) fn()
    await vi.waitFor(() => expect(el.classList.contains('apexmaps--dark')).toBe(true))
    expect(nullColor()).toBe('#374151')

    await map!.updateOptions({ theme: { mode: 'light' } })
    expect(listeners.size).toBe(0)
    expect(el.classList.contains('apexmaps--dark')).toBe(false)
  })
})
