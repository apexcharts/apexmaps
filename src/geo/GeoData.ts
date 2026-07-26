/**
 * Geometry ingestion.
 *
 * Accepts GeoJSON (FeatureCollection / Feature / bare geometry / array of
 * features) and TopoJSON, and normalises everything to a flat feature list with
 * a resolved join key per feature.
 *
 * Two deliberate opinions live here:
 *
 * 1. **Winding is repaired by default,** to the d3-geo spherical convention
 *    (exterior rings clockwise), which is the opposite of RFC 7946. A reversed
 *    ring is interpreted as "the whole sphere except this polygon", so the map
 *    fills solid and every feature reports identical world bounds. It is silent,
 *    it breaks labels and camera framing, and repairing costs one signed-area
 *    pass per ring. See `rewindPolygon` for the full explanation.
 * 2. **The join key is resolved explicitly and reported.** Auto-detection is a
 *    convenience, never a guess we hide: the resolved field name is returned so
 *    diagnostics can tell the developer what was actually used.
 *
 * @module geo/GeoData
 */

import { feature as topoFeature } from 'topojson-client'
import { geoArea } from 'd3-geo'
import type { Feature, Geometry, Position } from 'geojson'
import type { GeoInput, NormalizedFeature, NormalizedGeo } from '../types'

/**
 * Candidate join-key properties, most specific first. ISO codes beat names
 * because names are unstable across datasets ("Côte d'Ivoire" vs "Ivory Coast")
 * while codes are not. `hc-key` is included so Highcharts map geometry works
 * unchanged, which removes a migration blocker.
 */
const KEY_CANDIDATES = [
  'iso_a3',
  'ISO_A3',
  'iso3',
  'ISO3',
  'adm0_a3',
  'ADM0_A3',
  'iso_a2',
  'ISO_A2',
  'hc-key',
  'hc_key',
  'GEOID',
  'geoid',
  'GEO_ID',
  'fips',
  'FIPS',
  'STATEFP',
  'id',
  'ID',
  'code',
  'CODE',
  'postal',
  'POSTAL',
  'name',
  'NAME',
  'NAME_1',
  'name_long',
  'NAME_LONG',
  'admin',
  'ADMIN',
]

const NAME_CANDIDATES = [
  'name',
  'NAME',
  'name_long',
  'NAME_LONG',
  'admin',
  'ADMIN',
  'NAME_1',
  'NAME_EN',
  'name_en',
  'label',
  'title',
]

function firstPresent(
  props: Record<string, unknown> | undefined,
  candidates: string[],
): string | undefined {
  for (const c of candidates) {
    const v = props?.[c]
    if (v !== undefined && v !== null && v !== '') return c
  }
  return undefined
}

/** Half the sphere, in steradians. */
const HEMISPHERE = 2 * Math.PI

/**
 * Spherical area of a polygon, in steradians, as d3-geo itself interprets it.
 *
 * Two wrong approaches were tried first, and both are instructive:
 *
 * 1. **Planar shoelace per ring.** Longitude wraps, so a ring crossing the
 *    antimeridian or containing a pole has no meaningful planar area. Measured
 *    that way, Russia and Fiji come out with the opposite sign from reality and
 *    get "repaired" into covering the entire globe.
 * 2. **Spherical area per ring, with ring 0 treated as the exterior and the rest
 *    as holes.** Ring order is not a reliable statement of role: Natural Earth's
 *    Antarctica has a polygon carrying two exterior-like rings, and forcing the
 *    second one to be a hole inverts the continent.
 *
 * Asking d3-geo about the polygon as a whole avoids both traps. It is the same
 * spherical interpretation that will render the polygon, so the check agrees with
 * the renderer by construction, and it needs no assumption about which ring is
 * which.
 *
 * @returns 0 to 4pi. Above `HEMISPHERE` means the polygon is inside-out.
 */
function polygonArea(rings: Position[][]): number {
  return geoArea({ type: 'Polygon', coordinates: rings })
}

/**
 * Force ring orientation to the **d3-geo spherical convention**: exterior rings
 * clockwise, holes counterclockwise.
 *
 * This is deliberately the *opposite* of RFC 7946, and the mismatch is the single
 * most expensive trap in this file, so it is worth stating precisely.
 *
 * - **RFC 7946** (the GeoJSON interchange spec) requires exterior rings
 *   counterclockwise. Most published GeoJSON follows it, loosely.
 * - **d3-geo** treats polygons as spherical, where a ring divides the sphere into
 *   two parts and winding decides which part is inside: the interior lies to the
 *   right of the traversal direction, so an exterior ring smaller than a
 *   hemisphere must be **clockwise**.
 *
 * Feed a counterclockwise ring to d3-geo and it renders the entire sphere minus
 * your polygon. The visible symptom is a fully-filled map, or every feature
 * reporting identical whole-world bounds and centroids, which silently breaks
 * label anchors, tooltip positions and `frameFeature`. Nothing throws.
 *
 * Note that geometry authored for d3 (world-atlas, us-atlas, anything built with
 * `topojson` for a d3 pipeline) is already correct and must be left alone. That
 * is why the test is "does this ring enclose more than half the sphere" rather
 * than a planar orientation check: it is idempotent, and it agrees with the
 * renderer by construction. Its one limitation is that a legitimately
 * larger-than-hemisphere polygon (an ocean or whole-sphere backdrop) reads as
 * inside-out; pass `geo.repairWinding: false` for those.
 *
 * Copy-on-write: the caller's arrays are never mutated, and nothing is cloned
 * unless it actually needs reversing, so already-correct geometry allocates
 * nothing and a continent-sized dataset is not deep-copied. Mutating the input
 * would be marginally cheaper and is not worth it, because geometry objects get
 * shared between several maps on one dashboard, cached in a module, or frozen,
 * and repairing one map's winding must not change another's.
 *
 * @param polygon Array of rings, exterior first.
 */
function rewindPolygon(polygon: Position[][]): {
  rings: Position[][]
  fixed: number
} {
  if (!polygon || !polygon.length) return { rings: polygon, fixed: 0 }

  // No real-world feature covers more than half the globe, so a polygon that
  // measures larger than a hemisphere is inside-out. Reversing every ring flips
  // exteriors and holes together, which is exactly what is needed and keeps the
  // operation idempotent: geometry already authored for d3 measures small and is
  // returned untouched.
  if (polygonArea(polygon) <= HEMISPHERE) return { rings: polygon, fixed: 0 }

  return {
    rings: polygon.map((ring) => (ring?.length ? ring.slice().reverse() : ring)),
    fixed: polygon.length,
  }
}

/** Returns a new geometry object only when a ring was actually reversed. */
function rewindGeometry(geometry: Geometry | undefined): {
  geometry: Geometry | undefined
  fixed: number
} {
  if (!geometry) return { geometry, fixed: 0 }

  switch (geometry.type) {
    case 'Polygon': {
      const { rings, fixed } = rewindPolygon(geometry.coordinates || [])
      return fixed
        ? { geometry: { ...geometry, coordinates: rings }, fixed }
        : { geometry, fixed: 0 }
    }
    case 'MultiPolygon': {
      let fixed = 0
      const polygons = (geometry.coordinates || []).map((p: Position[][]) => {
        const result = rewindPolygon(p)
        fixed += result.fixed
        return result.rings
      })
      return fixed
        ? { geometry: { ...geometry, coordinates: polygons }, fixed }
        : { geometry, fixed: 0 }
    }
    case 'GeometryCollection': {
      let fixed = 0
      const geometries = (geometry.geometries || []).flatMap((g: Geometry) => {
        const result = rewindGeometry(g)
        fixed += result.fixed
        return result.geometry ? [result.geometry] : []
      })
      return fixed ? { geometry: { ...geometry, geometries }, fixed } : { geometry, fixed: 0 }
    }
    default:
      return { geometry, fixed: 0 }
  }
}

/**
 * Choose which object inside a TopoJSON topology to render.
 *
 */
function pickTopoObject(topology: any, requested?: string): string {
  const names = Object.keys(topology.objects || {})
  if (!names.length) throw new Error('ApexMaps: TopoJSON topology has no objects')
  if (requested) {
    if (!names.includes(requested)) {
      throw new Error(
        `ApexMaps: TopoJSON object "${requested}" not found. Available: ${names.join(', ')}`,
      )
    }
    return requested
  }
  if (names.length === 1) return names[0]
  // Prefer the conventional thematic object over land/borders meshes.
  const preferred = ['countries', 'states', 'counties', 'regions', 'districts', 'municipalities']
  for (const p of preferred) if (names.includes(p)) return p
  return names[0]
}

/** Raw GeoJSON features, whatever wrapper they arrived in. */
function toFeatureArray(input: any): Feature[] {
  if (Array.isArray(input)) return input
  if (!input || typeof input !== 'object') {
    throw new TypeError('ApexMaps: geo.map must be GeoJSON, TopoJSON, or an array of features')
  }
  if (input.type === 'FeatureCollection') return input.features || []
  if (input.type === 'Feature') return [input]
  if (input.type === 'GeometryCollection') {
    return (input.geometries || []).map((g: Geometry) => ({
      type: 'Feature' as const,
      properties: {},
      geometry: g,
    }))
  }
  if (typeof input.type === 'string') {
    // A bare geometry.
    return [{ type: 'Feature', properties: {}, geometry: input }]
  }
  throw new TypeError(`ApexMaps: unrecognised geo input of type "${input.type}"`)
}

/**
 * Normalize any supported geometry input.
 *
 */
export function normalizeGeo(
  input: GeoInput | null | undefined,
  options: {
    keyField?: string
    nameField?: string
    object?: string
    repairWinding?: boolean
  } = {},
): NormalizedGeo {
  const { keyField, nameField, object, repairWinding = true } = options
  const warnings: string[] = []

  let source: 'geojson' | 'topojson' = 'geojson'
  let objectName: string | undefined
  let rawFeatures: Feature[]

  if (input && (input as { type?: string }).type === 'Topology') {
    source = 'topojson'
    const topology = input as any
    objectName = pickTopoObject(topology, object)
    const converted = topoFeature(topology, topology.objects[objectName]) as any
    rawFeatures = converted.type === 'FeatureCollection' ? converted.features : [converted]
  } else {
    rawFeatures = toFeatureArray(input)
  }

  if (!rawFeatures.length) {
    warnings.push('geometry contained zero features')
  }

  const sampleProps = (rawFeatures.find((f) => f && f.properties)?.properties ?? {}) as Record<
    string,
    unknown
  >
  const resolvedKeyField =
    keyField ||
    firstPresent(sampleProps, KEY_CANDIDATES) ||
    (rawFeatures[0]?.id != null ? '$id' : '')
  const resolvedNameField = nameField || firstPresent(sampleProps, NAME_CANDIDATES)

  if (!keyField && resolvedKeyField && resolvedKeyField !== '$id') {
    // Not a warning: auto-detection is expected. Recorded so join diagnostics
    // can name the field it used.
  }
  // Geometry with no properties at all is a backdrop (a coastline, a nation
  // outline), and telling its author to pass a join key is wrong advice. Warn only
  // when there were properties to choose from and none of them worked.
  if (!resolvedKeyField && Object.keys(sampleProps).length > 0) {
    warnings.push(
      'no join key could be resolved from geometry properties; pass geo.keyField or joinBy to set one explicitly',
    )
  }

  let rewound = 0
  const features: NormalizedFeature[] = new Array(rawFeatures.length)

  for (let i = 0; i < rawFeatures.length; i++) {
    const raw = rawFeatures[i]
    const properties = (raw?.properties ?? {}) as Record<string, unknown>

    let geometry: Geometry | null | undefined = raw?.geometry
    if (repairWinding) {
      const result = rewindGeometry(geometry)
      geometry = result.geometry
      rewound += result.fixed
    }

    const rawKey =
      resolvedKeyField === '$id'
        ? raw?.id
        : resolvedKeyField
          ? (properties[resolvedKeyField] ?? raw?.id)
          : raw?.id

    const resolvedName = resolvedNameField ? properties[resolvedNameField] : undefined

    features[i] = {
      key: rawKey == null ? '' : String(rawKey),
      name: resolvedName == null ? undefined : String(resolvedName),
      geometry: geometry ?? null,
      properties,
      index: i,
      raw,
    }
  }

  if (rewound > 0) {
    warnings.push(
      `repaired winding order on ${rewound} ring(s) to the spherical convention (exterior clockwise). ` +
        'Unrepaired counterclockwise rings render as the whole sphere minus the polygon. ' +
        'Set geo.repairWinding: false to disable.',
    )
  }

  const dupes = findDuplicateKeys(features)
  if (dupes.length) {
    warnings.push(
      `duplicate join keys in geometry: ${dupes.slice(0, 5).join(', ')}${dupes.length > 5 ? `, +${dupes.length - 5} more` : ''}. ` +
        'Data rows will bind to the last matching feature.',
    )
  }

  return {
    features,
    // Built from the repaired geometry, not the raw input: d3-geo's fitExtent and
    // bounds interpret a reversed ring as "the rest of the sphere", so fitting
    // against unrepaired input would zoom the map to the whole world.
    collection: {
      type: 'FeatureCollection',
      features: features.map((f) => ({
        type: 'Feature' as const,
        id: (f.raw as { id?: string | number } | undefined)?.id,
        properties: f.properties,
        geometry: f.geometry,
      })),
    },
    keyField: resolvedKeyField || '',
    nameField: resolvedNameField,
    source,
    objectName,
    warnings,
  }
}

function findDuplicateKeys(features: NormalizedFeature[]): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const f of features) {
    if (!f.key) continue
    if (seen.has(f.key)) dupes.add(f.key)
    else seen.add(f.key)
  }
  return [...dupes]
}

/** Build a lookup of key to feature. */
export function indexByKey(features: NormalizedFeature[]): Map<string, NormalizedFeature> {
  const map = new Map<string, NormalizedFeature>()
  for (const f of features) if (f.key) map.set(f.key, f)
  return map
}
