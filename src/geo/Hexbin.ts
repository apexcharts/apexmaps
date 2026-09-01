/**
 * Hexagonal binning of point data.
 *
 * The sibling of `geo/Cluster`, and the place where that module's first decision
 * is deliberately reversed. Clustering rejects grid bucketing because it merges
 * by cell rather than by distance, and a reader can see the difference: two
 * points a few pixels apart end up in different clusters. Here the lattice *is*
 * the answer. A bin is not a group of points that happen to be near each other,
 * it is a fixed patch of the map reporting how much landed in it, and every patch
 * has to be the same size or the colours are not comparable. Distance clustering
 * would give bins of varying area, which is the one thing a density map cannot
 * have.
 *
 * The other two decisions carry over unchanged, for the same reasons.
 *
 * **Binning happens in world space, at quantized zoom levels.** World coordinates
 * do not move when the camera pans, so a pan never re-bins and the lattice never
 * crawls under the reader's cursor. The level policy is `geo/Cluster`'s, shared
 * rather than reimplemented, so a map carrying both a cluster layer and a hexbin
 * layer changes them at the same moments instead of at two different sets of
 * thresholds.
 *
 * **Input order is irrelevant to the result**, which is stronger than clustering
 * manages: a lattice cell is decided by arithmetic on a coordinate, so the same
 * points produce the same bins whatever order they arrive in. Only the order of
 * the returned array follows the data, and only so that a snapshot is stable.
 *
 * A bin is drawn at its cell's centre and never at its members' centre of mass.
 * That is the opposite of the choice `geo/Cluster` makes, and for the opposite
 * reason: a cluster marker stands for the points, so it belongs where they are,
 * while a bin stands for the patch, and sliding it towards whichever corner the
 * points happened to occupy would misreport which patch was measured.
 *
 * @module geo/Hexbin
 */

import type { WorldPoint } from '../types'

/** One point to bin, and the value it carries. */
export interface BinInput {
  /** Index into the caller's own item array. */
  index: number
  world: WorldPoint
  /** Null for a point that is only being counted. */
  value?: number | null
}

export interface HexBin {
  /** Axial lattice coordinates, which are the bin's identity across redraws. */
  q: number
  r: number
  /** The cell's own centre in world space. */
  world: WorldPoint
  /** Item indices that landed here, in input order. */
  members: number[]
  count: number
  /** Over the members that carried a finite value; `values` is how many did. */
  sum: number
  min: number
  max: number
  values: number
}

export type BinOrientation = 'pointy' | 'flat'

export interface BinOptions {
  /** Cell radius, centre to vertex, in **screen** pixels. */
  radius: number
  /** Camera scale the binning is for. Screen distance = world distance * k. */
  zoom: number
  orientation?: BinOrientation
}

export type BinAggregate = 'count' | 'sum' | 'mean' | 'min' | 'max'

/**
 * Round fractional axial coordinates to the cell that contains the point.
 *
 * Rounding q and r independently lands outside the intended cell near its
 * corners, because axial space is a sheared grid. Cube space is not: the three
 * coordinates sum to zero, so rounding all three and then repairing whichever
 * moved furthest gives the true nearest centre.
 */
function axialRound(qf: number, rf: number): [number, number] {
  const yf = -qf - rf
  let x = Math.round(qf)
  let z = Math.round(rf)
  const y = Math.round(yf)
  const dx = Math.abs(x - qf)
  const dy = Math.abs(y - yf)
  const dz = Math.abs(z - rf)

  // Repair whichever coordinate moved furthest, so the three sum to zero again.
  // When that is y there is nothing to repair: y is derived from the other two
  // and is not part of the answer, so x and z stand as they rounded.
  if (dx > dy && dx > dz) x = -y - z
  else if (dz >= dy) z = -x - y

  // Adding zero, because Math.round(-0.2) is -0 and a lattice coordinate that
  // compares unequal to its own value is a trap for every caller downstream.
  return [x + 0, z + 0]
}

const SQRT3 = Math.sqrt(3)

/** The lattice cell a world point falls in. */
export function cellOf(
  [x, y]: WorldPoint,
  radius: number,
  orientation: BinOrientation,
): [number, number] {
  if (orientation === 'flat') {
    return axialRound(((2 / 3) * x) / radius, (-x / 3 + (SQRT3 / 3) * y) / radius)
  }
  return axialRound(((SQRT3 / 3) * x - y / 3) / radius, ((2 / 3) * y) / radius)
}

/** The world-space centre of a lattice cell. */
export function centreOf(
  q: number,
  r: number,
  radius: number,
  orientation: BinOrientation,
): WorldPoint {
  if (orientation === 'flat') {
    return [radius * 1.5 * q, radius * SQRT3 * (r + q / 2)]
  }
  return [radius * SQRT3 * (q + r / 2), radius * 1.5 * r]
}

/**
 * The outline of a cell, as world-space offsets from its centre.
 *
 * Offsets rather than absolute points because every cell in a layer is the same
 * shape: the ring is computed once and translated per bin, which is the whole
 * reason a hexbin layer of ten thousand cells costs about what one costs.
 */
export function cellRing(radius: number, orientation: BinOrientation): WorldPoint[] {
  const turn = orientation === 'flat' ? 0 : Math.PI / 6
  return Array.from({ length: 6 }, (_, i) => {
    const angle = turn + (i * Math.PI) / 3
    return [radius * Math.cos(angle), radius * Math.sin(angle)] as WorldPoint
  })
}

/**
 * Bin points onto a hexagonal lattice.
 *
 * Returns one entry per occupied cell. Empty cells are absent rather than
 * present with a count of zero: a density map should show where the data is, and
 * a lattice over a whole projection is mostly ocean.
 */
export function binPoints(points: readonly BinInput[], options: BinOptions): HexBin[] {
  const { radius, zoom } = options
  const orientation = options.orientation ?? 'pointy'
  if (!points.length) return []

  // Screen pixels to world units, exactly as clustering does it. At high zoom
  // this is small, which is why the lattice refines as the reader zooms in.
  const worldRadius = radius / Math.max(zoom, 1e-9)
  if (!(worldRadius > 0) || !Number.isFinite(worldRadius)) return []

  const bins = new Map<string, HexBin>()
  const order: HexBin[] = []

  for (const point of points) {
    const [x, y] = point.world
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue

    const [q, r] = cellOf(point.world, worldRadius, orientation)
    const id = `${q},${r}`
    let bin = bins.get(id)
    if (!bin) {
      bin = {
        q,
        r,
        world: centreOf(q, r, worldRadius, orientation),
        members: [],
        count: 0,
        sum: 0,
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
        values: 0,
      }
      bins.set(id, bin)
      order.push(bin)
    }

    bin.members.push(point.index)
    bin.count++
    const value = point.value
    if (value != null && Number.isFinite(value)) {
      bin.sum += value
      bin.values++
      if (value < bin.min) bin.min = value
      if (value > bin.max) bin.max = value
    }
  }

  return order
}

/**
 * The number a bin is coloured by.
 *
 * Null rather than zero when an aggregate has nothing to work on, so the scale
 * treats the bin as having no data instead of as having a real value of zero.
 * `'count'` always answers, which is why it is the default: a hexbin over points
 * that carry no value at all is still a perfectly good density map.
 */
export function aggregateOf(bin: HexBin, aggregate: BinAggregate): number | null {
  if (aggregate === 'count') return bin.count
  if (!bin.values) return null
  switch (aggregate) {
    case 'sum':
      return bin.sum
    case 'mean':
      return bin.sum / bin.values
    case 'min':
      return bin.min
    case 'max':
      return bin.max
    default:
      return null
  }
}
