/**
 * The level a drilldown arrives at, developing out of the shape it came from.
 *
 * `LevelGhost` dissolves the level being left, which covers the surroundings
 * disappearing but says nothing about the level arriving: 58 counties are drawn
 * complete under the copy, so every boundary surfaces at the same moment and at
 * the same rate. What is missing is the part a reader reads as a morph, the
 * parent shape *dividing*.
 *
 * So the incoming marks are seeded with the parent's own fill and no boundaries,
 * which makes the new level start as a flat copy of the one shape both levels
 * share, and are then released in bands ordered by distance from the middle. Each
 * mark's fill and boundary arrive together, so the division ripples outwards from
 * the centre of the feature that was clicked.
 *
 * The two beats are deliberately sequenced rather than simultaneous: while the
 * copy is still fading, the only thing changing inside the parent shape is
 * nothing at all, because the seeded level is the same flat colour. The
 * surroundings go first, then the shape divides.
 *
 * Bands rather than a per-mark `transition-delay`, which is the obvious
 * implementation and the wrong one: a delay has to be written to each mark and
 * then taken off again, and until it is, that mark answers the reader's hover
 * late. A band is one timer for a slice of the level, nothing is written that has
 * to be cleaned up, and at a dozen bands over the spread each is about a frame
 * apart, which is as fine-grained as a display can show anyway.
 *
 * The transitions themselves are the ones `ApexMaps.css` already declares on
 * `--apexmaps-anim`. That is what keeps the effect free of any per-frame cost,
 * and it is also what makes it honour `chart.animations.speed` and the motion
 * budget without knowing they exist.
 *
 * @module renderers/LevelReveal
 */

/** One mark to develop, and where it sits in the order. */
export interface RevealMark {
  el: SVGElement
  /** 0 for the mark at the origin of the ripple, 1 for the furthest out. */
  order: number
}

/** What a mark was drawn as, so the release puts back exactly that. */
interface Held {
  el: SVGElement
  fill: string | null
  strokeOpacity: string | null
}

/**
 * Bands to break the ripple into.
 *
 * Twelve over a ~180ms spread is about one band per frame. More would be finer
 * than anything the reader could see, and fewer starts to read as a wipe in
 * steps rather than a ripple.
 */
const BANDS = 12

export class LevelReveal {
  private bands: Held[][] = []
  private frame: number | null = null
  private timers: ReturnType<typeof setTimeout>[] = []

  private constructor() {}

  /**
   * Seed every mark, then release them band by band.
   *
   * Returns null when there is nothing to develop or no motion to do it with, so
   * a caller can treat "no reveal" as a normal outcome rather than a failure.
   *
   * @param seed The fill the marks start from: the parent feature's own.
   * @param spread How long the ripple takes to reach the furthest band, in ms.
   */
  static run({
    marks,
    seed,
    spread,
  }: {
    marks: RevealMark[]
    seed: string
    spread: number
  }): LevelReveal | null {
    if (!marks.length || spread <= 0 || typeof requestAnimationFrame !== 'function') return null

    const reveal = new LevelReveal()
    reveal.bands = Array.from({ length: BANDS }, () => [])

    for (const { el, order } of marks) {
      const band = Math.min(BANDS - 1, Math.max(0, Math.floor(order * BANDS)))
      reveal.bands[band].push({
        el,
        fill: el.getAttribute('fill'),
        strokeOpacity: el.getAttribute('stroke-opacity'),
      })
      el.setAttribute('fill', seed)
      el.setAttribute('stroke-opacity', '0')
    }

    // The seed has to be committed in a frame of its own or there is only one
    // value for the transition to run between, which is the same reason the
    // copy's fade waits a frame before going to zero.
    reveal.frame = requestAnimationFrame(() => {
      reveal.frame = null
      reveal.releaseBand(0)
      const step = spread / (BANDS - 1)
      for (let band = 1; band < BANDS; band++) {
        reveal.timers.push(setTimeout(() => reveal.releaseBand(band), Math.round(band * step)))
      }
    })
    return reveal
  }

  /** Put one band's marks back to what they were drawn as, and let them transition. */
  private releaseBand(band: number): void {
    const held = this.bands[band]
    if (!held) return
    this.bands[band] = []
    for (const { el, fill, strokeOpacity } of held) {
      if (fill === null) el.removeAttribute('fill')
      else el.setAttribute('fill', fill)
      // Removed rather than set to 1: the renderer never writes this attribute,
      // and a transition to the initial value runs the same as one to an explicit
      // value, so the mark is left exactly as it was drawn.
      if (strokeOpacity === null) el.removeAttribute('stroke-opacity')
      else el.setAttribute('stroke-opacity', strokeOpacity)
    }
  }

  /**
   * Stop now, wherever it got to. Every mark ends up as drawn either way: a
   * reveal cut short must never leave the level holding a borrowed colour.
   */
  destroy(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame)
      this.frame = null
    }
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
    for (let band = 0; band < this.bands.length; band++) this.releaseBand(band)
    this.bands = []
  }
}

/**
 * Order items by how far they sit from a point, nearest first.
 *
 * Squared distances throughout the comparison: the ordering is identical and the
 * result is normalised against the furthest item anyway, so a square root per
 * item buys nothing. Items with no position sort last rather than being dropped,
 * so every mark in the level is accounted for by exactly one of the two paths.
 */
export function orderFromPoint<T>(
  items: readonly T[],
  origin: readonly [number, number],
  positionOf: (item: T) => readonly [number, number] | undefined,
): { item: T; order: number }[] {
  const measured = items.map((item) => {
    const at = positionOf(item)
    if (!at) return { item, d2: Number.POSITIVE_INFINITY }
    const dx = at[0] - origin[0]
    const dy = at[1] - origin[1]
    return { item, d2: dx * dx + dy * dy }
  })

  let max = 0
  for (const { d2 } of measured) if (Number.isFinite(d2) && d2 > max) max = d2
  return measured.map(({ item, d2 }) => ({
    item,
    order: !Number.isFinite(d2) || max <= 0 ? 1 : Math.sqrt(d2 / max),
  }))
}
