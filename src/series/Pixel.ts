/**
 * Pixel series: a choropleth drawn as a lattice of dots.
 *
 * Everything upstream of the mark is the choropleth's, inherited rather than
 * reimplemented: the join, normalisation, the scale, legend muting, drilldown and
 * the advice about counts on an area fill (which applies to dots exactly as it
 * does to fills, because a region's dot count is its area). What this class adds
 * is one thing, the path a region is drawn with, and it keeps that to one path
 * per region on purpose. Hover, selection, keyboard focus, fill tweens and the
 * level reveal all address a region by its element, and a region drawn as two
 * hundred elements would have to be taught to every one of them.
 *
 * The lattice comes from `geo/PixelGrid`, sampled in one of three ways:
 *
 * - **`grid: 'geo'` on a flat map** lays a plane lattice over the map as it
 *   opened, keeps the points that land in a region, and stores each one as a
 *   longitude and latitude. The lattice is therefore perfectly even where the
 *   reader first sees it, on any projection, and every shape tiles; and because
 *   what is kept is a place on the ground, zooming enlarges the dots, a resize
 *   reprojects them, and nothing ever resamples. Sampling in degrees instead
 *   puts the rows on the parallels, which most projections draw at a spacing
 *   that has nothing to do with the shape's, so hexagons seam and diamonds gap.
 * - **`grid: 'geo'` on a globe** cannot do that, because the map as it opened
 *   is one hemisphere and the reader can turn to the other. There the lattice
 *   is laid on the sphere itself, in rows along the parallels that each wrap
 *   the world exactly once, so it turns with the ground and has no seam.
 * - **`grid: 'screen'`** samples the projected outlines at quantized zoom
 *   levels, around the viewport. A pan inside the sampled area costs nothing; a
 *   pan that leaves it, or a zoom that crosses a level, resamples.
 *
 * Both geo samples are cached against the geometry, so a data update (which
 * builds a new series) reuses them and only reprojects.
 *
 * @module series/Pixel
 */

import { geoStream } from 'd3-geo'
import { resolveSize } from '../utils/dom'
import { clusterLevel, levelScale } from '../geo/Cluster'
import { Viewport } from '../geo/Viewport'
import {
  dotPath,
  dotTail,
  geoLattice,
  geoRings,
  latticeFor,
  lonSpan,
  niceDegrees,
  planeLattice,
  projectedRings,
  rowRatio,
  sampleRegions,
} from '../geo/PixelGrid'
import type {
  DotTail,
  LatticeSpec,
  PixelCell,
  PixelLattice,
  RegionInput,
  Ring,
} from '../geo/PixelGrid'
import type { Rotation } from '../geo/Versor'
import { ChoroplethSeries } from './Choropleth'
import type {
  LegendItem,
  LonLat,
  NormalizedFeature,
  NormalizedGeo,
  PixelSeriesOptions,
  PixelShape,
  WorldBounds,
} from '../types'

/** Screen pixels between dots on a screen grid when the caller does not say. */
const DEFAULT_SCREEN_SPACING = 8

const DEFAULT_SIZE = '80%'

/**
 * How far past the viewport a screen lattice is sampled, in viewports.
 *
 * One on every side means a pan has to cross a whole screen before it resamples,
 * which is more than a flick covers, while the box stays at nine screens of
 * points however far in the reader has zoomed.
 */
const SCREEN_MARGIN = 1

/** A dot smaller than this, in world units, is below a pixel and not drawn. */
const MIN_DOT = 0.15

/**
 * How far shapes asked to touch overlap instead, in pixels at the zoom the
 * lattice was laid at.
 *
 * Two shapes that share an edge exactly are antialiased along it from both
 * sides, and the two half-covered pixel rows composite to less than full
 * coverage: a hairline of background runs through every seam of a 100%
 * hexagon lattice. Half a pixel of overlap closes it. Inside a region the
 * overlap is the same colour on the same path and cannot be seen; across a
 * border it is half a pixel of one neighbour drawn over the other.
 */
const TILE_BLEED = 0.5

const RAD = Math.PI / 180

interface GeoSample {
  /** Kept lattice points per feature index, in degrees. */
  points: Map<number, LonLat[]>
  dropped: number[]
}

/**
 * Geographic samples, per geometry, per scope, per lattice.
 *
 * Keyed on the normalised geometry object, which survives `updateSeries`
 * untouched, so a data update reuses the sample instead of rescanning every
 * region. The scope is the projection object for a flat map, whose sample was
 * taken on that projection (a resize builds a new one and resamples, at the new
 * size), and a fixed token for the globe's, which does not depend on the
 * projection at all. WeakMaps, so a map that drills away or is destroyed takes
 * its entries with it.
 */
const SAMPLES = new WeakMap<NormalizedGeo, WeakMap<object, Map<string, GeoSample>>>()
const ON_THE_SPHERE = {}

function cachedSample(
  geo: NormalizedGeo,
  scope: object,
  key: string,
  compute: () => GeoSample,
): GeoSample {
  let scopes = SAMPLES.get(geo)
  if (!scopes) {
    scopes = new WeakMap()
    SAMPLES.set(geo, scopes)
  }
  let byKey = scopes.get(scope)
  if (!byKey) {
    byKey = new Map()
    scopes.set(scope, byKey)
  }
  let sample = byKey.get(key)
  if (!sample) {
    sample = compute()
    byKey.set(key, sample)
  }
  return sample
}

export class PixelSeries extends ChoroplethSeries {
  static override readonly type = 'pixel' as const

  override readonly type = 'pixel' as const
  declare readonly config: PixelSeriesOptions

  readonly shape: PixelShape
  readonly lattice: PixelLattice
  /** The grid actually drawn: `'screen'` is refused on a globe. */
  readonly grid: 'geo' | 'screen'
  /** Degrees on a geo grid, screen pixels on a screen grid. */
  readonly spacing: number
  /** Only the globe's lattice has rows to thin. */
  readonly equalArea: boolean

  private readonly viewport: Viewport
  private readonly openingRotation: Rotation | undefined
  /** World-space path per feature index, for the projection as it stands. */
  private paths = new Map<number, string>()
  private pathsValid = false
  /** Screen grid only: the level and the box the current sample covers. */
  private sampledLevel: number | null = null
  private sampledBox: WorldBounds | null = null
  private screenDropped: number[] = []

  constructor({
    config,
    geo,
    index,
    viewport,
    rotation,
    theme,
    dark = false,
    noData,
  }: {
    config: PixelSeriesOptions
    geo: NormalizedGeo
    index: number
    viewport: Viewport
    /**
     * The rotation the map opened at. Passed in rather than read off the
     * viewport, because a series is rebuilt on every data update and the
     * viewport by then may have been spun anywhere: the lattice belongs to the
     * map as it opened, not to wherever the reader has turned it since.
     */
    rotation?: Rotation
    theme?: { palette?: string }
    dark?: boolean
    noData?: string
  }) {
    super({ config, geo, index, theme, dark, noData })
    this.viewport = viewport
    this.openingRotation = rotation

    this.shape = isShape(config.shape) ? config.shape : 'circle'
    this.lattice =
      config.lattice === 'square' || config.lattice === 'staggered'
        ? config.lattice
        : latticeFor(this.shape)

    let grid = config.grid === 'screen' ? 'screen' : 'geo'
    if (grid === 'screen' && viewport.isGlobeView) {
      // Refused rather than honoured slowly: a screen lattice belongs to the
      // projected outlines, and a spin changes every one of them every frame.
      this.warnings.push(
        "grid: 'screen' is not available on a globe, because the lattice would be resampled on every frame of a spin; drawing on grid: 'geo' instead",
      )
      grid = 'geo'
    }
    this.grid = grid as 'geo' | 'screen'

    this.equalArea = config.equalArea !== false
    if (config.equalArea != null && !this.spherical) {
      this.warnings.push(
        'equalArea only applies on a globe, where the lattice is laid in rows along the parallels and has rows to thin. On a flat map the lattice is laid on the map as drawn, which on an equal-area projection is equal-area already; the option is ignored here',
      )
    }

    const asked = config.spacing
    const valid = asked != null && Number.isFinite(asked) && asked > 0
    if (asked != null && !valid) {
      this.warnings.push(`spacing ${String(asked)} is not a positive number; using the default`)
    }
    this.spacing = valid
      ? asked
      : this.grid === 'screen'
        ? DEFAULT_SCREEN_SPACING
        : niceDegrees(lonSpan(Viewport.bounds(geo.collection)))
  }

  /** Whether the lattice is laid on the sphere rather than on the map. */
  private get spherical(): boolean {
    return this.grid === 'geo' && this.viewport.isGlobeView
  }

  /** Projected paths are stale after a projection, size or rotation change. */
  reproject(_viewport?: Viewport): void {
    this.pathsValid = false
    this.sampledLevel = null
    this.sampledBox = null
  }

  /**
   * Whether the camera has moved far enough to change what a screen grid drew.
   *
   * Always false on a geo grid, whose dots ride the camera transform like any
   * other world-space geometry.
   */
  needsRedraw(): boolean {
    if (this.grid !== 'screen') return false
    if (!this.pathsValid) return true
    if (clusterLevel(this.viewport.camera.k) !== this.sampledLevel) return true
    const visible = this.visibleBox()
    const box = this.sampledBox
    return (
      !box ||
      visible[0][0] < box[0][0] ||
      visible[0][1] < box[0][1] ||
      visible[1][0] > box[1][0] ||
      visible[1][1] > box[1][1]
    )
  }

  /**
   * The world-space path a feature is drawn with, or null when none of its dots
   * are on the map (the far side of a globe, or outside a screen sample).
   */
  shapeFor(feature: NormalizedFeature): string | null {
    if (!this.pathsValid) this.build()
    return this.paths.get(feature.index) ?? null
  }

  /** Swatches drawn as the mark, so the legend shows what the map shows. */
  override legendItems(options?: {
    includeNull?: boolean
    format?: (v: number) => string
  }): LegendItem[] {
    return super.legendItems(options).map((item) => ({ ...item, mark: this.shape }))
  }

  override advise(): string[] {
    const notes = super.advise()
    const dropped = this.droppedNames()
    if (dropped.length) {
      const shown = dropped.slice(0, 5).join(', ')
      const more = dropped.length > 5 ? ` and ${dropped.length - 5} more` : ''
      const spacing = this.grid === 'geo' ? `${this.spacing}°` : `${this.spacing}px`
      notes.push(
        `${dropped.length} region(s) are too small for a ${spacing} lattice and are not drawn (${shown}${more}): each is wedged between neighbours that hold only one dot themselves. A smaller spacing gives them room`,
      )
    }
    return notes
  }

  private droppedNames(): string[] {
    if (!this.pathsValid) this.build()
    const indices = this.grid === 'geo' ? this.geoSample().dropped : this.screenDropped
    return indices.map((i) => {
      const f = this.geo.features[i]
      return String(f?.name ?? f?.key ?? i)
    })
  }

  // --- the geo grid ---------------------------------------------------------

  private build(): void {
    this.paths = this.grid === 'geo' ? this.buildGeo() : this.buildScreen()
    this.pathsValid = true
  }

  /** Project the kept places, cull what the projection hides, and draw them. */
  private buildGeo(): Map<number, string> {
    const out = new Map<number, string>()
    const projection = this.viewport.projection
    if (!projection) return out

    const sample = this.geoSample()
    // Measured on the map as it opened, which is what the lattice was laid on.
    // On a globe the centre is the one point drawn at true scale, so the answer
    // is the same at any rotation.
    const nominal = this.spherical ? this.geoNominal() : this.atOpening(() => this.geoNominal())
    if (!(nominal > 0)) return out
    const half = this.dotHalf(nominal, 1)
    if (half < MIN_DOT / 2) return out
    const precision = 3
    const tail = dotTail(this.shape, half, precision)

    // A projection that hides part of the sphere (a globe, or anything given a
    // clip angle) hides the dots there too. Only a globe foreshortens them: on a
    // stereographic map the edge is a projection artefact rather than a horizon,
    // and dots shrinking towards it would read as data.
    const clipAngle = typeof projection.clipAngle === 'function' ? projection.clipAngle() : null
    const horizon =
      typeof clipAngle === 'number' && clipAngle > 0 ? Math.cos(clipAngle * RAD) : null
    const globe = this.viewport.isGlobeView
    const [cl, cp] = this.viewport.subObserver()
    const sinP0 = Math.sin(cp * RAD)
    const cosP0 = Math.cos(cp * RAD)

    for (const [index, points] of sample.points) {
      let d = ''
      for (const [lon, lat] of points) {
        let scale = 1
        if (horizon !== null) {
          const cosC =
            sinP0 * Math.sin(lat * RAD) + cosP0 * Math.cos(lat * RAD) * Math.cos((lon - cl) * RAD)
          if (cosC < horizon) continue
          if (globe) scale = cosC
        }
        const world = this.viewport.project([lon, lat])
        if (!world) continue
        if (scale === 1) {
          d += dotPath(world[0], world[1], tail, precision)
        } else {
          const h = half * scale
          if (h < MIN_DOT / 2) continue
          d += dotPath(world[0], world[1], dotTail(this.shape, h, precision), precision)
        }
      }
      if (d) out.set(index, d)
    }
    return out
  }

  private geoSample(): GeoSample {
    const key = `${this.spacing}|${this.shape}|${this.lattice}`
    if (this.spherical) {
      const meridian = this.centralMeridian()
      return cachedSample(this.geo, ON_THE_SPHERE, `${key}|${this.equalArea}|${meridian}`, () =>
        this.sampleSphere(meridian),
      )
    }
    const projection = this.viewport.projection
    if (!projection) return { points: new Map(), dropped: [] }
    return cachedSample(this.geo, projection, key, () => this.atOpening(() => this.sampleMap()))
  }

  /**
   * The flat map's lattice: laid over the map as drawn, kept as places.
   *
   * Anchored on the map's centre so it sits symmetrically about the central
   * meridian and the equator, which is where a reader looks for a seam.
   */
  private sampleMap(): GeoSample {
    const projection = this.viewport.projection
    const invert = projection?.invert
    const spacing = this.geoNominal()
    if (!projection || typeof invert !== 'function' || !(spacing > 0)) {
      return { points: new Map(), dropped: [] }
    }

    const [ax, ay] = this.latticeAnchor()
    const lattice = planeLattice({
      spacing,
      rowRatio: rowRatio(this.shape, this.lattice),
      staggered: this.lattice === 'staggered',
    })

    const regions: RegionInput[] = []
    for (const feature of this.geo.features) {
      const rings = projectedRings(projection, feature.geometry, geoStream).map((ring) =>
        shift(ring, -ax, -ay),
      )
      if (!rings.length) continue
      const centroid = this.viewport.path?.centroid(feature.geometry)
      regions.push({
        index: feature.index,
        rings,
        anchor:
          centroid && Number.isFinite(centroid[0]) ? [centroid[0] - ax, centroid[1] - ay] : null,
      })
    }

    const { cells, dropped } = sampleRegions(regions, lattice)
    const points = new Map<number, LonLat[]>()
    for (const [index, list] of cells) {
      const places: LonLat[] = []
      for (const cell of list) {
        const place = invert([cell.x + ax, cell.y + ay])
        if (place && Number.isFinite(place[0]) && Number.isFinite(place[1])) {
          places.push(place as LonLat)
        }
      }
      if (places.length) points.set(index, places)
    }
    return { points, dropped }
  }

  /** The globe's lattice: rows along the parallels, in degrees. */
  private sampleSphere(meridian: number): GeoSample {
    const lattice = geoLattice({
      spacing: this.spacing,
      rowRatio: rowRatio(this.shape, this.lattice),
      staggered: this.lattice === 'staggered',
      equalArea: this.equalArea,
      meridian,
    })
    const regions: RegionInput[] = this.geo.features.map((f) => ({
      index: f.index,
      rings: geoRings(f.geometry),
      anchor: geoAnchor(f),
    }))
    const { cells, dropped } = sampleRegions(regions, lattice)
    const points = new Map<number, LonLat[]>()
    for (const [index, list] of cells)
      points.set(
        index,
        list.map((c) => [c.x, c.y]),
      )
    return { points, dropped }
  }

  /** Run with the sphere turned back to where the map opened. */
  private atOpening<T>(fn: () => T): T {
    return this.openingRotation ? this.viewport.underRotation(this.openingRotation, fn) : fn()
  }

  /**
   * The longitude the globe's rows line up on: the middle of the map as it
   * opened. A projection that cannot rotate has no central meridian to report,
   * and the middle of its frame stands in.
   */
  private centralMeridian(): number {
    const lon = this.openingRotation ? -this.openingRotation[0] : this.mapCentre()?.[0]
    // Rounded so a wobble in how the centre was measured cannot miss the cache.
    return lon != null && Number.isFinite(lon) ? Math.round(lon * 1000) / 1000 + 0 : 0
  }

  /** Where the flat lattice is pinned: the central meridian at the equator. */
  private latticeAnchor(): [number, number] {
    const pinned = this.viewport.project([this.centralMeridian(), 0])
    if (pinned) return pinned
    // A composite has no point there (the equator is between its insets).
    const bounds = this.viewport.worldBounds
    return bounds ? [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2] : [0, 0]
  }

  /**
   * World units between two dots a `spacing` apart, measured at the middle of
   * the map along a meridian.
   *
   * Along a meridian because the globe's rows are what `equalArea` leaves
   * alone: the column step at the measuring point is `spacing / cos(latitude)`
   * degrees, which an equal-area projection draws the same length as `spacing`
   * degrees of latitude, so the dots come out round in their cells. At the
   * middle of the map because that is where the reader is looking, and on a
   * globe it is the one point the projection draws at true scale.
   */
  private geoNominal(): number {
    const centre = this.viewport.rotatable ? this.viewport.subObserver() : this.mapCentre()
    const half = this.spacing / 2
    if (centre) {
      const lat = Math.max(-89, Math.min(89, centre[1]))
      const a = this.viewport.project([centre[0], lat - half])
      const b = this.viewport.project([centre[0], lat + half])
      if (a && b) {
        const length = Math.hypot(b[0] - a[0], b[1] - a[1])
        if (length > 0) return length
      }
    }
    // A projection that cannot answer at the centre (a composite, asked about a
    // point between its insets) still knows how wide the map is.
    const bounds = this.viewport.worldBounds
    if (!bounds) return 0
    const span = lonSpan(Viewport.bounds(this.geo.collection))
    return ((bounds[1][0] - bounds[0][0]) * this.spacing) / span
  }

  private mapCentre(): LonLat | null {
    const bounds = this.viewport.worldBounds
    if (!bounds || typeof this.viewport.projection?.invert !== 'function') return null
    const middle: [number, number] = [
      (bounds[0][0] + bounds[1][0]) / 2,
      (bounds[0][1] + bounds[1][1]) / 2,
    ]
    const ll = this.viewport.projection.invert(middle)
    return ll && Number.isFinite(ll[0]) && Number.isFinite(ll[1]) ? (ll as LonLat) : null
  }

  // --- the screen grid ------------------------------------------------------

  private buildScreen(): Map<number, string> {
    const out = new Map<number, string>()
    const projection = this.viewport.projection
    if (!projection) return out

    const level = clusterLevel(this.viewport.camera.k)
    const zoom = levelScale(level)
    // The level's scale, not the live one, so every dot sampled at a level is
    // the same size as every other, exactly as a hexbin's cells are.
    const spacing = this.spacing / zoom
    const box = this.sampleBox()
    this.sampledLevel = level
    this.sampledBox = box

    const lattice: LatticeSpec = planeLattice({
      spacing,
      rowRatio: rowRatio(this.shape, this.lattice),
      staggered: this.lattice === 'staggered',
    })

    const regions: RegionInput[] = []
    for (const feature of this.geo.features) {
      const rings = projectedRings(projection, feature.geometry, geoStream)
      if (!rings.length) continue
      const centroid = this.viewport.path?.centroid(feature.geometry)
      regions.push({
        index: feature.index,
        rings,
        anchor: centroid && Number.isFinite(centroid[0]) ? centroid : null,
      })
    }

    const { cells, dropped } = sampleRegions(regions, lattice, box)
    this.screenDropped = dropped

    const half = this.dotHalf(spacing, zoom)
    if (half < MIN_DOT / zoom / 2) return out
    // Two decimals of a screen pixel at this level, in world units.
    const precision = Math.max(2, Math.ceil(2 + Math.log10(Math.max(1, zoom))))
    const tail = dotTail(this.shape, half, precision)
    for (const [index, list] of cells) out.set(index, pathOf(list, tail, precision))
    return out
  }

  /**
   * The world box a screen lattice is sampled over: the viewport and a margin
   * round it, which at the opening zoom takes in the whole map.
   *
   * Not cut to the map's fitted bounds. A pack's recommended view crops (Europe
   * drops Réunion, and its frame ends a few pixels below Malta), and a region
   * whose nearest lattice point fell just outside the crop would vanish rather
   * than sit at the edge of the frame where the reader can pan to it.
   */
  private sampleBox(): WorldBounds {
    const [[x0, y0], [x1, y1]] = this.visibleBox()
    const mx = (x1 - x0) * SCREEN_MARGIN
    const my = (y1 - y0) * SCREEN_MARGIN
    return [
      [x0 - mx, y0 - my],
      [x1 + mx, y1 + my],
    ]
  }

  private visibleBox(): WorldBounds {
    const a = this.viewport.screenToWorld([0, 0])
    const b = this.viewport.screenToWorld([this.viewport.width, this.viewport.height])
    return [a, b]
  }

  /**
   * Half a dot's width, in world units.
   *
   * @param nominal World units between neighbouring dots.
   * @param zoom The camera scale a pixel size is measured at.
   */
  private dotHalf(nominal: number, zoom: number): number {
    const size = this.config.size ?? DEFAULT_SIZE
    const fallback = nominal * 0.8
    // A percentage is of the spacing, which is already in world units. A bare
    // number is pixels, and a pixel is a world unit only at the camera scale it
    // was measured at.
    const width = isPercent(size)
      ? resolveSize(size, nominal, fallback)
      : resolveSize(size, 0, Number.NaN) / zoom
    const valid = Number.isFinite(width) && width > 0 ? width : fallback
    // Capped at a full step: past it neighbours overlap, and which one lands on
    // top is decided by drawing order rather than by anything on the map.
    if (valid >= nominal) return (nominal + TILE_BLEED / zoom) / 2
    return valid / 2
  }
}

const SHAPES: readonly PixelShape[] = ['circle', 'square', 'diamond', 'hexagon']

function isShape(value: unknown): value is PixelShape {
  return SHAPES.includes(value as PixelShape)
}

function isPercent(value: unknown): boolean {
  return typeof value === 'string' && value.trim().endsWith('%')
}

function shift(ring: Ring, dx: number, dy: number): Ring {
  const out = new Array<number>(ring.length)
  for (let i = 0; i < ring.length; i += 2) {
    out[i] = ring[i] + dx
    out[i + 1] = ring[i + 1] + dy
  }
  return out
}

/**
 * Where a region with no lattice point inside it gets its one dot on the globe:
 * the centre of its bounding box in degrees, which for anything small enough to
 * need it is inside or beside the region. Not the spherical centroid, which for
 * a scatter of islands can land in open water a long way from all of them.
 */
function geoAnchor(feature: NormalizedFeature): [number, number] | null {
  const [[west, south], [east, north]] = Viewport.bounds(feature.geometry)
  if (![west, south, east, north].every(Number.isFinite)) return null
  // A box that crosses the antimeridian has its west edge east of its east edge.
  const lon = east >= west ? (west + east) / 2 : (west + east + 360) / 2
  return [lon > 180 ? lon - 360 : lon, (south + north) / 2]
}

function pathOf(cells: readonly PixelCell[], tail: DotTail, precision: number): string {
  let d = ''
  for (const cell of cells) d += dotPath(cell.x, cell.y, tail, precision)
  return d
}
