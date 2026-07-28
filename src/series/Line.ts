/**
 * Line series: a route drawn through the places it actually passes.
 *
 * The mark for GPS traces, shipping lanes, pipelines, historical journeys and
 * transit lines. It differs from the arc series in what the caller supplies:
 * an arc is two endpoints and the series derives the great circle between
 * them, while a line is the vertex sequence itself, drawn in order.
 *
 * Rendering still goes through the projection's path generator rather than
 * connecting projected vertices by hand, and that buys the two things a
 * hand-drawn polyline silently gets wrong: clipping (a route leaving the right
 * edge of the map re-enters at the left instead of streaking backwards across
 * the world) and correct behaviour under rotated and clipped projections. The
 * corollary is that each segment between consecutive vertices follows the
 * sphere's shortest path, so a sparse pair of waypoints an ocean apart will
 * bow rather than run straight; a route with real intermediate vertices is
 * unaffected. That is the geographically honest reading of "the route passed
 * through these points".
 *
 * @module series/Line
 */

import { createScale, Scale } from '../scales/Scale'
import { createSizeScale, SizeScale } from '../scales/SizeScale'
import { Viewport } from '../geo/Viewport'
import type {
  LineDatum,
  LineSeriesOptions,
  LonLat,
  MarkItem,
  NormalizedGeo,
  WorldPoint,
} from '../types'
import type { PathSpec } from '../renderers/SvgRenderer'
import { readNumber, readText, readLonLat } from './accessors'

const DEFAULT_COLOR = '#008FFB'
const DEFAULT_WIDTH_RANGE: [number, number] = [1, 5]

export interface LineItem extends MarkItem {
  path: LonLat[]
  /** Path data in world space, rebuilt whenever the projection changes. */
  d: string
  width: number
  color?: string
}

export class LineSeries {
  static readonly type = 'line' as const
  static readonly kind = 'paths' as const

  readonly type = 'line' as const
  readonly kind = 'paths' as const
  readonly config: LineSeriesOptions
  readonly index: number
  readonly id: string
  readonly warnings: string[] = []

  readonly items: LineItem[] = []
  readonly widthScale: SizeScale
  readonly colorScale: Scale | null = null

  constructor({
    config,
    index,
    viewport,
  }: {
    config: LineSeriesOptions
    geo: NormalizedGeo
    index: number
    viewport: Viewport
  }) {
    this.config = config
    this.index = index
    this.id = `s${index}`

    const rows = (config.data ?? []) as readonly LineDatum[]
    const valueField = config.valueField ?? 'value'

    const values: (number | null)[] = []
    let dropped = 0

    const resolved: Omit<LineItem, 'd' | 'width'>[] = []
    rows.forEach((datum, i) => {
      const path = this.resolvePath(datum)
      if (!path) {
        dropped++
        return
      }

      const value = readNumber(datum, valueField)
      values.push(value)

      resolved.push({
        key: String(readText(datum, 'id') ?? `${this.id}-${i}`),
        name: readText(datum, 'name'),
        value,
        datum,
        path,
        color: typeof datum.color === 'string' ? datum.color : undefined,
        anchor: undefined,
      })
    })

    if (dropped) {
      this.warnings.push(
        `${dropped} line datum(s) had no usable path: supply at least two [lon, lat] vertices under \`path\` (or \`coordinates\`)`,
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

    this.items = resolved.map((item) => ({
      ...item,
      d: '',
      width: this.widthScale.radius(item.value) ?? DEFAULT_WIDTH_RANGE[0],
    }))

    this.reproject(viewport)

    // Heaviest routes last so the important ones are not buried under thin ones.
    this.items.sort((a, b) => (a.value ?? 0) - (b.value ?? 0))
  }

  /**
   * Rebuild path data. Called on construction and after any projection change,
   * because the drawn geometry is projection-dependent while the vertices are
   * not.
   */
  reproject(viewport: Viewport): void {
    for (const item of this.items) {
      item.d =
        viewport.path?.({
          type: 'LineString',
          coordinates: item.path,
        }) ?? ''

      // Anchor tooltips at the middle vertex rather than an endpoint, which is
      // roughly where a reader's pointer is when they hover a long route.
      const middle = item.path[Math.floor(item.path.length / 2)]
      item.anchor = viewport.project(middle) ?? undefined
    }
  }

  itemAt(index: number): LineItem | undefined {
    return this.items[index]
  }

  colorFor(item: LineItem): string {
    if (item.color) return item.color
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
        opacity: this.config.opacity ?? 0.9,
        dashArray: this.config.stroke?.dashArray,
      })
    })
    return out
  }

  /** Start and end dots, drawn as screen-space symbols so they keep a constant size. */
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

    // Deduplicate: routes sharing a terminus would otherwise stack identical
    // dots into a darker blob than intended.
    const seen = new Map<string, WorldPoint>()
    this.items.forEach((item) => {
      for (const lonLat of [item.path[0], item.path[item.path.length - 1]]) {
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

  describe(item: LineItem): string {
    const label = item.name ?? item.key
    if (item.value == null) return label
    return `${label}, ${Number.isInteger(item.value) ? item.value.toLocaleString() : item.value.toFixed(2)}`
  }

  advise(): string[] {
    const notes: string[] = []
    if (this.items.length > 400 && (this.config.opacity ?? 0.9) > 0.5) {
      notes.push(
        `${this.items.length} routes will read as a tangle at high opacity. Lower series opacity, or aggregate before plotting.`,
      )
    }
    return notes
  }

  /** A datum's vertex sequence, under `path` or its GeoJSON-habit synonym. */
  private resolvePath(datum: LineDatum): LonLat[] | null {
    const raw = datum.path ?? datum.coordinates
    if (!Array.isArray(raw)) return null

    const vertices: LonLat[] = []
    for (const entry of raw) {
      const lonLat = readLonLat(entry)
      if (lonLat) vertices.push(lonLat)
    }

    return vertices.length >= 2 ? vertices : null
  }
}
