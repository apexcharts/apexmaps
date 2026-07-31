/**
 * The three-space transform chain: data -> world -> screen.
 *
 * ```
 *  lon/lat  --projection-->  world px (fitted once)  --camera-->  screen px
 * ```
 *
 * The projection is fitted to the container **once**, so world coordinates are
 * projected pixels at camera scale 1. Panning and zooming are then a pure affine
 * transform applied to a single SVG group, which is why interaction never
 * triggers reprojection. Reprojection
 * happens only when the projection itself, the container size, or the fitted
 * extent changes.
 *
 * Nothing in this module stores screen coordinates: labels, annotations and
 * story scenes anchor in data or world space so a resize cannot invalidate them
 * (section 5.1, rule 1).
 *
 * @module geo/Viewport
 */

import { geoPath, geoBounds, geoCentroid } from 'd3-geo'
import { createProjection, isAzimuthal, isComposite, isGlobe } from './Projections'
import type { GeoProjection } from './Projections'
import type { Rotation } from './Versor'
import type {
  CameraState,
  LonLat,
  Padding,
  ProjectionName,
  ProjectionSpec,
  ScreenPoint,
  WorldBounds,
  WorldPoint,
} from '../types'

/** A d3 path generator, which doubles as a measurement tool. */
export interface GeoPathLike {
  (object: unknown): string | null
  bounds: (object: unknown) => [[number, number], [number, number]]
  centroid: (object: unknown) => [number, number]
  area: (object: unknown) => number
}

export class Viewport {
  width: number
  height: number
  projection: GeoProjection | null = null
  projectionName = ''
  path: GeoPathLike | null = null
  camera: CameraState = { k: 1, x: 0, y: 0 }
  /** World-space bounds of the fitted content. */
  worldBounds: WorldBounds | null = null
  /**
   * The projection's `[lambda, phi, gamma]`, mirrored here so callers have one
   * place to read it and so it survives the projection being rebuilt by a
   * resize. Unlike the camera this is *not* a view transform: changing it moves
   * the sphere under the projection, so every projected coordinate on the map is
   * stale afterwards and has to be recomputed.
   */
  rotation: Rotation = [0, 0, 0]

  constructor({ width = 0, height = 0 }: { width?: number; height?: number } = {}) {
    this.width = width
    this.height = height
  }

  resize(width: number, height: number): void {
    this.width = width
    this.height = height
  }

  setProjection(spec: ProjectionName | ProjectionSpec): void {
    this.projection = createProjection(spec)
    this.projectionName = typeof spec === 'string' ? spec : spec?.name || 'equalEarth'
    // Read back rather than copy the spec: composite projections ignore `rotate`
    // and several projections carry a non-zero default, so the projection itself
    // is the only honest source.
    const angles = typeof this.projection.rotate === 'function' ? this.projection.rotate() : null
    this.rotation = angles ? [angles[0] ?? 0, angles[1] ?? 0, angles[2] ?? 0] : [0, 0, 0]
    // `geoPath` with no context returns SVG path strings. It lives on the
    // viewport rather than inside the renderer because the series measure and
    // project through it too.
    this.path = geoPath(this.projection as never) as unknown as GeoPathLike
  }

  /**
   * Whether the projection can be spun at all: it has to rotate, and it has to
   * invert, because grabbing a point on the sphere is how a drag decides what to
   * rotate by.
   */
  get rotatable(): boolean {
    return (
      !!this.projection &&
      typeof this.projection.rotate === 'function' &&
      typeof this.projection.invert === 'function' &&
      !isComposite(this.projectionName)
    )
  }

  /** Whether this projection is a globe, so a drag should spin it by default. */
  get isGlobeView(): boolean {
    return this.rotatable && isGlobe(this.projectionName)
  }

  /**
   * Turn the sphere. Longitude is wrapped rather than clamped, so a globe spins
   * through 360 degrees and keeps going instead of stopping at the antimeridian.
   *
   * The projection's scale and translate are untouched, so world coordinates stay
   * in the same space and the camera survives: rotating never refits, which is
   * what keeps a spin from breathing in and out as different continents come into
   * view.
   */
  setRotation(angles: Rotation): void {
    if (!this.projection || typeof this.projection.rotate !== 'function') return
    if (isComposite(this.projectionName)) return
    const next: Rotation = [wrapDegrees(angles[0]), angles[1] ?? 0, angles[2] ?? 0]
    if (!next.every(Number.isFinite)) return
    this.rotation = next
    this.projection.rotate(next)
    // `geoPath` reads `projection.stream` on every call and d3-geo invalidates
    // its stream cache inside `rotate`, so the existing generator already emits
    // the new geometry. Nothing to rebuild.
  }

  /**
   * Fit the projection so `object` fills the container, minus padding.
   *
   * @param object Any GeoJSON object: FeatureCollection, Feature or geometry.
   */
  fit(object: unknown, padding: Padding = 0): void {
    if (!this.projection || !object) return
    const p =
      typeof padding === 'number'
        ? { top: padding, right: padding, bottom: padding, left: padding }
        : { top: 0, right: 0, bottom: 0, left: 0, ...padding }

    const x0 = p.left
    const y0 = p.top
    const x1 = Math.max(x0 + 1, this.width - p.right)
    const y1 = Math.max(y0 + 1, this.height - p.bottom)

    if (typeof this.projection.fitExtent === 'function') {
      this.projection.fitExtent(
        [
          [x0, y0],
          [x1, y1],
        ],
        object,
      )
      this.path = geoPath(this.projection as never) as unknown as GeoPathLike
      this._refineFit(object, x0, y0, x1, y1)
    } else if (typeof this.projection.scale === 'function') {
      // Projections without fitExtent (rare, and only custom ones) get a
      // best-effort centre so they render something sane rather than nothing.
      this.projection.translate([(x0 + x1) / 2, (y0 + y1) / 2])
      this.path = geoPath(this.projection as never) as unknown as GeoPathLike
    }

    this.worldBounds = this.measure(object)
  }

  /**
   * Correct `fitExtent`'s residual overflow.
   *
   * d3-geo's `fitExtent` measures bounds at a fixed reference scale, but geodesic
   * edges are adaptively resampled, so at the final (larger) scale the rendered
   * shape is very slightly bigger than what was measured: an edge between two
   * points at the same latitude bows poleward along its great circle. The result
   * is a fit that overflows its extent by a pixel or two and clips at the
   * container boundary.
   *
   * Dense real-world coastlines hide this, sparse geometry (bounding boxes,
   * schematic shapes, tilegrams) does not. One correction pass converges because
   * the residual after rescaling is second-order.
   *
   */
  private _refineFit(object: unknown, x0: number, y0: number, x1: number, y1: number): void {
    if (!this.projection) return
    const bounds = this.measure(object)
    if (!bounds) return

    const targetW = x1 - x0
    const targetH = y1 - y0
    const actualW = bounds[1][0] - bounds[0][0]
    const actualH = bounds[1][1] - bounds[0][1]
    if (actualW <= 0 || actualH <= 0) return

    const correction = Math.min(targetW / actualW, targetH / actualH)
    // Only act on real overflow. Shrinking on every fit would compound rounding
    // error, and a sub-pixel gap is invisible.
    if (correction >= 1 || (1 - correction) * Math.max(actualW, actualH) < 0.5) return

    const scale = this.projection.scale() * correction
    this.projection.scale(scale)
    this.path = geoPath(this.projection as never) as unknown as GeoPathLike

    // Re-centre: scaling happened about the projection origin, not the content.
    const scaled = this.measure(object)
    if (!scaled) return
    const translate = this.projection.translate()
    this.projection.translate([
      translate[0] + (x0 + x1) / 2 - (scaled[0][0] + scaled[1][0]) / 2,
      translate[1] + (y0 + y1) / 2 - (scaled[0][1] + scaled[1][1]) / 2,
    ])
    this.path = geoPath(this.projection as never) as unknown as GeoPathLike
  }

  /**
   * World-space bounding box of a GeoJSON object under the current projection.
   *
   */
  measure(object: unknown): WorldBounds | null {
    if (!this.path || !object) return null
    const b = this.path.bounds(object)
    if (!b || !Number.isFinite(b[0][0]) || !Number.isFinite(b[1][0])) return null
    return b as WorldBounds
  }

  /**
   * SVG path string for a feature, in world space (camera-independent, so it is
   * safe to cache for the lifetime of the projection).
   *
   */
  pathFor(feature: { geometry?: unknown } | null | undefined): string | null {
    if (!this.path || !feature?.geometry) return null
    return this.path(feature.geometry) || null
  }

  /**
   * The SVG transform implementing the camera. Applied to one group, so panning
   * and zooming cost one attribute write regardless of feature count.
   *
   */
  transform(): string {
    const { k, x, y } = this.camera
    return `translate(${x},${y}) scale(${k})`
  }

  worldToScreen([wx, wy]: WorldPoint): ScreenPoint {
    const { k, x, y } = this.camera
    return [wx * k + x, wy * k + y]
  }

  screenToWorld([sx, sy]: ScreenPoint): WorldPoint {
    const { k, x, y } = this.camera
    return [(sx - x) / k, (sy - y) / k]
  }

  /** Null when the point is clipped away by the projection. */
  project(lonLat: LonLat): WorldPoint | null {
    if (!this.projection) return null
    const w = this.projection(lonLat)
    if (!w || !Number.isFinite(w[0]) || !Number.isFinite(w[1])) return null
    return w as WorldPoint
  }

  lonLatToScreen(lonLat: LonLat): ScreenPoint | null {
    const w = this.project(lonLat)
    return w ? this.worldToScreen(w) : null
  }

  /** Null when the projection has no inverse. */
  screenToLonLat(screen: ScreenPoint): LonLat | null {
    if (!this.projection || typeof this.projection.invert !== 'function') return null
    const ll = this.projection.invert(this.screenToWorld(screen))
    if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) return null
    return ll as LonLat
  }

  /**
   * Spherical bounds of a GeoJSON object, in degrees. Used for `frame()` and for
   * diagnostics; unlike `measure()` this is projection-independent.
   *
   */
  static bounds(object: unknown): [LonLat, LonLat] {
    return geoBounds(object as never) as [LonLat, LonLat]
  }

  static centroid(object: unknown): LonLat {
    return geoCentroid(object as never) as LonLat
  }

  /**
   * Camera state that frames a world-space box inside the container.
   *
   * @param bounds World-space box.
   */
  cameraForBounds(
    bounds: WorldBounds,
    {
      padding = 24,
      maxZoom = Number.POSITIVE_INFINITY,
    }: { padding?: Padding; maxZoom?: number } = {},
  ): CameraState {
    const p =
      typeof padding === 'number'
        ? { top: padding, right: padding, bottom: padding, left: padding }
        : { top: 0, right: 0, bottom: 0, left: 0, ...padding }

    const [[bx0, by0], [bx1, by1]] = bounds
    const bw = Math.max(bx1 - bx0, 1e-6)
    const bh = Math.max(by1 - by0, 1e-6)

    // Padding-aware framing matters more than it sounds: in a scrollytelling
    // layout half the viewport is text, so "fit this feature into the visible
    // area" is the real requirement.
    const availW = Math.max(1, this.width - p.left - p.right)
    const availH = Math.max(1, this.height - p.top - p.bottom)

    const k = Math.min(maxZoom, Math.min(availW / bw, availH / bh))
    const cx = (bx0 + bx1) / 2
    const cy = (by0 + by1) / 2
    const x = p.left + availW / 2 - cx * k
    const y = p.top + availH / 2 - cy * k
    return { k, x, y }
  }

  /**
   * Camera state centred on a geographic point at a given scale.
   *
   */
  cameraForCenter(lonLat: LonLat, k: number): CameraState | null {
    const w = this.project(lonLat)
    if (!w) return null
    return { k, x: this.width / 2 - w[0] * k, y: this.height / 2 - w[1] * k }
  }

  /**
   * The geographic point currently at the centre of the viewport.
   *
   */
  center(): LonLat | null {
    return this.screenToLonLat([this.width / 2, this.height / 2])
  }

  /**
   * Whether re-centring this projection means **turning the sphere** rather
   * than panning the plane.
   *
   * True for the azimuthal family, false for everything laid out flat and for
   * composite projections such as Albers USA, which translate their insets
   * internally and break under any rotation. The camera consults this to decide
   * whether a `center` target is a pan or a rotation: on a globe it has to be a
   * rotation, because no amount of screen-space panning can bring the far
   * hemisphere into view.
   */
  supportsRecentre(): boolean {
    return this.rotatable && isAzimuthal(this.projectionName)
  }

  /**
   * Run `fn` with the sphere temporarily turned to `rotation`, then put it back.
   *
   * This is how a camera move works out where it is going: the destination
   * camera has to be measured against the sphere as it will be *after* the
   * move, or the move pans across the screen to chase a point the rotation was
   * about to bring home anyway. Nothing renders inside the callback, so the
   * projection's momentary state is never observable; `finally` guarantees that
   * stays true even if `fn` throws.
   */
  underRotation<T>(rotation: Rotation, fn: () => T): T {
    if (!this.projection || typeof this.projection.rotate !== 'function') return fn()
    const current = this.rotation
    try {
      this.projection.rotate(rotation)
      return fn()
    } finally {
      this.projection.rotate(current)
    }
  }

  /**
   * The rotation that brings a place to the sub-observer point: the centre of an
   * azimuthal projection, and on a globe the point facing the viewer.
   *
   * Any roll the reader has applied by dragging is preserved, because a camera
   * move was asked to go somewhere, not to level the horizon.
   */
  rotationFor([lon, lat]: LonLat): Rotation {
    return [-lon, -lat, this.rotation[2]]
  }

  /** The place currently at the sub-observer point. */
  subObserver(): LonLat {
    return [-this.rotation[0], -this.rotation[1]]
  }
}

/** Fold a longitude into (-180, 180], so a spin never accumulates unbounded. */
function wrapDegrees(value: number): number {
  if (!Number.isFinite(value)) return 0
  const wrapped = ((value + 180) % 360 + 360) % 360 - 180
  return wrapped === -180 ? 180 : wrapped
}
