/**
 * Quaternion helpers for globe dragging.
 *
 * A projection's rotation is three Euler angles, and interpolating or
 * accumulating those directly is what produces the "sticky globe": drag left
 * near the pole and the sphere slides sideways instead of following the cursor,
 * because a longitude step is worth a different amount of surface at every
 * latitude. Quaternions have no such preferred axis, so "turn the sphere by
 * whatever rotation carries the point I grabbed to the point I am now over" is
 * a single well-defined operation.
 *
 * The algorithm is Bostock and Davies' versor drag. Kept here rather than taken
 * from the `versor` package: it is forty lines, and this way globe rotation adds
 * nothing to the dependency tree.
 *
 * @module geo/Versor
 */

/** A unit quaternion, `[w, x, y, z]`. */
export type Quaternion = [number, number, number, number]

/** A point on the unit sphere in Cartesian coordinates. */
export type Cartesian = [number, number, number]

/** Projection rotation, `[lambda, phi, gamma]` in degrees. */
export type Rotation = [number, number, number]

const RADIANS = Math.PI / 180
const DEGREES = 180 / Math.PI

/** The quaternion equivalent to a projection's `[lambda, phi, gamma]`. */
export function versor([lambda, phi, gamma]: Rotation): Quaternion {
  const l = (lambda / 2) * RADIANS
  const p = (phi / 2) * RADIANS
  const g = (gamma / 2) * RADIANS
  const sl = Math.sin(l)
  const cl = Math.cos(l)
  const sp = Math.sin(p)
  const cp = Math.cos(p)
  const sg = Math.sin(g)
  const cg = Math.cos(g)
  return [
    cl * cp * cg + sl * sp * sg,
    sl * cp * cg - cl * sp * sg,
    cl * sp * cg + sl * cp * sg,
    cl * cp * sg - sl * sp * cg,
  ]
}

/** A lon/lat pair in degrees as a point on the unit sphere. */
export function cartesian([lon, lat]: [number, number]): Cartesian {
  const l = lon * RADIANS
  const p = lat * RADIANS
  const cp = Math.cos(p)
  return [cp * Math.cos(l), cp * Math.sin(l), Math.sin(p)]
}

/** The `[lambda, phi, gamma]` a projection would need to apply this quaternion. */
export function rotation(q: Quaternion): Rotation {
  return [
    Math.atan2(2 * (q[0] * q[1] + q[2] * q[3]), 1 - 2 * (q[1] * q[1] + q[2] * q[2])) * DEGREES,
    Math.asin(Math.max(-1, Math.min(1, 2 * (q[0] * q[2] - q[3] * q[1])))) * DEGREES,
    Math.atan2(2 * (q[0] * q[3] + q[1] * q[2]), 1 - 2 * (q[2] * q[2] + q[3] * q[3])) * DEGREES,
  ]
}

/**
 * The shortest rotation carrying `v0` to `v1`: the great-circle arc between
 * them, taken about the axis perpendicular to both.
 *
 * Returns the identity when the two points coincide (or are exactly antipodal,
 * where the axis is undefined and any answer would be arbitrary).
 */
export function delta(v0: Cartesian, v1: Cartesian): Quaternion {
  const w: Cartesian = [
    v0[1] * v1[2] - v0[2] * v1[1],
    v0[2] * v1[0] - v0[0] * v1[2],
    v0[0] * v1[1] - v0[1] * v1[0],
  ]
  const l = Math.sqrt(w[0] * w[0] + w[1] * w[1] + w[2] * w[2])
  if (!l) return [1, 0, 0, 0]
  const dot = v0[0] * v1[0] + v0[1] * v1[1] + v0[2] * v1[2]
  const t = Math.acos(Math.max(-1, Math.min(1, dot))) / 2
  const s = Math.sin(t)
  return [Math.cos(t), (w[2] / l) * s, (-w[1] / l) * s, (w[0] / l) * s]
}

/**
 * Interpolate between two orientations along the shortest arc, at constant
 * angular speed.
 *
 * This is what a camera move to a new sub-observer point has to use. Lerping
 * `[lambda, phi]` component-wise instead looks correct in a diagram and wrong on
 * screen: the two angles are not independent, so the sphere wobbles as one
 * outruns the other, a move across the antimeridian takes the long way round
 * unless the caller unwraps by hand, and a move over a pole swings out sideways
 * because longitude has to travel 180 degrees while latitude travels none.
 *
 * Quaternions double-cover rotations (`q` and `-q` are the same orientation), so
 * the sign is chosen to keep the arc under 180 degrees. Near-parallel inputs
 * fall back to a normalised lerp, where the great-circle formula divides by a
 * sine approaching zero.
 */
export function slerp(q0: Quaternion, q1: Quaternion, t: number): Quaternion {
  let dot = q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3]
  let end = q1
  if (dot < 0) {
    end = [-q1[0], -q1[1], -q1[2], -q1[3]]
    dot = -dot
  }

  let w0 = 1 - t
  let w1 = t
  if (dot < 0.9995) {
    const theta = Math.acos(Math.min(1, dot))
    const sin = Math.sin(theta)
    w0 = Math.sin((1 - t) * theta) / sin
    w1 = Math.sin(t * theta) / sin
  }

  return normalise([
    q0[0] * w0 + end[0] * w1,
    q0[1] * w0 + end[1] * w1,
    q0[2] * w0 + end[2] * w1,
    q0[3] * w0 + end[3] * w1,
  ])
}

function normalise(q: Quaternion): Quaternion {
  const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3])
  return l ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [1, 0, 0, 0]
}

/** Compose two rotations: `q0` then `q1`. */
export function multiply(q0: Quaternion, q1: Quaternion): Quaternion {
  return [
    q0[0] * q1[0] - q0[1] * q1[1] - q0[2] * q1[2] - q0[3] * q1[3],
    q0[0] * q1[1] + q0[1] * q1[0] + q0[2] * q1[3] - q0[3] * q1[2],
    q0[0] * q1[2] - q0[1] * q1[3] + q0[2] * q1[0] + q0[3] * q1[1],
    q0[0] * q1[3] + q0[1] * q1[2] - q0[2] * q1[1] + q0[3] * q1[0],
  ]
}
