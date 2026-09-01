// @vitest-environment jsdom
/**
 * Regions in flight between their boundaries and their layout cells.
 *
 * Two halves, tested differently. The geometry is pure and gets held to exact
 * numbers: what a path string parses to, where equal-arc-length samples land,
 * that a morph ends on the renderer's own string to the character. The wiring
 * is a contract about *when* a morph happens, which is the part that has been
 * wrong twice: `resolveMap` hands back the id it was asked for, so comparing
 * "us" against "us/states@10m" reads a change of representation as a change of
 * subject, and the morph silently never ran.
 *
 * How it looks is not in here. jsdom has no layout and no compositor, so the
 * frames themselves were reviewed in Chromium; what this file protects is that
 * they are still being asked for.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import ApexMaps from '../src/ApexMaps'
import { LayoutMorph, ringsOf, resample } from '../src/renderers/LayoutMorph'
import type { MorphRing } from '../src/renderers/LayoutMorph'

const BOX = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { code: 'A', name: 'A' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-20, -20],
            [-20, 20],
            [20, 20],
            [20, -20],
            [-20, -20],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { code: 'B', name: 'B' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [30, -20],
            [30, 20],
            [60, 20],
            [60, -20],
            [30, -20],
          ],
        ],
      },
    },
  ],
}

const path = (): SVGPathElement =>
  document.createElementNS('http://www.w3.org/2000/svg', 'path') as SVGPathElement

/** A square ring, which has a perimeter every assertion can be checked against. */
const SQUARE: MorphRing = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
]

describe('ringsOf', () => {
  it('reads the rings d3-geo draws for a projected polygon', () => {
    const rings = ringsOf('M0,0L10,0L10,10L0,10ZM2,2L4,2L4,4Z')
    expect(rings).toHaveLength(2)
    expect(rings?.[0]).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ])
    expect(rings?.[1]).toHaveLength(3)
  })

  it('takes negatives, decimals and exponents, which projected output has', () => {
    const rings = ringsOf('M-1.5,2.25L3e1,-4.5L0.5,0.5Z')
    expect(rings?.[0]).toEqual([
      [-1.5, 2.25],
      [30, -4.5],
      [0.5, 0.5],
    ])
  })

  it('refuses a path it cannot sample rather than guessing at it', () => {
    // A point radius draws arcs, and a caller handed one of those must leave the
    // mark alone: sampling `A` as if it were `L` would draw a shape that is not
    // the one on screen.
    expect(ringsOf('M0,0A5,5 0 1 1 10,10Z')).toBeNull()
    expect(ringsOf('M0,0C1,1 2,2 3,3Z')).toBeNull()
    expect(ringsOf('')).toBeNull()
  })

  it('drops a ring too small to enclose anything', () => {
    // Not an error: a two-point ring has no area and a zero perimeter, so it
    // would divide by zero on being sampled.
    expect(ringsOf('M0,0L1,1Z')).toBeNull()
    expect(ringsOf('M0,0L1,1ZM0,0L5,0L5,5Z')).toHaveLength(1)
  })

  it('rejects an odd number of coordinates', () => {
    expect(ringsOf('M0,0L10,0L10Z')).toBeNull()
  })

  it('closes a ring the string left open', () => {
    // d3-geo always emits `Z`, but the close is implicit in this representation
    // anyway, so a missing one must not lose the ring.
    expect(ringsOf('M0,0L10,0L10,10')).toHaveLength(1)
  })
})

describe('resample', () => {
  it('spaces points equally by arc length, not by vertex', () => {
    // Four points on a 40-unit square land on the corners; the vertex-index
    // reading would give the same answer here, which is why the next case
    // matters more.
    expect(resample(SQUARE, 4)).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ])
  })

  it('puts a point halfway along an edge when the count asks for one', () => {
    const eight = resample(SQUARE, 8)
    expect(eight).toHaveLength(8)
    expect(eight[1]).toEqual([5, 0])
    expect(eight[3]).toEqual([10, 5])
  })

  it('samples up from a ring with fewer vertices than the count', () => {
    // This is the hexagon's side of every morph: six vertices asked to describe
    // the same outline as a coastline with hundreds.
    const many = resample(SQUARE, 40)
    expect(many).toHaveLength(40)
    // Still on the square: every sample sits on an edge.
    for (const [x, y] of many) {
      expect(x === 0 || x === 10 || y === 0 || y === 10).toBe(true)
    }
  })

  it('samples down from a ring with more vertices than the count', () => {
    const dense: MorphRing = Array.from({ length: 200 }, (_, i) => {
      const a = (i / 200) * Math.PI * 2
      return [Math.cos(a) * 10, Math.sin(a) * 10] as [number, number]
    })
    expect(resample(dense, 12)).toHaveLength(12)
  })

  it('resamples a ring with no perimeter to itself', () => {
    const point: MorphRing = [
      [3, 4],
      [3, 4],
      [3, 4],
    ]
    expect(resample(point, 5)).toEqual([
      [3, 4],
      [3, 4],
      [3, 4],
      [3, 4],
      [3, 4],
    ])
  })
})

describe('LayoutMorph', () => {
  let frames: FrameRequestCallback[]

  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', ((cb: FrameRequestCallback) => {
      frames.push(cb)
      return frames.length
    }) as unknown as typeof requestAnimationFrame)
    vi.stubGlobal('cancelAnimationFrame', (() => {}) as unknown as typeof cancelAnimationFrame)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const run = (from: string, to: string, duration = 400) => {
    const el = path()
    el.setAttribute('d', to)
    const morph = LayoutMorph.run({ pairs: [{ el, from, to }], duration })
    return { el, morph }
  }

  const HEX = 'M10,0L20,6L20,18L10,24L0,18L0,6Z'
  const BLOB = 'M100,100L140,102L138,140L102,138Z'

  it('declines when there is nothing to move', () => {
    expect(LayoutMorph.run({ pairs: [], duration: 400 })).toBeNull()
  })

  it('declines at zero duration rather than animating instantly', () => {
    const el = path()
    expect(LayoutMorph.run({ pairs: [{ el, from: HEX, to: BLOB }], duration: 0 })).toBeNull()
  })

  it('declines a pair it cannot sample, leaving the mark as drawn', () => {
    const el = path()
    el.setAttribute('d', BLOB)
    expect(
      LayoutMorph.run({ pairs: [{ el, from: 'M0,0A5,5 0 1 1 9,9Z', to: BLOB }], duration: 400 }),
    ).toBeNull()
    expect(el.getAttribute('d')).toBe(BLOB)
  })

  it('paints the starting shape before the first frame is asked for', () => {
    // Otherwise the reader sees one frame of the destination and the morph then
    // appears to run backwards out of it.
    const { el } = run(HEX, BLOB)
    expect(el.getAttribute('d')).not.toBe(BLOB)
    // Near the hexagon it started from, not the blob it is going to.
    const first = ringsOf(el.getAttribute('d')!)![0][0]
    expect(first[0]).toBeLessThan(50)
    expect(first[1]).toBeLessThan(50)
  })

  it('lands on the string the renderer drew, character for character', () => {
    // Not on the interpolation as it reaches the end: the samples are rounded to
    // two decimals and would leave the map holding an approximation of itself
    // forever.
    const { el, morph } = run(HEX, BLOB, 400)
    frames.shift()?.(0)
    expect(el.getAttribute('d')).not.toBe(BLOB)
    frames.shift()?.(1000)
    expect(el.getAttribute('d')).toBe(BLOB)
    expect(morph).not.toBeNull()
  })

  it('moves through positions between the two shapes', () => {
    const { el } = run(HEX, BLOB, 400)
    frames.shift()?.(0)
    frames.shift()?.(200)
    const mid = ringsOf(el.getAttribute('d')!)![0][0]
    // Between the hexagon's corner and the blob's, on both axes.
    expect(mid[0]).toBeGreaterThan(0)
    expect(mid[0]).toBeLessThan(140)
    expect(mid[1]).toBeGreaterThan(0)
    expect(mid[1]).toBeLessThan(140)
  })

  it('lands on the target when cut short, never halfway between geographies', () => {
    const { el, morph } = run(HEX, BLOB, 400)
    frames.shift()?.(0)
    frames.shift()?.(120)
    morph!.destroy()
    expect(el.getAttribute('d')).toBe(BLOB)
  })

  it('reports done exactly once, however it ended', () => {
    const el = path()
    const onDone = vi.fn()
    const morph = LayoutMorph.run({
      pairs: [{ el, from: HEX, to: BLOB }],
      duration: 400,
      onDone,
    })
    frames.shift()?.(0)
    frames.shift()?.(1000)
    expect(onDone).toHaveBeenCalledTimes(1)
    morph!.destroy()
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('pairs an island against the cell it collapses into', () => {
    // Ring counts almost never match: Hawaii is eight islands against one
    // hexagon. The extra rings have to travel somewhere rather than pop.
    const twoRings = 'M100,100L140,102L138,140L102,138ZM200,200L210,200L210,210L200,210Z'
    const { el } = run(HEX, twoRings, 400)
    frames.shift()?.(0)
    const rings = ringsOf(el.getAttribute('d')!)
    expect(rings).toHaveLength(2)
    // At t=0 the second ring is collapsed onto one point inside the hexagon, so
    // it has no extent at all and every sample of it is the same coordinate.
    const second = rings![1]
    const xs = second.map((point) => point[0])
    const ys = second.map((point) => point[1])
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.02)
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(0.02)
    expect(Math.max(...xs)).toBeLessThan(30)
  })
})

describe('a layout toggle on a live map', () => {
  let el: HTMLElement
  let map: ApexMaps | null

  beforeEach(() => {
    el = document.createElement('div')
    document.body.appendChild(el)
    // The timestamp has to advance. A stub that always reports the same instant
    // holds every duration-driven effect at t=0 forever, which is a property of
    // the stub and not of the effect.
    let clock = 1000
    vi.stubGlobal('requestAnimationFrame', ((cb: FrameRequestCallback) => {
      clock += 250
      return setTimeout(() => cb(clock), 0) as unknown as number
    }) as unknown as typeof requestAnimationFrame)
    vi.stubGlobal('cancelAnimationFrame', ((id: number) =>
      clearTimeout(id)) as unknown as typeof cancelAnimationFrame)
  })

  afterEach(() => {
    map?.destroy()
    map = null
    el.remove()
    vi.unstubAllGlobals()
  })

  const build = async (): Promise<ApexMaps> => {
    // Both sides have to be registered, and the layout has to name the pack it
    // represents: that name is the only thing that says these are two pictures
    // of one region set. Inline geometry has no id, so it can never pair.
    ApexMaps.registerMap('testOnly/pairbox', BOX as never, { keyField: 'code' } as never)
    ApexMaps.registerLayout('testOnly/pairhex', {
      of: 'testOnly/pairbox',
      keyField: 'code',
      cells: { A: [0, 0], B: [1, 0] },
    })
    const instance = new ApexMaps(el, {
      chart: { height: 300 },
      geo: { map: 'testOnly/pairbox' },
      series: [{ name: 'v', joinBy: ['code', 'key'], data: [{ key: 'A', value: 1 }] }],
    })
    await instance.render()
    return instance
  }

  it('morphs between two representations of the same region set', async () => {
    // The regression this exists for: the two sides are compared by region set,
    // and the id a map reports is the one it was asked for rather than the
    // canonical pack, so an alias on one side used to read as a different set.
    map = await build()
    const before = el.querySelector<SVGPathElement>('path.apexmaps-feature')!.getAttribute('d')
    await map.updateOptions({ geo: { map: 'testOnly/pairhex' } })
    expect(el.classList.contains('apexmaps--morphing')).toBe(true)
    const during = el.querySelector<SVGPathElement>('path.apexmaps-feature')!.getAttribute('d')
    expect(during).not.toBe(before)
  })

  it('leaves the overlay alone once the flight is over', async () => {
    map = await build()
    await map.updateOptions({ geo: { map: 'testOnly/pairhex' } })
    expect(el.classList.contains('apexmaps--morphing')).toBe(true)
    // Four frames at the stubbed clock's 250ms step to cross a 700ms morph, and
    // one turn of the timer queue per frame.
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0))
    expect(el.classList.contains('apexmaps--morphing')).toBe(false)
  })

  it('does not morph when animations are off', async () => {
    map = await build()
    await map.updateOptions({ chart: { animations: { enabled: false } } })
    await map.updateOptions({ geo: { map: 'testOnly/pairhex' } })
    expect(el.classList.contains('apexmaps--morphing')).toBe(false)
  })

  it('does not morph to geometry that names no region set', async () => {
    // Inline geometry has no id, so nothing says whether it is a picture of the
    // same regions. No correspondence to claim, so the swap stays a swap.
    map = await build()
    await map.updateOptions({
      geo: {
        map: {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { code: 'Z', name: 'Z' },
              geometry: {
                type: 'Polygon',
                coordinates: [
                  [
                    [0, 0],
                    [0, 5],
                    [5, 5],
                    [5, 0],
                    [0, 0],
                  ],
                ],
              },
            },
          ],
        },
      },
    })
    expect(el.classList.contains('apexmaps--morphing')).toBe(false)
  })
})
