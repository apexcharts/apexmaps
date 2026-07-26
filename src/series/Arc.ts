/**
 * Arc series: connections between places.
 *
 * The mark for airline routes, submarine cables, trade, migration and remittance
 * flows. Two things make this series either credible or embarrassing, and both are
 * handled here rather than left to the caller (PRODUCT-RESEARCH.md section 4.12):
 *
 * 1. **Geodesics, on by default.** The shortest path between two places is a great
 *   circle, not a straight line on a projected map. A Tokyo to New York route
 *   really does arc over the Arctic, and drawing the straight line misstates both
 *   the path and its length.
 * 2. **Antimeridian crossings.** A Tokyo to Los Angeles arc must leave the right
 *   edge of the map and re-enter at the left, not streak backwards across the
 *   whole world. Emitting the arc as a lon/lat LineString and letting d3-geo cut
 *   it is what makes that correct for free, in every projection.
 *
 * Endpoints may be `[lon, lat]` pairs or geometry keys, so "route network between
 * these airports" and "trade between these countries" are both one line of config.
 *
 * @module series/Arc
 */

import { indexByKey } from '../geo/GeoData'
import { bezierArc, greatCircleLine, greatCircleMidpoint } from '../geo/Geodesic'
import { createScale, Scale } from '../scales/Scale'
import { createSizeScale, SizeScale } from '../scales/SizeScale'
import { Viewport } from '../geo/Viewport'
import type {
  ArcDatum,
  ArcSeriesOptions,
  LonLat,
  MarkItem,
  NormalizedGeo,
  WorldPoint,
} from '../types'
import type { PathSpec } from '../renderers/SvgRenderer'
import { readNumber, readText, readLonLat } from './accessors'

const DEFAULT_COLOR = '#775DD0'
const DEFAULT_WIDTH_RANGE: [number, number] = [0.75, 6]

export interface ArcItem extends MarkItem {
  from: LonLat
  to: LonLat
  /** Path data in world space, rebuilt whenever the projection changes. */
  d: string
  width: number
  fromLabel?: string
  toLabel?: string
}

export class ArcSeries {
  static readonly type = 'arc' as const
  static readonly kind = 'paths' as const

  readonly type = 'arc' as const
  readonly kind = 'paths' as const
  readonly config: ArcSeriesOptions
  readonly index: number
  readonly id: string
  readonly warnings: string[] = []

  readonly items: ArcItem[] = []
  readonly widthScale: SizeScale
  readonly colorScale: Scale | null = null

  constructor({
    config,
    geo,
    index,
    viewport,
  }: {
    config: ArcSeriesOptions
    geo: NormalizedGeo
    index: number
    viewport: Viewport
  }) {
    this.config = config
    this.index = index
    this.id = `s${index}`

    const rows = (config.data ?? []) as readonly ArcDatum[]
    const byKey = indexByKey(geo.features)
    const valueField = config.valueField ?? 'value'

    const values: (number | null)[] = []
    let unresolved = 0

    const resolved: Omit<ArcItem, 'd' | 'width'>[] = []
    rows.forEach((datum, i) => {
      const from = this.resolveEndpoint(datum.from, byKey)
      const to = this.resolveEndpoint(datum.to, byKey)
      if (!from || !to) {
        unresolved++
        return
      }

      const value = readNumber(datum, valueField)
      values.push(value)

      resolved.push({
        key: String(readText(datum, 'id') ?? `${this.id}-${i}`),
        name: readText(datum, 'name'),
        value,
        datum,
        from: from.lonLat,
        to: to.lonLat,
        fromLabel: from.label,
        toLabel: to.label,
        // Anchor tooltips at the arc midpoint rather than an endpoint, which is
        // where a reader's pointer actually is when they hover a long route.
        anchor: undefined,
      })
    })

    if (unresolved) {
      this.warnings.push(
        `${unresolved} arc datum(s) had an endpoint that could not be resolved: use [lon, lat] pairs, or geometry keys that exist in the current map`,
      )
    }

    this.widthScale = createSizeScale(values, {
      range: DEFAULT_WIDTH_RANGE,
      // Line width reads linearly, unlike circle area, so a linear default is
      // correct here where it would be wrong for bubbles.
      scale: 'linear',
      ...config.width,
    })
    this.warnings.push(...this.widthScale.warnings)

    if (config.colorScale) {
      this.colorScale = createScale(values, config.colorScale)
      this.warnings.push(...this.colorScale.warnings)
    }

    if (config.curvature && config.geodesic !== false) {
      this.warnings.push(
        'curvature bends the arc away from the true great circle, so it is decorative rather than geographic. Set geodesic: false to acknowledge that, or curvature: 0 to keep the real path.',
      )
    }

    this.items = resolved.map((item) => ({
      ...item,
      d: '',
      width: this.widthScale.radius(item.value) ?? DEFAULT_WIDTH_RANGE[0],
    }))

    this.reproject(viewport)

    // Heaviest arcs last so the important flows are not buried under thin ones.
    this.items.sort((a, b) => (a.value ?? 0) - (b.value ?? 0))
  }

  /**
   * Rebuild path data. Called on construction and after any projection change,
   * because arc geometry is projection-dependent while its endpoints are not.
   */
  reproject(viewport: Viewport): void {
    const curvature = this.config.curvature ?? 0
    const geodesic = this.config.geodesic !== false

    for (const item of this.items) {
      if (curvature > 0) {
        // Bezier bulge is a screen-space effect, so it needs projected endpoints.
        const a = viewport.project(item.from)
        const b = viewport.project(item.to)
        item.d = a && b ? bezierArc(a, b, curvature) : ''
      } else if (geodesic) {
        // Hand d3-geo a lon/lat LineString so its clipping and antimeridian
        // cutting apply. This is what makes trans-Pacific arcs render correctly.
        item.d = viewport.path?.(greatCircleLine(item.from, item.to)) ?? ''
      } else {
        item.d =
          viewport.path?.({
            type: 'LineString',
            coordinates: [item.from, item.to],
          }) ?? ''
      }

      const midpoint = greatCircleMidpoint(item.from, item.to)
      item.anchor = viewport.project(midpoint) ?? undefined
    }
  }

  itemAt(index: number): ArcItem | undefined {
    return this.items[index]
  }

  colorFor(item: ArcItem): string {
    if (this.colorScale) return this.colorScale.color(item.value)
    return this.config.color ?? DEFAULT_COLOR
  }

  paths(): PathSpec[] {
    const out: PathSpec[] = []
    this.items.forEach((item, i) => {
      if (!item.d) return
      out.push({
        key: item.key,
        item: i,
        d: item.d,
        stroke: this.colorFor(item),
        width: item.width,
        opacity: this.config.opacity ?? 0.75,
        dashArray: this.config.stroke?.dashArray,
      })
    })
    return out
  }

  /** Endpoint dots, drawn as screen-space symbols so they keep a constant size. */
  endpoints(viewport: Viewport): {
    key: string
    item: number
    world: WorldPoint
    radius: number
    fill: string
  }[] {
    if (!this.config.endpoints?.show) return []
    const radius = this.config.endpoints.radius ?? 2.5
    const fill = this.config.endpoints.color ?? this.config.color ?? DEFAULT_COLOR

    // Deduplicate: a hub airport appears in every route it serves, and stacking
    // 80 identical dots on it is wasted DOM and a darker blob than intended.
    const seen = new Map<string, WorldPoint>()
    this.items.forEach((item) => {
      for (const lonLat of [item.from, item.to]) {
        const key = `${lonLat[0].toFixed(4)},${lonLat[1].toFixed(4)}`
        if (seen.has(key)) continue
        const world = viewport.project(lonLat)
        if (world) seen.set(key, world)
      }
    })

    return [...seen.entries()].map(([key, world], i) => ({
      key: `end-${key}`,
      item: i,
      world,
      radius,
      fill,
    }))
  }

  legendTitle(): string | undefined {
    return this.config.name
  }

  toggleClass(): boolean {
    return false
  }

  legendItems(): never[] {
    return []
  }

  describe(item: ArcItem): string {
    const route = item.name ?? [item.fromLabel, item.toLabel].filter(Boolean).join(' to ')
    if (item.value == null) return route || item.key
    return `${route || item.key}, ${Number.isInteger(item.value) ? item.value.toLocaleString() : item.value.toFixed(2)}`
  }

  advise(): string[] {
    const notes: string[] = []
    if (this.items.length > 400 && (this.config.opacity ?? 0.75) > 0.5) {
      notes.push(
        `${this.items.length} arcs will read as a hairball at full opacity. Lower series opacity, or aggregate origin-destination pairs before plotting.`,
      )
    }
    return notes
  }

  /** Resolve an endpoint that may be coordinates or a geometry key. */
  private resolveEndpoint(
    value: unknown,
    byKey: Map<string, { geometry: unknown; name?: string }>,
  ): { lonLat: LonLat; label?: string } | null {
    const coords = readLonLat(value)
    if (coords) return { lonLat: coords }

    if (typeof value === 'string') {
      const feature = byKey.get(value)
      if (!feature) return null
      const lonLat = Viewport.centroid({
        type: 'Feature',
        geometry: feature.geometry,
        properties: {},
      })
      if (!Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1])) return null
      return { lonLat, label: feature.name ?? value }
    }

    return null
  }
}
