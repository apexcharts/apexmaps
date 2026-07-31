/**
 * Pattern and image fills.
 *
 * A flat fill is one attribute. Anything else is a document-level resource: SVG
 * paints texture through `<pattern>` in `<defs>`, referenced by id, so a textured
 * map is no longer "colour per feature" but "a small set of paints, shared". That
 * shape is the whole design here.
 *
 * **Paints are deduplicated by what they look like.** Five classes across three
 * thousand features is five `<pattern>` elements, because the key is the resolved
 * spec and identical specs land on the same def. Image fills are the exception and
 * are inherently per-feature: the tile is positioned on the feature's own bounding
 * box, so a hundred flags really are a hundred defs.
 *
 * **Texture holds its size on screen; imagery does not.** A pattern resolves in
 * the user space of the element referencing it, and that element sits under the
 * camera transform, so an untouched tile grows with the zoom. Texture is rescaled
 * per camera frame by the inverse (`applyScale`), on the same reasoning as
 * `vector-effect: non-scaling-stroke` on borders: dots that swell into blobs stop
 * reading as a fill. An image fill is left alone deliberately, because there the
 * scaling is the point: the picture is pinned to the ground it describes and the
 * reader zooms into it.
 *
 * **Ids are namespaced per registry.** Two maps on one page, or one map exported
 * next to another, would otherwise collide on `#p0` and each would paint with
 * whichever def the document happened to define last.
 *
 * @module renderers/Paint
 */

import { contrastRatio, darken } from '../scales/Color'
import { remove, setAttrs, svg } from '../utils/dom'
import type { PatternFillOptions, ResolvedPattern, WorldBounds } from '../types'

/**
 * Tile edge in screen pixels: the spacing between one dot, bar or square and the
 * next.
 *
 * Ten rather than the six or eight that a first attempt reaches for, and the
 * reason is the whole visual argument for the ink weights below. The fill is
 * still the colour; the tile is a mark *on* it. Tight spacing makes the two
 * compete, the ink starts averaging with the background into a fourth colour
 * that is on no scale, and neighbouring classes stop being separable, which is
 * the exact job the texture was added to do.
 */
const DEFAULT_SIZE = 10

/**
 * Ink coverage, as a fraction of the tile, for each family.
 *
 * These are the numbers that decide whether a patterned map looks drawn or looks
 * clogged, so they are named rather than sprinkled through the geometry.
 *
 * Around a tenth of the tile is the target. A dot of radius `0.16 * size` covers
 * 8% of its tile and a bar of `size / 5` covers 20% of its width, which sounds
 * unbalanced and is not: a bar is uninterrupted along its length while a dot has
 * background on all sides, and white ink on a saturated fill reads fatter than it
 * measures. Both land near a tenth of the *visible* area.
 */
const DOT_RADIUS = 0.16
const SQUARE_SIDE = 0.3
const BAR_WIDTH = 1 / 5

/**
 * Contrast at which white ink is preferred over a darkened tint of the
 * background. Low on purpose: white texture on a mid-tone works, and the
 * alternative (a dark tint) is what pale ends of a ramp need.
 */
const WHITE_INK_MIN_CONTRAST = 1.9

/** Distinct ids across every registry on the page. See the module note. */
let REGISTRY_SEQ = 0

export interface ResolvedImage {
  src: string
  fit: 'cover' | 'contain' | 'fill'
  background: string
  opacity: number
}

/**
 * What a series asks the renderer to paint a feature with. `color` rides along so
 * the caller keeps the flat fill for the places that need a colour rather than a
 * paint: hover, the legend, and the seed a drilldown develops out of.
 */
export type FeaturePaint =
  | { kind: 'pattern'; color: string; pattern: ResolvedPattern }
  | { kind: 'image'; color: string; image: ResolvedImage }

/**
 * Ink for a tile whose colour the caller left to us.
 *
 * Exported because the tile is not the only thing that has to make this call: a
 * legend swatch drawing the same pattern has to reach the same answer.
 */
export function patternInk(background: string): string {
  return contrastRatio(background, '#ffffff') >= WHITE_INK_MIN_CONTRAST
    ? '#ffffff'
    : darken(background, 0.35)
}

/**
 * Apply the defaults, resolving ink and background against the colour the scale
 * chose. Lives here rather than in the series because it is the same decision the
 * tile geometry below is made of.
 */
export function resolvePattern(options: PatternFillOptions, color: string): ResolvedPattern {
  const size = options.size != null && options.size > 0 ? options.size : DEFAULT_SIZE
  const background = options.background ?? color
  return {
    type: options.type ?? (options.path ? 'custom' : 'dots'),
    path: options.path,
    size,
    color: options.color ?? patternInk(background),
    background,
    strokeWidth: options.strokeWidth != null ? options.strokeWidth : size * BAR_WIDTH,
    angle: options.angle ?? 0,
    opacity: options.opacity ?? 1,
  }
}

/**
 * The ink of a tile, in a `size` by `size` box.
 *
 * Every tile is built to be seamless at the box edge, which is why the diagonals
 * run corner to corner (a 45-degree line through opposite corners continues into
 * the next tile) and the line tiles are full-width bars rather than centred
 * segments.
 */
function inkShapes(pattern: ResolvedPattern): SVGElement[] {
  const s = pattern.size
  const w = Math.max(0.25, pattern.strokeWidth)
  const stroke = {
    stroke: pattern.color,
    'stroke-width': w,
    'stroke-linecap': 'square',
    fill: 'none',
  }

  switch (pattern.type) {
    case 'dots':
      return [
        svg('circle', {
          cx: s / 2,
          cy: s / 2,
          r: Math.max(0.5, s * DOT_RADIUS),
          fill: pattern.color,
        }),
      ]

    case 'squares': {
      const side = Math.max(1, s * SQUARE_SIDE)
      const offset = (s - side) / 2
      return [svg('rect', { x: offset, y: offset, width: side, height: side, fill: pattern.color })]
    }

    case 'checks':
      return [
        svg('rect', { width: s / 2, height: s / 2, fill: pattern.color }),
        svg('rect', { x: s / 2, y: s / 2, width: s / 2, height: s / 2, fill: pattern.color }),
      ]

    case 'lines':
      return [svg('rect', { y: (s - w) / 2, width: s, height: w, fill: pattern.color })]

    case 'grid':
      return [
        svg('rect', { y: (s - w) / 2, width: s, height: w, fill: pattern.color }),
        svg('rect', { x: (s - w) / 2, width: w, height: s, fill: pattern.color }),
      ]

    case 'diagonal':
      return [svg('path', { d: `M0,0 L${s},${s}`, ...stroke })]

    case 'crosshatch':
      return [
        svg('path', { d: `M0,0 L${s},${s}`, ...stroke }),
        svg('path', { d: `M${s},0 L0,${s}`, ...stroke }),
      ]

    case 'custom':
      // Filled, and stroked as well when a weight was asked for, because a custom
      // tile may be either an outline or a shape and the author knows which.
      return pattern.path
        ? [
            svg('path', {
              d: pattern.path,
              fill: pattern.color,
              stroke: pattern.strokeWidth ? pattern.color : 'none',
              'stroke-width': pattern.strokeWidth || null,
            }),
          ]
        : []
  }
}

/**
 * The tile's own transform: the author's rotation, then the inverse of the camera
 * so the texture holds its screen size. A uniform scale commutes with the
 * rotation, so the order costs nothing either way.
 */
function tileTransform(angle: number, k: number): string {
  const scale = k > 0 ? 1 / k : 1
  const parts: string[] = []
  if (angle) parts.push(`rotate(${angle})`)
  parts.push(`scale(${round(scale)})`)
  return parts.join(' ')
}

function round(value: number): number {
  return Math.round(value * 1e4) / 1e4
}

/**
 * A `<pattern>` for a tile, at a camera scale.
 *
 * A module function rather than a method because the legend needs it too, and a
 * swatch drawn by a second implementation is a swatch that will eventually
 * disagree with the map it is explaining.
 */
function patternElement(id: string, pattern: ResolvedPattern, k: number): SVGPatternElement {
  const el = svg('pattern', {
    id,
    width: pattern.size,
    height: pattern.size,
    patternUnits: 'userSpaceOnUse',
    patternTransform: tileTransform(pattern.angle, k),
    // Carried on the element because `applyScale` rewrites the whole transform and
    // would otherwise have to parse the author's rotation back out of it.
    dataset: { angle: pattern.angle },
  })

  if (pattern.background && pattern.background !== 'none') {
    el.appendChild(
      svg('rect', { width: pattern.size, height: pattern.size, fill: pattern.background }),
    )
  }

  const shapes = inkShapes(pattern)
  if (pattern.opacity !== 1) {
    const group = svg('g', { opacity: pattern.opacity })
    for (const shape of shapes) group.appendChild(shape)
    el.appendChild(group)
  } else {
    for (const shape of shapes) el.appendChild(shape)
  }

  return el
}

/** Swatch ids, namespaced the same way the registry's are and for the same reason. */
let SWATCH_SEQ = 0

/**
 * Intrinsic aspect ratio per source: a number once measured, null once measured and
 * found unusable. Fifty regions sharing nine pictures measure nine times, and a
 * second map on the page measures none of them again.
 */
const ASPECT = new Map<string, number | null>()

/** Callbacks waiting on a measurement already in flight, keyed by source. */
const PENDING = new Map<string, ((aspect: number) => void)[]>()

/**
 * Learn a source's aspect ratio, then hand it over. Synchronous on a cache hit,
 * which is the common case after the first feature.
 *
 * A probe image rather than parsing the source: it is the one route that works for
 * a photograph, an icon and an SVG alike. An SVG carrying only a `viewBox` reports
 * a browser-chosen default size, and that default preserves the viewBox ratio,
 * which is the only thing wanted here.
 */
function withAspect(src: string, apply: (aspect: number) => void): void {
  const known = ASPECT.get(src)
  if (known != null) {
    apply(known)
    return
  }
  // Measured and unusable: a broken URL, or an SVG the browser would not size.
  if (known === null) return

  const waiting = PENDING.get(src)
  if (waiting) {
    waiting.push(apply)
    return
  }

  // No DOM (SSR) or no loader (jsdom): the attribute stays the answer.
  if (typeof Image === 'undefined') {
    ASPECT.set(src, null)
    return
  }

  PENDING.set(src, [apply])
  const probe = new Image()
  const settle = (aspect: number | null) => {
    ASPECT.set(src, aspect)
    const queue = PENDING.get(src) ?? []
    PENDING.delete(src)
    if (aspect) for (const fn of queue) fn(aspect)
  }
  probe.onload = () =>
    settle(
      probe.naturalWidth > 0 && probe.naturalHeight > 0
        ? probe.naturalWidth / probe.naturalHeight
        : null,
    )
  probe.onerror = () => settle(null)
  probe.src = src
}

/**
 * Size and centre an image so it covers its tile, cropping the overflow.
 *
 * The crop is done by the pattern and by the feature's own outline, so the image is
 * simply drawn larger than the box: anything outside the shape was never going to
 * be painted. `preserveAspectRatio: none` is safe here *because* the box is already
 * the source's own ratio, so there is nothing left to distort.
 */
function coverImage(node: SVGElement, width: number, height: number, aspect: number): void {
  const box = width / height
  const w = aspect > box ? height * aspect : width
  const h = aspect > box ? height : width / aspect
  setAttrs(node, {
    x: round((width - w) / 2),
    y: round((height - h) / 2),
    width: round(w),
    height: round(h),
    preserveAspectRatio: 'none',
  })
}

/** Repeats a swatch shows, so the reader sees a pattern rather than one mark. */
const SWATCH_REPEATS = 2

/**
 * A self-contained swatch for a legend entry: the tile the map is painted with.
 *
 * The legend is HTML, and the obvious route is a CSS `background-image` holding an
 * encoded tile. This returns an inline `<svg>` instead, so the tile comes off the
 * same builder as the map's. A patterned map whose legend shows flat colour is
 * telling the reader the pattern means nothing.
 *
 * The tile is shown at whatever scale fits two repeats across, not at its size on
 * the map. Correct spacing on a map is spacing that leaves the colour dominant, and
 * a 10px tile in a 14px swatch is one dot and a crop: the reader cannot tell dots
 * from squares, which is the one thing the swatch is for. Two repeats is the
 * smallest count that reads as a repeat.
 */
export function patternSwatch(pattern: ResolvedPattern, size = 14): SVGSVGElement {
  const id = `apexmaps-swatch-${SWATCH_SEQ++}`
  const root = svg('svg', {
    width: size,
    height: size,
    viewBox: `0 0 ${size} ${size}`,
    style: { display: 'block' },
    'aria-hidden': 'true',
  })
  // `patternElement` divides by this, so it is "how much bigger than the swatch
  // wants" rather than a camera scale here. Same arithmetic, same code path.
  const shrink = (pattern.size * SWATCH_REPEATS) / size
  root.appendChild(svg('defs', {}, [patternElement(id, pattern, Math.max(1, shrink))]))
  root.appendChild(svg('rect', { width: size, height: size, fill: `url(#${id})` }))
  return root
}

/**
 * `<defs>` for one renderer: builds paints on demand, shares identical ones,
 * rescales texture with the camera, and drops what a redraw stopped asking for.
 */
export class PaintRegistry {
  private readonly defs: SVGDefsElement
  private readonly uid: number
  /** Resolved spec -> the def serving it, so identical paints share one element. */
  private readonly byKey = new Map<
    string,
    { id: string; el: SVGElement; seriesId: string; texture: boolean }
  >()
  private seq = 0
  /** Camera scale last written, so an unchanged camera writes nothing. */
  private scale = 1

  constructor(defs: SVGDefsElement) {
    this.defs = defs
    this.uid = REGISTRY_SEQ++
  }

  /**
   * The `fill` value for a paint, creating the def if it is new.
   *
   * Returns null when the paint cannot be honoured (an image fill on a feature
   * that projects to nothing), which the caller reads as "use the flat colour".
   *
   * @param seen Keys touched this pass, for {@link pruneSeries}.
   */
  resolve(
    paint: FeaturePaint,
    {
      seriesId,
      bounds,
      seen,
    }: { seriesId: string; bounds?: WorldBounds | null; seen?: Set<string> },
  ): string | null {
    const key =
      paint.kind === 'pattern'
        ? patternKey(seriesId, paint.pattern)
        : imageKey(seriesId, paint.image, bounds)
    if (!key) return null

    seen?.add(key)
    const existing = this.byKey.get(key)
    if (existing) return `url(#${existing.id})`

    const id = `apexmaps-paint-${this.uid}-${this.seq++}`
    const el =
      paint.kind === 'pattern'
        ? patternElement(id, paint.pattern, this.scale)
        : this.buildImage(id, paint.image, bounds as WorldBounds)

    this.defs.appendChild(el)
    this.byKey.set(key, { id, el, seriesId, texture: paint.kind === 'pattern' })
    return `url(#${id})`
  }

  /**
   * A one-tile pattern pinned to the feature's projected box.
   *
   * A pattern rather than a `<clipPath>` plus `<image>`: the clip route needs an
   * extra element per feature *and* a second copy of the geometry, while this
   * keeps the feature a single path whose `fill` happens to be a picture. Hover,
   * selection, hit-testing and the export all keep working with no special case.
   */
  private buildImage(id: string, image: ResolvedImage, bounds: WorldBounds): SVGElement {
    const [[x0, y0], [x1, y1]] = bounds
    const width = Math.max(1e-3, x1 - x0)
    const height = Math.max(1e-3, y1 - y0)

    const el = svg('pattern', {
      id,
      x: round(x0),
      y: round(y0),
      width: round(width),
      height: round(height),
      patternUnits: 'userSpaceOnUse',
    })

    if (image.background && image.background !== 'none') {
      el.appendChild(
        svg('rect', { width: round(width), height: round(height), fill: image.background }),
      )
    }

    const node = svg('image', {
      width: round(width),
      height: round(height),
      preserveAspectRatio:
        image.fit === 'fill'
          ? 'none'
          : image.fit === 'contain'
            ? 'xMidYMid meet'
            : 'xMidYMid slice',
      opacity: image.opacity !== 1 ? image.opacity : null,
    })
    node.setAttribute('href', image.src)
    // Both spellings: `href` is the standard, and `xlink:href` is what several
    // rasterisers and older viewers still read out of an exported file.
    node.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', image.src)
    el.appendChild(node)

    // `slice` is a request the referencing element does not always win. An SVG
    // source brings its own aspect handling, which takes precedence, so a flag or
    // an icon asked to cover ends up letterboxed inside the feature with the fill
    // colour showing around it: correct per spec, and a defect to the reader. So
    // cover is *computed* once the source's aspect ratio is known, and the
    // attribute above stays as the answer for the moment before that and for
    // sources that cannot be measured.
    if (image.fit === 'cover') {
      withAspect(image.src, (aspect) => coverImage(node, width, height, aspect))
    }

    return el
  }

  /** Hold texture at its authored screen size for a new camera scale. */
  applyScale(k: number): void {
    if (k === this.scale) return
    this.scale = k
    for (const entry of this.byKey.values()) {
      if (!entry.texture) continue
      const angle = Number(entry.el.getAttribute('data-angle') ?? 0)
      entry.el.setAttribute('patternTransform', tileTransform(angle, k))
    }
  }

  /** Drop this series' paints that the pass just finished did not ask for. */
  pruneSeries(seriesId: string, seen: Set<string>): void {
    for (const [key, entry] of this.byKey) {
      if (entry.seriesId !== seriesId || seen.has(key)) continue
      remove(entry.el)
      this.byKey.delete(key)
    }
  }

  clearSeries(seriesId: string): void {
    this.pruneSeries(seriesId, new Set())
  }

  clear(): void {
    for (const entry of this.byKey.values()) remove(entry.el)
    this.byKey.clear()
  }
}

function patternKey(seriesId: string, p: ResolvedPattern): string {
  return [
    seriesId,
    'p',
    p.type,
    p.path ?? '',
    p.size,
    p.color,
    p.background,
    p.strokeWidth,
    p.angle,
    p.opacity,
  ].join('|')
}

/**
 * Keyed by the box as well as the source, because the tile is positioned on it.
 * Rounded to whole world pixels so a refit that moves a feature by a hair reuses
 * the def instead of orphaning it.
 */
function imageKey(
  seriesId: string,
  image: ResolvedImage,
  bounds?: WorldBounds | null,
): string | null {
  if (!bounds) return null
  const box = bounds.flat().map(Math.round).join(',')
  return [seriesId, 'i', image.src, image.fit, image.background, image.opacity, box].join('|')
}
