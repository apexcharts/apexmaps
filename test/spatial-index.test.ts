/**
 * The R-tree.
 *
 * A spatial index is only worth having if it returns exactly what a linear scan
 * would, so the load-bearing test here is differential: thousands of randomised
 * queries against brute force, on several distributions chosen because each one
 * breaks a different naive packing. Asserting a hand-picked example instead
 * tests the example.
 *
 * The randomness is seeded, so a failure is reproducible and CI cannot go
 * intermittently red on a distribution nobody can recreate.
 */
import { describe, it, expect } from 'vitest'
import { SpatialIndex } from '../src/geo/SpatialIndex'
import type { WorldBounds } from '../src/types'

/** Mulberry32: small, seeded, and good enough that runs are not correlated. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function box(x: number, y: number, w: number, h: number): WorldBounds {
  return [
    [x, y],
    [x + w, y + h],
  ]
}

function brute(
  boxes: readonly (WorldBounds | null)[],
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): number[] {
  const out: number[] = []
  boxes.forEach((b, i) => {
    if (!b) return
    const [[bx0, by0], [bx1, by1]] = b
    if (!Number.isFinite(bx0) || !Number.isFinite(by0)) return
    if (!Number.isFinite(bx1) || !Number.isFinite(by1)) return
    if (bx0 <= maxX && by0 <= maxY && bx1 >= minX && by1 >= minY) out.push(i)
  })
  return out
}

const sorted = (a: number[]) => [...a].sort((x, y) => x - y)

/** Distributions that each punish a different packing mistake. */
const DISTRIBUTIONS: { name: string; make: (r: () => number, n: number) => WorldBounds[] }[] = [
  {
    name: 'uniform small boxes',
    make: (r, n) => Array.from({ length: n }, () => box(r() * 1000, r() * 1000, r() * 8, r() * 8)),
  },
  {
    name: 'wildly mixed sizes (one Alaska among counties)',
    // A few enormous boxes among many tiny ones: a packing that ignores extent
    // buries the giants in nodes that then overlap every query.
    make: (r, n) =>
      Array.from({ length: n }, (_, i) =>
        i % 97 === 0
          ? box(r() * 200, r() * 200, 600 + r() * 300, 600 + r() * 300)
          : box(r() * 1000, r() * 1000, r() * 5, r() * 5),
      ),
  },
  {
    name: 'clustered in a corner',
    // Real geography is clustered, not uniform. Slicing on one axis only leaves
    // long thin nodes here.
    make: (r, n) =>
      Array.from({ length: n }, () => box(r() * r() * 100, r() * r() * 100, r() * 3, r() * 3)),
  },
  {
    name: 'a grid, all identical size',
    // Ties everywhere in both sort keys, which is where an unstable comparator
    // or an off-by-one slice loses items.
    make: (_r, n) => {
      const side = Math.ceil(Math.sqrt(n))
      return Array.from({ length: n }, (_, i) =>
        box((i % side) * 10, Math.floor(i / side) * 10, 9, 9),
      )
    },
  },
  {
    name: 'collinear boxes on one row',
    // Zero variance on y: every centre-y comparison ties.
    make: (r, n) => Array.from({ length: n }, () => box(r() * 1000, 50, r() * 4, 0)),
  },
]

describe('SpatialIndex agrees with brute force', () => {
  for (const { name, make } of DISTRIBUTIONS) {
    it(name, () => {
      const r = rng(0xc0ffee)
      // Straddles the node size (9) in both directions, so single-leaf trees,
      // one-level trees and deep trees are all exercised.
      for (const n of [1, 2, 8, 9, 10, 81, 82, 500, 3231]) {
        const boxes = make(r, n)
        const index = SpatialIndex.build(boxes)
        expect(index.size).toBe(n)

        for (let q = 0; q < 60; q++) {
          const qx = r() * 1100 - 50
          const qy = r() * 1100 - 50
          // Mix point queries with area queries: a point query is the pointer
          // case and exercises the degenerate box.
          const w = q % 3 === 0 ? 0 : r() * 120
          const h = q % 3 === 0 ? 0 : r() * 120
          const got = sorted(index.search(qx, qy, qx + w, qy + h))
          const want = sorted(brute(boxes, qx, qy, qx + w, qy + h))
          expect(got, `n=${n} q=${q} at ${qx},${qy} +${w}x${h}`).toEqual(want)
        }
      }
    })
  }

  it('finds every box when queried with the whole extent', () => {
    const r = rng(7)
    const boxes = Array.from({ length: 1000 }, () => box(r() * 500, r() * 500, r() * 10, r() * 10))
    const index = SpatialIndex.build(boxes)
    const all = index.search(-1e9, -1e9, 1e9, 1e9)
    expect(sorted(all)).toEqual(boxes.map((_, i) => i))
  })
})

describe('SpatialIndex edges', () => {
  it('is empty and safe with nothing to index', () => {
    const index = SpatialIndex.build([])
    expect(index.size).toBe(0)
    expect(index.bounds).toBeNull()
    expect(index.search(0, 0, 10, 10)).toEqual([])
    expect(index.searchPoint(0, 0)).toEqual([])
  })

  it('skips null boxes rather than indexing them at the origin', () => {
    // A clipped feature indexed as a zero box at 0,0 becomes a candidate for
    // every query near the origin, which on a fitted world map is the middle of
    // the plot.
    const boxes = [null, box(100, 100, 10, 10), null, box(0, 0, 5, 5)]
    const index = SpatialIndex.build(boxes)
    expect(index.size).toBe(2)
    expect(index.searchPoint(2, 2)).toEqual([3])
    expect(index.searchPoint(105, 105)).toEqual([1])
  })

  it('drops non-finite boxes so they cannot poison ancestor bounds', () => {
    const boxes: WorldBounds[] = [
      box(10, 10, 5, 5),
      [
        [NaN, 0],
        [10, 10],
      ],
      [
        [0, 0],
        [Infinity, 10],
      ],
    ]
    const index = SpatialIndex.build(boxes)
    expect(index.size).toBe(1)
    expect(index.bounds).toEqual([
      [10, 10],
      [15, 15],
    ])
    // Had the infinite box been kept, the root would span everything and every
    // query would descend into it.
    expect(index.searchPoint(1000, 1000)).toEqual([])
  })

  it('keeps indices aligned with the caller array, not with insertion order', () => {
    // Packing sorts internally; the payload must still be the caller's index.
    const boxes = [box(900, 900, 5, 5), box(0, 0, 5, 5), box(450, 450, 5, 5)]
    const index = SpatialIndex.build(boxes)
    expect(index.searchPoint(902, 902)).toEqual([0])
    expect(index.searchPoint(2, 2)).toEqual([1])
    expect(index.searchPoint(452, 452)).toEqual([2])
  })

  it('includes boxes that merely touch the query edge', () => {
    // The reader aiming at a border is aiming at exactly this case.
    const index = SpatialIndex.build([box(10, 10, 10, 10)])
    expect(index.searchPoint(10, 10)).toEqual([0])
    expect(index.searchPoint(20, 20)).toEqual([0])
    expect(index.searchPoint(9.999, 15)).toEqual([])
  })

  it('handles zero-area boxes, which a degenerate polygon produces', () => {
    const index = SpatialIndex.build([box(5, 5, 0, 0), box(20, 20, 0, 0)])
    expect(index.size).toBe(2)
    expect(index.searchPoint(5, 5)).toEqual([0])
    expect(index.search(19, 19, 21, 21)).toEqual([1])
  })

  it('searchNear expands by the radius', () => {
    const index = SpatialIndex.build([box(100, 100, 2, 2)])
    expect(index.searchNear(90, 100, 5)).toEqual([])
    expect(index.searchNear(90, 100, 12)).toEqual([0])
  })
})

describe('SpatialIndex actually prunes', () => {
  it('descends into a small fraction of the tree for a point query', () => {
    // The property that makes the index worth its code: a point query must not
    // touch everything. Counted through the comparisons brute force would need
    // versus what search returns, on data with no overlap so the answer is 1.
    const side = 60
    const boxes = Array.from({ length: side * side }, (_, i) =>
      box((i % side) * 10, Math.floor(i / side) * 10, 8, 8),
    )
    const index = SpatialIndex.build(boxes)
    expect(index.size).toBe(3600)

    const hits = index.searchPoint(304, 254)
    expect(hits).toHaveLength(1)
    expect(brute(boxes, 304, 254, 304, 254)).toEqual(hits)
  })
})
