/**
 * SVG renderer.
 *
 * The hybrid layering is set up here even
 * though only the SVG tier exists, because layer order is the part that is
 * expensive to change later:
 *
 * ```
 *   overlay   (screen space)  labels, annotations, focus  <- crisp text, a11y
 *   symbols   (screen space)  bubbles, endpoint dots      <- constant size
 *   regions   (world space)   annotation areas            <- camera transform
 *   marks     (world space)   feature fills, arcs         <- camera transform
 *   base      (world space)   sphere, graticule           <- camera transform
 * ```
 *
 * Annotation areas sit above the fills and below the symbols on purpose: a
 * translucent "this region" highlight belongs over the choropleth it qualifies,
 * but drawing it over the bubbles would veil the data it is pointing at.
 *
 * World-space content sits under a single `<g>` carrying the camera transform, so
 * a pan costs one attribute write regardless of feature count, and strokes use
 * `vector-effect: non-scaling-stroke` so borders keep their weight when zoomed.
 *
 * Symbols are the exception: a bubble must **not** grow when the reader zooms in,
 * because its radius encodes a value. They therefore live in screen space and are
 * repositioned per camera frame, which is two attribute writes per symbol. That is
 * fine for the hundreds-to-low-thousands range this renderer is built for, and
 * clustering bounds the count above it.
 *
 * @module renderers/SvgRenderer
 */

import { svg, setAttrs, empty, remove } from '../utils/dom'
import { PaintRegistry } from './Paint'
import type { FeaturePaint } from './Paint'
import type { Viewport } from '../geo/Viewport'
import type { NormalizedFeature, StrokeOptions, WorldPoint } from '../types'

/** Below this stroke width a line needs an invisible wider path to be hoverable. */
const MIN_HIT_WIDTH = 8

/*
 * Three bounds on how far a ground-anchored flow may follow the camera, one per
 * property, because each degenerates in its own way and at its own zoom. Between
 * them the beads are frozen past six times the opening view: whatever the camera
 * does after that, the flow looks the same.
 */

/**
 * How much larger than its calibrated size a bead may get.
 *
 * Routes carry `non-scaling-stroke` and keep their width however far the reader
 * zooms, so an uncapped bead ends up a blob sitting on a hairline.
 */
const MAX_BEAD_GROWTH = 3

/**
 * How much further apart the beads may spread.
 *
 * Spreading is the point of anchoring them to the ground, and it is what keeps the
 * bead count on a route constant instead of the route turning back into a dotted
 * line at 3x, so this bound is the loosest of the three. It exists because the
 * viewport does not grow with the zoom: at 256x an unbounded spacing is 14,000
 * pixels, one bead passes a given point every eighty seconds, and a reader who
 * zoomed in to look at the traffic finds a static line.
 */
const MAX_SPACING_GROWTH = 6

/**
 * How much faster than at the opening view a bead may appear to travel.
 *
 * Beads cover one dash period per cycle and the period scales, so without this the
 * apparent speed scales too: at ten times the opening zoom they cross the screen
 * ten times faster, which stops reading as traffic and starts reading as agitation.
 *
 * Stretching the cycle is the only lever that holds the speed. Capping the travel
 * instead would leave it shorter than the pattern it advances, and the beads would
 * jump back once per cycle rather than looping.
 */
const MAX_FLOW_SPEEDUP = 2

export interface SymbolSpec {
  /** Stable identity within the series, used for the DOM key and hit-testing. */
  key: string
  /** Index within the series, carried on the DOM for event resolution. */
  item: number
  world: WorldPoint
  radius: number
  fill: string
  stroke?: StrokeOptions
  opacity?: number
}

/**
 * A shaped, optionally labelled screen-space mark: a marker or a point cluster.
 *
 * Drawn as a `<g transform>` wrapping a path and an optional label, so however
 * many parts a mark has, moving it stays one attribute write.
 */
export interface MarkSpec {
  key: string
  /** Index into the series' items, or -1 for a cluster. */
  item: number
  /** Index into the series' clusters, or -1 for a single mark. */
  cluster: number
  world: WorldPoint
  /** Path data centred on the origin, or with its tip there when point-anchored. */
  d: string
  pointAnchored?: boolean
  fill: string
  stroke?: StrokeOptions
  opacity?: number
  label?: string
  labelSize?: number
  /**
   * Ink for the label, which the mark decides rather than the stylesheet: a
   * cluster count sits on the cluster's own fill, and that fill is the caller's.
   * Left unset the text inherits, which is only safe when nothing is behind it.
   */
  labelFill?: string
  /** Radius of the invisible hit circle, so small shapes stay clickable. */
  hitRadius?: number
}

export interface PathSpec {
  key: string
  item: number
  /** Path data in world space. */
  d: string
  stroke: string
  width: number
  opacity?: number
  dashArray?: string
  /** Beads travelling along this path. See `series/flow`. */
  flow?: FlowSpec
}

/**
 * A resolved flow: everything the dashed companion path needs, in screen pixels
 * and seconds. Built by `series/flow`, which is where the reasoning lives.
 */
export interface FlowSpec {
  /** Dash length. Near zero with a round cap is a dot. */
  dash: number
  gap: number
  /** Stroke width, which is the bead's diameter. */
  width: number
  color: string
  opacity: number
  /** Seconds to advance one full period. Zero paints the beads without motion. */
  duration: number
  /** Negative seconds, so a staggered route starts mid-pattern rather than pausing. */
  delay: number
  /**
   * `'zoom'` anchors the beads to the ground: every number above is multiplied by
   * how far the camera has zoomed from the view the map opened at, so a bead stays
   * over the same stretch of route. `'screen'` holds them at a fixed size and
   * spacing however far the reader zooms.
   */
  scale: 'zoom' | 'screen'
}

export class SvgRenderer {
  static readonly kind = 'svg' as const

  readonly viewport: Viewport
  root: SVGSVGElement | null = null
  world: SVGGElement | null = null
  baseLayer: SVGGElement | null = null
  marksLayer: SVGGElement | null = null
  /** World space, above the marks: annotation area highlights. */
  regionLayer: SVGGElement | null = null
  symbolLayer: SVGGElement | null = null
  overlayLayer: SVGGElement | null = null
  defs: SVGDefsElement | null = null
  /** Pattern and image fills, which are document resources rather than attributes. */
  paints: PaintRegistry | null = null

  private readonly pathsByKey = new Map<string, SVGPathElement>()
  /** Calibrated geometry of live flow paths, so a camera change can rescale them. */
  private readonly flowByKey = new Map<string, FlowSpec>()
  /** The scale factor last written, so an unchanged camera writes nothing. */
  private flowFactor = 1
  private readonly symbolsByKey = new Map<string, SVGCircleElement>()
  private readonly marksByKey = new Map<string, SVGGElement>()
  /** World positions of live symbols, so a camera change can reposition them. */
  private readonly symbolWorld = new Map<string, WorldPoint>()
  private readonly markWorld = new Map<string, WorldPoint>()

  constructor({ viewport }: { viewport: Viewport }) {
    this.viewport = viewport
  }

  mount(
    container: HTMLElement,
    {
      width,
      height,
      background,
      fontFamily,
    }: {
      width: number
      height: number
      background?: string
      fontFamily?: string
    },
  ): SVGSVGElement {
    const root = svg('svg', {
      class: 'apexmaps-svg',
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      // Sized by the container, so the SVG must not impose its own aspect fit.
      preserveAspectRatio: 'none',
      style: {
        display: 'block',
        background: background || 'transparent',
        fontFamily: fontFamily || 'inherit',
        overflow: 'hidden',
        touchAction: 'none',
      },
    })

    this.defs = svg('defs')
    this.paints = new PaintRegistry(this.defs)
    this.world = svg('g', { class: 'apexmaps-world' })
    this.baseLayer = svg('g', { class: 'apexmaps-layer-base' })
    this.marksLayer = svg('g', { class: 'apexmaps-layer-marks' })
    this.regionLayer = svg('g', { class: 'apexmaps-layer-regions' })
    this.symbolLayer = svg('g', { class: 'apexmaps-layer-symbols' })
    this.overlayLayer = svg('g', { class: 'apexmaps-layer-overlay' })

    this.world.appendChild(this.baseLayer)
    this.world.appendChild(this.marksLayer)
    this.world.appendChild(this.regionLayer)
    root.appendChild(this.defs)
    root.appendChild(this.world)
    root.appendChild(this.symbolLayer)
    root.appendChild(this.overlayLayer)
    container.appendChild(root)

    this.root = root
    this.applyCamera()
    return root
  }

  resize(width: number, height: number): void {
    if (!this.root) return
    setAttrs(this.root, { width, height, viewBox: `0 0 ${width} ${height}` })
  }

  /**
   * Push the current camera onto the world group, and reposition screen-space
   * symbols. The only work that runs on every pan and zoom frame.
   */
  applyCamera(): void {
    if (this.world) this.world.setAttribute('transform', this.viewport.transform())
    this.positionSymbols()
    this.applyFlowScale()
    // Texture tiles resolve in world space, so without this they grow with the
    // zoom. Image fills are meant to, and are left alone. See `renderers/Paint`.
    this.paints?.applyScale(this.viewport.camera.k)
  }

  /**
   * Re-place every screen-space mark from its cached world position.
   *
   * This is the per-frame cost of screen-space marks, and it is O(marks) rather
   * than O(features): the features themselves ride the world transform untouched.
   */
  positionSymbols(): void {
    for (const [key, world] of this.symbolWorld) {
      const el = this.symbolsByKey.get(key)
      if (!el) continue
      const [sx, sy] = this.viewport.worldToScreen(world)
      el.setAttribute('cx', String(sx))
      el.setAttribute('cy', String(sy))
    }
    for (const [key, world] of this.markWorld) {
      const el = this.marksByKey.get(key)
      if (!el) continue
      const [sx, sy] = this.viewport.worldToScreen(world)
      // One write per mark however many parts it has, which is why marks are
      // groups rather than loose shapes.
      el.setAttribute('transform', `translate(${sx},${sy})`)
    }
  }

  /**
   * Draw (or update) feature fills.
   *
   * Paths are keyed and reused across renders so a data update tweens fills
   * instead of tearing down the DOM, which is what makes `updateSeries` feel like
   * a chart update rather than a page reload.
   *
   * `paint` is the licensed path: a pattern or an image instead of the flat fill.
   * The flat colour is still written, to `data-fill`, because a paint is a
   * document reference and the places that need to *reason* about the colour
   * (darkening on hover, seeding a drilldown) cannot read one out of `url(#id)`.
   */
  drawFeatures({
    features,
    fill,
    paint,
    stroke = {},
    opacity = 1,
    seriesId = 's0',
  }: {
    features: NormalizedFeature[]
    fill: (feature: NormalizedFeature) => string
    paint?: (feature: NormalizedFeature) => FeaturePaint | null
    stroke?: StrokeOptions
    opacity?: number
    seriesId?: string
  }): void {
    if (!this.marksLayer) return
    const group = this.ensureGroup(this.marksLayer, seriesId, 'apexmaps-series')
    const seen = new Set<string>()
    const paintsSeen = new Set<string>()

    for (const feature of features) {
      const d = this.viewport.pathFor(feature)
      if (!d) continue

      const key = `${seriesId}:${feature.key || feature.index}`
      seen.add(key)
      let path = this.pathsByKey.get(key)

      if (!path) {
        path = svg('path', {
          class: 'apexmaps-feature',
          dataset: {
            key: feature.key,
            index: feature.index,
            item: feature.index,
            series: seriesId,
          },
        })
        this.pathsByKey.set(key, path)
        group.appendChild(path)
      }

      const color = fill(feature)
      const spec = paint?.(feature) ?? null
      const ref = spec
        ? (this.paints?.resolve(spec, {
            seriesId,
            bounds: spec.kind === 'image' ? this.viewport.measure(feature.geometry) : null,
            seen: paintsSeen,
          }) ?? null)
        : null

      path.setAttribute('d', d)
      path.setAttribute('fill', ref ?? color)
      if (ref) {
        path.setAttribute('data-paint', ref)
        path.setAttribute('data-fill', color)
      } else {
        path.removeAttribute('data-paint')
        path.removeAttribute('data-fill')
      }
      path.setAttribute('stroke', stroke.color || 'none')
      path.setAttribute('stroke-width', String(stroke.width ?? 0.5))
      path.setAttribute('vector-effect', 'non-scaling-stroke')
      if (opacity !== 1) path.setAttribute('opacity', String(opacity))
    }

    this.prune(this.pathsByKey, seriesId, seen)
    // Unconditional: a series that *stops* painting has to have its defs cleared,
    // and that is exactly the pass where `paint` is absent.
    this.paints?.pruneSeries(seriesId, paintsSeen)
  }

  /**
   * Draw (or update) world-space line marks, such as arcs and routes.
   *
   * Thin lines get an invisible wider companion path so they can actually be
   * hovered: a 1px flight line is effectively unpointable otherwise, and widening
   * the visible stroke to compensate would misrepresent the value it encodes.
   */
  drawPaths({
    paths,
    seriesId = 'p0',
    hitWidth = MIN_HIT_WIDTH,
    markClass = 'apexmaps-arc',
    animateFlow = true,
  }: {
    paths: PathSpec[]
    seriesId?: string
    hitWidth?: number
    /** CSS class per mark; the hit companion gets `${markClass}-hit`. */
    markClass?: string
    /**
     * Whether a flow's beads travel. False still paints them, spaced along the
     * route: a dotted route reads as a route, which is a better answer under
     * reduced motion than a route that lost its marks.
     */
    animateFlow?: boolean
  }): void {
    if (!this.marksLayer) return
    const group = this.ensureGroup(
      this.marksLayer,
      seriesId,
      'apexmaps-series apexmaps-series--paths',
    )
    const seen = new Set<string>()

    for (const spec of paths) {
      if (!spec.d) continue

      const hitKey = `${seriesId}:hit:${spec.key}`
      const key = `${seriesId}:${spec.key}`

      if (spec.width < hitWidth) {
        seen.add(hitKey)
        let hit = this.pathsByKey.get(hitKey)
        if (!hit) {
          hit = svg('path', {
            class: `${markClass}-hit`,
            fill: 'none',
            stroke: 'transparent',
            'stroke-linecap': 'round',
            'pointer-events': 'stroke',
            dataset: { key: spec.key, item: spec.item, series: seriesId },
          })
          this.pathsByKey.set(hitKey, hit)
          group.appendChild(hit)
        }
        hit.setAttribute('d', spec.d)
        hit.setAttribute('stroke-width', String(hitWidth))
        hit.setAttribute('vector-effect', 'non-scaling-stroke')
      }

      seen.add(key)
      let path = this.pathsByKey.get(key)
      if (!path) {
        path = svg('path', {
          class: markClass,
          fill: 'none',
          'stroke-linecap': 'round',
          // Pointer events live on the hit path when there is one.
          'pointer-events': 'stroke',
          dataset: { key: spec.key, item: spec.item, series: seriesId },
        })
        this.pathsByKey.set(key, path)
        group.appendChild(path)
      }

      path.setAttribute('d', spec.d)
      path.setAttribute('stroke', spec.stroke)
      path.setAttribute('stroke-width', String(spec.width))
      path.setAttribute('vector-effect', 'non-scaling-stroke')
      if (spec.opacity != null && spec.opacity !== 1)
        path.setAttribute('opacity', String(spec.opacity))
      if (spec.dashArray) path.setAttribute('stroke-dasharray', spec.dashArray)
    }

    this.drawFlow(group, paths, seriesId, seen, animateFlow)
    this.prune(this.pathsByKey, seriesId, seen)
  }

  /**
   * The travelling beads, one dashed companion path per route.
   *
   * They go in a group of their own, after the routes, for two reasons. Every
   * bead then sits above every route, rather than being cut by whichever route
   * happened to be drawn later, and the only content on the map that repaints
   * every frame is isolated in its own paint chunk from the geometry that never
   * moves.
   */
  private drawFlow(
    group: SVGGElement,
    paths: PathSpec[],
    seriesId: string,
    seen: Set<string>,
    animate: boolean,
  ): void {
    const flows = paths.filter((spec) => spec.d && spec.flow)
    let flowGroup = group.querySelector<SVGGElement>('g.apexmaps-series--flow')

    // Rebuilt rather than merged: a route that lost its flow, or the series that
    // lost every route, must not leave an entry behind for the camera to keep
    // rescaling.
    for (const key of this.flowByKey.keys()) {
      if (key.startsWith(`${seriesId}:`)) this.flowByKey.delete(key)
    }

    // Flow turned off by an update. The beads themselves are pruned by key like
    // any other companion mark, because they never entered `seen`; this is the
    // group they lived in, which nothing else would collect.
    if (!flows.length) {
      remove(flowGroup)
      return
    }

    if (!flowGroup) {
      flowGroup = svg('g', { class: 'apexmaps-series--flow' })
      group.appendChild(flowGroup)
    }

    for (const spec of flows) {
      const flow = spec.flow!
      const key = `${seriesId}:flow:${spec.key}`
      seen.add(key)

      let path = this.pathsByKey.get(key) as SVGPathElement | undefined
      if (!path) {
        path = svg('path', {
          class: 'apexmaps-flow',
          fill: 'none',
          'stroke-linecap': 'round',
          // A bead is decoration over a route that is already hoverable, and one
          // that swallowed the pointer would make the route under it harder to
          // hit than it was before flow was turned on.
          'pointer-events': 'none',
        })
        this.pathsByKey.set(key, path)
        flowGroup.appendChild(path)
      }

      this.flowByKey.set(key, flow)
      setAttrs(path, {
        d: spec.d,
        stroke: flow.color,
        // The width and the dash pattern are written by `applyFlowScale` below,
        // which is the only place that knows where the camera is.
        'vector-effect': 'non-scaling-stroke',
      })
      // Written or removed rather than skipped when it is 1: `setAttrs` treats a
      // null as "leave alone", which would strand yesterday's 0.4 on a bead the
      // caller has since asked for at full strength.
      if (flow.opacity === 1) path.removeAttribute('opacity')
      else path.setAttribute('opacity', String(flow.opacity))

      // Every number the animation runs on is written by `applyFlowScale`, which
      // is the only place that knows where the camera is. All that is decided here
      // is whether it runs at all.
      path.classList.toggle('apexmaps-flow--moving', animate && flow.duration > 0)
    }

    // Kept last: a route added by a later update is appended to the series group,
    // which would otherwise put it over the beads.
    group.appendChild(flowGroup)
    this.applyFlowScale(true)
  }

  /**
   * Size and space the beads for where the camera is.
   *
   * Beads are anchored to the ground rather than to the screen, so a bead stays
   * over the same stretch of route as the reader zooms, and the number of them on
   * a route stays what it was set to be. Holding the spacing constant in screen
   * pixels instead means the count grows with the zoom, and a route that read as
   * five beads at the opening view is a dotted line at 3x, which is the whole
   * reason this exists.
   *
   * Everything is written in screen pixels, against `non-scaling-stroke`, rather
   * than left in world units for the camera transform to scale: expressing it in
   * world units would scale the bead's width by the same factor as its spacing,
   * and those two want different laws. See `MAX_BEAD_GROWTH`.
   *
   * The travel goes with them, so the beads cross the same ground per second at
   * any zoom and appear faster when the reader is closer, which is what anything
   * moving over a map does, up to `MAX_FLOW_SPEEDUP`. Past that the cycle is
   * stretched to hold the speed, because a deep zoom is where the honest version
   * turns into agitation.
   *
   * The factor is the camera's zoom, with nothing subtracted, because `view.fit`
   * fits the *projection* and never moves the camera: `k` is already the zoom
   * relative to the view the map opened at, whatever that view was framed on. A
   * flow's screen-pixel options therefore mean what they say in the opening view of
   * a map fitted to one country as much as one fitted to the world.
   *
   * @param force Write even when the camera has not moved, for newly drawn paths.
   */
  private applyFlowScale(force = false): void {
    if (!this.flowByKey.size) return

    const factor = this.viewport.camera.k || 1
    // A pan changes no zoom, and a pan is the common gesture: below this the whole
    // pass is one comparison per frame.
    if (!force && Math.abs(factor - this.flowFactor) < 1e-4) return
    this.flowFactor = factor

    for (const [key, flow] of this.flowByKey) {
      const path = this.pathsByKey.get(key)
      if (!path) continue

      const scale = flow.scale === 'screen' ? 1 : factor
      const spread = Math.min(scale, MAX_SPACING_GROWTH)
      const dash = flow.dash * spread
      const gap = flow.gap * spread
      path.setAttribute('stroke-dasharray', `${dash} ${gap}`)
      path.setAttribute('stroke-width', String(flow.width * Math.min(scale, MAX_BEAD_GROWTH)))
      // The keyframe travels by one period, and the period just changed.
      path.style.setProperty('--apexmaps-flow-travel', `${dash + gap}px`)

      // The cycle covers exactly that travel, so pace is period over duration and
      // this ratio is what sets it: the cycle takes as much longer as the period
      // grew, divided by however much faster the beads are allowed to look. Below
      // both bounds it is 1 and the pace tracks the zoom. The delay is stretched
      // with it so the routes keep the relative stagger they were given rather than
      // drifting into step.
      const stretch = spread / Math.min(scale, MAX_FLOW_SPEEDUP)
      path.style.setProperty('--apexmaps-flow-duration', `${flow.duration * stretch}s`)
      path.style.setProperty('--apexmaps-flow-delay', `${flow.delay * stretch}s`)
    }
  }

  /**
   * Draw (or update) screen-space symbols.
   *
   * Order matters and is the caller's responsibility: the series sorts largest
   * first so small bubbles end up on top and stay clickable.
   */
  drawSymbols({ symbols, seriesId = 'b0' }: { symbols: SymbolSpec[]; seriesId?: string }): void {
    if (!this.symbolLayer) return
    const group = this.ensureGroup(this.symbolLayer, seriesId, 'apexmaps-symbols')
    const seen = new Set<string>()

    for (const spec of symbols) {
      const key = `${seriesId}:${spec.key}`
      seen.add(key)

      let circle = this.symbolsByKey.get(key)
      if (!circle) {
        circle = svg('circle', {
          class: 'apexmaps-bubble',
          dataset: { key: spec.key, item: spec.item, series: seriesId },
        })
        this.symbolsByKey.set(key, circle)
        group.appendChild(circle)
      }

      const [sx, sy] = this.viewport.worldToScreen(spec.world)
      this.symbolWorld.set(key, spec.world)

      circle.setAttribute('cx', String(sx))
      circle.setAttribute('cy', String(sy))
      circle.setAttribute('r', String(spec.radius))
      circle.setAttribute('fill', spec.fill)
      circle.setAttribute('stroke', spec.stroke?.color ?? 'none')
      circle.setAttribute('stroke-width', String(spec.stroke?.width ?? 0))
      circle.setAttribute('opacity', String(spec.opacity ?? 1))
    }

    for (const [key, el] of this.symbolsByKey) {
      if (key.startsWith(`${seriesId}:`) && !seen.has(key)) {
        remove(el)
        this.symbolsByKey.delete(key)
        this.symbolWorld.delete(key)
      }
    }
  }

  /**
   * Draw (or update) shaped screen-space marks: markers and point clusters.
   *
   * Each mark is a group holding its shape, an optional label, and an invisible
   * hit circle. The hit circle exists because a 10px star has perhaps 30 square
   * pixels of actual ink, and a reader should not have to hit the ink.
   */
  drawMarks({ marks, seriesId = 'm0' }: { marks: MarkSpec[]; seriesId?: string }): void {
    if (!this.symbolLayer) return
    const group = this.ensureGroup(this.symbolLayer, seriesId, 'apexmaps-marks')
    const seen = new Set<string>()

    for (const spec of marks) {
      const key = `${seriesId}:${spec.key}`
      seen.add(key)

      let mark = this.marksByKey.get(key)
      if (!mark) {
        mark = svg('g', { class: 'apexmaps-mark' }) as SVGGElement
        this.marksByKey.set(key, mark)
        group.appendChild(mark)
      }

      // The dataset lives on the group; hit resolution walks up from whichever
      // child the pointer actually landed on.
      mark.setAttribute('data-key', String(spec.key))
      mark.setAttribute('data-item', String(spec.item))
      mark.setAttribute('data-series', seriesId)
      if (spec.cluster >= 0) mark.setAttribute('data-cluster', String(spec.cluster))
      else mark.removeAttribute('data-cluster')
      mark.classList.toggle('apexmaps-cluster', spec.cluster >= 0)

      const [sx, sy] = this.viewport.worldToScreen(spec.world)
      this.markWorld.set(key, spec.world)
      mark.setAttribute('transform', `translate(${sx},${sy})`)
      mark.setAttribute('opacity', String(spec.opacity ?? 1))

      let shape = mark.querySelector<SVGPathElement>('path.apexmaps-mark-shape')
      if (!shape) {
        shape = svg('path', { class: 'apexmaps-mark-shape' }) as SVGPathElement
        mark.appendChild(shape)
      }
      shape.setAttribute('d', spec.d)
      shape.setAttribute('fill', spec.fill)
      shape.setAttribute('stroke', spec.stroke?.color ?? 'none')
      shape.setAttribute('stroke-width', String(spec.stroke?.width ?? 0))

      const hitRadius = spec.hitRadius ?? 0
      let hit = mark.querySelector<SVGCircleElement>('circle.apexmaps-mark-hit')
      if (hitRadius > 0) {
        if (!hit) {
          hit = svg('circle', { class: 'apexmaps-mark-hit', fill: 'transparent', stroke: 'none' })
          mark.appendChild(hit)
        }
        hit.setAttribute('r', String(hitRadius))
        // A pin's ink sits above its anchor, so its hit area has to as well.
        hit.setAttribute('cy', spec.pointAnchored ? String(-hitRadius * 1.6) : '0')
      } else if (hit) {
        remove(hit)
      }

      let text = mark.querySelector<SVGTextElement>('text.apexmaps-mark-label')
      if (spec.label) {
        if (!text) {
          text = svg('text', {
            class: 'apexmaps-mark-label',
            'text-anchor': 'middle',
            'dominant-baseline': 'central',
            'pointer-events': 'none',
          }) as SVGTextElement
          mark.appendChild(text)
        }
        text.textContent = spec.label
        text.setAttribute('font-size', String(spec.labelSize ?? 11))
        if (spec.labelFill) text.setAttribute('fill', spec.labelFill)
      } else if (text) {
        remove(text)
      }
    }

    for (const [key, el] of this.marksByKey) {
      if (key.startsWith(`${seriesId}:`) && !seen.has(key)) {
        remove(el)
        this.marksByKey.delete(key)
        this.markWorld.delete(key)
      }
    }
  }

  markGroupFor(seriesId: string, key: string | number): SVGGElement | undefined {
    return this.marksByKey.get(`${seriesId}:${key}`)
  }

  /**
   * Draw (or clear) the selection box.
   *
   * Lives in the overlay layer, in screen space: a box drawn in world space would
   * follow the map if the camera moved under it, which is not what a reader
   * dragging a box on their screen means. `null` removes it.
   */
  drawSelectBox(box: [[number, number], [number, number]] | null): void {
    if (!this.overlayLayer) return
    const existing = this.overlayLayer.querySelector<SVGRectElement>('rect.apexmaps-select-box')
    if (!box) {
      remove(existing)
      return
    }

    const rect = existing ?? (svg('rect', { class: 'apexmaps-select-box' }) as SVGRectElement)
    if (!existing) this.overlayLayer.appendChild(rect)
    setAttrs(rect, {
      x: box[0][0],
      y: box[0][1],
      width: Math.max(0, box[1][0] - box[0][0]),
      height: Math.max(0, box[1][1] - box[0][1]),
    })
  }

  drawBasePath(d: string, attrs: Record<string, string | number>, className: string): void {
    if (!this.baseLayer || !d) return
    let path = this.baseLayer.querySelector(`.${className}`)
    if (!path) {
      path = svg('path', { class: className })
      this.baseLayer.appendChild(path)
    }
    setAttrs(path, { d, 'vector-effect': 'non-scaling-stroke', ...attrs })
  }

  clearBasePath(className: string): void {
    if (!this.baseLayer) return
    remove(this.baseLayer.querySelector(`.${className}`))
  }

  /** The rendered element for a mark, for hover and selection styling. */
  pathFor(seriesId: string, key: string | number): SVGPathElement | undefined {
    return this.pathsByKey.get(`${seriesId}:${key}`)
  }

  symbolFor(seriesId: string, key: string | number): SVGCircleElement | undefined {
    return this.symbolsByKey.get(`${seriesId}:${key}`)
  }

  markFor(seriesId: string, key: string | number): SVGElement | undefined {
    return (
      this.pathFor(seriesId, key) ??
      this.symbolFor(seriesId, key) ??
      this.markGroupFor(seriesId, key)
    )
  }

  overlay(): SVGGElement | null {
    return this.overlayLayer
  }

  /** World space, above the marks: where annotation areas are drawn. */
  regions(): SVGGElement | null {
    return this.regionLayer
  }

  clearOverlay(): void {
    if (this.overlayLayer) empty(this.overlayLayer)
  }

  /** Remove every mark belonging to a series, e.g. when its type changes. */
  clearSeries(seriesId: string): void {
    for (const [key, el] of this.pathsByKey) {
      if (key.startsWith(`${seriesId}:`)) {
        remove(el)
        this.pathsByKey.delete(key)
        this.flowByKey.delete(key)
      }
    }
    for (const [key, el] of this.symbolsByKey) {
      if (key.startsWith(`${seriesId}:`)) {
        remove(el)
        this.symbolsByKey.delete(key)
        this.symbolWorld.delete(key)
      }
    }
    for (const [key, el] of this.marksByKey) {
      if (key.startsWith(`${seriesId}:`)) {
        remove(el)
        this.marksByKey.delete(key)
        this.markWorld.delete(key)
      }
    }
    remove(this.marksLayer?.querySelector(`g[data-series="${seriesId}"]`) ?? null)
    remove(this.symbolLayer?.querySelector(`g[data-series="${seriesId}"]`) ?? null)
    this.paints?.clearSeries(seriesId)
  }

  destroy(): void {
    this.paints?.clear()
    this.paints = null
    remove(this.root)
    this.root = null
    this.world = null
    this.baseLayer = null
    this.marksLayer = null
    this.regionLayer = null
    this.symbolLayer = null
    this.overlayLayer = null
    this.defs = null
    this.pathsByKey.clear()
    this.flowByKey.clear()
    this.symbolsByKey.clear()
    this.symbolWorld.clear()
    this.marksByKey.clear()
    this.markWorld.clear()
  }

  private ensureGroup(parent: SVGGElement, seriesId: string, className: string): SVGGElement {
    let group = parent.querySelector<SVGGElement>(`g[data-series="${seriesId}"]`)
    if (!group) {
      group = svg('g', { class: className, dataset: { series: seriesId } })
      parent.appendChild(group)
    }
    return group
  }

  /**
   * Drop marks whose data disappeared, e.g. after a filter or a reload.
   *
   * Companion marks (an arc's invisible hit path) are pruned by the same rule:
   * their keys enter `seen` alongside their primary mark, so a surviving arc
   * keeps its hit path and a removed arc loses both. Exempting them instead
   * leaves a transparent, still-hoverable path whose stale item index resolves
   * to a different arc's data.
   */
  private prune(store: Map<string, SVGElement>, seriesId: string, seen: Set<string>): void {
    for (const [key, el] of store) {
      if (!key.startsWith(`${seriesId}:`)) continue
      if (seen.has(key)) continue
      remove(el)
      store.delete(key)
    }
  }
}
