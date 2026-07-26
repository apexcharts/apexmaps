/**
 * SVG renderer.
 *
 * The hybrid layering from PRODUCT-RESEARCH.md section 7.2 is set up here even
 * though only the SVG tier exists, because layer order is the part that is
 * expensive to change later:
 *
 * ```
 *   overlay   (screen space)  labels, focus ring          <- crisp text, a11y
 *   symbols   (screen space)  bubbles, endpoint dots      <- constant size
 *   marks     (world space)   feature fills, arcs         <- camera transform
 *   base      (world space)   sphere, graticule           <- camera transform
 * ```
 *
 * World-space content sits under a single `<g>` carrying the camera transform, so
 * a pan costs one attribute write regardless of feature count, and strokes use
 * `vector-effect: non-scaling-stroke` so borders keep their weight when zoomed.
 *
 * Symbols are the exception: a bubble must **not** grow when the reader zooms in,
 * because its radius encodes a value. They therefore live in screen space and are
 * repositioned per camera frame, which is two attribute writes per symbol. That is
 * fine for the hundreds-to-low-thousands range SVG is the right renderer for, and
 * it is the specific cost the Canvas tier removes.
 *
 * @module renderers/SvgRenderer
 */

import { svg, setAttrs, empty, remove } from '../utils/dom'
import type { Viewport } from '../geo/Viewport'
import type { NormalizedFeature, StrokeOptions, WorldPoint } from '../types'

/** Below this stroke width a line needs an invisible wider path to be hoverable. */
const MIN_HIT_WIDTH = 8

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

export interface PathSpec {
  key: string
  item: number
  /** Path data in world space. */
  d: string
  stroke: string
  width: number
  opacity?: number
  dashArray?: string
}

export class SvgRenderer {
  static readonly kind = 'svg' as const

  readonly viewport: Viewport
  root: SVGSVGElement | null = null
  world: SVGGElement | null = null
  baseLayer: SVGGElement | null = null
  marksLayer: SVGGElement | null = null
  symbolLayer: SVGGElement | null = null
  overlayLayer: SVGGElement | null = null
  defs: SVGDefsElement | null = null

  private readonly pathsByKey = new Map<string, SVGPathElement>()
  private readonly symbolsByKey = new Map<string, SVGCircleElement>()
  /** World positions of live symbols, so a camera change can reposition them. */
  private readonly symbolWorld = new Map<string, WorldPoint>()

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
    this.world = svg('g', { class: 'apexmaps-world' })
    this.baseLayer = svg('g', { class: 'apexmaps-layer-base' })
    this.marksLayer = svg('g', { class: 'apexmaps-layer-marks' })
    this.symbolLayer = svg('g', { class: 'apexmaps-layer-symbols' })
    this.overlayLayer = svg('g', { class: 'apexmaps-layer-overlay' })

    this.world.appendChild(this.baseLayer)
    this.world.appendChild(this.marksLayer)
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
  }

  /** Re-place every symbol from its cached world position. */
  positionSymbols(): void {
    if (!this.symbolWorld.size) return
    for (const [key, world] of this.symbolWorld) {
      const el = this.symbolsByKey.get(key)
      if (!el) continue
      const [sx, sy] = this.viewport.worldToScreen(world)
      el.setAttribute('cx', String(sx))
      el.setAttribute('cy', String(sy))
    }
  }

  /**
   * Draw (or update) feature fills.
   *
   * Paths are keyed and reused across renders so a data update tweens fills
   * instead of tearing down the DOM, which is what makes `updateSeries` feel like
   * a chart update rather than a page reload.
   */
  drawFeatures({
    features,
    fill,
    stroke = {},
    opacity = 1,
    seriesId = 's0',
  }: {
    features: NormalizedFeature[]
    fill: (feature: NormalizedFeature) => string
    stroke?: StrokeOptions
    opacity?: number
    seriesId?: string
  }): void {
    if (!this.marksLayer) return
    const group = this.ensureGroup(this.marksLayer, seriesId, 'apexmaps-series')
    const seen = new Set<string>()

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

      path.setAttribute('d', d)
      path.setAttribute('fill', fill(feature))
      path.setAttribute('stroke', stroke.color || 'none')
      path.setAttribute('stroke-width', String(stroke.width ?? 0.5))
      path.setAttribute('vector-effect', 'non-scaling-stroke')
      if (opacity !== 1) path.setAttribute('opacity', String(opacity))
    }

    this.prune(this.pathsByKey, seriesId, seen)
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
  }: {
    paths: PathSpec[]
    seriesId?: string
    hitWidth?: number
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
            class: 'apexmaps-arc-hit',
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
          class: 'apexmaps-arc',
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

    this.prune(this.pathsByKey, seriesId, seen, ['hit'])
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
    return this.pathFor(seriesId, key) ?? this.symbolFor(seriesId, key)
  }

  overlay(): SVGGElement | null {
    return this.overlayLayer
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
      }
    }
    for (const [key, el] of this.symbolsByKey) {
      if (key.startsWith(`${seriesId}:`)) {
        remove(el)
        this.symbolsByKey.delete(key)
        this.symbolWorld.delete(key)
      }
    }
    remove(this.marksLayer?.querySelector(`g[data-series="${seriesId}"]`) ?? null)
    remove(this.symbolLayer?.querySelector(`g[data-series="${seriesId}"]`) ?? null)
  }

  destroy(): void {
    remove(this.root)
    this.root = null
    this.world = null
    this.baseLayer = null
    this.marksLayer = null
    this.symbolLayer = null
    this.overlayLayer = null
    this.defs = null
    this.pathsByKey.clear()
    this.symbolsByKey.clear()
    this.symbolWorld.clear()
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
   * @param skipInfixes Key infixes that belong to this series but are managed
   *   alongside their primary mark, so they must not be pruned independently.
   */
  private prune(
    store: Map<string, SVGElement>,
    seriesId: string,
    seen: Set<string>,
    skipInfixes: string[] = [],
  ): void {
    for (const [key, el] of store) {
      if (!key.startsWith(`${seriesId}:`)) continue
      if (seen.has(key)) continue
      if (skipInfixes.some((infix) => key.startsWith(`${seriesId}:${infix}:`))) continue
      remove(el)
      store.delete(key)
    }
  }
}
