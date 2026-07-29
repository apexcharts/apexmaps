/**
 * The Canvas tier: rasterises the world-space geometry layers.
 *
 * It is an accelerator, not a replacement. The SVG renderer stays mounted and
 * keeps everything whose value is in being DOM (labels, annotations, the
 * selection box, the focus ring, the accessibility tree) and everything whose
 * count is already bounded (screen-space bubbles and markers). This tier takes
 * the layers whose element count scales with the geometry: feature fills, arcs
 * and routes, the sphere and the graticule. On a 3,231-county map that is 3,231
 * DOM nodes replaced by one canvas.
 *
 * ## The trade, measured rather than assumed
 *
 * SVG gets a free camera: the world group carries one transform, so a pan is one
 * attribute write regardless of feature count, which is the invariant
 * `test/perf.test.ts` pins. Canvas has no such thing and must re-rasterise every
 * frame, trading an O(1) frame for an O(features) one.
 *
 * Measuring that trade in Chromium gives an answer worth stating plainly,
 * because it is not the one "add a canvas tier" suggests: **panning does not get
 * faster.** At 10,000 features both tiers sit at about 9 ms; at 20,000 canvas is
 * 9.8 ms; above roughly 30,000 a canvas pan leaves the 16 ms budget while SVG's
 * would not. Recolouring is slower on canvas too (10.3 ms against 6.2 ms at
 * 20,000), because it remerges and re-rasterises where SVG rewrites attributes.
 *
 * What canvas removes is the DOM: sixteen elements instead of twenty thousand.
 * That is memory, style recalculation and accessibility-tree weight the map
 * imposes on the entire page, not just on its own frames, and it is why the tier
 * exists and why `'auto'` promotes on element count rather than on frame time.
 * Anyone reading this to decide whether to reach for it should reach for it when
 * the element count is the problem, and leave it alone otherwise.
 *
 * The invariant that makes that trade good, and the one this tier's guard pins:
 *
 * > **A camera frame never projects geometry and never builds a `Path2D`.**
 * > It sets one transform and re-fills cached paths.
 *
 * Break it and canvas becomes slower than the SVG it replaced, which is exactly
 * the regression a well-meaning refactor introduces, since reprojecting per
 * frame still looks fine on a fast laptop at 200 features.
 *
 * ## Two details that are easy to get wrong
 *
 * **Stroke width.** SVG feature borders use `vector-effect: non-scaling-stroke`,
 * so a 0.5px border stays 0.5px at any zoom. Under a scaled canvas transform a
 * 0.5 `lineWidth` becomes 0.5×k, so borders would thicken as the reader zooms
 * in. Dividing by k restores parity.
 *
 * **Hit testing coordinates.** `isPointInPath` takes its point in device space,
 * unaffected by the current transform, while the path it tests *is* transformed
 * by it. So the painting transform is left in place and the pointer is passed in
 * device pixels: no inverse-transform arithmetic, and no chance of the hit test
 * and the paint disagreeing about where a shape is.
 *
 * @module renderers/CanvasRenderer
 */

import { SpatialIndex } from '../geo/SpatialIndex'
import { darken } from '../scales/Color'
import { html, remove } from '../utils/dom'
import type { Viewport } from '../geo/Viewport'
import type { ActiveRendererKind, HitResult, MarkState } from './Renderer'
import type { PathSpec } from './SvgRenderer'
import type { NormalizedFeature, StrokeOptions, WorldBounds } from '../types'

/** Cap the backing store so a retina 4K plot cannot allocate absurdly. */
const MAX_DPR = 2

interface FeatureEntry {
  index: number
  path: Path2D
  fill: string
}

/**
 * One fill colour's worth of features.
 *
 * `merged` is every entry in the bucket combined into a single `Path2D`, which
 * is what makes the tier fast rather than merely DOM-free: 40,000 separate
 * `fill()` calls spend nearly all their time in per-call overhead, while one
 * `fill()` of a 40,000-subpath geometry is a single rasterisation pass. On a
 * classed choropleth the bucket count is the class count, so a frame becomes a
 * handful of fills regardless of feature count.
 *
 * Merging is safe because ingest normalises ring winding (exterior clockwise,
 * holes counterclockwise), so the nonzero fill rule treats the union exactly as
 * it treats the parts.
 */
interface Bucket {
  fill: string
  entries: FeatureEntry[]
  /** Rebuilt when fills change or the muted set changes; null means rebuild. */
  merged: Path2D | null
}

interface FeatureLayerState {
  seriesId: string
  entries: FeatureEntry[]
  /** Entries grouped by fill colour, each with a merged path for painting. */
  buckets: Bucket[]
  stroke: StrokeOptions
  opacity: number
  index: SpatialIndex
  /** Index into `entries` by feature index, for state lookups. */
  byFeature: Map<number, FeatureEntry>
}

interface PathEntry {
  item: number
  key: string
  path: Path2D
  stroke: string
  width: number
  opacity: number
  dashArray?: string
}

interface PathLayerState {
  seriesId: string
  entries: PathEntry[]
  hitWidth: number
  index: SpatialIndex
}

interface BaseEntry {
  className: string
  path: Path2D
  fill: string
  stroke: string
  width: number
}

/** Observable counters. The tier's perf guard reads these; nothing else does. */
export interface CanvasStats {
  /** `Path2D` objects constructed. Must not grow during a camera frame. */
  pathBuilds: number
  /** Full canvas repaints. Grows once per camera frame, which is the point. */
  repaints: number
  /** Fill and stroke calls issued. Grows with features, which is the trade. */
  draws: number
}

export class CanvasRenderer {
  static readonly kind: ActiveRendererKind = 'canvas'
  readonly kind: ActiveRendererKind = 'canvas'
  /** Canvas has no free transform, so the chart must ask it to repaint. */
  readonly repaintsOnCamera = true

  readonly viewport: Viewport
  el: HTMLCanvasElement | null = null
  ctx: CanvasRenderingContext2D | null = null
  dpr = 1

  readonly stats: CanvasStats = { pathBuilds: 0, repaints: 0, draws: 0 }

  private featureLayers: FeatureLayerState[] = []
  private pathLayers: PathLayerState[] = []
  private baseEntries: BaseEntry[] = []
  /** `seriesId:key` -> state, applied at repaint rather than at set time. */
  private readonly states = new Map<string, MarkState>()
  private hoverStyle: { brightness: number; stroke?: string; strokeWidth?: number } = {
    brightness: 0.08,
  }
  private activeStyle: { stroke: string; strokeWidth: number } = {
    stroke: '#111111',
    strokeWidth: 1.5,
  }
  private mutedOpacity = 0.25
  private background = 'transparent'

  constructor({ viewport }: { viewport: Viewport }) {
    this.viewport = viewport
  }

  /**
   * Insert the canvas under the SVG.
   *
   * Returns false when no 2D context is available, which is the honest signal
   * for the controller to fall back: jsdom has no canvas implementation, and a
   * browser can refuse a context under memory pressure or when too many are
   * live. Throwing instead would make the tier a liability rather than an
   * optimisation.
   */
  mount(
    container: HTMLElement,
    { width, height, background }: { width: number; height: number; background?: string },
  ): boolean {
    const el = html('canvas', {
      class: 'apexmaps-canvas',
      style: {
        position: 'absolute',
        inset: '0',
        display: 'block',
        // The SVG above owns every pointer event, including the ones this tier
        // answers: the chart converts them to a hit test. A canvas that took
        // events itself would compete with the annotation and symbol layers.
        pointerEvents: 'none',
      },
    })

    let ctx: CanvasRenderingContext2D | null
    try {
      ctx = el.getContext('2d')
    } catch {
      // jsdom throws rather than returning null. Either way the answer is the
      // same: no tier.
      ctx = null
    }
    if (!ctx) return false

    this.el = el
    this.ctx = ctx
    this.background = background || 'transparent'
    // First child, so it sits beneath the SVG in paint order without either
    // needing a z-index.
    container.insertBefore(el, container.firstChild)
    this.resize(width, height)
    return true
  }

  resize(width: number, height: number): void {
    if (!this.el || !this.ctx) return
    this.dpr = Math.min(MAX_DPR, Math.max(1, globalThis.devicePixelRatio || 1))
    this.el.width = Math.max(1, Math.round(width * this.dpr))
    this.el.height = Math.max(1, Math.round(height * this.dpr))
    this.el.style.width = `${width}px`
    this.el.style.height = `${height}px`
  }

  setStateStyles({
    hover,
    active,
    mutedOpacity,
  }: {
    hover?: { brightness?: number; stroke?: string; strokeWidth?: number }
    active?: { stroke?: string; strokeWidth?: number }
    mutedOpacity?: number
  }): void {
    this.hoverStyle = {
      brightness: hover?.brightness ?? 0.08,
      stroke: hover?.stroke,
      strokeWidth: hover?.strokeWidth,
    }
    this.activeStyle = {
      stroke: active?.stroke ?? '#111111',
      strokeWidth: active?.strokeWidth ?? 1.5,
    }
    this.mutedOpacity = mutedOpacity ?? 0.25
  }

  // --- layer building -------------------------------------------------------

  /**
   * Build the feature layer: one `Path2D` and one bbox per feature.
   *
   * Called once per draw, never per frame. Both the paths and the index come
   * from the same projected `d` string the SVG renderer would have used, so
   * there is exactly one projection code path in the product.
   */
  drawFeatures({
    features,
    fill,
    stroke = {},
    opacity = 1,
    seriesId,
  }: {
    features: NormalizedFeature[]
    fill: (feature: NormalizedFeature) => string
    stroke?: StrokeOptions
    opacity?: number
    seriesId: string
  }): void {
    const entries: FeatureEntry[] = []
    const boxes: (WorldBounds | null)[] = []
    const byFeature = new Map<number, FeatureEntry>()

    for (const feature of features) {
      const d = this.viewport.pathFor(feature)
      if (!d) {
        boxes.push(null)
        continue
      }
      const entry: FeatureEntry = {
        index: feature.index,
        path: this.buildPath(d),
        fill: fill(feature),
      }
      entries.push(entry)
      byFeature.set(feature.index, entry)
      // The bbox comes from d3's own measurement of the projected geometry,
      // which is exact rather than a parse of the path string.
      boxes.push(this.boundsOf(feature))
    }

    // The index is keyed by position in `boxes`, which tracks `features`, so a
    // hit resolves to the same item index the SVG tier reports.
    const index = SpatialIndex.build(boxes)

    const layer: FeatureLayerState = {
      seriesId,
      entries,
      buckets: bucketByFill(entries),
      stroke,
      opacity,
      index,
      byFeature,
    }

    const existing = this.featureLayers.findIndex((l) => l.seriesId === seriesId)
    if (existing === -1) this.featureLayers.push(layer)
    else this.featureLayers[existing] = layer
  }

  /** Build a world-space path layer: arcs and routes. */
  drawPaths({
    paths,
    seriesId,
    hitWidth = 8,
  }: {
    paths: PathSpec[]
    seriesId: string
    hitWidth?: number
  }): void {
    const entries: PathEntry[] = []
    const boxes: (WorldBounds | null)[] = []

    paths.forEach((spec) => {
      if (!spec.d) {
        boxes.push(null)
        return
      }
      entries.push({
        item: spec.item,
        key: spec.key,
        path: this.buildPath(spec.d),
        stroke: spec.stroke,
        width: spec.width,
        opacity: spec.opacity ?? 1,
        dashArray: spec.dashArray,
      })
      boxes.push(boundsOfPathData(spec.d))
    })

    const layer: PathLayerState = {
      seriesId,
      entries,
      hitWidth,
      index: SpatialIndex.build(boxes),
    }
    const existing = this.pathLayers.findIndex((l) => l.seriesId === seriesId)
    if (existing === -1) this.pathLayers.push(layer)
    else this.pathLayers[existing] = layer
  }

  drawBasePath(
    d: string,
    { fill, stroke, width }: { fill?: string; stroke?: string; width?: number },
    className: string,
  ): void {
    this.clearBasePath(className)
    if (!d) return
    this.baseEntries.push({
      className,
      path: this.buildPath(d),
      fill: fill || 'none',
      stroke: stroke || 'none',
      width: width ?? 0.5,
    })
  }

  clearBasePath(className: string): void {
    this.baseEntries = this.baseEntries.filter((e) => e.className !== className)
  }

  clearSeries(seriesId: string): void {
    this.featureLayers = this.featureLayers.filter((l) => l.seriesId !== seriesId)
    this.pathLayers = this.pathLayers.filter((l) => l.seriesId !== seriesId)
    for (const key of [...this.states.keys()]) {
      if (key.startsWith(`${seriesId}:`)) this.states.delete(key)
    }
  }

  /** Drop every layer, for a level change that rebuilds from scratch. */
  clearAll(): void {
    this.featureLayers = []
    this.pathLayers = []
    this.baseEntries = []
    this.states.clear()
  }

  // --- state ----------------------------------------------------------------

  /**
   * Record a mark's visual state. Cheap by design: a repaint applies it, so
   * muting three thousand features is three thousand map writes and one paint,
   * rather than three thousand DOM mutations.
   */
  setState(seriesId: string, key: string | number, state: MarkState | null): void {
    const id = `${seriesId}:${key}`
    const wasMuted = !!this.states.get(id)?.muted
    if (!state || (!state.hovered && !state.selected && !state.muted)) this.states.delete(id)
    else this.states.set(id, state)
    // Only a change in muting invalidates the merged paths; hover and selection
    // are overdrawn, so they cost nothing structural.
    if (wasMuted !== !!state?.muted) this.invalidateMerged()
  }

  clearStates(): void {
    if (this.states.size) {
      this.states.clear()
      this.invalidateMerged()
    }
  }

  /** Refresh fills after a data or palette change, without rebuilding paths. */
  refill(seriesId: string, fill: (index: number) => string | undefined): void {
    const layer = this.featureLayers.find((l) => l.seriesId === seriesId)
    if (!layer) return
    for (const entry of layer.entries) {
      const next = fill(entry.index)
      if (next) entry.fill = next
    }
    layer.buckets = bucketByFill(layer.entries)
  }

  // --- painting -------------------------------------------------------------

  /** The camera moved. One transform, then re-fill: no projection, no Path2D. */
  applyCamera(): void {
    this.repaint()
  }

  repaint(): void {
    const ctx = this.ctx
    const el = this.el
    if (!ctx || !el) return

    this.stats.repaints++

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, el.width, el.height)
    if (this.background && this.background !== 'transparent') {
      ctx.fillStyle = this.background
      ctx.fillRect(0, 0, el.width, el.height)
    }

    const { k, x, y } = this.viewport.camera
    const s = this.dpr
    // World -> device in one matrix, so every path below is drawn in world
    // coordinates exactly as it was built.
    ctx.setTransform(s * k, 0, 0, s * k, s * x, s * y)

    for (const entry of this.baseEntries) {
      if (entry.fill !== 'none') {
        ctx.fillStyle = entry.fill
        ctx.fill(entry.path)
        this.stats.draws++
      }
      if (entry.stroke !== 'none') {
        ctx.strokeStyle = entry.stroke
        ctx.lineWidth = entry.width / k
        ctx.stroke(entry.path)
        this.stats.draws++
      }
    }

    for (const layer of this.featureLayers) this.paintFeatureLayer(ctx, layer, k)
    for (const layer of this.pathLayers) this.paintPathLayer(ctx, layer, k)
  }

  private paintFeatureLayer(
    ctx: CanvasRenderingContext2D,
    layer: FeatureLayerState,
    k: number,
  ): void {
    const strokeColor = layer.stroke.color
    const strokeWidth = (layer.stroke.width ?? 0.5) / k
    const baseAlpha = layer.opacity

    // Muted marks come out of the merged path, because dimming is a reduced
    // alpha and cannot be overdrawn: the full-opacity copy underneath would show
    // through. Hovered and selected marks stay in and are overdrawn instead,
    // since both paint opaquely, which keeps hover off the O(features) path: it
    // changes several times a second and must not rebuild anything.
    const muted: FeatureEntry[] = []
    const decorated: FeatureEntry[] = []

    for (const bucket of layer.buckets) {
      if (!bucket.merged) bucket.merged = this.mergeBucket(layer, bucket)

      ctx.globalAlpha = baseAlpha
      ctx.fillStyle = bucket.fill
      ctx.fill(bucket.merged)
      this.stats.draws++
      if (strokeColor) {
        ctx.strokeStyle = strokeColor
        ctx.lineWidth = strokeWidth
        ctx.stroke(bucket.merged)
        this.stats.draws++
      }

      for (const entry of bucket.entries) {
        const state = this.states.get(`${layer.seriesId}:${entry.index}`)
        if (!state) continue
        if (state.muted) muted.push(entry)
        else decorated.push(entry)
      }
    }

    for (const entry of muted) {
      const state = this.states.get(`${layer.seriesId}:${entry.index}`) as MarkState
      ctx.globalAlpha = baseAlpha * this.mutedOpacity
      ctx.fillStyle = state.hovered ? darken(entry.fill, this.hoverStyle.brightness) : entry.fill
      ctx.fill(entry.path)
      this.stats.draws++
      if (strokeColor) {
        ctx.strokeStyle = strokeColor
        ctx.lineWidth = strokeWidth
        ctx.stroke(entry.path)
        this.stats.draws++
      }
    }

    for (const entry of decorated) {
      const state = this.states.get(`${layer.seriesId}:${entry.index}`) as MarkState
      ctx.globalAlpha = baseAlpha
      ctx.fillStyle = state.hovered ? darken(entry.fill, this.hoverStyle.brightness) : entry.fill
      ctx.fill(entry.path)
      this.stats.draws++

      const outline = state.selected
        ? this.activeStyle
        : state.hovered && this.hoverStyle.stroke
          ? { stroke: this.hoverStyle.stroke, strokeWidth: this.hoverStyle.strokeWidth ?? 1 }
          : strokeColor
            ? { stroke: strokeColor, strokeWidth: layer.stroke.width ?? 0.5 }
            : null
      if (outline) {
        ctx.strokeStyle = outline.stroke
        ctx.lineWidth = outline.strokeWidth / k
        ctx.stroke(entry.path)
        this.stats.draws++
      }
    }

    ctx.globalAlpha = 1
  }

  /** Combine a bucket's non-muted entries into one path. */
  private mergeBucket(layer: FeatureLayerState, bucket: Bucket): Path2D {
    const merged = this.buildPath()
    for (const entry of bucket.entries) {
      if (this.states.get(`${layer.seriesId}:${entry.index}`)?.muted) continue
      merged.addPath(entry.path)
    }
    return merged
  }

  /** Force every bucket to remerge, after fills or the muted set changed. */
  private invalidateMerged(): void {
    for (const layer of this.featureLayers) {
      for (const bucket of layer.buckets) bucket.merged = null
    }
  }

  private paintPathLayer(ctx: CanvasRenderingContext2D, layer: PathLayerState, k: number): void {
    ctx.lineCap = 'round'
    for (const entry of layer.entries) {
      const state = this.states.get(`${layer.seriesId}:${entry.key}`)
      ctx.globalAlpha = state?.muted
        ? entry.opacity * this.mutedOpacity
        : state?.hovered
          ? 1
          : entry.opacity
      ctx.strokeStyle = entry.stroke
      ctx.lineWidth = entry.width / k
      if (entry.dashArray) {
        ctx.setLineDash(
          entry.dashArray
            .split(/[\s,]+/)
            .map(Number)
            .filter(Number.isFinite),
        )
      } else {
        ctx.setLineDash([])
      }
      ctx.stroke(entry.path)
      this.stats.draws++
    }
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }

  // --- hit testing ----------------------------------------------------------

  /**
   * What is under a screen point, topmost first.
   *
   * Two stages, because a bounding box is not a shape: the R-tree narrows
   * thousands of features to a handful, then `isPointInPath` answers exactly.
   * Skipping the second stage would report Alaska for a pointer in the middle of
   * the Pacific, the same error box-based selection made before it was changed
   * to test anchors.
   */
  hitTest(screen: [number, number]): HitResult | null {
    const ctx = this.ctx
    if (!ctx) return null

    const [wx, wy] = this.viewport.screenToWorld(screen)
    const px = screen[0] * this.dpr
    const py = screen[1] * this.dpr
    const { k } = this.viewport.camera

    // Paths sit above features, matching the SVG paint order, so they answer
    // first.
    for (let i = this.pathLayers.length - 1; i >= 0; i--) {
      const layer = this.pathLayers[i]
      // A stroke's ink extends half its hit width either side of the geometry,
      // in screen pixels, so the world-space search radius divides by k.
      const radius = layer.hitWidth / 2 / (k || 1)
      const candidates = layer.index.searchNear(wx, wy, radius)
      for (const c of candidates) {
        const entry = layer.entries[c]
        if (!entry) continue
        ctx.lineWidth = Math.max(entry.width, layer.hitWidth) / (k || 1)
        if (ctx.isPointInStroke(entry.path, px, py)) {
          return { seriesId: layer.seriesId, item: entry.item }
        }
      }
    }

    for (let i = this.featureLayers.length - 1; i >= 0; i--) {
      const layer = this.featureLayers[i]
      const candidates = layer.index.searchPoint(wx, wy)
      // Later features paint over earlier ones, so the last match is the one the
      // reader can see.
      for (let c = candidates.length - 1; c >= 0; c--) {
        const entry = layer.byFeature.get(candidates[c])
        if (!entry) continue
        if (ctx.isPointInPath(entry.path, px, py)) {
          return { seriesId: layer.seriesId, item: entry.index }
        }
      }

      // Nothing contained the point, so try the borders.
      //
      // SVG hit-tests `visiblePainted`, which is fill *and stroke*, so a feature's
      // half-pixel border is clickable there. `isPointInPath` is fill only, and
      // without this second pass a pointer in the hairline gap between two
      // neighbours selects a county on the SVG tier and nothing on the canvas
      // tier. That difference is invisible on a world map and constant on a dense
      // one, which is the worst combination: it looks like a flaky map.
      const borderWidth = layer.stroke.width ?? 0.5
      if (borderWidth <= 0) continue
      // `vector-effect: non-scaling-stroke` keeps the border a screen width, so
      // its world-space half-width shrinks as the reader zooms in.
      const reach = borderWidth / 2 / (k || 1)
      const near = layer.index.searchNear(wx, wy, reach)
      ctx.lineWidth = borderWidth / (k || 1)
      for (let c = near.length - 1; c >= 0; c--) {
        const entry = layer.byFeature.get(near[c])
        if (!entry) continue
        if (ctx.isPointInStroke(entry.path, px, py)) {
          return { seriesId: layer.seriesId, item: entry.index }
        }
      }
    }

    return null
  }

  /** Indexed feature count per layer, for the diagnostics block. */
  indexSizes(): { seriesId: string; features: number }[] {
    return this.featureLayers.map((l) => ({ seriesId: l.seriesId, features: l.index.size }))
  }

  destroy(): void {
    remove(this.el)
    this.el = null
    this.ctx = null
    this.clearAll()
  }

  private buildPath(d?: string): Path2D {
    this.stats.pathBuilds++
    return d == null ? new Path2D() : new Path2D(d)
  }

  private boundsOf(feature: NormalizedFeature): WorldBounds | null {
    if (!this.viewport.path || !feature.geometry) return null
    const b = this.viewport.path.bounds(feature.geometry)
    if (!b || !Number.isFinite(b[0][0])) return null
    return b as WorldBounds
  }
}

function bucketByFill(entries: FeatureEntry[]): Bucket[] {
  const byFill = new Map<string, FeatureEntry[]>()
  for (const entry of entries) {
    const list = byFill.get(entry.fill)
    if (list) list.push(entry)
    else byFill.set(entry.fill, [entry])
  }
  return [...byFill].map(([fill, list]) => ({ fill, entries: list, merged: null }))
}

/**
 * Bounds of an SVG path string, read from its coordinate pairs.
 *
 * Used only for path marks (arcs, routes), where d3 has already flattened the
 * geodesic into line segments, so every coordinate in the string is a real
 * vertex and the extent of the numbers is the extent of the shape. Feature
 * bounds come from d3's own measurement instead, which is exact for curves.
 */
function boundsOfPathData(d: string): WorldBounds | null {
  const numbers = d.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi)
  if (!numbers || numbers.length < 4) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    const x = Number(numbers[i])
    const y = Number(numbers[i + 1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null
  return [
    [minX, minY],
    [maxX, maxY],
  ]
}
