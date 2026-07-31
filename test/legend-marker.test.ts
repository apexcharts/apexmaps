// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import ApexMaps from '../src/ApexMaps'
import { createScale } from '../src/scales/Scale'

/**
 * Four boxes, so a five-class quantile scale has something to spread across and
 * the marker has more than one band to land in.
 */
const BOXES = {
  type: 'FeatureCollection',
  features: [
    box('AAA', 'Alpha', -30),
    box('BBB', 'Beta', -10),
    box('CCC', 'Gamma', 10),
    box('DDD', 'Delta', 30),
  ],
}

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
    chart: { width: 400, height: 300, type: 'choropleth' },
    geo: { map: BOXES, projection: 'equirectangular' },
    debug: { enabled: false },
    legend: { style: 'gradient' },
    series: [
      {
        name: 'Score',
        joinBy: ['iso_a3', 'code'],
        data: [
          { code: 'AAA', value: 10 },
          { code: 'BBB', value: 40 },
          { code: 'CCC', value: 70 },
          { code: 'DDD', value: 100 },
        ],
      },
    ],
    ...options,
  } as never)
  await map.render()
  return map
}

/** jsdom does no layout, so the container's box has to be declared. */
function sizeContainer(width: number, height = 400) {
  el.getBoundingClientRect = () =>
    ({ width, height, top: 0, left: 0, right: width, bottom: height }) as DOMRect
}

const marker = () => el.querySelector('.apexmaps-legend-marker') as HTMLElement
const legendEl = () => el.querySelector('.apexmaps-legend') as HTMLElement
const plot = () => el.querySelector('.apexmaps-plot') as HTMLElement
const hover = (i: number, type = 'pointerover') =>
  el
    .querySelectorAll('path.apexmaps-feature')
    [i].dispatchEvent(new window.PointerEvent(type, { bubbles: true }))

describe('Scale.position', () => {
  it('places a continuous value where its colour is sampled', () => {
    const scale = createScale([0, 100], { type: 'linear', domain: [0, 100] })
    expect(scale.position(0)).toBe(0)
    expect(scale.position(50)).toBeCloseTo(0.5, 6)
    expect(scale.position(100)).toBe(1)
  })

  it('keeps a classed value inside the band that coloured it', () => {
    const scale = createScale([0, 25, 50, 75, 100], { type: 'quantile', classes: 4 })
    for (const value of [0, 25, 50, 75, 100]) {
      const p = scale.position(value)!
      const band = Math.min(3, Math.floor(p * 4))
      expect(band).toBe(scale.classIndex(value))
    }
  })

  it('has no position for missing data or an unknown category', () => {
    const scale = createScale([1, 2, 3])
    expect(scale.position(null)).toBeNull()
    expect(scale.position('nope')).toBeNull()
    const ordinal = createScale(['a', 'b'], { type: 'ordinal' })
    expect(ordinal.position('c')).toBeNull()
    expect(ordinal.position('b')).toBeCloseTo(0.75, 6)
  })

  it('clamps a value outside an explicit domain onto the bar', () => {
    const scale = createScale([0, 10], { type: 'linear', domain: [0, 10] })
    expect(scale.position(-5)).toBe(0)
    expect(scale.position(99)).toBe(1)
  })
})

describe('legend hover marker', () => {
  it('moves along the bar as the pointer crosses features', async () => {
    await render()
    expect(marker()).toBeTruthy()
    expect(marker().classList.contains('is-visible')).toBe(false)

    hover(0)
    expect(marker().classList.contains('is-visible')).toBe(true)
    const low = parseFloat(marker().style.left)

    hover(0, 'pointerout')
    hover(3)
    const high = parseFloat(marker().style.left)

    expect(high).toBeGreaterThan(low)
    expect(low).toBeGreaterThanOrEqual(0)
    expect(high).toBeLessThanOrEqual(100)
    expect(marker().textContent).toContain('100')
  })

  it('parks on pointerout', async () => {
    await render()
    hover(1)
    expect(marker().classList.contains('is-visible')).toBe(true)
    hover(1, 'pointerout')
    expect(marker().classList.contains('is-visible')).toBe(false)
    expect(marker().textContent).toBe('')
  })

  it('stays parked for a feature with no data', async () => {
    await render({
      series: [
        {
          name: 'Score',
          joinBy: ['iso_a3', 'code'],
          data: [
            { code: 'AAA', value: 10 },
            { code: 'BBB', value: 40 },
            { code: 'CCC', value: 70 },
          ],
        },
      ],
    })
    hover(3)
    expect(marker().classList.contains('is-visible')).toBe(false)
  })

  it('can be turned off, and its label turned off on its own', async () => {
    await render({ legend: { style: 'gradient', marker: false } })
    hover(0)
    expect(marker().classList.contains('is-visible')).toBe(false)

    map?.destroy()
    await render({ legend: { style: 'gradient', marker: { label: false } } })
    hover(0)
    expect(marker().classList.contains('is-visible')).toBe(true)
    expect(marker().textContent).toBe('')
  })

  it('gives a classed scale a banded bar and boundary ticks', async () => {
    await render()
    const bar = el.querySelector('.apexmaps-legend-gradient') as HTMLElement
    // Hard steps: every colour appears at both edges of its band.
    expect(bar.style.background).toMatch(/linear-gradient/)
    const ticks = el.querySelectorAll('.apexmaps-legend-tick')
    expect(ticks.length).toBeGreaterThan(0)
    for (const tick of ticks) {
      const left = parseFloat((tick as HTMLElement).style.left)
      expect(left).toBeGreaterThan(0)
      expect(left).toBeLessThan(100)
    }
  })
})

describe('legend.position', () => {
  it('marks the root with the side the legend is on', async () => {
    for (const position of ['top', 'bottom', 'left', 'right'] as const) {
      await render({ legend: { style: 'gradient', position } })
      expect(el.classList.contains(`apexmaps--legend-${position}`)).toBe(true)
      expect(legendEl().classList.contains(`apexmaps-legend--${position}`)).toBe(true)
      // Exactly one side at a time, or two layout rules would fight.
      const sides = ['top', 'bottom', 'left', 'right'].filter((s) =>
        el.classList.contains(`apexmaps--legend-${s}`),
      )
      expect(sides).toEqual([position])
      map?.destroy()
      map = null
    }
  })

  it('claims no side when the legend is hidden', async () => {
    await render({ legend: { show: false, position: 'left' } })
    for (const side of ['top', 'bottom', 'left', 'right']) {
      expect(el.classList.contains(`apexmaps--legend-${side}`)).toBe(false)
    }
  })

  it('takes a side legend out of the width the plot is measured against', async () => {
    sizeContainer(800)
    await render({ chart: { width: '100%', height: 300 }, legend: { position: 'left' } })
    expect(plot().style.width).toBe('620px')

    map?.destroy()
    sizeContainer(800)
    await render({
      chart: { width: '100%', height: 300 },
      legend: { position: 'left', width: 240 },
    })
    expect(plot().style.width).toBe('560px')

    map?.destroy()
    sizeContainer(800)
    await render({ chart: { width: '100%', height: 300 }, legend: { position: 'bottom' } })
    expect(plot().style.width).toBe('800px')
  })

  it('re-measures the plot when the legend moves after render', async () => {
    sizeContainer(800)
    await render({ chart: { width: '100%', height: 300 }, legend: { position: 'bottom' } })
    expect(plot().style.width).toBe('800px')

    await map!.updateOptions({ legend: { position: 'right' } } as never)
    expect(plot().style.width).toBe('620px')
    expect(el.classList.contains('apexmaps--legend-right')).toBe(true)

    await map!.updateOptions({ legend: { position: 'bottom' } } as never)
    expect(plot().style.width).toBe('800px')
  })

  it('runs the bar bottom-to-top on a side legend, and moves the marker in y', async () => {
    await render({ legend: { style: 'gradient', position: 'left' } })
    expect(legendEl().classList.contains('apexmaps-legend--vertical')).toBe(true)

    const bar = el.querySelector('.apexmaps-legend-gradient') as HTMLElement
    expect(bar.style.background).toContain('to top')

    hover(0)
    const low = parseFloat(marker().style.bottom)
    expect(marker().style.left).toBe('')
    hover(0, 'pointerout')
    hover(3)
    expect(parseFloat(marker().style.bottom)).toBeGreaterThan(low)

    // Ticks travel up the bar with it.
    const tick = el.querySelector('.apexmaps-legend-tick') as HTMLElement
    expect(tick.style.bottom).not.toBe('')
    expect(tick.style.left).toBe('')
  })
})
