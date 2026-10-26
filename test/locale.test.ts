// @vitest-environment jsdom
/**
 * `locale`: the map's own text, for a page that is not in English.
 *
 * Reported against 1.1.1 (#4): on a Japanese dashboard every string the host
 * could set was Japanese, and the zoom buttons still announced and showed
 * "Zoom in". The same was true of every other string the map writes itself,
 * so these pin each one, its default, and that a translation reaches it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import ApexMaps from '../src/ApexMaps'
import { DEFAULT_LOCALE, fillTemplate, resolveLocale } from '../src/core/Locale'
import type { ApexMapsOptions } from '../src/types'

function box(key: string, name: string, lon: number) {
  return {
    type: 'Feature',
    properties: { iso_a3: key, name },
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

const GEO = {
  type: 'FeatureCollection',
  features: [box('AAA', 'Alpha', -20), box('BBB', 'Beta', 0)],
}

const JA = {
  zoomControls: { group: 'ズーム', zoomIn: '拡大', zoomOut: '縮小', reset: '表示をリセット' },
  dataTable: { caption: '地図データ', area: '地域', item: '項目', value: '値' },
  noData: 'データなし',
}

let el: HTMLElement
let map: any

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

async function build(options: ApexMapsOptions = {}) {
  map = new ApexMaps(el, {
    chart: { width: 400, height: 300, animations: { enabled: false } },
    geo: { map: GEO as never, projection: 'equirectangular' },
    debug: { enabled: false },
    a11y: { dataTable: true },
    series: [{ joinBy: ['iso_a3', 'code'], data: [{ code: 'AAA', value: 3 }] }],
    ...options,
  })
  await map.render()
  return map
}

const zoomLabels = () => {
  const group = el.querySelector('.apexmaps-zoom')!
  return [
    group.getAttribute('aria-label'),
    ...[...el.querySelectorAll('.apexmaps-zoom-button')].flatMap((b) => [
      b.getAttribute('aria-label'),
      b.getAttribute('title'),
    ]),
  ]
}

const tableText = () => {
  const table = el.querySelector('table')!
  return {
    caption: table.querySelector('caption')?.textContent,
    headers: [...table.querySelectorAll('thead th')].map((th) => th.textContent),
    cells: [...table.querySelectorAll('tbody td')].map((td) => td.textContent),
  }
}

describe('resolveLocale', () => {
  it('is the English defaults when nothing is set', () => {
    expect(resolveLocale(undefined)).toEqual(DEFAULT_LOCALE)
  })

  it('merges a group key by key, so one translation keeps its siblings', () => {
    const text = resolveLocale({ zoomControls: { zoomIn: '拡大' } })
    expect(text.zoomControls).toEqual({ ...DEFAULT_LOCALE.zoomControls, zoomIn: '拡大' })
    expect(text.breadcrumb).toEqual(DEFAULT_LOCALE.breadcrumb)
  })

  it('ignores keys it does not know and values of the wrong type', () => {
    const text = resolveLocale({
      noData: 4 as never,
      zoomControls: { zoomIn: null as never, nonsense: 'x' } as never,
      unknown: 'x',
    } as never)
    expect(text).toEqual(DEFAULT_LOCALE)
  })

  it('fills placeholders, and leaves one with no value as written', () => {
    expect(fillTemplate('{count} {level} in {where}', { count: 3, level: 'states' })).toBe(
      '3 states in {where}',
    )
  })
})

describe('zoom controls', () => {
  it('are in English by default', async () => {
    await build()
    expect(zoomLabels()).toEqual([
      'Zoom',
      'Zoom in',
      'Zoom in',
      'Zoom out',
      'Zoom out',
      'Reset view',
      'Reset view',
    ])
  })

  it('take their names and tooltips from locale.zoomControls', async () => {
    await build({ locale: JA })
    expect(zoomLabels()).toEqual([
      'ズーム',
      '拡大',
      '拡大',
      '縮小',
      '縮小',
      '表示をリセット',
      '表示をリセット',
    ])
  })

  it('are retitled in place by updateOptions', async () => {
    await build()
    const first = el.querySelector('.apexmaps-zoom-button')
    await map.updateOptions({ locale: { zoomControls: { zoomIn: '拡大' } } })
    const after = el.querySelector('.apexmaps-zoom-button')!
    expect(after).toBe(first)
    expect(after.getAttribute('aria-label')).toBe('拡大')
    expect(after.getAttribute('title')).toBe('拡大')
  })
})

describe('the data table', () => {
  it('uses the English headings when the series has no name', async () => {
    await build()
    const { caption, headers, cells } = tableText()
    expect(caption).toBe('Map data')
    expect(headers).toEqual(['Area', 'Value'])
    expect(cells).toContain('No data')
  })

  it('takes its caption, headings and no-data text from the locale', async () => {
    await build({ locale: JA })
    const { caption, headers, cells } = tableText()
    expect(caption).toBe('地図データ')
    expect(headers).toEqual(['地域', '値'])
    expect(cells).toContain('データなし')
  })

  it('heads a point table with the item column', async () => {
    await build({
      locale: JA,
      series: [{ type: 'bubble', data: [{ lon: 2, lat: 4, name: 'Here', value: null }] }],
    })
    const { headers, cells } = tableText()
    expect(headers).toEqual(['項目', '値'])
    expect(cells).toEqual(['データなし'])
  })
})

describe('no data', () => {
  it('labels the legend entry, unless the series scale names its own', async () => {
    await build({ locale: JA })
    expect(el.querySelector('.apexmaps-legend')!.textContent).toContain('データなし')

    map.destroy()
    await build({
      locale: JA,
      series: [
        {
          joinBy: ['iso_a3', 'code'],
          data: [{ code: 'AAA', value: 3 }],
          scale: { nullLabel: '未集計' },
        },
      ],
    })
    expect(el.querySelector('.apexmaps-legend')!.textContent).toContain('未集計')
  })

  it('is what the keyboard announces for an empty region', async () => {
    await build()
    const beta = map.geo.features.find((f: { key: string }) => f.key === 'BBB')
    expect(map._describeFeature(beta)).toBe('Beta, no data')

    map.destroy()
    await build({ locale: JA })
    expect(map._describeFeature(beta)).toBe('Beta, データなし')
  })
})

describe('the size legend', () => {
  it('fills {sizes} into locale.sizeLegend', async () => {
    const bubbles = {
      series: [
        {
          type: 'bubble' as const,
          name: 'Sites',
          data: [
            { lon: 2, lat: 4, value: 10 },
            { lon: -12, lat: 4, value: 1000 },
          ],
        },
      ],
    }
    await build(bubbles)
    const name = () => el.querySelector('.apexmaps-legend-sizes')!.getAttribute('aria-label')!
    expect(name()).toMatch(/^Circle sizes: /)

    map.destroy()
    await build({ ...bubbles, locale: { sizeLegend: '円の大きさ：{sizes}' } })
    expect(name()).toMatch(/^円の大きさ：\d/)
  })
})
