// @vitest-environment jsdom
/**
 * Hexagonal binning of point data.
 *
 * The lattice gets held to exact geometry, because the whole claim of a density
 * map is that every cell is the same size and every point is in exactly one of
 * them: cells that overlap double-count and cells that gap lose data, and
 * neither is visible on screen. The tiling test is the one that would catch a
 * wrong rounding rule, which is the easy thing to get wrong here and the hard
 * thing to see.
 *
 * The rest is the contract with the series: what the default aggregate is, what
 * happens to a point with no value, and that the lattice refines with the zoom
 * rather than magnifying.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import ApexMaps from '../src/ApexMaps'
import { binPoints, cellOf, centreOf, cellRing, aggregateOf } from '../src/geo/Hexbin'
import type { BinOrientation } from '../src/geo/Hexbin'

const ORIENTATIONS: BinOrientation[] = ['pointy', 'flat']

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
            [-40, -40],
            [-40, 40],
            [40, 40],
            [40, -40],
            [-40, -40],
          ],
        ],
      },
    },
  ],
}

describe('the lattice', () => {
  for (const orientation of ORIENTATIONS) {
    it(`${orientation}: a cell centre resolves to its own cell`, () => {
      for (let q = -6; q <= 6; q++) {
        for (let r = -6; r <= 6; r++) {
          expect(cellOf(centreOf(q, r, 10, orientation), 10, orientation)).toEqual([q, r])
        }
      }
    })

    it(`${orientation}: every point lands in the cell whose centre is nearest`, () => {
      // The test that catches a wrong rounding rule. Rounding axial coordinates
      // independently looks right in the middle of a cell and is wrong near its
      // corners, where it hands the point to a neighbour that is further away.
      // Overlapping cells double-count and gaps lose data, and a picture of
      // either looks like a perfectly good hexbin.
      let checked = 0
      for (let x = -50; x <= 50; x += 3.7) {
        for (let y = -50; y <= 50; y += 3.3) {
          const [q, r] = cellOf([x, y], 10, orientation)
          const own = centreOf(q, r, 10, orientation)
          const ownDistance = Math.hypot(x - own[0], y - own[1])
          for (let dq = -2; dq <= 2; dq++) {
            for (let dr = -2; dr <= 2; dr++) {
              const other = centreOf(q + dq, r + dr, 10, orientation)
              expect(Math.hypot(x - other[0], y - other[1])).toBeGreaterThanOrEqual(
                ownDistance - 1e-9,
              )
            }
          }
          checked++
        }
      }
      expect(checked).toBeGreaterThan(500)
    })

    it(`${orientation}: the outline has six corners, all at the radius`, () => {
      const ring = cellRing(10, orientation)
      expect(ring).toHaveLength(6)
      for (const [x, y] of ring) expect(Math.hypot(x, y)).toBeCloseTo(10, 9)
    })

    it(`${orientation}: neighbouring centres are one cell width apart`, () => {
      // Two cells sharing an edge sit at twice the inradius, which for a unit
      // hexagon is sqrt(3). Anything else is a lattice with gaps or overlap.
      const a = centreOf(0, 0, 10, orientation)
      const b = centreOf(1, 0, 10, orientation)
      expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(10 * Math.sqrt(3), 9)
    })
  }

  it('gives a cell the same coordinates however the rounding fell', () => {
    // Math.round(-0.2) is -0, and a lattice coordinate that compares unequal to
    // itself would split one cell into two everywhere downstream.
    const [q, r] = cellOf([-0.5, -0.5], 10, 'pointy')
    expect(Object.is(q, -0)).toBe(false)
    expect(Object.is(r, -0)).toBe(false)
  })
})

describe('binPoints', () => {
  const grid = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      index: i,
      world: [Math.sin(i * 0.7) * 60, Math.cos(i * 0.31) * 60] as [number, number],
      value: i % 10,
    }))

  it('does not depend on the order the points arrive in', () => {
    // Stronger than clustering manages, and worth asserting because it is the
    // reason a hexbin is reproducible: a cell is decided by arithmetic on a
    // coordinate, not by which point got there first.
    const points = grid(200)
    const digest = (bins: ReturnType<typeof binPoints>) =>
      bins
        .map((b) => `${b.q},${b.r}:${b.count}:${b.sum}`)
        .sort()
        .join('|')
    expect(digest(binPoints(points, { radius: 12, zoom: 1 }))).toBe(
      digest(binPoints([...points].reverse(), { radius: 12, zoom: 1 })),
    )
  })

  it('accounts for every point exactly once', () => {
    const points = grid(500)
    const bins = binPoints(points, { radius: 9, zoom: 1 })
    const total = bins.reduce((sum, bin) => sum + bin.count, 0)
    expect(total).toBe(points.length)
    const members = new Set(bins.flatMap((bin) => bin.members))
    expect(members.size).toBe(points.length)
  })

  it('refines as the camera zooms in', () => {
    const points = grid(300)
    const coarse = binPoints(points, { radius: 20, zoom: 1 })
    const fine = binPoints(points, { radius: 20, zoom: 8 })
    expect(fine.length).toBeGreaterThan(coarse.length)
    // Still every point, whatever the resolution.
    expect(fine.reduce((s, b) => s + b.count, 0)).toBe(300)
  })

  it('places a bin at its cell centre, not at its members', () => {
    // The opposite of what clustering does, and the reason is the opposite too:
    // a bin stands for the patch, so sliding it towards whichever corner the
    // points occupied would misreport which patch was measured.
    const centre = centreOf(0, 0, 10, 'pointy')
    const bins = binPoints(
      [
        { index: 0, world: [centre[0] + 6, centre[1] + 4] },
        { index: 1, world: [centre[0] + 5, centre[1] + 5] },
      ],
      { radius: 10, zoom: 1 },
    )
    expect(bins).toHaveLength(1)
    expect(bins[0].world[0]).toBeCloseTo(centre[0], 9)
    expect(bins[0].world[1]).toBeCloseTo(centre[1], 9)
  })

  it('skips a point with no finite position rather than binning it at zero', () => {
    const bins = binPoints(
      [
        { index: 0, world: [0, 0] },
        { index: 1, world: [Number.NaN, 3] },
      ],
      { radius: 10, zoom: 1 },
    )
    expect(bins).toHaveLength(1)
    expect(bins[0].count).toBe(1)
  })

  it('leaves empty cells out entirely', () => {
    // A lattice over a whole projection is mostly ocean, and a density map should
    // show where the data is rather than paper the world in zeroes.
    const bins = binPoints([{ index: 0, world: [0, 0] }], { radius: 5, zoom: 1 })
    expect(bins).toHaveLength(1)
  })
})

describe('aggregateOf', () => {
  const bin = binPoints(
    [
      { index: 0, world: [0, 0], value: 4 },
      { index: 1, world: [1, 1], value: 10 },
      { index: 2, world: [-1, 1], value: null },
    ],
    { radius: 40, zoom: 1 },
  )[0]

  it('counts every point, valued or not', () => {
    expect(aggregateOf(bin, 'count')).toBe(3)
  })

  it('aggregates over the points that carried a number', () => {
    expect(aggregateOf(bin, 'sum')).toBe(14)
    expect(aggregateOf(bin, 'mean')).toBe(7)
    expect(aggregateOf(bin, 'min')).toBe(4)
    expect(aggregateOf(bin, 'max')).toBe(10)
  })

  it('reports no data rather than zero when nothing carried a number', () => {
    // Zero is a value, and a cell that had none must not be coloured as though
    // it measured one.
    const empty = binPoints([{ index: 0, world: [0, 0] }], { radius: 40, zoom: 1 })[0]
    expect(aggregateOf(empty, 'sum')).toBeNull()
    expect(aggregateOf(empty, 'mean')).toBeNull()
    expect(aggregateOf(empty, 'count')).toBe(1)
  })
})

describe('the hexbin series on a live map', () => {
  let el: HTMLElement
  let map: ApexMaps | null

  const points = Array.from({ length: 400 }, (_, i) => ({
    lon: -30 + ((i * 7) % 60),
    lat: -30 + ((i * 11) % 60),
    value: (i % 20) + 1,
  }))

  beforeEach(() => {
    el = document.createElement('div')
    document.body.appendChild(el)
    vi.stubGlobal('requestAnimationFrame', ((cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame)
  })

  afterEach(() => {
    map?.destroy()
    map = null
    el.remove()
    vi.unstubAllGlobals()
  })

  const build = async (series: Record<string, unknown>): Promise<ApexMaps> => {
    const instance = new ApexMaps(el, {
      // An explicit size, because jsdom measures every element at zero and the
      // plot then falls back to one pixel wide. Every point in a 1px strip lands
      // in the same column, so without this the bin counts below would be
      // measuring the harness rather than the lattice.
      chart: { width: 800, height: 500 },
      geo: { map: BOX },
      series: [{ type: 'hexbin', ...series }] as never,
    })
    await instance.render()
    return instance
  }

  it('draws one cell per occupied bin', async () => {
    map = await build({ data: points, radius: 18 })
    const cells = el.querySelectorAll('path.apexmaps-bin')
    expect(cells.length).toBeGreaterThan(3)
    expect(cells.length).toBeLessThan(points.length)
    for (const cell of cells) {
      // Six corners and the close, for every cell of every lattice.
      expect((cell.getAttribute('d') ?? '').match(/[ML]/g)).toHaveLength(6)
    }
  })

  it('counts by default, without being given a value field', async () => {
    // The question that brings anyone here is "where are these things", and a
    // hexbin that demanded a numeric column to answer it would be asking for a
    // column the caller does not have.
    map = await build({ data: points.map(({ lon, lat }) => ({ lon, lat })), radius: 18 })
    const series = map.renderTargets.find((s) => s.kind === 'bins')! as never as {
      aggregate: string
      bins: (z: number) => { count: number }[]
    }
    expect(series.aggregate).toBe('count')
    const total = series.bins(1).reduce((sum, bin) => sum + bin.count, 0)
    expect(total).toBe(points.length)
  })

  it('legends the aggregate, since count and mean are different maps', async () => {
    map = await build({ data: points, radius: 18 })
    const withCount = map.renderTargets.find((s) => s.kind === 'bins')! as never as {
      legendTitle: () => string
    }
    expect(withCount.legendTitle()).toBe('points per cell')
    await map.updateOptions({ series: [{ type: 'hexbin', data: points, aggregate: 'mean' }] })
    const withMean = map.renderTargets.find((s) => s.kind === 'bins')! as never as {
      legendTitle: () => string
    }
    expect(withMean.legendTitle()).toBe('mean')
  })

  it('drops a point with no position and says so', async () => {
    map = await build({ data: [...points, { value: 3 }, { lon: 10 }] })
    expect(map.warnings.join(' ')).toMatch(/2 hexbin datum\(s\) had no position/)
  })

  it('warns when an aggregate needs numbers the points do not carry', async () => {
    map = await build({
      data: points.map(({ lon, lat }) => ({ lon, lat })),
      aggregate: 'sum',
    })
    expect(map.warnings.join(' ')).toMatch(/aggregate "sum" needs a number/)
  })

  it('advises against a hexbin over too few points to bin', async () => {
    map = await build({ data: points.slice(0, 12), radius: 18 })
    const series = map.renderTargets.find((s) => s.kind === 'bins')! as never as {
      bins: (z: number) => unknown[]
      advise: () => string[]
    }
    series.bins(1)
    expect(series.advise().join(' ')).toMatch(/binning away detail/)
  })

  it('accepts a GeoJSON coordinates pair as readily as lon and lat', async () => {
    map = await build({
      data: points.map(({ lon, lat }) => ({ coordinates: [lon, lat] })),
      radius: 18,
    })
    expect(el.querySelectorAll('path.apexmaps-bin').length).toBeGreaterThan(3)
    expect(map.warnings.join(' ')).not.toMatch(/had no position/)
  })

  it('rebuilds the lattice when the projection changes', async () => {
    // Bins live in world space, so a new projection is new world coordinates:
    // the lattice has to be rebuilt rather than moved.
    map = await build({ data: points, radius: 18 })
    const before = [...el.querySelectorAll('path.apexmaps-bin')].map((n) => n.getAttribute('d'))
    await map.updateOptions({ geo: { projection: 'orthographic' } })
    const after = [...el.querySelectorAll('path.apexmaps-bin')].map((n) => n.getAttribute('d'))
    expect(after.join()).not.toBe(before.join())
  })
})
