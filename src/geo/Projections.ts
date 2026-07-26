/**
 * Projection registry.
 *
 * Wraps `d3-geo` rather than reimplementing spherical math: clipping,
 * antimeridian cutting and adaptive resampling are correctness traps that took
 * d3-geo years to get right (see PRODUCT-RESEARCH.md section 5.4).
 *
 * Core ships the projections d3-geo itself provides. Anything else (Mollweide,
 * Robinson, Winkel Tripel, Eckert, Bonne, ...) lives in `d3-geo-projection` and
 * is registered by the consumer via `ApexMaps.registerProjection()`, which
 * keeps the core bundle inside its 150 kB budget.
 *
 * @module geo/Projections
 */

import {
  geoAlbers,
  geoAlbersUsa,
  geoAzimuthalEqualArea,
  geoAzimuthalEquidistant,
  geoConicConformal,
  geoConicEqualArea,
  geoConicEquidistant,
  geoEqualEarth,
  geoEquirectangular,
  geoGnomonic,
  geoIdentity,
  geoMercator,
  geoNaturalEarth1,
  geoOrthographic,
  geoStereographic,
  geoTransverseMercator,
} from 'd3-geo'

import type { ProjectionName, ProjectionSpec } from '../types'

/**
 * A d3-geo style projection. Typed loosely on purpose: the various d3
 * projections expose different optional methods (`parallels`, `clipAngle`,
 * `rotate`), and composite projections such as Albers USA omit several of them.
 */
export interface GeoProjection {
  (coordinates: [number, number]): [number, number] | null
  invert?: (point: [number, number]) => [number, number] | null
  scale: (scale?: number) => number & GeoProjection
  translate: (t?: [number, number]) => [number, number] & GeoProjection
  fitExtent?: (extent: [[number, number], [number, number]], object: unknown) => GeoProjection
  rotate?: (angles?: number[]) => number[] & GeoProjection
  center?: (center?: [number, number]) => [number, number] & GeoProjection
  parallels?: (parallels?: [number, number]) => [number, number] & GeoProjection
  angle?: (angle?: number) => number & GeoProjection
  clipAngle?: (angle?: number) => number & GeoProjection
  clipExtent?: (extent?: [[number, number], [number, number]] | null) => unknown
  reflectX?: (reflect?: boolean) => unknown
  reflectY?: (reflect?: boolean) => unknown
  stream: (stream: unknown) => unknown
  [method: string]: unknown
}

export type ProjectionFactory = () => GeoProjection

const registry = new Map<string, ProjectionFactory>()

/** Register a projection factory under a name. */
export function registerProjection(name: string, factory: ProjectionFactory): void {
  if (typeof name !== 'string' || !name) {
    throw new TypeError('ApexMaps: projection name must be a non-empty string')
  }
  if (typeof factory !== 'function') {
    throw new TypeError(`ApexMaps: projection "${name}" must be registered with a factory function`)
  }
  registry.set(name, factory)
}

export function hasProjection(name: string): boolean {
  return registry.has(name)
}

/** Registered projection names, sorted. */
export function listProjections(): string[] {
  return [...registry.keys()].sort()
}

// Core set. Aliases are deliberate: `webMercator` and `epsg:3857` are the names
// developers arriving from tile-based libraries will reach for, and
// `plateCarree` / `epsg:4326` is what they mean when they render raw lon/lat.
registerProjection('equalEarth', geoEqualEarth as unknown as ProjectionFactory)
registerProjection('mercator', geoMercator as unknown as ProjectionFactory)
registerProjection('webMercator', geoMercator as unknown as ProjectionFactory)
registerProjection('epsg:3857', geoMercator as unknown as ProjectionFactory)
registerProjection('equirectangular', geoEquirectangular as unknown as ProjectionFactory)
registerProjection('plateCarree', geoEquirectangular as unknown as ProjectionFactory)
registerProjection('epsg:4326', geoEquirectangular as unknown as ProjectionFactory)
registerProjection('naturalEarth', geoNaturalEarth1 as unknown as ProjectionFactory)
registerProjection('orthographic', geoOrthographic as unknown as ProjectionFactory)
registerProjection('albers', geoAlbers as unknown as ProjectionFactory)
registerProjection('albersUsa', geoAlbersUsa as unknown as ProjectionFactory)
registerProjection('conicConformal', geoConicConformal as unknown as ProjectionFactory)
registerProjection('conicEqualArea', geoConicEqualArea as unknown as ProjectionFactory)
registerProjection('conicEquidistant', geoConicEquidistant as unknown as ProjectionFactory)
registerProjection('azimuthalEqualArea', geoAzimuthalEqualArea as unknown as ProjectionFactory)
registerProjection('azimuthalEquidistant', geoAzimuthalEquidistant as unknown as ProjectionFactory)
registerProjection('gnomonic', geoGnomonic as unknown as ProjectionFactory)
registerProjection('stereographic', geoStereographic as unknown as ProjectionFactory)
registerProjection('transverseMercator', geoTransverseMercator as unknown as ProjectionFactory)
registerProjection('identity', geoIdentity as unknown as ProjectionFactory)

/**
 * Projections whose output is already a fixed composite layout. They must not
 * be re-centred or rotated: `geoAlbersUsa` in particular translates Alaska and
 * Hawaii into insets internally, and mutating `center`/`rotate` breaks it.
 */
const COMPOSITE = new Set(['albersUsa'])

export function isComposite(name: string): boolean {
  return COMPOSITE.has(name)
}

/**
 * Build a configured projection from a spec.
 *
 * Accepts a bare name (`'mercator'`) or a spec object. Unknown names throw
 * rather than silently falling back, because a silent fallback to the wrong
 * projection produces a map that looks plausible and is wrong, which is the
 * worst possible failure mode in cartography.
 *
 */
export function createProjection(
  spec: ProjectionName | ProjectionSpec = 'equalEarth',
): GeoProjection {
  const cfg: ProjectionSpec = typeof spec === 'string' ? { name: spec } : { ...(spec || {}) }
  const name = cfg.name || 'equalEarth'

  const factory = registry.get(name)
  if (!factory) {
    throw new Error(
      `ApexMaps: unknown projection "${name}". Registered: ${listProjections().join(', ')}. ` +
        'Register others (mollweide, robinson, winkel3, ...) from d3-geo-projection via ApexMaps.registerProjection().',
    )
  }

  const projection = factory()
  const composite = isComposite(name)

  if (cfg.parallels && typeof projection.parallels === 'function') {
    projection.parallels(cfg.parallels)
  }
  if (cfg.rotate && !composite && typeof projection.rotate === 'function') {
    projection.rotate(cfg.rotate)
  }
  if (cfg.center && !composite && typeof projection.center === 'function') {
    projection.center(cfg.center)
  }
  if (typeof cfg.angle === 'number' && typeof projection.angle === 'function') {
    projection.angle(cfg.angle)
  }
  if (typeof cfg.clipAngle === 'number' && typeof projection.clipAngle === 'function') {
    projection.clipAngle(cfg.clipAngle)
  }
  if (cfg.clipExtent && typeof projection.clipExtent === 'function') {
    projection.clipExtent(cfg.clipExtent)
  }
  if (cfg.reflectX && typeof projection.reflectX === 'function') projection.reflectX(true)
  if (cfg.reflectY && typeof projection.reflectY === 'function') projection.reflectY(true)

  return projection
}

/**
 * Whether a projection maps the whole sphere (so a sphere outline and a full
 * graticule make sense) or only a hemisphere / region.
 *
 */
export function isGlobal(name: string): boolean {
  return !/^(orthographic|gnomonic|stereographic|azimuthal|albersUsa|identity|conic)/.test(name)
}
