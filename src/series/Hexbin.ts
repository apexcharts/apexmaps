/**
 * Hexbin series (binned point density).
 *
 * The right mark when there are more points than pixels. Ten thousand markers on
 * a country map is not a map of ten thousand things: past the first overlap the
 * ink stops tracking the number, so the reader gets the shape of the data and no
 * way to rank one part of it against another. Binning answers the question the
 * points were asked to answer, because a cell of fixed area can carry a number.
 *
 * It is also three SVG nodes per point against one per cell, which is the same
 * argument in a different currency.
 *
 * Not to be confused with `geo/HexLayout`, which is also hexagons and is a
 * different thing entirely. A layout is a cartogram: one cell per region, placed
 * by hand, and the hexagon is a container for a region's identity. A hexbin has
 * no regions in it at all; its cells are a lattice laid over the projection and
 * each one reports what landed inside it. One replaces the boundaries, the other
 * ignores them.
 *
 * Three decisions are made for the caller:
 *
 * 1. **`count` is the default aggregate**, and needs no value field. "Where are
 *    these things" is the question that brings anyone here, and a hexbin that
 *    demanded a numeric column to answer it would be asking for a column the
 *    caller does not have.
 * 2. **The radius is in screen pixels**, so the lattice refines as the reader
 *    zooms rather than magnifying. Cells are rebuilt at quantized zoom levels,
 *    which is `geo/Cluster`'s policy and shared with it, so a pan never re-bins.
 * 3. **The colour domain follows the bins.** Smaller cells hold fewer points, so
 *    the class breaks move when the lattice refines, and the legend moves with
 *    them. Pinning them is one option away (`scale.domain`), and that is the
 *    right call when two maps have to be read against each other, but a fixed
 *    domain as the *default* would leave every cell in the palest class two zoom
 *    levels in.
 *
 * @module series/Hexbin
 */

import { createScale, Scale } from '../scales/Scale'
import { Viewport } from '../geo/Viewport'
import { clusterLevel, levelScale } from '../geo/Cluster'
import { aggregateOf, binPoints, cellRing } from '../geo/Hexbin'
import type { BinOrientation, HexBin } from '../geo/Hexbin'
import type {
  HexbinAggregate,
  HexbinDatum,
  HexbinSeriesOptions,
  LonLat,
  MarkItem,
  WorldPoint,
} from '../types'
import type { BinSpec } from '../renderers/SvgRenderer'
import { readNumber, readText } from './accessors'

/** Cells this big read as a texture at country scale without becoming a blob. */
const DEFAULT_RADIUS = 14

export interface HexbinItem extends MarkItem {
  lonLat: LonLat
  world: WorldPoint | null
}

export class HexbinSeries {
  static readonly type = 'hexbin' as const
  static readonly kind = 'bins' as const

  readonly type = 'hexbin' as const
  readonly kind = 'bins' as const
  readonly config: HexbinSeriesOptions
  readonly index: number
  readonly id: string
  readonly warnings: string[] = []

  readonly items: HexbinItem[] = []
  readonly radius: number
  readonly orientation: BinOrientation
  readonly aggregate: HexbinAggregate
  readonly minCount: number

  /** Live only once the first level has been binned; the legend reads it. */
  colorScale: Scale | null = null

  private cached: HexBin[] = []
  private cachedLevel: number | null = null
  private cachedValid = false
  /** Colour classes switched off from the legend. */
  readonly mutedClasses = new Set<number>()

  constructor({
    config,
    index,
    viewport,
  }: {
    config: HexbinSeriesOptions
    index: number
    viewport: Viewport
  }) {
    this.config = config
    this.index = index
    this.id = `s${index}`
    this.radius = Math.max(1, config.radius ?? DEFAULT_RADIUS)
    this.orientation = config.orientation ?? 'pointy'
    this.aggregate = config.aggregate ?? 'count'
    this.minCount = Math.max(1, config.minCount ?? 1)

    const rows = (config.data ?? []) as readonly HexbinDatum[]
    const valueField = config.valueField ?? 'value'
    let missingPosition = 0
    let missingValue = 0

    rows.forEach((datum, i) => {
      const lonLat = coordinatesOf(datum)
      if (!lonLat) {
        missingPosition++
        return
      }
      const value = readNumber(datum, valueField)
      if (value == null && this.aggregate !== 'count') missingValue++

      this.items.push({
        key: String(readText(datum, 'id') ?? readText(datum, 'name') ?? `${this.id}-${i}`),
        name: readText(datum, 'name'),
        value,
        datum,
        lonLat,
        world: viewport.project(lonLat),
      })
    })

    if (missingPosition) {
      this.warnings.push(
        `${missingPosition} hexbin datum(s) had no position and were dropped: supply lon/lat or coordinates. A hexbin bins points, so there is no joinBy to fall back on`,
      )
    }
    if (missingValue) {
      this.warnings.push(
        `aggregate "${this.aggregate}" needs a number from every point, and ${missingValue} had none; those bins report on the rest. Use aggregate "count" to bin on position alone`,
      )
    }
  }

  /** Recompute world positions after a projection change. */
  reproject(viewport: Viewport): void {
    for (const item of this.items) {
      item.world = viewport.project(item.lonLat)
      item.anchor = item.world ?? undefined
    }
    this.cachedValid = false
  }

  itemAt(index: number): HexbinItem | undefined {
    return this.items[index]
  }

  /**
   * Whether the camera has moved far enough to change the lattice.
   *
   * Panning never changes the level, so a pan never re-bins, and a smooth zoom
   * crosses a level a handful of times rather than sixty times a second.
   */
  needsRedraw(zoom: number): boolean {
    if (!this.cachedValid) return true
    return clusterLevel(zoom) !== this.cachedLevel
  }

  /**
   * Bins at this camera scale, cached per level.
   *
   * Rebuilding the colour scale here rather than in the constructor is not a
   * shortcut: the values being coloured are the aggregates, and those do not
   * exist until the lattice does.
   */
  bins(zoom: number): HexBin[] {
    const level = clusterLevel(zoom)
    if (this.cachedValid && level === this.cachedLevel) return this.cached

    const points = this.items
      .map((item, i) => (item.world ? { index: i, world: item.world, value: item.value } : null))
      .filter(Boolean) as { index: number; world: WorldPoint; value: number | null }[]

    const bins = binPoints(points, {
      radius: this.radius,
      // The level's scale, not the live one, so every cell in a level is the
      // same size as every other.
      zoom: levelScale(level),
      orientation: this.orientation,
    }).filter((bin) => bin.count >= this.minCount)

    const values = bins.map((bin) => aggregateOf(bin, this.aggregate))
    const scale = createScale(values, this.config.scale ?? {})
    // Warnings are replaced rather than appended: this runs again on every level
    // the reader crosses, and appending would grow the list without bound.
    this.warnings.length = 0
    this.warnings.push(...scale.warnings)
    this.colorScale = scale

    this.cached = bins
    this.cachedLevel = level
    this.cachedValid = true
    return this.cached
  }

  binAt(index: number): HexBin | undefined {
    return this.cached[index]
  }

  valueOf(bin: HexBin): number | null {
    return aggregateOf(bin, this.aggregate)
  }

  fillFor(bin: HexBin): string {
    return this.colorScale?.color(this.valueOf(bin)) ?? '#008FFB'
  }

  /** Whether the legend has switched off the colour class this bin falls in. */
  isMuted(bin: HexBin): boolean {
    if (!this.mutedClasses.size || !this.colorScale) return false
    const value = this.valueOf(bin)
    if (typeof value !== 'number' || !Number.isFinite(value)) return false
    return this.mutedClasses.has(this.colorScale.classIndex(value))
  }

  /**
   * Development-time advice about the choice of mark, not about the data.
   *
   * Both notes are about a hexbin being the wrong tool for what was passed to
   * it, which is the failure mode this series has: it will happily draw a
   * beautiful lattice over forty points and tell the reader nothing.
   */
  advise(): string[] {
    const notes: string[] = []
    const placed = this.items.filter((item) => item.world).length
    if (!placed) return notes

    const cells = this.cached.length
    if (placed < 50) {
      notes.push(
        `a hexbin over ${placed} points is binning away detail it did not have to lose; markers or bubbles show each one, and a hexbin earns its keep once the points outnumber the pixels`,
      )
    }
    if (cells && placed / cells < 1.5) {
      notes.push(
        `${cells} cells for ${placed} points means most cells hold one, so the map is a scatter plot wearing hexagons. A larger radius makes the density readable`,
      )
    }
    if (this.aggregate === 'mean' && this.minCount === 1) {
      notes.push(
        'aggregate "mean" with minCount 1 lets a single point set a cell\'s colour as loudly as a hundred do. Raising minCount is what keeps a mean honest',
      )
    }
    return notes
  }

  legendTitle(): string | undefined {
    // The aggregate names itself when the series does not, because "count" and
    // "mean depth" are different maps and the legend is the only place that says
    // which one this is.
    return this.config.name ?? (this.aggregate === 'count' ? 'points per cell' : this.aggregate)
  }

  /** Switch a colour class off, or back on. Returns the new muted state. */
  toggleClass(classIndex: number): boolean {
    if (!this.colorScale) return false
    if (this.mutedClasses.has(classIndex)) {
      this.mutedClasses.delete(classIndex)
      return false
    }
    this.mutedClasses.add(classIndex)
    return true
  }

  /**
   * One spec per drawn cell, at this camera scale.
   *
   * The ring is built once and translated per bin. Every cell in a lattice is
   * the same hexagon, so recomputing six vertices ten thousand times would be
   * ten thousand times the trigonometry for one shape.
   */
  binSpecs(zoom: number): BinSpec[] {
    const bins = this.bins(zoom)
    const level = clusterLevel(zoom)
    const worldRadius = this.radius / Math.max(levelScale(level), 1e-9)
    const gap = Math.min(0.9, Math.max(0, this.config.gap ?? 0))
    const ring = cellRing(worldRadius * (1 - gap), this.orientation)

    const out: BinSpec[] = []
    bins.forEach((bin, i) => {
      if (this.isMuted(bin)) return
      const [cx, cy] = bin.world
      let d = ''
      for (let v = 0; v < ring.length; v++) {
        d += `${v === 0 ? 'M' : 'L'}${cx + ring[v][0]},${cy + ring[v][1]}`
      }
      out.push({
        key: `${bin.q},${bin.r}`,
        item: i,
        d: `${d}Z`,
        fill: this.fillFor(bin),
      })
    })
    return out
  }
}

/** `lon`/`lat`, `lng`, or a GeoJSON `coordinates` pair. */
function coordinatesOf(datum: HexbinDatum): LonLat | null {
  if (Array.isArray(datum.coordinates) && datum.coordinates.length >= 2) {
    const [lon, lat] = datum.coordinates
    if (Number.isFinite(lon) && Number.isFinite(lat)) return [lon, lat]
  }
  const lon = typeof datum.lon === 'number' ? datum.lon : datum.lng
  const lat = datum.lat
  if (
    typeof lon === 'number' &&
    typeof lat === 'number' &&
    Number.isFinite(lon) &&
    Number.isFinite(lat)
  ) {
    return [lon, lat]
  }
  return null
}
