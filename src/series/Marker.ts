/**
 * Marker series (fixed-size point symbols), with optional clustering.
 *
 * The mark for **"something is here"**: offices, incidents, stores, sightings.
 * Size is deliberately fixed, because the moment size varies the reader starts
 * decoding it as a quantity. When it *is* a quantity, that is the bubble series,
 * which scales by area and ships a legend that can be decoded.
 *
 * Three decisions worth stating:
 *
 * 1. **Clustering is an option here, not a separate series.** The data is the
 *    same; clustering is a decision about how to draw points that would otherwise
 *    pile up. A separate series type would fork position resolution, hit testing,
 *    colouring and the legend, and would force the caller to swap series at a zoom
 *    threshold.
 * 2. **Categories colour themselves.** Point maps almost always encode a type
 *    (incident kind, store format), so `colorBy` runs the ordinal scale and emits
 *    a real legend rather than making the caller hand-assign colours.
 * 3. **Positions may come from the data or from geometry**, exactly as for
 *    bubbles, so "one marker per country office" needs no coordinates.
 *
 * @module series/Marker
 */

import { resolveJoin } from '../data/Join'
import { createScale, Scale } from '../scales/Scale'
import { readableOn } from '../scales/Color'
import { clusterPoints, clusterLevel, levelScale } from '../geo/Cluster'
import type { Cluster } from '../geo/Cluster'
import type { JoinResult } from '../data/Join'
import { Viewport } from '../geo/Viewport'
import { markerPath, isPointAnchored } from '../renderers/Shapes'
import type {
  ClusterOptions,
  LonLat,
  MarkItem,
  MarkerDatum,
  MarkerSeriesOptions,
  MarkerShape,
  NormalizedGeo,
  WorldPoint,
} from '../types'
import type { MarkSpec } from '../renderers/SvgRenderer'
import { readNumber, readText } from './accessors'

const DEFAULT_COLOR = '#008FFB'
const DEFAULT_SIZE = 10
const DEFAULT_CLUSTER_RADIUS = 60
const DEFAULT_CLUSTER_MAX_ZOOM = 8
const DEFAULT_CLUSTER_SIZE: [number, number] = [15, 30]

export interface MarkerItem extends MarkItem {
  lonLat: LonLat
  world: WorldPoint | null
  shape: MarkerShape
  size: number
  category?: string
}

export class MarkerSeries {
  static readonly type = 'marker' as const
  static readonly kind = 'marks' as const

  readonly type = 'marker' as const
  readonly kind = 'marks' as const
  readonly config: MarkerSeriesOptions
  readonly index: number
  readonly id: string
  readonly warnings: string[] = []

  readonly items: MarkerItem[] = []
  readonly colorScale: Scale | null = null
  readonly join: JoinResult | null = null
  /**
   * Categories switched off from the legend, by name rather than by legend index.
   *
   * A marker legend is categorical, so what a click means is "hide this kind", and
   * a kind is a string on the datum. Holding the index instead would cost a lookup
   * through `colorScale.categories` for every marker on every draw, and would go
   * wrong the moment the category set changes under an `updateSeries` while the
   * legend's own muted state survives it.
   */
  readonly mutedCategories = new Set<string>()

  /**
   * Clusters for the level they were computed at, so a pan never recomputes.
   *
   * `cachedValid` is separate from `cachedLevel` because `null` is a legitimate
   * level meaning "not clustering at this zoom", and it must not be confused with
   * "nothing computed yet".
   */
  private cachedLevel: number | null = null
  private cachedValid = false
  private cached: Cluster[] = []

  constructor({
    config,
    geo,
    index,
    viewport,
  }: {
    config: MarkerSeriesOptions
    geo: NormalizedGeo
    index: number
    viewport: Viewport
  }) {
    this.config = config
    this.index = index
    this.id = `s${index}`

    const rows = (config.data ?? []) as readonly MarkerDatum[]
    const needsJoin = rows.some((d) => !hasCoordinates(d))

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
        const lonLat = Viewport.centroid({
          type: 'Feature',
          geometry: feature.geometry,
          properties: {},
        })
        const world = viewport.project(lonLat)
        if (world) centroidByDatum.set(datum, { lonLat, world })
      }
    }

    const valueField = config.valueField ?? 'value'
    const baseSize = config.size ?? DEFAULT_SIZE
    const categories: string[] = []
    let missingPosition = 0

    rows.forEach((datum, i) => {
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

      const category = config.colorBy ? readText(datum, config.colorBy) : undefined
      categories.push(category ?? '')

      this.items.push({
        key: String(readText(datum, 'id') ?? readText(datum, 'name') ?? `${this.id}-${i}`),
        name: readText(datum, 'name'),
        value: readNumber(datum, valueField),
        datum,
        lonLat,
        world,
        anchor: world ?? undefined,
        shape: resolveShape(config.shape, datum),
        size: typeof datum.size === 'number' ? datum.size : baseSize,
        category,
      })
    })

    if (missingPosition) {
      this.warnings.push(
        `${missingPosition} marker datum(s) had no position: supply lon/lat, or a joinBy that matches geometry so the centroid can be used`,
      )
    }

    if (config.colorBy) {
      this.colorScale = createScale(categories, {
        type: 'ordinal',
        palette: config.palette ?? 'category',
      })
      this.warnings.push(...this.colorScale.warnings)
    }
  }

  /** Recompute world positions after a projection change, and drop the cache. */
  reproject(viewport: Viewport): void {
    for (const item of this.items) {
      item.world = viewport.project(item.lonLat)
      item.anchor = item.world ?? undefined
    }
    this.cachedValid = false
  }

  itemAt(index: number): MarkerItem | undefined {
    return this.items[index]
  }

  fillFor(item: MarkerItem): string {
    if (
      typeof item.datum === 'object' &&
      item.datum &&
      typeof (item.datum as MarkerDatum).color === 'string'
    ) {
      return (item.datum as MarkerDatum).color as string
    }
    if (this.colorScale && item.category != null) return this.colorScale.color(item.category)
    return this.config.color ?? DEFAULT_COLOR
  }

  // --- clustering ------------------------------------------------------------

  get clusterOptions(): Required<Pick<ClusterOptions, 'radius' | 'maxZoom' | 'minPoints'>> &
    ClusterOptions {
    const c = this.config.cluster ?? {}
    return {
      ...c,
      radius: c.radius ?? DEFAULT_CLUSTER_RADIUS,
      maxZoom: c.maxZoom ?? DEFAULT_CLUSTER_MAX_ZOOM,
      minPoints: c.minPoints ?? 2,
    }
  }

  clusteringEnabled(zoom: number): boolean {
    const c = this.config.cluster
    if (!c || c.enabled === false) return false
    return zoom < this.clusterOptions.maxZoom
  }

  /**
   * True when the drawn marks would change at this camera scale.
   *
   * Panning never changes the level, so a pan never reclusters, and a smooth zoom
   * crosses a level only a few times rather than sixty times a second.
   */
  needsRedraw(zoom: number): boolean {
    if (!this.config.cluster || this.config.cluster.enabled === false) return false
    if (!this.cachedValid) return true
    return this.levelFor(zoom) !== this.cachedLevel
  }

  private levelFor(zoom: number): number | null {
    return this.clusteringEnabled(zoom) ? clusterLevel(zoom) : null
  }

  /** Clusters at this camera scale, cached per level. */
  clusters(zoom: number): Cluster[] {
    const level = this.levelFor(zoom)
    if (this.cachedValid && level === this.cachedLevel) return this.cached

    // A marker the legend has switched off is not clustered, not merely not
    // drawn: it must not be counted into a circle, and it must not pull that
    // circle's centre of mass towards itself either. Indices stay the item's own,
    // so `members` keeps resolving to data.
    if (level === null) {
      this.cached = this.items
        .map((item, i) =>
          item.world && !this.isMuted(item)
            ? { world: item.world, members: [i], count: 1, bounds: [item.world, item.world] }
            : null,
        )
        .filter(Boolean) as Cluster[]
    } else {
      const points = this.items
        .map((item, i) =>
          item.world && !this.isMuted(item) ? { index: i, world: item.world } : null,
        )
        .filter(Boolean) as { index: number; world: WorldPoint }[]

      this.cached = clusterPoints(points, {
        radius: this.clusterOptions.radius,
        // The level's scale, not the live one, so every mark inside a level is
        // clustered against the same distance.
        zoom: levelScale(level),
        minPoints: this.clusterOptions.minPoints,
      })
    }

    this.cachedLevel = level
    this.cachedValid = true
    return this.cached
  }

  clusterAt(index: number): Cluster | undefined {
    return this.cached[index]
  }

  // --- rendering -------------------------------------------------------------

  /** Marks for the renderer at this camera scale: individual points or clusters. */
  marks(zoom: number): MarkSpec[] {
    const clusters = this.clusters(zoom)
    const opts = this.clusterOptions
    const [minR, maxR] = opts.size ?? DEFAULT_CLUSTER_SIZE
    const largest = clusters.reduce((max, c) => Math.max(max, c.count), 1)
    const stroke = this.config.stroke ?? { color: '#ffffff', width: 1.5 }
    const opacity = this.config.opacity ?? 0.9

    return clusters.map((cluster, i) => {
      if (cluster.count === 1) {
        const item = this.items[cluster.members[0]]
        return {
          key: item.key,
          item: cluster.members[0],
          cluster: -1,
          world: cluster.world,
          d: markerPath(item.shape, item.size),
          pointAnchored: isPointAnchored(item.shape),
          fill: this.fillFor(item),
          stroke,
          opacity,
          hitRadius: Math.max(item.size, 12) / 2,
        }
      }

      // Area proportional to count, the same square-root rule the bubble series
      // uses, so a cluster of 100 does not read as 100 times a cluster of 1.
      const t = Math.sqrt(cluster.count) / Math.sqrt(largest)
      const radius = minR + (maxR - minR) * t
      const fill = opts.color ?? this.config.color ?? DEFAULT_COLOR

      return {
        key: `cluster-${i}`,
        item: -1,
        cluster: i,
        world: cluster.world,
        d: markerPath('circle', radius * 2),
        pointAnchored: false,
        fill,
        stroke,
        opacity,
        label: opts.showCount === false ? undefined : String(cluster.count),
        labelSize: cluster.count >= 1000 ? 10 : 11,
        // The count is the one piece of text in this library that sits on a
        // colour the caller chose, so it cannot inherit the page's ink: a dark
        // `cluster.color` used to draw a near-black count on a near-black circle.
        // WCAG contrast against the fill decides, the same rule the choropleth
        // labels use over a dark class.
        labelFill: readableOn(fill),
        hitRadius: radius,
      }
    })
  }

  legendTitle(): string | undefined {
    return this.config.name
  }

  /** A categorical legend, but only when categories are actually driving colour. */
  legendItems(): { label: string; color: string }[] {
    if (!this.colorScale) return []
    return this.colorScale
      .legendItems({})
      .map((entry) => ({ label: String(entry.label), color: entry.color }))
  }

  /** Whether the legend has switched off the category this marker belongs to. */
  isMuted(item: MarkerItem): boolean {
    if (!this.mutedCategories.size || item.category == null) return false
    return this.mutedCategories.has(item.category)
  }

  /**
   * Switch a legend category off, or back on. Returns the new muted state.
   *
   * The cluster cache goes with it, and that is the whole substance of this
   * method. Clusters are computed from `items` and cached per level, so filtering
   * only at the drawing stage would leave a cluster of twelve still saying twelve
   * with five of its members hidden. A wrong number on the map is worse than a
   * legend that does nothing, which is what this used to be.
   */
  toggleClass(classIndex: number): boolean {
    const category = this.colorScale?.categories[classIndex]
    if (category == null) return false

    let muted: boolean
    if (this.mutedCategories.has(category)) {
      this.mutedCategories.delete(category)
      muted = false
    } else {
      this.mutedCategories.add(category)
      muted = true
    }
    this.cachedValid = false
    return muted
  }

  describe(item: MarkerItem): string {
    const name = item.name ?? item.key
    const parts = [name]
    if (item.category) parts.push(item.category)
    if (item.value != null) parts.push(`${this.config.name ?? 'value'} ${item.value}`)
    return parts.join(', ')
  }

  describeCluster(cluster: Cluster): string {
    return `Cluster of ${cluster.count} ${this.config.name ?? 'markers'}`
  }

  advise(): string[] {
    const notes: string[] = []
    const clustering = !!this.config.cluster && this.config.cluster.enabled !== false

    if (this.items.length > 500 && !clustering) {
      notes.push(
        `${this.items.length} markers without clustering will overplot into a blob at low zoom. Set cluster: {} to enable it, or use a bubble series if size carries meaning.`,
      )
    }

    if (this.config.colorBy && this.colorScale && this.colorScale.categories.length > 12) {
      notes.push(
        `colorBy produced ${this.colorScale.categories.length} categories, which is more colours than a reader can tell apart. Group the long tail into "other".`,
      )
    }

    if (typeof this.config.size === 'number' && this.config.size > 40) {
      notes.push(
        `marker size ${this.config.size}px is large enough to hide the geography underneath. Markers say "here"; if size should carry a value, use a bubble series.`,
      )
    }

    return notes
  }
}

function hasCoordinates(datum: MarkerDatum): boolean {
  return coordinatesOf(datum) !== null
}

function coordinatesOf(datum: MarkerDatum): LonLat | null {
  if (!datum || typeof datum !== 'object') return null
  const lon = typeof datum.lon === 'number' ? datum.lon : datum.lng
  const lat = datum.lat
  if (typeof lon !== 'number' || typeof lat !== 'number') return null
  if (!isFinite(lon) || !isFinite(lat)) return null
  return [lon, lat]
}

function resolveShape(shape: MarkerSeriesOptions['shape'], datum: MarkerDatum): MarkerShape {
  if (typeof datum?.shape === 'string') return datum.shape
  if (typeof shape === 'function') return shape(datum)
  return shape ?? 'circle'
}
