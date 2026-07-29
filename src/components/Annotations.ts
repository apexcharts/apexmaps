/**
 * Annotations: the editorial layer.
 *
 * A map with data on it says what is where. An annotation says what the reader
 * is supposed to notice, and that is usually the actual point of publishing the
 * map. Three anchoring modes, because there are three things authors point at:
 *
 * - **points** at a coordinate: "epicentre", "the new plant".
 * - **features** by key: anchored at the same point the label engine picks, so
 *   it tracks the geometry through a projection change instead of drifting off
 *   the shape it belongs to.
 * - **areas** over a box or any geometry: "the drought region".
 *
 * Four decisions worth stating, because each is a place a naive implementation
 * behaves worse in a way that is hard to notice:
 *
 * 1. **Annotations never lose a collision; generated labels yield to them.**
 *    An author placed the annotation deliberately, and a feature label is
 *    produced by a rule. Dropping the deliberate one because the generated one
 *    got there first is exactly backwards, so annotations lay out first and
 *    hand their boxes to the label engine as already-occupied space.
 * 2. **Inert to the pointer.** An annotation sits over data by definition, and
 *    a chip that swallows the hover of the country it is explaining would make
 *    the map worse than an unannotated one.
 * 3. **Anchors live in world space, text in screen space.** Same split as
 *    labels: the anchor tracks the geography through pan and zoom, while the
 *    text keeps its size, because editorial type that grows with the camera
 *    stops being type and becomes decoration.
 * 4. **Areas go through the projection**, so a "box" over the Arctic bows the
 *    way the graticule does rather than staying a screen-space rectangle that
 *    claims the projection is flat.
 *
 * @module components/Annotations
 */

import { svg, empty } from '../utils/dom'
import { markerPath, isPointAnchored } from '../renderers/Shapes'
import type { SvgRenderer } from '../renderers/SvgRenderer'
import type { Box } from './Labels'
import type { Viewport } from '../geo/Viewport'
import type {
  AnnotationConnector,
  AnnotationLabel,
  AnnotationMarker,
  AnnotationOptions,
  BBox4,
  FeatureAnnotation,
  LonLat,
  MarkerShape,
  StrokeOptions,
  WorldPoint,
} from '../types'

const DEFAULT_MARKER_SIZE = 9
const DEFAULT_FONT_SIZE = 11
const DEFAULT_PADDING = 4
const DEFAULT_GAP = 10

/** A laid-out annotation, resolved to world space and ready to draw. */
interface Resolved {
  id: string
  kind: 'point' | 'feature' | 'area'
  world: WorldPoint
  label: AnnotationLabel | null
  marker: AnnotationMarker | null
  connector: AnnotationConnector | undefined
  className?: string
  /** Area and feature-outline path data, in world space. */
  d?: string
  fill?: string
  fillOpacity?: number
  stroke?: StrokeOptions
}

/**
 * A screen-space box an annotation occupies, for the label engine to avoid.
 * The same unit label collision uses, so reservation is just a seeded list.
 */
export type ReservedBox = Box

/**
 * How the chart exposes what annotations need to look up, so this component
 * holds no geometry of its own and cannot go stale against a drilldown.
 */
export interface AnnotationAccess {
  /** World-space anchor for a feature key, from the same map labels use. */
  anchorFor(key: string): WorldPoint | undefined
  /** The feature itself, for tracing an outline. */
  featureFor(key: string): { geometry?: unknown } | undefined
}

export class Annotations {
  readonly renderer: SvgRenderer
  readonly viewport: Viewport
  options: AnnotationOptions
  warnings: string[] = []

  /** Screen-space boxes occupied by the last layout, for label collision. */
  reserved: ReservedBox[] = []
  count = 0

  private readonly access: AnnotationAccess
  private overlayGroup: SVGGElement | null = null
  private regionGroup: SVGGElement | null = null
  private resolved: Resolved[] = []

  constructor({
    renderer,
    viewport,
    options,
    access,
  }: {
    renderer: SvgRenderer
    viewport: Viewport
    options?: AnnotationOptions
    access: AnnotationAccess
  }) {
    this.renderer = renderer
    this.viewport = viewport
    this.options = options ?? {}
    this.access = access
  }

  /**
   * Resolve anchors to world space. Called once per draw, and again on a
   * projection change, but never per camera frame: projecting is the expensive
   * half and the camera does not change it.
   */
  resolve(): void {
    const { points = [], features = [], areas = [] } = this.options
    this.resolved = []
    this.warnings = []

    points.forEach((annotation, i) => {
      const at = annotation.at
      if (!isLonLat(at)) {
        this.warnings.push(
          `annotations.points[${i}] has no usable "at": expected [lon, lat], received ${describe(at)}`,
        )
        return
      }
      const world = this.viewport.project(at as LonLat)
      // A clipped anchor is not an error: an orthographic projection legitimately
      // hides half the earth, and the annotation reappears when it is rotated
      // back into view.
      if (!world) return
      this.resolved.push({
        id: annotation.id ?? `point-${i}`,
        kind: 'point',
        world,
        ...common(annotation),
      })
    })

    features.forEach((annotation, i) => {
      if (!annotation?.key) {
        this.warnings.push(`annotations.features[${i}] has no "key" to attach to`)
        return
      }
      const world = this.access.anchorFor(annotation.key)
      if (!world) {
        // Worth saying: a key that matches nothing is the silent failure this
        // whole diagnostics philosophy exists for. Drilling into a level where
        // the key legitimately does not exist reports it the same way, which is
        // the honest reading of "your annotation is not on this map".
        this.warnings.push(
          `annotations.features[${i}] key "${annotation.key}" matches no feature on this map, so nothing was drawn for it`,
        )
        return
      }
      this.resolved.push({
        id: annotation.id ?? `feature-${i}`,
        kind: 'feature',
        world,
        d: annotation.outline ? (this.outlinePath(annotation.key) ?? undefined) : undefined,
        stroke: outlineStroke(annotation.outline),
        fill: 'none',
        ...common(annotation),
      })
    })

    areas.forEach((annotation, i) => {
      const geometry = annotation.geometry ?? boundsToPolygon(annotation.bounds)
      if (!geometry) {
        this.warnings.push(
          `annotations.areas[${i}] needs "bounds" ([west, south, east, north]) or a GeoJSON "geometry"`,
        )
        return
      }
      const d = this.viewport.path?.(geometry as never) || null
      const centre = this.viewport.path?.centroid(geometry as never)
      if (!d || !centre || !Number.isFinite(centre[0])) return

      this.resolved.push({
        id: annotation.id ?? `area-${i}`,
        kind: 'area',
        world: [centre[0], centre[1]],
        d,
        fill: annotation.fill ?? 'var(--apexmaps-focus, #2563eb)',
        fillOpacity: annotation.fillOpacity ?? 0.12,
        stroke: annotation.stroke ?? { color: 'var(--apexmaps-focus, #2563eb)', width: 1.5 },
        ...common(annotation),
      })
    })

    this.count = this.resolved.length
  }

  /**
   * Draw. World-space shapes are written once per resolve; screen-space parts
   * are rebuilt per camera change, exactly as labels are, because the candidate
   * set is small and pre-resolved.
   */
  layout(): void {
    this.drawRegions()
    this.drawOverlay()
  }

  private drawRegions(): void {
    const host = this.renderer.regions()
    if (!host) return
    if (!this.regionGroup) {
      this.regionGroup = svg('g', {
        class: 'apexmaps-annotation-regions',
        // Editorial overlay, never a hit target: see the module note.
        'pointer-events': 'none',
      })
      host.appendChild(this.regionGroup)
    }
    empty(this.regionGroup)

    for (const item of this.resolved) {
      if (!item.d) continue
      const path = svg('path', {
        class: `apexmaps-annotation-area${item.className ? ` ${item.className}` : ''}`,
        d: item.d,
        fill: item.fill ?? 'none',
        'fill-opacity': item.fillOpacity ?? 1,
        stroke: item.stroke?.color ?? 'none',
        'stroke-width': item.stroke?.width ?? 1,
        'stroke-dasharray': item.stroke?.dashArray,
        // Keeps an outline's weight honest at any zoom, the same rule feature
        // borders follow.
        'vector-effect': 'non-scaling-stroke',
        dataset: { annotation: item.id },
      })
      this.regionGroup.appendChild(path)
    }
  }

  private drawOverlay(): void {
    const host = this.renderer.overlay()
    if (!host) return
    if (!this.overlayGroup) {
      this.overlayGroup = svg('g', {
        class: 'apexmaps-annotations',
        'pointer-events': 'none',
      })
      host.appendChild(this.overlayGroup)
    }
    empty(this.overlayGroup)
    this.reserved = []

    for (const item of this.resolved) {
      const [sx, sy] = this.viewport.worldToScreen(item.world)
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue
      // Cull generously offscreen: a chip anchored just outside the plot still
      // has ink inside it.
      if (
        sx < -200 ||
        sy < -200 ||
        sx > this.viewport.width + 200 ||
        sy > this.viewport.height + 200
      )
        continue

      const group = svg('g', {
        class: `apexmaps-annotation apexmaps-annotation--${item.kind}${
          item.className ? ` ${item.className}` : ''
        }`,
        dataset: { annotation: item.id },
      })

      const marker = item.marker
      const markerSize = marker?.size ?? DEFAULT_MARKER_SIZE
      const showMarker = !!marker && marker.show !== false
      if (showMarker) {
        const shape = (marker.shape ?? 'circle') as MarkerShape
        group.appendChild(
          svg('path', {
            class: 'apexmaps-annotation-marker',
            d: markerPath(shape, markerSize),
            transform: `translate(${sx},${sy})`,
            fill: marker.fill ?? 'var(--apexmaps-focus, #2563eb)',
            stroke: marker.stroke?.color ?? '#ffffff',
            'stroke-width': marker.stroke?.width ?? 1.5,
          }),
        )
      }

      if (item.label?.text) {
        const box = this.appendLabel(group, item, [sx, sy], showMarker ? markerSize : 0)
        if (box) this.reserved.push(box)
      }

      this.overlayGroup.appendChild(group)
    }
  }

  /**
   * Draw the chip and its connector, and report the box it occupies.
   *
   * The box is what the label engine avoids, so it is measured the same
   * approximate way labels measure themselves. Measuring properly would need a
   * reflow per annotation, which is the per-frame cost the whole layout is
   * built to avoid, and being a few pixels generous only makes labels yield
   * slightly more.
   */
  private appendLabel(
    group: SVGGElement,
    item: Resolved,
    [sx, sy]: [number, number],
    markerSize: number,
  ): ReservedBox | null {
    const label = item.label
    if (!label?.text) return null

    const fontSize = label.fontSize ?? DEFAULT_FONT_SIZE
    const padding = label.padding ?? DEFAULT_PADDING
    const bare = label.background === 'none'
    const lines = String(label.text).split('\n')
    const longest = lines.reduce((max, line) => Math.max(max, line.length), 0)
    const textWidth = longest * fontSize * 0.58
    const lineHeight = fontSize * 1.25
    const width = textWidth + padding * 2
    const height = lineHeight * lines.length + padding * 2

    // A pin's ink is above its tip, so the gap has to clear the ink and not
    // just the anchor.
    const anchorClearance =
      markerSize > 0
        ? (isPointAnchored((item.marker?.shape ?? 'circle') as MarkerShape)
            ? markerSize * 1.9
            : markerSize / 2) + 3
        : 0
    const gap = anchorClearance + DEFAULT_GAP
    const [dx, dy] = offsetFor(label.position ?? 'top', gap, width, height)
    const cx = sx + dx + (label.offsetX ?? 0)
    const cy = sy + dy + (label.offsetY ?? 0)

    const connector = item.connector
    const wantsConnector = connector === true || (!!connector && typeof connector === 'object')
    if (wantsConnector) {
      const spec = typeof connector === 'object' ? connector : {}
      group.appendChild(
        svg('line', {
          class: 'apexmaps-annotation-connector',
          x1: sx,
          y1: sy,
          x2: cx,
          y2: cy,
          stroke: spec.color ?? 'var(--apexmaps-fg-muted, #6b7280)',
          'stroke-width': spec.width ?? 1,
          'stroke-dasharray': spec.dashArray ?? '3 2',
        }),
      )
    }

    if (!bare) {
      group.appendChild(
        svg('rect', {
          class: 'apexmaps-annotation-chip',
          x: cx - width / 2,
          y: cy - height / 2,
          width,
          height,
          rx: label.borderRadius ?? 3,
          fill: label.background ?? 'var(--apexmaps-surface, #ffffff)',
          stroke: label.borderColor ?? 'var(--apexmaps-border, rgba(0,0,0,0.12))',
          'stroke-width': label.borderWidth ?? 1,
        }),
      )
    }

    const text = svg('text', {
      class: 'apexmaps-annotation-text',
      x: cx,
      // Multi-line text hangs from the first baseline, so the block is raised
      // by half its own extra height to stay centred on the anchor.
      y: cy - (lineHeight * (lines.length - 1)) / 2,
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      'font-size': fontSize,
      'font-weight': label.fontWeight ?? 500,
      fill: label.color ?? 'var(--apexmaps-fg, currentColor)',
    })

    lines.forEach((line, i) => {
      const tspan = svg('tspan', { x: cx, text: line })
      if (i > 0) tspan.setAttribute('dy', String(lineHeight))
      text.appendChild(tspan)
    })

    if (bare) {
      // Without a chip, the halo is what keeps editorial text readable over an
      // arbitrary fill. Same paint-order trick the label engine uses.
      text.setAttribute('paint-order', 'stroke')
      text.setAttribute('stroke', 'rgba(255,255,255,0.85)')
      text.setAttribute('stroke-width', '2.5')
      text.setAttribute('stroke-linejoin', 'round')
    }

    group.appendChild(text)

    return {
      x0: cx - width / 2,
      y0: cy - height / 2,
      x1: cx + width / 2,
      y1: cy + height / 2,
    }
  }

  private outlinePath(key: string): string | null {
    const feature = this.access.featureFor(key)
    return feature ? this.viewport.pathFor(feature) : null
  }

  destroy(): void {
    if (this.overlayGroup?.parentNode) this.overlayGroup.parentNode.removeChild(this.overlayGroup)
    if (this.regionGroup?.parentNode) this.regionGroup.parentNode.removeChild(this.regionGroup)
    this.overlayGroup = null
    this.regionGroup = null
    this.resolved = []
    this.reserved = []
    this.count = 0
  }
}

function common(annotation: {
  label?: AnnotationLabel | string
  marker?: AnnotationMarker
  connector?: AnnotationConnector
  className?: string
}): Pick<Resolved, 'label' | 'marker' | 'connector' | 'className'> {
  return {
    label: normalizeLabel(annotation.label),
    marker: annotation.marker ?? null,
    connector: annotation.connector,
    className: annotation.className,
  }
}

/** `label: 'text'` is the shorthand almost every annotation actually wants. */
function normalizeLabel(label: AnnotationLabel | string | undefined): AnnotationLabel | null {
  if (label == null) return null
  return typeof label === 'string' ? { text: label } : label
}

function outlineStroke(outline: FeatureAnnotation['outline']): StrokeOptions | undefined {
  if (!outline) return undefined
  const base: StrokeOptions = { color: 'var(--apexmaps-focus, #2563eb)', width: 2 }
  return outline === true ? base : { ...base, ...outline }
}

/**
 * Where the chip sits relative to the anchor.
 *
 * `'top'` is the default because a chip below an anchor covers the place the
 * anchor is pointing at more often than not: labels read upward on a map.
 */
function offsetFor(
  position: NonNullable<AnnotationLabel['position']>,
  gap: number,
  width: number,
  height: number,
): [number, number] {
  switch (position) {
    case 'bottom':
      return [0, gap + height / 2]
    case 'left':
      return [-(gap + width / 2), 0]
    case 'right':
      return [gap + width / 2, 0]
    case 'center':
      return [0, 0]
    case 'top':
    default:
      return [0, -(gap + height / 2)]
  }
}

/**
 * `[west, south, east, north]` to a closed polygon.
 *
 * Wound **clockwise** in lon/lat, which is what `d3-geo` reads as "the inside is
 * this box". The other winding asks for the whole sphere minus the box, which
 * fills the map and leaves the region as a hole. Same convention as `geo.view.fit`
 * and ingested geometry, and it has cost this project enough mistakes to be worth
 * repeating at every site.
 */
function boundsToPolygon(bounds: BBox4 | undefined) {
  if (!bounds || bounds.length !== 4 || bounds.some((n) => !Number.isFinite(n))) return null
  const [west, south, east, north] = bounds
  return {
    type: 'Polygon' as const,
    coordinates: [
      [
        [west, south],
        [west, north],
        [east, north],
        [east, south],
        [west, south],
      ],
    ],
  }
}

function isLonLat(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  )
}

function describe(value: unknown): string {
  if (value == null) return String(value)
  return Array.isArray(value) ? `[${value.join(', ')}]` : typeof value
}
