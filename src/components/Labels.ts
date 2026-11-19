/**
 * Feature labels, with collision avoidance.
 *
 * Label placement is where maps built in a chart library usually look weakest
 * next to a dedicated mapping tool, so even the phase-1 version does the things
 * that matter:
 *
 * - **Priority ordering.** Larger and higher-valued features win, so dropping
 *   labels degrades gracefully instead of arbitrarily.
 * - **Axis-aligned collision** against already-placed labels.
 * - **Area gating.** A label wider than its feature is noise.
 * - **Halo by default** via `paint-order`, so text stays readable on any fill.
 *
 * Labels are drawn in the screen-space overlay, not the world group: text must
 * not scale with the camera. They are re-laid-out on camera change, which is
 * cheap because the candidate set is small and pre-sorted.
 *
 * @module components/Labels
 */

import { svg, empty } from '../utils/dom'
import type { SvgRenderer } from '../renderers/SvgRenderer'
import type { GeoPathLike, Viewport } from '../geo/Viewport'
import type { Anchor, DataLabelOptions, NormalizedFeature, WorldPoint } from '../types'

export interface LabelCandidate {
  text: string
  /** Anchor in world space. */
  world: WorldPoint
  /** Higher wins when labels collide. */
  priority: number
  /** Approximate world-space area, in square pixels. */
  featureArea: number
  color?: string
  key?: string
}

export class Labels {
  readonly renderer: SvgRenderer
  readonly viewport: Viewport
  /** Re-pointed at the live config on every draw; see `_syncComponentOptions`. */
  options: DataLabelOptions
  candidates: LabelCandidate[] = []
  group: SVGGElement | null = null
  placedCount = 0
  droppedCount = 0

  constructor({
    renderer,
    viewport,
    options,
  }: {
    renderer: SvgRenderer
    viewport: Viewport
    options: DataLabelOptions
  }) {
    this.renderer = renderer
    this.viewport = viewport
    this.options = options || {}
  }

  setCandidates(candidates: LabelCandidate[]): void {
    // Sort once: layout runs on every camera change, so ordering must not.
    this.candidates = [...candidates].sort((a, b) => b.priority - a.priority)
  }

  /**
   * Lay out and draw. Called after every render and camera change.
   *
   * @param reserved Screen-space boxes already occupied, currently the
   *   annotation chips. A generated label yields to an annotation rather than
   *   the other way round: the annotation was placed deliberately and the label
   *   was produced by a rule, so the rule is the one that should give way.
   */
  layout(reserved: readonly Box[] = []): void {
    const overlay = this.renderer.overlay()
    if (!overlay) return

    if (!this.group) {
      this.group = svg('g', {
        class: 'apexmaps-labels',
        'pointer-events': 'none',
      })
      overlay.appendChild(this.group)
    }
    empty(this.group)

    if (this.options.enabled === false || !this.candidates.length) {
      this.placedCount = 0
      this.droppedCount = 0
      return
    }

    const style = this.options.style || {}
    const fontSize = style.fontSize ?? 11
    const fontWeight = style.fontWeight ?? 500
    // Unset by default, so the label inherits the chart's font as it always has.
    const fontFamily = style.fontFamily || undefined
    const collide = this.options.collision !== 'none'
    const minArea = this.options.minFeatureArea ?? 240
    const k = this.viewport.camera.k

    const placed: Box[] = [...reserved]
    let dropped = 0

    for (const candidate of this.candidates) {
      const screen = this.viewport.worldToScreen(candidate.world)
      if (!isFinite(screen[0]) || !isFinite(screen[1])) continue

      // Cull offscreen before doing any measurement work.
      if (
        screen[0] < -50 ||
        screen[1] < -50 ||
        screen[0] > this.viewport.width + 50 ||
        screen[1] > this.viewport.height + 50
      ) {
        continue
      }

      // Feature area scales with k^2, so a label that does not fit at low zoom
      // may fit once the reader zooms in. This is the cheap form of
      // zoom-dependent label density.
      if (minArea > 0 && candidate.featureArea * k * k < minArea) {
        dropped++
        continue
      }

      // Estimated, not measured: measuring needs a reflow per label, which is
      // exactly the per-frame cost to avoid. See `estimateTextWidth`.
      const width = estimateTextWidth(candidate.text, fontSize, fontFamily)
      const height = fontSize * 1.15
      const box = {
        x0: screen[0] - width / 2,
        y0: screen[1] - height / 2,
        x1: screen[0] + width / 2,
        y1: screen[1] + height / 2,
      }

      if (collide && placed.some((p) => intersects(p, box))) {
        dropped++
        continue
      }
      placed.push(box)

      const text = svg('text', {
        class: 'apexmaps-label',
        x: screen[0],
        y: screen[1],
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
        'font-size': fontSize,
        'font-weight': fontWeight,
        fill: candidate.color || 'currentColor',
        text: candidate.text,
      })
      if (fontFamily) text.setAttribute('font-family', fontFamily)

      if (style.halo !== false) {
        // paint-order puts the stroke behind the fill, which is how a halo is
        // done without duplicating the element.
        text.setAttribute('paint-order', 'stroke')
        text.setAttribute(
          'stroke',
          style.haloColor || 'var(--_apexmaps-halo, rgba(255,255,255,0.85))',
        )
        text.setAttribute('stroke-width', String(style.haloWidth ?? 2.5))
        text.setAttribute('stroke-linejoin', 'round')
      }

      this.group.appendChild(text)
    }

    // Reserved boxes were never labels, so they must not inflate the count a
    // diagnostic or a test reads.
    this.placedCount = placed.length - reserved.length
    this.droppedCount = dropped
  }

  destroy(): void {
    if (this.group && this.group.parentNode) this.group.parentNode.removeChild(this.group)
    this.group = null
    this.candidates = []
  }
}

/** An axis-aligned screen-space box, the unit of label collision. */
export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

function intersects(a: Box, b: Box): boolean {
  return !(b.x0 > a.x1 || b.x1 < a.x0 || b.y0 > a.y1 || b.y1 < a.y0)
}

/**
 * Code point ranges drawn a full em wide: the East Asian Wide and Fullwidth
 * blocks (CJK ideographs and their extensions, kana, hangul, CJK symbols and
 * punctuation, fullwidth forms) and the pictographs Unicode also classes as
 * wide, which is every character with an emoji presentation by default. Sorted,
 * so the lookup can stop early.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo, leading consonants
  [0x231a, 0x231b], // watch, hourglass
  [0x2329, 0x232a], // angle brackets
  [0x23e9, 0x23ec], // media controls
  [0x23f0, 0x23f0], // alarm clock
  [0x23f3, 0x23f3], // hourglass flowing
  [0x25fd, 0x25fe], // medium small squares
  [0x2614, 0x2615], // umbrella with rain, hot beverage
  [0x2648, 0x2653], // zodiac signs
  [0x267f, 0x267f], // wheelchair
  [0x2693, 0x2693], // anchor
  [0x26a1, 0x26a1], // high voltage
  [0x26aa, 0x26ab], // medium circles
  [0x26bd, 0x26be], // soccer ball, baseball
  [0x26c4, 0x26c5], // snowman, sun behind cloud
  [0x26ce, 0x26ce], // ophiuchus
  [0x26d4, 0x26d4], // no entry
  [0x26ea, 0x26ea], // church
  [0x26f2, 0x26f3], // fountain, flag in hole
  [0x26f5, 0x26f5], // sailboat
  [0x26fa, 0x26fa], // tent
  [0x26fd, 0x26fd], // fuel pump
  [0x2705, 0x2705], // check mark button
  [0x270a, 0x270b], // raised fist, raised hand
  [0x2728, 0x2728], // sparkles
  [0x274c, 0x274c], // cross mark
  [0x274e, 0x274e], // cross mark button
  [0x2753, 0x2755], // question and exclamation ornaments
  [0x2757, 0x2757], // exclamation mark
  [0x2795, 0x2797], // heavy plus, minus, division
  [0x27b0, 0x27b0], // curly loop
  [0x27bf, 0x27bf], // double curly loop
  [0x2b1b, 0x2b1c], // large squares
  [0x2b50, 0x2b50], // star
  [0x2b55, 0x2b55], // heavy circle
  [0x2e80, 0x303e], // CJK radicals, Kangxi radicals, CJK symbols and punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul compatibility jamo, CJK compatibility
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // Vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // Fullwidth ASCII variants
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f004, 0x1f004], // mahjong red dragon
  [0x1f0cf, 0x1f0cf], // joker
  [0x1f18e, 0x1f18e], // AB button
  [0x1f191, 0x1f19a], // squared CL to VS
  [0x1f200, 0x1f2ff], // enclosed ideographic supplement
  [0x1f300, 0x1f64f], // pictographs, emoticons
  [0x1f680, 0x1f6ff], // transport and map symbols
  [0x1f900, 0x1f9ff], // supplemental symbols and pictographs
  [0x1fa70, 0x1faff], // symbols and pictographs extended-A
  [0x20000, 0x2fffd], // CJK Unified Ideographs Extensions B onward, supplementary
  [0x30000, 0x3fffd], // CJK Unified Ideographs Extensions G onward
]

function isWide(codePoint: number): boolean {
  if (codePoint < 0x1100) return false
  for (const [from, to] of WIDE_RANGES) {
    if (codePoint < from) return false
    if (codePoint <= to) return true
  }
  return false
}

/**
 * Code points that add nothing to the width of the glyph they belong to:
 * combining accents and enclosing marks (the keycap), zero-width spaces and
 * joiners, variation selectors, emoji skin-tone modifiers and tag characters.
 */
function isZeroWidth(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) ||
    (codePoint >= 0xe0020 && codePoint <= 0xe007f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  )
}

/** Average advance of a proportional sans-serif glyph, in em. */
const NARROW_EM = 0.58
/** Every glyph in a monospace face is the same advance, a little wider. */
const MONO_EM = 0.6
/** Half of a flag: a flag is a pair of regional indicators drawn as one em-wide glyph. */
const REGIONAL_INDICATOR_EM = 0.5
const ZERO_WIDTH_JOINER = 0x200d
const EMOJI_PRESENTATION = 0xfe0f

/**
 * Approximate rendered width of one line of text, in px.
 *
 * The one estimator labels and annotation chips share, so a label and the chip
 * it yields to agree about how much room a string takes. Measuring for real
 * needs a reflow per string, which is the per-frame cost the label layout is
 * built to avoid, so this counts instead.
 *
 * Wide and fullwidth characters count as a full em. A CJK glyph sits on an
 * em square in every font that has one, so a flat per-character average built
 * for Latin text (about 0.58em) put a two-kanji label like 秋田 at a little over
 * half its real width, and the collision test let neighbours draw over it.
 * Emoji are wide too, and a narrow symbol asked for in emoji presentation
 * (U+FE0F after it) is drawn as one. Everything else uses that average.
 *
 * The font family only changes the answer where it matters to a count: a
 * monospace face sets every narrow glyph at the same 0.6em. Proportional faces
 * differ from each other by less than the error already in an average, so they
 * are not told apart, and the wide glyphs are an em whatever the face.
 *
 * Counted by code point, so a supplementary ideograph or emoji (two UTF-16
 * units) is one glyph, not two. Marks that only modify the glyph before them
 * (accents, variation selectors, skin tones) add nothing, and a character after
 * a zero-width joiner is part of the emoji before it. A pair of regional
 * indicators is one flag.
 */
export function estimateTextWidth(text: string, fontSize: number, fontFamily?: string): number {
  const narrow = isMonospace(fontFamily) ? MONO_EM : NARROW_EM
  let ems = 0
  let previous = 0
  let joined = false
  for (const char of String(text ?? '')) {
    const cp = char.codePointAt(0) ?? 0
    if (cp === ZERO_WIDTH_JOINER) {
      joined = true
      continue
    }
    if (joined) {
      joined = false
      continue
    }
    if (cp === EMOJI_PRESENTATION) {
      if (previous === narrow) ems += 1 - narrow
      previous = 0
      continue
    }
    if (isZeroWidth(cp)) continue
    previous = cp >= 0x1f1e6 && cp <= 0x1f1ff ? REGIONAL_INDICATOR_EM : isWide(cp) ? 1 : narrow
    ems += previous
  }
  return ems * fontSize
}

/** Whether the first family in a CSS font stack is a monospace face. */
function isMonospace(fontFamily: string | undefined): boolean {
  if (!fontFamily) return false
  const first = fontFamily
    .split(',')[0]
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase()
  return first === 'monospace' || /\bmono\b|courier|consolas|menlo/.test(first)
}

/**
 * Label anchor for a feature, in world space.
 *
 * The projected centroid of the feature's main part, falling back to the
 * bounding-box centre. The main part of a MultiPolygon is its largest polygon
 * on screen: a label names the region, so it belongs on the region's body, and
 * the centroid of a whole archipelago is a point in the sea between its
 * islands. Okinawa's lands about 130 km off Okinawa Island once the Amami
 * Islands are no longer drawn as part of it, and Tokyo's is pulled out over the
 * ocean by the Izu and Ogasawara islands. A feature drawn as one polygon is
 * anchored exactly as before.
 *
 * A proper pole-of-inaccessibility anchor (`polylabel`) is a phase-2 item: it
 * matters for concave shapes such as Florida or Chile where the centroid lands
 * offshore, and it is not worth the dependency until the label engine is doing
 * leader lines too.
 *
 * `area`, the gate on whether a label fits, is still the whole feature's box.
 */
export function labelAnchor(viewport: Viewport, feature: NormalizedFeature): Anchor | null {
  if (!viewport.path || !feature.geometry) return null

  const bounds = viewport.path.bounds(feature.geometry)
  if (!bounds || !isFinite(bounds[0][0])) return null
  const centroid = viewport.path.centroid(mainPart(viewport.path, feature.geometry))

  const area = Math.max(0, (bounds[1][0] - bounds[0][0]) * (bounds[1][1] - bounds[0][1]))
  const world: WorldPoint =
    centroid && Number.isFinite(centroid[0]) && Number.isFinite(centroid[1])
      ? [centroid[0], centroid[1]]
      : [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2]

  return { world, area }
}

type FeatureGeometry = NonNullable<NormalizedFeature['geometry']>

/**
 * The largest polygon of a MultiPolygon, measured as projected, or the geometry
 * itself. Projected rather than spherical so that on a globe a part turned
 * away from the reader, which projects to nothing, never wins.
 */
function mainPart(path: GeoPathLike, geometry: FeatureGeometry): FeatureGeometry {
  if (geometry.type !== 'MultiPolygon' || geometry.coordinates.length < 2) return geometry
  let best: FeatureGeometry | null = null
  let bestArea = 0
  for (const coordinates of geometry.coordinates) {
    const part: FeatureGeometry = { type: 'Polygon', coordinates }
    const area = path.area(part)
    if (area > bestArea) {
      bestArea = area
      best = part
    }
  }
  return best ?? geometry
}
