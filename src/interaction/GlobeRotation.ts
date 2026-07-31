/**
 * Globe dragging: a drag on an orthographic spins the sphere.
 *
 * Panning a globe is the wrong gesture. It slides a picture of the earth around
 * inside its box, leaves the far hemisphere permanently unreachable, and offers
 * the reader nothing they could not get by scrolling the page. Rotation is the
 * gesture the shape promises, so on a globe the drag belongs here rather than to
 * `ZoomPan`.
 *
 * The rotation is **versor-based** (see `geo/Versor`): the point the reader
 * grabbed stays under the cursor for the whole drag, at any latitude, however
 * far the globe has already turned. Accumulating Euler angles instead is the
 * cheap version, and it reads as cheap: near the poles a horizontal drag whips
 * the sphere around, because a degree of longitude there is worth almost no
 * surface.
 *
 * Two details that a naive implementation gets wrong and this one does not:
 *
 * - **Dragging off the disc keeps working.** Outside the globe's edge there is no
 *   point to grab, so versor has nothing to solve for. Rather than freeze, the
 *   drag falls back to angular stepping, which is what the reader expects when
 *   they fling the cursor past the limb.
 * - **Longitude wraps.** The spin runs through 360 degrees and out the other
 *   side, so nothing stops at the antimeridian.
 *
 * @module interaction/GlobeRotation
 */

import { cartesian, delta, multiply, rotation, versor } from '../geo/Versor'
import type { Quaternion, Cartesian, Rotation } from '../geo/Versor'
import { prefersReducedMotion } from '../utils/motion'
import type { Viewport } from '../geo/Viewport'
import type { InteractionOptions, ScreenPoint } from '../types'

const INERTIA_FRICTION = 0.92
/** Degrees per frame below which a spin has visually stopped. */
const INERTIA_MIN_SPEED = 0.02
/** Cap on a fling, so a fast flick spins fast rather than absurdly. */
const MAX_SPIN_DEGREES = 12
const DEGREES_PER_RADIAN = 180 / Math.PI

export class GlobeRotation {
  readonly viewport: Viewport
  /** Reassigned by the host when `updateOptions` changes the interaction tree. */
  options: InteractionOptions
  readonly onChange: () => void
  readonly onEnd: () => void

  /** Rotation and orientation at the moment the drag started. */
  private _r0: Rotation | null = null
  private _q0: Quaternion | null = null
  /** The grabbed point on the unit sphere. Null when the drag began off the disc. */
  private _v0: Cartesian | null = null
  private _last: ScreenPoint = [0, 0]
  private _spin: [number, number] = [0, 0]
  private _raf: number | null = null
  /** Whether this gesture actually turned anything, so a click stays a click. */
  private _turned = false

  constructor({
    viewport,
    options,
    onChange,
    onEnd,
  }: {
    viewport: Viewport
    options: InteractionOptions
    /** Called after every applied rotation, so the host can redraw. */
    onChange: () => void
    /** Called once the globe comes to rest, after any glide. */
    onEnd?: () => void
  }) {
    this.viewport = viewport
    this.options = options
    this.onChange = onChange
    this.onEnd = onEnd ?? (() => {})
  }

  /**
   * Whether a drag should spin rather than pan.
   *
   * `'auto'` (the default) means "on a globe, yes", and defers to
   * `pan.enabled: false`, because a caller who turned dragging off meant it and
   * should not be handed a different drag gesture in its place. `true` forces
   * rotation on any projection that can rotate and invert, which is how a
   * stereographic or azimuthal view opts in.
   */
  get enabled(): boolean {
    if (!this.viewport.rotatable) return false
    const wanted = this.options.rotate?.enabled ?? 'auto'
    if (wanted === false) return false
    if (wanted === true) return true
    return this.viewport.isGlobeView && this.options.pan?.enabled !== false
  }

  get spinning(): boolean {
    return this._raf !== null
  }

  /** Grab the sphere at a screen point. */
  start(point: ScreenPoint): void {
    this.stop()
    const r0 = this.viewport.rotation
    this._r0 = [r0[0], r0[1], r0[2]]
    this._q0 = versor(this._r0)
    this._v0 = this._grab(point)
    this._last = point
    this._spin = [0, 0]
    this._turned = false
  }

  /** Continue a drag. Returns false when there was nothing to rotate. */
  move(point: ScreenPoint): boolean {
    if (!this._r0 || !this._q0) return false
    const before = this.viewport.rotation

    if (this._v0) {
      // Invert against the rotation in force when the point was grabbed: the two
      // vectors have to be expressed in the same frame or the delta is measured
      // against a sphere that has already moved, and the drag accelerates away.
      const v1 = this._grab(point, this._r0)
      if (v1) {
        this._apply(rotation(multiply(this._q0, delta(this._v0, v1))), before)
        this._last = point
        return true
      }
    }

    // Off the disc (or the drag started there). Step by angle instead, scaled so
    // a pixel near the centre of the globe is worth what it would have been worth
    // under versor, and re-anchor: the moment the cursor comes back over the
    // sphere the precise gesture resumes from wherever the globe now is.
    const radius = this._radius()
    const sensitivity = radius > 0.5 ? DEGREES_PER_RADIAN / radius : 0.25
    const dx = point[0] - this._last[0]
    const dy = point[1] - this._last[1]
    this._apply(
      [before[0] + dx * sensitivity, clamp(before[1] - dy * sensitivity, -90, 90), before[2]],
      before,
    )
    this._last = point
    this._reanchor(point)
    return true
  }

  /** Let go, gliding to a stop unless inertia is off. */
  release(): void {
    this._r0 = null
    this._q0 = null
    this._v0 = null

    // A press that never moved is a click on the map, not a spin, and must not
    // announce the end of one.
    if (!this._turned) {
      this._spin = [0, 0]
      return
    }

    const inertia = this.options.rotate?.inertia ?? this.options.pan?.inertia ?? true
    if (!inertia || prefersReducedMotion() || typeof requestAnimationFrame === 'undefined') {
      this._spin = [0, 0]
      this.onEnd()
      return
    }

    let [dl, dp] = this._spin
    if (Math.hypot(dl, dp) < INERTIA_MIN_SPEED) {
      this.onEnd()
      return
    }

    // What the glide last wrote. A glide is the one rotation that nobody
    // explicitly ends, so it has to notice when it has been overruled: a camera
    // `flyTo` fired while the globe is still coasting sets absolute angles every
    // frame, and a glide that kept adding its own delta on top would drag the
    // flight off course. Whoever moved the sphere last wins, and it is not this.
    let written = this.viewport.rotation

    const step = () => {
      dl *= INERTIA_FRICTION
      dp *= INERTIA_FRICTION
      const r = this.viewport.rotation
      if (Math.hypot(dl, dp) < INERTIA_MIN_SPEED || r !== written) {
        this._raf = null
        this.onEnd()
        return
      }
      this.viewport.setRotation([r[0] + dl, clamp(r[1] + dp, -90, 90), r[2]])
      written = this.viewport.rotation
      this.onChange()
      this._raf = requestAnimationFrame(step)
    }
    this._raf = requestAnimationFrame(step)
  }

  /** Halt a glide in place. Called before any new gesture. */
  stop(): void {
    if (this._raf !== null) {
      cancelAnimationFrame(this._raf)
      this._raf = null
      this.onEnd()
    }
  }

  /** The point on the unit sphere under a screen position, if there is one. */
  private _grab(point: ScreenPoint, underRotation?: Rotation): Cartesian | null {
    const projection = this.viewport.projection
    if (!projection || typeof projection.rotate !== 'function') return null

    // Probe through the projection directly rather than `setRotation`, so the
    // viewport's mirrored rotation is never momentarily untrue. Nothing renders
    // between these two lines.
    const current = this.viewport.rotation
    if (underRotation) projection.rotate(underRotation)
    const lonLat = this.viewport.screenToLonLat(point)
    if (underRotation) projection.rotate(current)

    return lonLat ? cartesian(lonLat) : null
  }

  /**
   * Re-establish the grab after an angular step, so a drag can cross the limb in
   * either direction without a discontinuity.
   */
  private _reanchor(point: ScreenPoint): void {
    const r = this.viewport.rotation
    this._r0 = [r[0], r[1], r[2]]
    this._q0 = versor(this._r0)
    this._v0 = this._grab(point)
  }

  /** The globe's on-screen radius in pixels, camera zoom included. */
  private _radius(): number {
    const projection = this.viewport.projection
    if (!projection || typeof projection.scale !== 'function') return 0
    return Math.abs(projection.scale()) * (this.viewport.camera.k || 1)
  }

  /** Apply a rotation and record what it was worth, for inertia. */
  private _apply(next: Rotation, before: Rotation): void {
    this.viewport.setRotation(next)
    const after = this.viewport.rotation
    this._spin = [
      clamp(shortestDelta(before[0], after[0]), -MAX_SPIN_DEGREES, MAX_SPIN_DEGREES),
      clamp(after[1] - before[1], -MAX_SPIN_DEGREES, MAX_SPIN_DEGREES),
    ]
    // A press with no travel still solves for a rotation, and it solves for the
    // one already in force. Redrawing on that would reproject the whole map for
    // every click on the globe, so nothing below this line runs unless the
    // sphere actually moved. The threshold is float noise, orders of magnitude
    // below anything visible.
    if (Math.abs(this._spin[0]) < 1e-6 && Math.abs(this._spin[1]) < 1e-6) return
    this._turned = true
    this.onChange()
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Signed longitude difference, taking the short way around the antimeridian. */
function shortestDelta(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180
}
