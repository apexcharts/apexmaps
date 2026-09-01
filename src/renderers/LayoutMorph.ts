/**
 * The same regions changing between their real boundaries and their layout cells.
 *
 * Every other transition in ApexMaps is a CSS transition on a property the
 * browser interpolates for us, which is what keeps them free of per-frame cost.
 * This one cannot be: no browser interpolates an SVG `d`, and the outline
 * changing *is* the effect. So this is the one renderer that does vertex work
 * every frame, and it declines rather than degrading whenever the motion budget
 * says the map is too big for that.
 *
 * It is worth the cost because of what a reader learns from it. A hex tile map
 * is a cartogram, and the single hardest thing about reading one is knowing
 * which cell is which region: the whole point is that Rhode Island is as big as
 * Texas, which is also exactly what destroys the reader's usual way in. Snapping
 * between the two representations makes them two unrelated pictures. Watching
 * Texas walk to its cell makes them one picture, seen twice, and the reader
 * keeps the map they already knew.
 *
 * Three things have to be right or the effect reads as a glitch rather than a
 * morph, and all three are about correspondence rather than about timing:
 *
 * 1. **Equal sampling.** A hexagon has six vertices and Michigan has hundreds.
 *    Interpolating by vertex index would fold the coastline into a corner, so
 *    both sides are resampled to the same count at equal arc length first.
 * 2. **Rotation.** Sample zero lands wherever the source data happened to start
 *    its ring. Left alone, every state spins on its way into its cell. So the
 *    cyclic offset that sits closest to the target is found once, up front.
 * 3. **Winding.** Two rings wound opposite ways turn the shape inside out
 *    halfway through. Screen winding depends on both the source data and the
 *    projection, and a hex layout and a boundary pack do not share a projection,
 *    so it is measured rather than assumed.
 *
 * @module renderers/LayoutMorph
 */

import { resolveEase } from '../utils/easing'

/** A closed ring as `[x, y]` pairs in plot-box pixels. The close is implicit. */
export type MorphRing = [number, number][]

/** One region to move, and the two shapes it moves between. */
export interface MorphPair {
  el: SVGPathElement
  from: string
  to: string
}

interface Tween {
  el: SVGPathElement
  rings: { from: MorphRing; to: MorphRing }[]
  /** The renderer's own string, so the morph lands on it exactly. */
  to: string
}

/**
 * Samples per ring: the richer of the two sides, within these bounds.
 *
 * A flat count cannot serve both ends of this. Sixty-four is generous for Rhode
 * Island and coarse for Texas, whose main ring has 678 vertices, so the last
 * frame of a flat-64 morph visibly pops as the Rio Grande gains back its detail.
 * Taking each ring's own complexity spends the points where the outline has
 * something to spend them on, and the total lands near what the renderer already
 * writes for the same map: about 11,000 points for the US at 10m detail.
 *
 * The ceiling is where more vertices stop being visible at map scale. The floor
 * is for the specks: Alaska is 137 rings, all but a handful of them Aleutian
 * islands a pixel or two across, and they still have to travel or they pop.
 */
const MIN_SAMPLES = 8
const MAX_SAMPLES = 192

/**
 * Points used to *find* the rotation, as opposed to draw the ring.
 *
 * The search is quadratic, so running it at full resolution on a 192-point ring
 * costs 37,000 comparisons to answer a question that 64 points already answer to
 * within a hundredth of the perimeter.
 */
const ALIGN_SAMPLES = 64

/** Anything not drawn by `M`, `L` and `Z` cannot be sampled by this. */
const STRAIGHT_LINES_ONLY = /^[MLZ0-9eE,.\s+-]*$/

/**
 * The rings of a path string, or null if it holds anything but straight lines.
 *
 * d3-geo draws a projected polygon with `M`, `L` and `Z` and nothing else, which
 * is what makes this a dozen lines rather than a dependency. Anything else, such
 * as the arc a point radius emits, is a shape this cannot sample, and returning
 * null lets the caller leave that mark alone rather than draw it wrong.
 */
export function ringsOf(d: string): MorphRing[] | null {
  if (!d || !STRAIGHT_LINES_ONLY.test(d)) return null

  const rings: MorphRing[] = []
  let ring: MorphRing | null = null
  const close = (): void => {
    // Two points cannot enclose anything, and a degenerate ring would divide by
    // a zero perimeter when it was sampled.
    if (ring && ring.length > 2) rings.push(ring)
    ring = null
  }

  for (const [, command, rest] of d.matchAll(/([MLZ])([^MLZ]*)/g)) {
    if (command === 'Z') {
      close()
      continue
    }
    if (command === 'M') {
      close()
      ring = []
    }
    if (!ring) return null

    const numbers = rest
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
    if (numbers.length % 2 !== 0) return null
    for (let i = 0; i < numbers.length; i += 2) {
      const x = numbers[i]
      const y = numbers[i + 1]
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null
      ring.push([x, y])
    }
  }
  close()
  return rings.length ? rings : null
}

/** Twice the signed area, whose sign is the winding direction. */
function signedArea(ring: MorphRing): number {
  let sum = 0
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % n]
    sum += a[0] * b[1] - b[0] * a[1]
  }
  return sum
}

/**
 * The mean of a ring's vertices.
 *
 * Not the area centroid, deliberately: this is only ever used as the point an
 * unmatched island collapses to, and for that "somewhere inside the shape" is
 * the whole requirement.
 */
function meanOf(ring: MorphRing): [number, number] {
  let x = 0
  let y = 0
  for (const point of ring) {
    x += point[0]
    y += point[1]
  }
  return [x / ring.length, y / ring.length]
}

/** `count` points at equal arc length around a closed ring. */
export function resample(ring: MorphRing, count: number): MorphRing {
  const n = ring.length
  const lengths = new Array<number>(n)
  let total = 0
  for (let i = 0; i < n; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % n]
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    lengths[i] = length
    total += length
  }

  const out: MorphRing = []
  if (!(total > 0)) {
    // A ring with no perimeter is a point, and a point resamples to itself.
    for (let k = 0; k < count; k++) out.push([ring[0][0], ring[0][1]])
    return out
  }

  let segment = 0
  let walked = 0
  for (let k = 0; k < count; k++) {
    const target = (k / count) * total
    while (segment < n - 1 && walked + lengths[segment] < target) {
      walked += lengths[segment]
      segment++
    }
    const a = ring[segment]
    const b = ring[(segment + 1) % n]
    const t = lengths[segment] > 0 ? (target - walked) / lengths[segment] : 0
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
  }
  return out
}

/**
 * The cyclic offset of `from` whose points sit closest to `to`.
 *
 * Brute force over every offset of a decimated copy, once per ring at setup
 * rather than per frame. The running-cost cutoff takes most of the rest back: a
 * wrong offset usually passes the best one within a handful of points.
 */
function alignOffset(from: MorphRing, to: MorphRing): number {
  const n = to.length
  const step = Math.max(1, Math.ceil(n / ALIGN_SAMPLES))
  const m = Math.floor(n / step)
  let best = 0
  let bestCost = Number.POSITIVE_INFINITY
  for (let k = 0; k < m; k++) {
    let cost = 0
    for (let i = 0; i < m && cost < bestCost; i++) {
      const a = from[((i + k) * step) % n]
      const b = to[(i * step) % n]
      cost += (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2
    }
    if (cost < bestCost) {
      bestCost = cost
      best = k
    }
  }
  return (best * step) % n
}

/** How finely to draw one ring pair: the richer side decides. */
function sampleCount(...rings: MorphRing[]): number {
  const richest = Math.max(...rings.map((ring) => ring.length))
  return Math.max(MIN_SAMPLES, Math.min(MAX_SAMPLES, richest))
}

/** Rings biggest first, so the two sides pair mainland with mainland. */
function byDescendingArea(rings: MorphRing[]): MorphRing[] {
  return rings
    .map((ring) => ({ ring, area: Math.abs(signedArea(ring)) }))
    .sort((a, b) => b.area - a.area)
    .map((entry) => entry.ring)
}

/**
 * Pair a region's rings across the two shapes, resampled and aligned.
 *
 * Ring counts almost never match: Hawaii is eight islands on one side and one
 * hexagon on the other. The shorter side is padded with rings collapsed onto
 * the other side's largest ring, so the extra islands fly into the cell and
 * vanish into it instead of popping out of existence.
 */
function pairRings(from: MorphRing[], to: MorphRing[]): Tween['rings'] {
  const a = byDescendingArea(from)
  const b = byDescendingArea(to)
  const collapseA = meanOf(a[0])
  const collapseB = meanOf(b[0])
  const pairs: Tween['rings'] = []

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const source = a[i]
    const target = b[i]
    if (source && target) {
      const n = sampleCount(source, target)
      const sampled = resample(source, n)
      const wanted = resample(target, n)
      // Opposite winding turns the shape inside out halfway through.
      if (signedArea(source) * signedArea(target) < 0) sampled.reverse()
      const offset = alignOffset(sampled, wanted)
      pairs.push({
        from: wanted.map((_, k) => sampled[(k + offset) % n]),
        to: wanted,
      })
    } else if (source) {
      const n = sampleCount(source)
      pairs.push({
        from: resample(source, n),
        to: Array.from({ length: n }, () => [...collapseB] as [number, number]),
      })
    } else {
      const n = sampleCount(target)
      pairs.push({
        from: Array.from({ length: n }, () => [...collapseA] as [number, number]),
        to: resample(target, n),
      })
    }
  }
  return pairs
}

export class LayoutMorph {
  private tweens: Tween[] = []
  private frame: number | null = null
  /** -1 until the first frame, because a timestamp of 0 is a real timestamp. */
  private started = -1
  private duration = 0
  private ease = resolveEase('cubicInOut')
  private onDone: (() => void) | undefined
  private done = false

  private constructor() {}

  /**
   * Start a morph, or return null when there is nothing to move.
   *
   * Null is a normal outcome: a pair whose path this cannot sample, a duration
   * of zero, or a region that is in one representation and not the other are all
   * cases where the caller should simply keep what the renderer already drew.
   */
  static run({
    pairs,
    duration,
    ease,
    onDone,
  }: {
    pairs: MorphPair[]
    duration: number
    ease?: string
    /** Called exactly once, whether the morph finished or was cut short. */
    onDone?: () => void
  }): LayoutMorph | null {
    if (!pairs.length || duration <= 0 || typeof requestAnimationFrame !== 'function') return null

    const morph = new LayoutMorph()
    morph.duration = duration
    morph.ease = resolveEase(ease, 'cubicInOut')
    morph.onDone = onDone

    for (const pair of pairs) {
      const from = ringsOf(pair.from)
      const to = ringsOf(pair.to)
      if (!from || !to) continue
      morph.tweens.push({ el: pair.el, rings: pairRings(from, to), to: pair.to })
    }
    if (!morph.tweens.length) return null

    // Paint the start before asking for a frame, so the first thing the reader
    // sees is the old shape in the new place rather than one frame of the new
    // shape followed by the morph starting from it.
    morph.paint(0)
    morph.frame = requestAnimationFrame(morph.step)
    return morph
  }

  private step = (now: number): void => {
    if (this.started < 0) this.started = now
    const t = Math.min(1, (now - this.started) / this.duration)
    if (t >= 1) {
      this.frame = null
      this.settle()
      return
    }
    this.paint(this.ease(t))
    this.frame = requestAnimationFrame(this.step)
  }

  private paint(t: number): void {
    for (const tween of this.tweens) {
      let d = ''
      for (const { from, to } of tween.rings) {
        for (let i = 0; i < to.length; i++) {
          const a = from[i]
          const b = to[i]
          // Two decimals: the rest is below a pixel, and the string build is
          // most of what this costs per frame.
          d += `${i === 0 ? 'M' : 'L'}${(a[0] + (b[0] - a[0]) * t).toFixed(2)},${(
            a[1] +
            (b[1] - a[1]) * t
          ).toFixed(2)}`
        }
        d += 'Z'
      }
      tween.el.setAttribute('d', d)
    }
  }

  /**
   * Put every mark back to the string the renderer drew, and let go of them.
   *
   * Idempotent, because both the natural end and `destroy` arrive here and a
   * caller that restores chrome in `onDone` must not be told twice.
   */
  private settle(): void {
    for (const tween of this.tweens) tween.el.setAttribute('d', tween.to)
    this.tweens = []
    if (this.done) return
    this.done = true
    this.onDone?.()
  }

  /**
   * Stop now, wherever it got to.
   *
   * Every mark lands on its target either way: a morph cut short must never
   * leave a region holding a shape halfway between two geographies, because
   * nothing downstream would ever correct it.
   */
  destroy(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame)
      this.frame = null
    }
    this.settle()
  }
}
