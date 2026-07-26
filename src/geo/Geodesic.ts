/**
 * Great-circle helpers for arc and route marks.
 *
 * Why this exists rather than drawing straight lines: a straight segment between
 * two points on a projected map is not the path anything travels. Tokyo to New
 * York arcs over the Arctic; in Web Mercator the true route looks like a curve
 * bending sharply north, and a straight line between the two is both wrong and
 * misleadingly long. Many libraries draw the straight line and hope
 * (PRODUCT-RESEARCH.md section 4.12).
 *
 * The output is a GeoJSON LineString in lon/lat, deliberately, so that d3-geo's
 * own clipping and antimeridian cutting handle the hard cases: a Tokyo to Los
 * Angeles arc crossing the antimeridian is split into two rendered segments
 * automatically instead of streaking back across the whole map.
 *
 * @module geo/Geodesic
 */

import { geoInterpolate, geoDistance } from 'd3-geo'
import type { LineString } from 'geojson'
import type { LonLat, WorldPoint } from '../types'

const DEG = 180 / Math.PI

/**
 * Angular distance between two points, in degrees along a great circle.
 */
export function angularDistance(from: LonLat, to: LonLat): number {
  return geoDistance(from, to) * DEG
}

/**
 * How many intermediate points a geodesic needs.
 *
 * Scaled by arc length so a 200 km hop is not sampled as densely as a
 * trans-Pacific route, and clamped so neither end degenerates: too few points
 * makes a great circle look like a polyline, too many wastes memory on every arc
 * in a 5,000-route network.
 */
export function segmentsFor(degrees: number, { min = 8, max = 96, perDegree = 0.6 } = {}): number {
  if (!Number.isFinite(degrees) || degrees <= 0) return min
  return Math.max(min, Math.min(max, Math.ceil(degrees * perDegree)))
}

/**
 * Sample a great circle between two points.
 *
 * Returns lon/lat coordinates including both endpoints.
 */
export function greatCircle(from: LonLat, to: LonLat, segments?: number): LonLat[] {
  const distance = angularDistance(from, to)

  // Coincident endpoints have no defined great circle; return a degenerate
  // two-point line so callers do not have to special-case it.
  if (distance < 1e-9) return [from, to]

  const n = segments ?? segmentsFor(distance)
  const interpolate = geoInterpolate(from, to)
  const out: LonLat[] = new Array(n + 1)
  for (let i = 0; i <= n; i++) out[i] = interpolate(i / n) as LonLat
  return out
}

/**
 * A great circle as a GeoJSON LineString, ready to hand to a d3 path generator.
 */
export function greatCircleLine(from: LonLat, to: LonLat, segments?: number): LineString {
  return { type: 'LineString', coordinates: greatCircle(from, to, segments) }
}

/**
 * The midpoint of a great circle, useful for anchoring a tooltip or a label on an
 * arc.
 */
export function greatCircleMidpoint(from: LonLat, to: LonLat): LonLat {
  return geoInterpolate(from, to)(0.5) as LonLat
}

/**
 * A quadratic bezier through world space, bulging perpendicular to the chord.
 *
 * This is the decorative alternative to a true geodesic, and it is worth being
 * explicit that it is decorative: the curve is not a path anything follows, and
 * its height carries no meaning. It reads well for hub-and-spoke marketing maps
 * and for keeping many parallel routes visually distinguishable, which is why it
 * is offered at all.
 *
 * The bulge is always drawn to the same side of the chord (left, in screen terms)
 * so that a set of arcs fans consistently instead of alternating.
 *
 * @param curvature 0 is a straight chord; 0.3 is a gentle arc; 1 is extreme.
 */
export function bezierArc(from: WorldPoint, to: WorldPoint, curvature: number): string {
  const [x0, y0] = from
  const [x1, y1] = to
  if (!curvature) return `M${x0},${y0}L${x1},${y1}`

  const dx = x1 - x0
  const dy = y1 - y0
  const length = Math.hypot(dx, dy)
  if (length < 1e-6) return `M${x0},${y0}L${x1},${y1}`

  const mx = (x0 + x1) / 2
  const my = (y0 + y1) / 2
  // Perpendicular offset, scaled by chord length so long arcs bulge more.
  const offset = length * curvature * 0.5
  const cx = mx + (dy / length) * offset
  const cy = my - (dx / length) * offset

  return `M${x0},${y0}Q${cx},${cy} ${x1},${y1}`
}

/**
 * Total length of a projected polyline in world pixels, used to seed
 * stroke-dasharray for draw-on animations.
 */
export function polylineLength(points: WorldPoint[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
  }
  return total
}
