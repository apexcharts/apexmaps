// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import ApexMaps from '../src/ApexMaps'
import { DARK_NULL_COLOR } from '../src/scales/Scale'
import type { ChoroplethSeries } from '../src/series/Choropleth'

/** Two boxes with data and one without, so there is a no-data fill to inspect. */
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
    chart: { width: 400, height: 300 },
    geo: { map: BOXES, projection: 'equirectangular' },
    debug: { enabled: false },
    series: [
      {
        name: 'Score',
        joinBy: ['iso_a3', 'code'],
        data: [
          { code: 'AAA', value: 10 },
          { code: 'BBB', value: 100 },
        ],
      },
    ],
    ...options,
  } as never)
  await map.render()
  return map
}

const nullColor = () => (map!.series[0] as ChoroplethSeries).scale.nullColor
const swatches = () =>
  [...el.querySelectorAll('.apexmaps-legend-swatch')].map((s) =>
    (s as HTMLElement).style.getPropertyValue('background'),
  )

describe('theme.mode', () => {
  it('leaves no-data light on a light map', async () => {
    await render()
    expect(el.classList.contains('apexmaps--dark')).toBe(false)
    expect(nullColor()).toBe('#eeeeee')
  })

  it('darkens no-data, in the map and in the legend, in dark mode', async () => {
    await render({ theme: { mode: 'dark' } })
    expect(el.classList.contains('apexmaps--dark')).toBe(true)
    expect(nullColor()).toBe(DARK_NULL_COLOR)
    // jsdom serialises the swatch's background as rgb().
    expect(swatches().at(-1)).toContain('rgb(55, 65, 81)')
  })

  it('follows a mode change through updateOptions', async () => {
    await render()
    await map!.updateOptions({ theme: { mode: 'dark' } })
    expect(el.classList.contains('apexmaps--dark')).toBe(true)
    expect(nullColor()).toBe(DARK_NULL_COLOR)

    await map!.updateOptions({ theme: { mode: 'light' } })
    expect(el.classList.contains('apexmaps--dark')).toBe(false)
    expect(nullColor()).toBe('#eeeeee')
  })

  it('keeps an explicit nullColor whatever the mode', async () => {
    await render({
      theme: { mode: 'dark' },
      series: [
        {
          name: 'Score',
          joinBy: ['iso_a3', 'code'],
          data: [{ code: 'AAA', value: 10 }],
          scale: { nullColor: '#ff00ff' },
        },
      ],
    })
    expect(nullColor()).toBe('#ff00ff')
  })

  it('flips the label halo with the theme rather than staying white', async () => {
    await render({ theme: { mode: 'dark' }, dataLabels: { enabled: true } })
    const label = el.querySelector('.apexmaps-label')
    expect(label?.getAttribute('stroke')).toContain('--apexmaps-halo')
  })
})
