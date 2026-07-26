/**
 * Bubble series (proportional symbols).
 *
 * The right mark for **absolute magnitudes**: totals, counts, revenue, population.
 * A choropleth of those quantities mostly redraws the map of where big areas are,
 * whereas a bubble is immune to area bias because its size is independent of the
 * polygon underneath it.
 *
 * Three decisions are made for the developer, each because the alternative is
 * usually a mistake:
 *
 * 1. **Square-root sizing** (see `scales/SizeScale`), so circle *area* is
 *    proportional to value. Linear radius overstates large values enormously.
 * 2. **Largest drawn first**, so small bubbles land on top and stay hoverable.
 *    Painting in data order buries them under their neighbours.
 * 3. **Positions may come from the data or from geometry.** Explicit `lon`/`lat`
 *    wins; otherwise the datum is joined to a feature and placed at its centroid,
 *    so "revenue by country" needs no coordinates at all.
 *
 * @module series/Bubble
 */

import { resolveJoin } from '../data/Join'
import { createScale, Scale } from '../scales/Scale'
import { createSizeScale, SizeScale } from '../scales/SizeScale'
import type { JoinResult } from '../data/Join'
import { Viewport } from '../geo/Viewport'
import type {
  BubbleDatum,
  BubbleSeriesOptions,
  LonLat,
  MarkItem,
  NormalizedGeo,
  SizeLegendEntry,
  WorldPoint,
} from '../types'
import type { SymbolSpec } from '../renderers/SvgRenderer'
import { readNumber, readText } from './accessors'

const DEFAULT_COLOR = '#008FFB'

export interface BubbleItem extends MarkItem {
  lonLat: LonLat
  world: WorldPoint | null
  radius: number | null
  /** Value driving the optional colour scale, when one is configured. */
  colorValue: number | null
}

export class BubbleSeries {
  static readonly type = 'bubble' as const
  static readonly kind = 'symbols' as const

  readonly type = 'bubble' as const
  readonly kind = 'symbols' as const
  readonly config: BubbleSeriesOptions
  readonly index: number
  readonly id: string
  readonly warnings: string[] = []

  readonly items: BubbleItem[] = []
  readonly sizeScale: SizeScale
  readonly colorScale: Scale | null = null
  readonly join: JoinResult | null = null

  constructor({
    config,
    geo,
    index,
    viewport,
  }: {
    config: BubbleSeriesOptions
    geo: NormalizedGeo
    index: number
    viewport: Viewport
  }) {
    this.config = config
    this.index = index
    this.id = `s${index}`

    const rows = (config.data ?? []) as readonly BubbleDatum[]
    const needsJoin = rows.some((d) => !hasCoordinates(d))

    // Only pay for a join when some datum actually lacks coordinates.
    if (needsJoin && rows.length) {
      this.join = resolveJoin({
        features: geo.features,
        data: rows,
        joinBy: config.joinBy,
        geoKeyField: geo.keyField,
        fuzzy: !!config.fuzzyJoin,
      })
    }

    const centroidByDatum = new Map<unknown, { lonLat: LonLat; world: WorldPoint }>()
    if (this.join) {
      for (const feature of geo.features) {
        const datum = this.join.byFeatureIndex.get(feature.index)
        if (datum == null) continue
        // Centroid in lon/lat, so the bubble survives a projection change.
        const lonLat = Viewport.centroid({
          type: 'Feature',
          geometry: feature.geometry,
          properties: {},
        })
        const world = viewport.project(lonLat)
        if (world) centroidByDatum.set(datum, { lonLat, world })
      }
    }

    const valueField = config.size?.field ?? config.valueField ?? 'value'
    const values: (number | null)[] = []
    const colorValues: (number | null)[] = []
    let missingPosition = 0

    const resolved: BubbleItem[] = []
    rows.forEach((datum, i) => {
      const value = readNumber(datum, valueField)
      values.push(value)

      const colorValue = config.colorField ? readNumber(datum, config.colorField) : value
      colorValues.push(colorValue)

      let lonLat = coordinatesOf(datum)
      let world = lonLat ? viewport.project(lonLat) : null

      if (!lonLat) {
        const centroid = centroidByDatum.get(datum)
        if (centroid) {
          lonLat = centroid.lonLat
          world = centroid.world
        }
      }

      if (!lonLat) {
        missingPosition++
        return
      }

      resolved.push({
        key: String(readText(datum, 'id') ?? readText(datum, 'name') ?? `${this.id}-${i}`),
        name: readText(datum, 'name'),
        value,
        colorValue,
        datum,
        lonLat,
        world,
        anchor: world ?? undefined,
        radius: null,
      })
    })

    if (missingPosition) {
      this.warnings.push(
        `${missingPosition} bubble datum(s) had no position: supply lon/lat, or a joinBy that matches geometry so the centroid can be used`,
      )
    }

    this.sizeScale = createSizeScale(values, {
      // Derived from the container, not fixed: the same range that reads well on a
      // full-width world map swamps a small multiple. Callers who set an explicit
      // range keep it.
      range: defaultRadiusRange(viewport.width, viewport.height),
      ...config.size,
    })
    this.warnings.push(...this.sizeScale.warnings)

    if (config.size?.scale === 'linear') {
      this.warnings.push(
        "size.scale 'linear' maps value to radius, so area grows with the square of the value and large bubbles read far too big. 'sqrt' is the honest default.",
      )
    }

    if (config.colorScale) {
      this.colorScale = createScale(colorValues, config.colorScale)
      this.warnings.push(...this.colorScale.warnings)
    }

    for (const item of resolved) item.radius = this.sizeScale.radius(item.value)

    // Largest first so small bubbles paint on top and remain clickable.
    this.items =
      config.sortBySize === false
        ? resolved
        : resolved.sort((a, b) => (b.radius ?? 0) - (a.radius ?? 0))
  }

  /** Recompute world positions after a projection change. */
  reproject(viewport: Viewport): void {
    for (const item of this.items) {
      item.world = viewport.project(item.lonLat)
      item.anchor = item.world ?? undefined
    }
  }

  itemAt(index: number): BubbleItem | undefined {
    return this.items[index]
  }

  fillFor(item: BubbleItem): string {
    if (this.colorScale) return this.colorScale.color(item.colorValue)
    return this.config.color ?? DEFAULT_COLOR
  }

  /** Symbol specs for the renderer, in paint order, skipping unplaceable marks. */
  symbols(): SymbolSpec[] {
    const out: SymbolSpec[] = []
    this.items.forEach((item, i) => {
      if (!item.world || item.radius == null) return
      out.push({
        key: item.key,
        item: i,
        world: item.world,
        radius: item.radius,
        fill: this.fillFor(item),
        stroke: this.config.stroke ?? { color: '#ffffff', width: 1 },
        opacity: this.config.opacity ?? 0.85,
      })
    })
    return out
  }

  legendTitle(): string | undefined {
    return this.config.name
  }

  /**
   * Reference circles for a nested-circle legend. This is the legend style that
   * actually lets a reader decode bubble areas, and almost nobody ships it.
   */
  sizeLegend(): SizeLegendEntry[] {
    return this.sizeScale.legendEntries()
  }

  /** Bubbles mute by size, not by class, so legend toggling is a no-op for now. */
  toggleClass(): boolean {
    return false
  }

  legendItems(): never[] {
    // Bubbles legend by size, not by class. A colour legend appears only when a
    // `colorScale` is configured, and then it comes from that scale.
    return []
  }

  describe(item: BubbleItem): string {
    const name = item.name ?? item.key
    if (item.value == null) return `${name}, no value`
    const label = this.config.name ?? 'value'
    return `${name}, ${label} ${formatValue(item.value)}`
  }

  advise(): string[] {
    const notes: string[] = []
    const values = this.items.map((i) => i.value).filter((v): v is number => v != null)
    if (!values.length) return notes

    if (values.some((v) => v < 0)) {
      notes.push(
        'bubble values include negatives, which cannot be encoded by radius. Consider splitting the series by sign, or a diverging choropleth.',
      )
    }

    const max = Math.max(...values)
    const min = Math.min(...values.filter((v) => v > 0))
    if (Number.isFinite(min) && max / min > 1e4) {
      notes.push(
        `bubble values span ${Math.round(max / min).toLocaleString()}x, so the smallest marks are invisible next to the largest. Consider a log size scale or splitting the data.`,
      )
    }

    return notes
  }
}

/**
 * A radius range scaled to the plot, so the largest bubble occupies a sensible
 * fraction of the shorter axis regardless of chart size.
 */
function defaultRadiusRange(width: number, height: number): [number, number] {
  const shorter = Math.min(width || 600, height || 400)
  const max = Math.max(8, Math.min(40, Math.round(shorter / 17)))
  return [Math.max(1.5, max * 0.1), max]
}

function hasCoordinates(datum: BubbleDatum): boolean {
  return coordinatesOf(datum) !== null
}

/** Accepts `lon`/`lat`, or `lng`/`lat` for data that came from a Google-shaped world. */
function coordinatesOf(datum: BubbleDatum): LonLat | null {
  if (!datum || typeof datum !== 'object') return null
  const lon =
    typeof datum.lon === 'number' ? datum.lon : typeof datum.lng === 'number' ? datum.lng : null
  const lat = typeof datum.lat === 'number' ? datum.lat : null
  if (lon == null || lat == null) return null
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  return [lon, lat]
}

function formatValue(v: number): string {
  return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2)
}
