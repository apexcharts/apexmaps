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

const marker = () => el.querySelector('.apexmaps-legend-marker') as HTMLElement
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
