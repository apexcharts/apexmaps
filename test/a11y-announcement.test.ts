// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import ApexMaps from '../src/ApexMaps'

/**
 * What the keyboard says about a feature.
 *
 * Arrowing through a choropleth used to announce a value of its own making (a
 * bare `toFixed(2)` with a hyphen-minus) while the tooltip beside it showed the
 * page's own formatting, so a screen-reader user and a sighted reader were told
 * two different numbers about the same prefecture. These pin the announcement
 * to the tooltip's name and the page's `tooltip.valueFormatter`, the spoken
 * form it keeps without one, and the hook that lets a page write it.
 */

/** Three boxes in one row, so keyboard reading order is left to right. */
const ROW = {
  type: 'FeatureCollection',
  features: [box('JP-01', 'Hokkaidō', -30), box('JP-26', 'Kyōto', -10), box('JP-13', 'Tokyo', 10)],
}

function box(key: string, name: string, lon: number) {
  return {
    type: 'Feature',
    properties: { iso: key, name },
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

const MINUS = '−'
const signed = (v: number) => `${v < 0 ? MINUS : '+'}${Math.abs(v).toFixed(1)}%`

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

async function render(options: Record<string, unknown> = {}) {
  map = new ApexMaps(el, {
    chart: { width: 400, height: 300, type: 'choropleth' },
    geo: { map: ROW, projection: 'equirectangular', keyField: 'iso' },
    debug: { enabled: false },
    series: [
      {
        name: 'Change',
        joinBy: ['iso', 'code'],
        data: [
          { code: 'JP-01', value: -4.5678, rank: 47 },
          { code: 'JP-26', value: 1.25, rank: 12 },
        ],
      },
    ],
    ...options,
  })
  await map.render()
  return map
}

const svg = () => el.querySelector('svg') as SVGSVGElement
const live = () => el.querySelector('[aria-live="polite"]') as HTMLElement
const press = (key: string) =>
  svg().dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }))
const shownValue = () =>
  (el.querySelector('.apexmaps-tooltip .apexmaps-tooltip-value') as HTMLElement).textContent

describe('the default keyboard announcement', () => {
  it('formats its value through tooltip.valueFormatter, as the tooltip shows it', async () => {
    await render({ tooltip: { valueFormatter: signed } })
    press('ArrowRight')
    expect(live().textContent).toBe(`Hokkaidō, Change ${MINUS}4.6%`)
    // Spoken and shown agree, character for character.
    expect(live().textContent!.endsWith(shownValue()!)).toBe(true)

    press('ArrowRight')
    expect(live().textContent).toBe('Kyōto, Change +1.3%')
    expect(live().textContent!.endsWith(shownValue()!)).toBe(true)
  })

  it('keeps a spoken number when no formatter is set: two decimals, not the raw float', async () => {
    await render()
    press('ArrowRight')
    // The tooltip shows the raw number; read aloud, sixteen digits of a rate
    // would be noise, so the announcement keeps the 1.4.0 spoken form.
    expect(shownValue()).toBe('-4.5678')
    expect(live().textContent).toBe('Hokkaidō, Change -4.57')
  })

  it('names a feature with no name by its key, in the announcement and the table alike', async () => {
    // An empty name in a field that names the others, as a source with a gap has.
    const unnamed = {
      type: 'FeatureCollection',
      features: [box('JP-26', 'Kyōto', -30), box('JP-01', '', -10)],
    }
    await render({
      geo: { map: unnamed, projection: 'equirectangular', keyField: 'iso', nameField: 'name' },
      a11y: { dataTable: true },
    })
    press('ArrowRight')
    press('ArrowRight')
    expect(live().textContent).toBe('JP-01, Change -4.57')
    const rowHeaders = [...el.querySelectorAll('tbody th[scope="row"]')].map((th) => th.textContent)
    expect(rowHeaders).toEqual(['Kyōto', 'JP-01'])
  })

  it("says the series' scale.nullLabel for a feature with no data, as the tooltip shows it", async () => {
    await render({
      series: [
        {
          name: 'Change',
          joinBy: ['iso', 'code'],
          data: [{ code: 'JP-01', value: 1 }],
          scale: { nullLabel: 'Not surveyed' },
        },
      ],
    })
    press('End')
    expect(live().textContent).toBe('Tokyo, Not surveyed')
  })

  it('keeps its no-data wording, which the value formatter never sees', async () => {
    const valueFormatter = vi.fn(signed)
    await render({ tooltip: { valueFormatter } })
    press('End')
    expect(live().textContent).toBe('Tokyo, no data')
    expect(valueFormatter).not.toHaveBeenCalledWith(null)
  })
})

describe('a11y.announcementFormatter', () => {
  it('replaces the announcement and receives the tooltip context plus the default text', async () => {
    const announcementFormatter = vi.fn(
      ({ name, datum }: { name?: string; datum: any }) => `${name}: ranked ${datum.rank} of 47`,
    )
    await render({ tooltip: { valueFormatter: signed }, a11y: { announcementFormatter } })
    press('ArrowRight')

    expect(live().textContent).toBe('Hokkaidō: ranked 47 of 47')
    const context = announcementFormatter.mock.calls[0][0] as any
    expect(context).toMatchObject({
      key: 'JP-01',
      name: 'Hokkaidō',
      value: -4.5678,
      datum: { code: 'JP-01', value: -4.5678, rank: 47 },
      properties: { iso: 'JP-01', name: 'Hokkaidō' },
      defaultText: `Hokkaidō, Change ${MINUS}4.6%`,
    })
    expect(context.series.name).toBe('Change')
  })

  it('falls back to the default per feature when it returns null or undefined', async () => {
    await render({
      a11y: {
        announcementFormatter: ({ key }: { key: string }) =>
          key === 'JP-01' ? undefined : key === 'JP-26' ? null : 'Tokyo has no row',
      },
    })
    press('ArrowRight')
    expect(live().textContent).toBe('Hokkaidō, Change -4.57')
    press('ArrowRight')
    expect(live().textContent).toBe('Kyōto, Change 1.25')
    press('ArrowRight')
    expect(live().textContent).toBe('Tokyo has no row')
  })

  it('reaches a feature with no data, with a null value', async () => {
    const announcementFormatter = vi.fn(() => undefined)
    await render({ a11y: { announcementFormatter } })
    press('End')
    expect(announcementFormatter).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'JP-13', value: null, datum: undefined }),
    )
    expect(live().textContent).toBe('Tokyo, no data')
  })

  it('is plain text: markup is read out, never parsed', async () => {
    await render({ a11y: { announcementFormatter: () => '<b>Hokkaidō</b> & more' } })
    press('ArrowRight')
    expect(live().textContent).toBe('<b>Hokkaidō</b> & more')
    expect(live().querySelector('b')).toBeNull()
  })

  it('can say nothing for a feature by returning an empty string', async () => {
    await render({ a11y: { announcementFormatter: () => '' } })
    press('ArrowRight')
    expect(live().textContent).toBe('')
  })

  it('follows updateOptions', async () => {
    await render()
    await map.updateOptions({ a11y: { announcementFormatter: () => 'updated' } })
    press('ArrowRight')
    expect(live().textContent).toBe('updated')
  })
})
