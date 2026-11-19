/**
 * Corrections to upstream geometry, applied by the pipeline before anything is
 * built, so a rebuild from a fresh download keeps them.
 *
 * Natural Earth is right far more often than not, and these are not editorial
 * changes: each entry fixes an island that the source assigns to the wrong
 * subdivision, against a fact an authority states, with that authority cited.
 * A boundary view (disputed areas, de facto control) is never "corrected" here;
 * that is what the provenance profile's `boundaries` string is for.
 *
 * **How an island is identified.** By a point on land, not by its index in the
 * source MultiPolygon or by a bounding box. Indices shift whenever upstream
 * touches the file. A box is fragile: the Amami islands span 128.40 to 130.03 E
 * and 27.02 to 28.51 N, and Iotorishima, which really is Okinawa, sits inside
 * that latitude band at 128.23 E, about 15 km west of the box's edge, so a box
 * padded to round degrees round Amami takes it in too. A point names one island
 * and nothing else, and it is checkable against any map.
 *
 * **What happens when upstream changes.** Every point must land in exactly one
 * polygon of the feature it is moved *from*. If it lands in the feature it is
 * moved *to*, upstream has fixed the error and the entry should be deleted; if
 * it lands nowhere, the source has changed shape and the entry needs a fresh
 * look. Both stop the build rather than quietly shipping a half-applied fix.
 *
 * The audit behind the Japanese entries, and the islands it cleared, is written
 * up in `geo/README.md` under "Corrections".
 */

/**
 * Admin-1 corrections, by ISO 3166-1 alpha-2 country code. Keys are the
 * `iso_3166_2` codes the packs are joined on.
 */
export const ADMIN1_CORRECTIONS = {
  JP: [
    {
      from: 'JP-47',
      to: 'JP-46',
      summary:
        'The Amami Islands (Amami Oshima, Kakeromajima, Kikaijima, Tokunoshima, ' +
        'Okinoerabujima and Yoronjima) moved from Okinawa (JP-47) to Kagoshima (JP-46)',
      reason:
        'The Amami Islands are Amami City and Oshima District of Kagoshima Prefecture, ' +
        "administered by the prefecture's Oshima branch office, which lists them with " +
        'Ukejima and Yorojima (too small to appear at 1:10m). Natural Earth 5.1.1 ' +
        'draws them inside Okinawa, which colours them with Okinawa and stretches ' +
        "Okinawa's bounds from 27.9 N to 28.5 N.",
      source: 'Kagoshima Prefecture, Oshima branch office: https://www.pref.kagoshima.jp/aq01/chiiki/oshima/',
      islands: [
        { name: 'Amami Oshima', point: [129.32, 28.3] },
        { name: 'Kakeromajima', point: [129.25, 28.13] },
        { name: 'Kikaijima', point: [129.97, 28.32] },
        { name: 'Tokunoshima', point: [128.96, 27.8] },
        { name: 'Okinoerabujima', point: [128.6, 27.38] },
        { name: 'Yoronjima', point: [128.42, 27.04] },
      ],
    },
    {
      from: 'JP-43',
      to: 'JP-46',
      summary: 'Nagashima and Shishijima moved from Kumamoto (JP-43) to Kagoshima (JP-46)',
      reason:
        'Nagashima and Shishijima make up most of Nagashima Town, Izumi District, ' +
        'Kagoshima Prefecture. Natural Earth 5.1.1 draws both inside Kumamoto, whose ' +
        'Amakusa islands lie a few kilometres to the north.',
      source:
        'Nagashima Town, Izumi District, Kagoshima Prefecture: https://www.town.nagashima.lg.jp/ ' +
        'and the Kagoshima Prefecture remote islands promotion plan, which places Shishijima in ' +
        'Nagashima Town: https://www.pref.kagoshima.jp/ac07/documents/33648_20230523104400-1.pdf',
      islands: [
        { name: 'Nagashima', point: [130.15, 32.17] },
        { name: 'Shishijima', point: [130.24, 32.28] },
      ],
    },
  ],
}

/** Even-odd ray cast against one ring. Planar is exact enough at island scale. */
function inRing([x, y], ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** True when the point is in the polygon's outer ring and in none of its holes. */
export function polygonContains(polygon, point) {
  if (!inRing(point, polygon[0])) return false
  for (let h = 1; h < polygon.length; h++) if (inRing(point, polygon[h])) return false
  return true
}

function polygonsOf(geometry) {
  if (!geometry) return []
  if (geometry.type === 'Polygon') return [geometry.coordinates]
  if (geometry.type === 'MultiPolygon') return geometry.coordinates
  return []
}

function asGeometry(polygons) {
  return polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons }
}

/**
 * Apply corrections to a feature array and return a new one. Features the
 * corrections do not touch are passed through by reference; the two a
 * correction moves polygons between are replaced with shallow copies, so the
 * parsed source shared with other packs is never mutated.
 *
 * Moved polygons are appended to the receiving feature, so the order of every
 * polygon already there is unchanged.
 *
 * @param {object[]} features GeoJSON features
 * @param {object[]} corrections entries in the shape of `ADMIN1_CORRECTIONS.JP`
 * @param {(props: object) => unknown} keyOf reads a feature's subdivision code
 * @returns {{ features: object[], applied: string[] }}
 */
export function applyCorrections(features, corrections, keyOf) {
  if (!corrections?.length) return { features, applied: [] }

  const out = features.slice()
  const indexOf = new Map()
  out.forEach((feature, i) => {
    const key = keyOf(feature.properties ?? {})
    if (key !== undefined) indexOf.set(key, i)
  })

  const applied = []
  for (const correction of corrections) {
    const { from, to } = correction
    if (!indexOf.has(from)) throw new Error(`correction ${from} -> ${to}: no feature keyed ${from}`)
    if (!indexOf.has(to)) throw new Error(`correction ${from} -> ${to}: no feature keyed ${to}`)

    const source = out[indexOf.get(from)]
    const target = out[indexOf.get(to)]
    const sourcePolygons = polygonsOf(source.geometry)
    const targetPolygons = polygonsOf(target.geometry)

    const moving = new Set()
    for (const island of correction.islands) {
      const hits = sourcePolygons.flatMap((p, i) => (polygonContains(p, island.point) ? [i] : []))
      if (hits.length === 1) {
        if (moving.has(hits[0])) {
          throw new Error(
            `correction ${from} -> ${to}: ${island.name} is the same polygon as another listed island`,
          )
        }
        moving.add(hits[0])
        continue
      }
      if (hits.length > 1) {
        throw new Error(`correction ${from} -> ${to}: ${island.name} matches ${hits.length} polygons`)
      }
      const fixedUpstream = targetPolygons.some((p) => polygonContains(p, island.point))
      throw new Error(
        fixedUpstream
          ? `correction ${from} -> ${to}: ${island.name} is already in ${to} upstream; delete this correction`
          : `correction ${from} -> ${to}: ${island.name} at ${island.point.join(', ')} is in no polygon of ${from}; the source changed shape, re-audit`,
      )
    }

    const keep = sourcePolygons.filter((_, i) => !moving.has(i))
    if (!keep.length) throw new Error(`correction ${from} -> ${to}: would leave ${from} empty`)
    const moved = sourcePolygons.filter((_, i) => moving.has(i))

    out[indexOf.get(from)] = { ...source, geometry: asGeometry(keep) }
    out[indexOf.get(to)] = { ...target, geometry: asGeometry([...targetPolygons, ...moved]) }
    applied.push(correction.summary)
  }

  return { features: out, applied }
}
