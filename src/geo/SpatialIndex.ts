/**
 * A static R-tree over world-space bounding boxes.
 *
 * This exists because the Canvas tier has no DOM. In SVG mode the browser does
 * hit testing for us: the pointer lands on a `<path>` and the event carries the
 * element. A canvas is one element, so "which of 3,231 counties is under the
 * pointer" becomes our problem, and the naive answer (test every feature) is
 * O(n) on every pointer move, which is the cost the Canvas tier was adopted to
 * avoid in the first place.
 *
 * Three decisions worth stating:
 *
 * 1. **Static and bulk-loaded, not incremental.** The index is rebuilt exactly
 *    when the projected geometry changes (projection, size, or a new level),
 *    which is the same moment the cached paths are rebuilt. Nothing inserts or
 *    deletes into a live tree, so the insertion heuristics that make a dynamic
 *    R-tree complicated (and slow to query, because it degrades as it grows)
 *    are not needed. Bulk loading by Sort-Tile-Recursive packing gives a
 *    near-optimally packed tree in one pass.
 * 2. **It answers with candidates, never with an answer.** A bounding box is
 *    not a shape: Alaska's box spans the Pacific, and a pointer inside it is
 *    usually in open water. The index narrows thousands of features to a
 *    handful, and the caller does the exact test (`isPointInPath`) on those.
 *    Treating a box hit as a feature hit is the same mistake box-based
 *    selection made before it was changed to test anchors.
 * 3. **Written rather than depended on.** `rbush` is small and battle-tested,
 *    but this is a hundred lines of a well-understood algorithm against a
 *    package whose failure modes now live in the bundle and the supply chain,
 *    for a tree that never mutates. It is validated against brute-force search
 *    on randomised data, which is the only test that actually proves an index.
 *
 * @module geo/SpatialIndex
 */

import type { WorldBounds } from '../types'

/**
 * Entries per node. Nine is the usual sweet spot for R-trees: enough fan-out
 * that the tree stays shallow, small enough that a node's box stays tight and
 * a linear scan of its children is cache-friendly.
 */
const NODE_SIZE = 9

interface Node {
  minX: number
  minY: number
  maxX: number
  maxY: number
  /** Leaf payload: indices into the caller's array. Empty on internal nodes. */
  items: number[]
  children: Node[]
}

export class SpatialIndex {
  /** Number of indexed boxes. Degenerate or missing boxes are not indexed. */
  readonly size: number
  /** Bounds of everything indexed, or null when nothing was. */
  readonly bounds: WorldBounds | null

  private readonly root: Node | null

  private constructor(root: Node | null, size: number) {
    this.root = root
    this.size = size
    this.bounds = root
      ? [
          [root.minX, root.minY],
          [root.maxX, root.maxY],
        ]
      : null
  }

  /**
   * Build an index over boxes, keyed by their position in the array.
   *
   * @param boxes One entry per item, in the caller's own order. `null` (a
   *   feature the projection clipped away, or one with no geometry) is skipped
   *   rather than indexed at the origin, which would make it a candidate for
   *   every query near 0,0.
   */
  static build(boxes: readonly (WorldBounds | null | undefined)[]): SpatialIndex {
    const leaves: Node[] = []

    boxes.forEach((box, index) => {
      if (!box) return
      const [[minX, minY], [maxX, maxY]] = box
      // A non-finite box comes from geometry the projection could not place. It
      // would poison every ancestor's bounds, so it is dropped here.
      if (!Number.isFinite(minX) || !Number.isFinite(minY)) return
      if (!Number.isFinite(maxX) || !Number.isFinite(maxY)) return
      leaves.push({ minX, minY, maxX, maxY, items: [index], children: [] })
    })

    if (!leaves.length) return new SpatialIndex(null, 0)
    return new SpatialIndex(pack(leaves), leaves.length)
  }

  /**
   * Indices whose box intersects the query box, in no particular order.
   *
   * Intersection is inclusive: a box touching the query edge is returned. A hit
   * test that excluded the boundary would drop the pointer exactly on a border,
   * which is where readers aim when they are trying to pick a small country.
   */
  search(minX: number, minY: number, maxX: number, maxY: number): number[] {
    const out: number[] = []
    if (!this.root) return out
    if (!overlaps(this.root, minX, minY, maxX, maxY)) return out

    // An explicit stack rather than recursion: the tree is shallow, but this is
    // on the pointer-move path and avoids the call overhead entirely.
    const stack: Node[] = [this.root]
    while (stack.length) {
      const node = stack.pop() as Node
      if (node.children.length) {
        for (const child of node.children) {
          if (overlaps(child, minX, minY, maxX, maxY)) stack.push(child)
        }
      } else {
        // Leaves hold a single item in a packed tree, but the loop keeps the
        // structure honest rather than assuming it.
        for (const item of node.items) out.push(item)
      }
    }
    return out
  }

  /** Indices whose box contains a point. */
  searchPoint(x: number, y: number): number[] {
    return this.search(x, y, x, y)
  }

  /**
   * Indices near a point, within a radius. Used for stroked marks, whose ink
   * extends beyond the geometry's own box by half the stroke width.
   */
  searchNear(x: number, y: number, radius: number): number[] {
    return this.search(x - radius, y - radius, x + radius, y + radius)
  }
}

function overlaps(node: Node, minX: number, minY: number, maxX: number, maxY: number): boolean {
  return node.minX <= maxX && node.minY <= maxY && node.maxX >= minX && node.maxY >= minY
}

/**
 * Sort-Tile-Recursive packing.
 *
 * Each pass sorts the level by centre x, cuts it into vertical slices, sorts
 * each slice by centre y, and groups runs of `NODE_SIZE` into parents. Slicing
 * on both axes is what keeps parent boxes square-ish; packing on one axis alone
 * produces long thin nodes that overlap the query box far more often, which is
 * how a technically-correct R-tree ends up no faster than a linear scan.
 */
function pack(level: Node[]): Node {
  let nodes = level
  while (nodes.length > 1) {
    const parentCount = Math.ceil(nodes.length / NODE_SIZE)
    const sliceCount = Math.ceil(Math.sqrt(parentCount))
    const sliceSize = Math.ceil(nodes.length / sliceCount)

    nodes.sort(byCentreX)
    const parents: Node[] = []

    for (let start = 0; start < nodes.length; start += sliceSize) {
      const slice = nodes.slice(start, start + sliceSize)
      slice.sort(byCentreY)
      for (let i = 0; i < slice.length; i += NODE_SIZE) {
        parents.push(parentOf(slice.slice(i, i + NODE_SIZE)))
      }
    }

    nodes = parents
  }
  return nodes[0]
}

function parentOf(children: Node[]): Node {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const child of children) {
    if (child.minX < minX) minX = child.minX
    if (child.minY < minY) minY = child.minY
    if (child.maxX > maxX) maxX = child.maxX
    if (child.maxY > maxY) maxY = child.maxY
  }
  return { minX, minY, maxX, maxY, items: [], children }
}

function byCentreX(a: Node, b: Node): number {
  return a.minX + a.maxX - (b.minX + b.maxX)
}

function byCentreY(a: Node, b: Node): number {
  return a.minY + a.maxY - (b.minY + b.maxY)
}
