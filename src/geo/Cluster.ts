/**
 * Point clustering.
 *
 * Three decisions, each of which is visible on screen if you get it wrong.
 *
 * **1. Greedy radius clustering, not grid bucketing.** Bucketing points into grid
 * cells is a dozen lines and is what most quick implementations do, but it merges
 * by cell rather than by distance: two points a few pixels apart sit in different
 * cells and stay stubbornly separate, while two points at opposite corners of one
 * cell merge. Readers notice, because the map contradicts what they can see. So a
 * grid is used only as a *neighbour index*: cells are exactly one radius wide, so
 * every point within the radius is in the 3x3 cell block around it, and the
 * clustering itself is a genuine distance test. Same linear cost, correct result.
 * This is the approach Supercluster takes with a k-d tree.
 *
 * **2. Clustering happens in world space, at quantized zoom levels.** World
 * coordinates do not move when the camera pans, so a pan never reclusters and can
 * never make clusters shimmer or renumber under the reader's cursor. Zoom is
 * bucketed to half-levels and cached, so a smooth pinch recomputes a handful of
 * times rather than sixty times a second.
 *
 * **3. Input order decides cluster seeds.** Deterministic: the same data always
 * produces the same clusters, which matters for snapshot tests and for a reader
 * who pans away and comes back.
 *
 * @module geo/Cluster
 */

import type { WorldPoint } from '../types'

export interface ClusterInput {
  /** Index into the caller's own item array. */
  index: number
  world: WorldPoint
}

export interface Cluster {
  /** Centre of mass of the members, in world space. */
  world: WorldPoint
  /** Item indices that were merged. Length 1 means an unclustered point. */
  members: number[]
  count: number
  /** World-space bounds of the members, for zoom-to-fit on click. */
  bounds: [WorldPoint, WorldPoint]
}

export interface ClusterOptions {
  /** Merge distance in **screen** pixels. */
  radius: number
  /** Camera scale the clustering is for. Screen distance = world distance * k. */
  zoom: number
  /** Groups smaller than this are emitted as individual points. */
  minPoints?: number
}

/**
 * Quantize a camera scale to a stable clustering level.
 *
 * Half-steps of log2 mean a 2x zoom passes through two reclusters, which is often
 * enough that clusters visibly respond to zooming and rare enough that a pinch
 * gesture is not a recompute storm.
 *
 */
export function clusterLevel(zoom: number): number {
  if (!(zoom > 0)) return 0
  return Math.round(Math.log2(zoom) * 2) / 2
}

/** The camera scale a level represents, which is what the merge distance uses. */
export function levelScale(level: number): number {
  return 2 ** level
}

/**
 * Merge points that fall within `radius` screen pixels of each other.
 *
 * Returns one entry per drawn mark, in input order of the seeds, so the result is
 * stable across calls.
 *
 */
export function clusterPoints(points: readonly ClusterInput[], options: ClusterOptions): Cluster[] {
  const { radius, zoom } = options
  const minPoints = Math.max(2, options.minPoints ?? 2)

  if (!points.length) return []

  // Screen pixels to world units. At high zoom this is a small number, which is
  // exactly why clusters dissolve as the reader zooms in.
  const worldRadius = radius / Math.max(zoom, 1e-9)
  if (!(worldRadius > 0) || !isFinite(worldRadius)) {
    return points.map((p) => single(p))
  }

  // Grid index with cells exactly one radius wide, so the neighbourhood of any
  // point is contained in the 3x3 block of cells around it.
  const cells = new Map<string, number[]>()
  const cellOf = (world: WorldPoint) => [
    Math.floor(world[0] / worldRadius),
    Math.floor(world[1] / worldRadius),
  ]

  points.forEach((point, i) => {
    const [cx, cy] = cellOf(point.world)
    const key = `${cx},${cy}`
    const bucket = cells.get(key)
    if (bucket) bucket.push(i)
    else cells.set(key, [i])
  })

  const taken = new Array<boolean>(points.length).fill(false)
  const clusters: Cluster[] = []
  const radiusSquared = worldRadius * worldRadius

  for (let i = 0; i < points.length; i++) {
    if (taken[i]) continue
    const seed = points[i]
    taken[i] = true

    const [cx, cy] = cellOf(seed.world)
    const members: number[] = [i]

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = cells.get(`${cx + dx},${cy + dy}`)
        if (!bucket) continue
        for (const j of bucket) {
          if (taken[j]) continue
          const ox = points[j].world[0] - seed.world[0]
          const oy = points[j].world[1] - seed.world[1]
          if (ox * ox + oy * oy <= radiusSquared) {
            taken[j] = true
            members.push(j)
          }
        }
      }
    }

    if (members.length < minPoints) {
      // Too few to be worth a cluster. Emit them as individual marks, and leave
      // them taken so a later seed does not claim them and produce a duplicate.
      for (const m of members) clusters.push(single(points[m]))
      continue
    }

    clusters.push(aggregate(points, members))
  }

  return clusters
}

function single(point: ClusterInput): Cluster {
  return {
    world: point.world,
    members: [point.index],
    count: 1,
    bounds: [point.world, point.world],
  }
}

function aggregate(points: readonly ClusterInput[], members: number[]): Cluster {
  let sx = 0
  let sy = 0
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const m of members) {
    const [x, y] = points[m].world
    sx += x
    sy += y
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }

  const n = members.length
  return {
    // Centre of mass, not the seed's position: a cluster drawn on its first member
    // sits off to one side of the group it represents.
    world: [sx / n, sy / n],
    members: members.map((m) => points[m].index),
    count: n,
    bounds: [
      [minX, minY],
      [maxX, maxY],
    ],
  }
}
