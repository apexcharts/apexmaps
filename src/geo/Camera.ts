/**
 * Camera controller.
 *
 * Cinematic semantics on purpose: `flyTo` follows the Van Wijk and Nuij (2003)
 * smooth-and-efficient zoom-and-pan path, which arcs out to a wider zoom during
 * long moves. Linear interpolation of centre and scale feels wrong because
 * perceived motion is logarithmic in scale, and that difference is what
 * separates a camera that reads as cinematic from one that reads as a slideshow.
 *
 * Every move is **interruptible and retargeting**: a new move starts from the
 * current interpolated state rather than queueing or snapping, because in a
 * scroll-driven story the reader can outrun the animation at any moment.
 *
 * On an azimuthal projection a move to a `center` is a **rotation**, not a pan.
 * The camera is a screen-space transform and cannot reach the far side of a
 * globe by any amount of translating, so where `viewport.supportsRecentre()`
 * says so, the same `flyTo({ center })` turns the sphere instead. See
 * `_resolveMove`.
 *
 * @module geo/Camera
 */

import { geoDistance } from 'd3-geo'
import { prefersReducedMotion } from '../utils/motion'
import { resolveEase } from '../utils/easing'
import type { EasingFn } from '../utils/easing'
import { rotation as anglesOf, slerp, versor } from './Versor'
import type { Rotation } from './Versor'
import type { Viewport } from './Viewport'
import type { CameraState, LonLat, Padding, ScreenPoint, WorldBounds } from '../types'

/**
 * Everything a camera move can target. Mutually exclusive in practice: `bounds`
 * wins, then `center`, then a bare `zoom`, then raw `k`/`x`/`y`.
 */
export interface CameraTarget {
  /** Geographic centre. */
  center?: LonLat
  zoom?: number
  /** World-space box to frame. */
  bounds?: WorldBounds
  padding?: Padding
  maxZoom?: number
  /** Raw camera scale. Advanced; prefer `zoom`. */
  k?: number
  /** Raw camera translate. Advanced. */
  x?: number
  y?: number
}

export interface TransitionOptions {
  duration?: number
  ease?: string | EasingFn
}

export interface CameraOptions {
  minZoom?: number
  maxZoom?: number
  /** Divides the Van Wijk natural duration. Higher is faster. */
  speed?: number
  /** Van Wijk rho. Higher arcs out further; 0 disables the arc. */
  curve?: number
}

/** An interpolator carrying its own natural duration, in ms. */
export type ZoomInterpolator = ((t: number) => [number, number, number]) & {
  duration: number
}

/** Where a move ends up: a camera state, and on a globe a rotation too. */
interface ResolvedMove {
  camera: CameraState | null
  /** Null when the projection is not re-centred by rotating. */
  rotation: Rotation | null
}

const RHO_DEFAULT = Math.SQRT2

/**
 * Natural duration of a rotation, in ms per radian of great-circle travel.
 *
 * The rotation analogue of the Van Wijk path length: a nudge across a country
 * should not take as long as a flip to the other side of the planet, and the
 * caller should not have to work out which is which. Calibrated so a half-turn
 * (pi radians, the longest move there is) lands near 1.3 seconds at the default
 * speed, and short hops fall under the 240 ms floor every move already has.
 */
const ROTATE_MS_PER_RADIAN = 500

/**
 * The unhurried duration for turning from one place to another, before `speed`
 * and the floor are applied. Exported because it is the one number in a globe
 * move a caller might reasonably want to reason about, and because a duration
 * curve is far easier to pin in a test than a wall clock.
 */
export function rotationDuration(from: LonLat, to: LonLat): number {
  const radians = geoDistance(from, to)
  return Number.isFinite(radians) ? radians * ROTATE_MS_PER_RADIAN : 0
}

const cosh = (x: number) => ((x = Math.exp(x)) + 1 / x) / 2
const sinh = (x: number) => ((x = Math.exp(x)) - 1 / x) / 2
const tanh = (x: number) => ((x = Math.exp(2 * x)) - 1) / (x + 1)

/**
 * Van Wijk and Nuij (2003) zoom-and-pan interpolator.
 *
 * Operates on `[cx, cy, w]` triples where `cx,cy` is the world-space point at
 * the viewport centre and `w` is the world-space width visible in the viewport.
 * Returns an interpolator carrying its own natural `duration` in ms, which is
 * how a long move automatically takes longer than a short one.
 *
 * @param rho Curvature. Higher arcs out further; 0 disables the arc.
 */
export function interpolateZoom(
  p0: [number, number, number],
  p1: [number, number, number],
  rho = RHO_DEFAULT,
): ZoomInterpolator {
  const [ux0, uy0, w0] = p0
  const [ux1, uy1, w1] = p1
  const dx = ux1 - ux0
  const dy = uy1 - uy0
  const d2 = dx * dx + dy * dy
  const rho2 = rho * rho
  const rho4 = rho2 * rho2

  let interpolator: ZoomInterpolator

  if (d2 < 1e-12 || rho <= 0) {
    // Pure zoom (or arc disabled): geometric interpolation of scale.
    const S = Math.log(w1 / w0) / rho || 0
    interpolator = ((t: number) => [
      ux0 + t * dx,
      uy0 + t * dy,
      w0 * Math.exp(rho * t * S),
    ]) as ZoomInterpolator
    interpolator.duration = Math.abs(S) * 1000
  } else {
    const d1 = Math.sqrt(d2)
    const b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1)
    const b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1)
    const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0)
    const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1)
    const S = (r1 - r0) / rho
    interpolator = ((t: number) => {
      const s = t * S
      const coshr0 = cosh(r0)
      const u = (w0 / (rho2 * d1)) * (coshr0 * tanh(rho * s + r0) - sinh(r0))
      return [ux0 + u * dx, uy0 + u * dy, (w0 * coshr0) / cosh(rho * s + r0)]
    }) as ZoomInterpolator
    interpolator.duration = Math.abs(S) * 1000
  }

  return interpolator
}

export class Camera {
  readonly viewport: Viewport
  readonly onChange: () => void
  readonly onRotate: () => void
  options: Required<CameraOptions>
  private _raf: number | null = null
  private _resolve: (() => void) | null = null

  constructor({
    viewport,
    onChange,
    onRotate,
    options = {},
  }: {
    viewport: Viewport
    /** Called on every frame, after the camera has been mutated. */
    onChange: () => void
    /**
     * Called after the sphere has been turned, which unlike a camera change
     * invalidates every projected coordinate. Optional: a camera with no host
     * to redraw still computes the right rotation, it just draws nothing.
     */
    onRotate?: () => void
    options?: CameraOptions
  }) {
    this.viewport = viewport
    this.onChange = onChange
    this.onRotate = onRotate ?? (() => {})
    this.options = {
      minZoom: 0.5,
      maxZoom: 4096,
      speed: 1.2,
      curve: RHO_DEFAULT,
      ...options,
    }
  }

  get state(): CameraState {
    return this.viewport.camera
  }

  get animating(): boolean {
    return this._raf !== null
  }

  /**
   * Stop any in-flight move, leaving the camera wherever it is. Called by every
   * new move so transitions retarget instead of fighting.
   *
   */
  stop(): void {
    if (this._raf !== null) {
      cancelAnimationFrame(this._raf)
      this._raf = null
    }
    if (this._resolve) {
      const r = this._resolve
      this._resolve = null
      r()
    }
  }

  /**
   * Apply a camera state immediately, clamped to the zoom range.
   *
   */
  set(next: Partial<CameraState>): void {
    const cam = this.viewport.camera
    const k = clamp(next.k ?? cam.k, this.options.minZoom, this.options.maxZoom)
    cam.k = k
    cam.x = next.x ?? cam.x
    cam.y = next.y ?? cam.y
    this.onChange()
  }

  /**
   * Turn the sphere and tell the host to reproject.
   *
   * Separate from `set` because the two are different kinds of change: a camera
   * write is a transform on already-projected geometry, while this invalidates
   * the geometry itself.
   */
  private _rotate(angles: Rotation): void {
    this.viewport.setRotation(angles)
    this.onRotate()
  }

  /**
   * Jump with no animation.
   *
   */
  jumpTo(target: CameraTarget): void {
    this.stop()
    const move = this._resolveMove(target)
    // The rotation goes first: the camera state was resolved against the sphere
    // in its destination orientation, so applying it to the old one would put
    // the map somewhere neither state describes, if only for an instant.
    if (move.rotation) this._rotate(move.rotation)
    if (move.camera) this.set(move.camera)
  }

  /**
   * Animate with a fixed duration and easing. Use for short, mechanical moves
   * (a legend filter re-fit, a drilldown) where an arc would be theatrical.
   *
   * Fixed is the contract, rotation included: unlike `flyTo` this does not
   * stretch its duration to suit a half-turn, because a caller who asked for
   * 400 ms asked for 400 ms.
   */
  easeTo(target: CameraTarget & TransitionOptions): Promise<void> {
    const move = this._resolveMove(target)
    const next = move.camera
    if (!next && !move.rotation) return Promise.resolve()

    const duration = target.duration ?? 400
    if (duration <= 0 || prefersReducedMotion()) {
      this.jumpTo(target)
      return Promise.resolve()
    }

    const from = { ...this.state }
    const turn = this._turn(move.rotation)
    const ease = resolveEase(target.ease)
    return this._run(duration, (t) => {
      const e = ease(t)
      turn?.(e)
      if (next) {
        this.set({
          k: from.k + (next.k - from.k) * e,
          x: from.x + (next.x - from.x) * e,
          y: from.y + (next.y - from.y) * e,
        })
      }
    })
  }

  /**
   * Animate along a Van Wijk zoom-and-pan path. Use for narrative moves.
   *
   * Duration is derived from the path length unless overridden, so crossing a
   * continent takes longer than nudging to a neighbouring county without the
   * author having to hand-tune anything. On a globe the same is true of the
   * turn: the angular distance between the place facing the viewer now and the
   * one that will be sets the pace, and whichever of the two motions needs
   * longer decides, so the zoom and the rotation land together.
   *
   */
  flyTo(
    target: CameraTarget & TransitionOptions & { speed?: number; curve?: number },
  ): Promise<void> {
    const move = this._resolveMove(target)
    const next = move.camera
    if (!next && !move.rotation) return Promise.resolve()
    if (prefersReducedMotion()) {
      this.jumpTo(target)
      return Promise.resolve()
    }

    const vp = this.viewport
    const from = { ...this.state }
    const w = vp.width || 1
    const landing = next ?? from

    // Convert camera states to Van Wijk space: centre in world coords, plus the
    // world-space width currently visible.
    const p0: [number, number, number] = [
      (vp.width / 2 - from.x) / from.k,
      (vp.height / 2 - from.y) / from.k,
      w / from.k,
    ]
    const p1: [number, number, number] = [
      (vp.width / 2 - landing.x) / landing.k,
      (vp.height / 2 - landing.y) / landing.k,
      w / landing.k,
    ]

    const spin = move.rotation ? rotationDuration(vp.subObserver(), invertRotation(move.rotation)) : 0
    const turn = this._turn(move.rotation)

    const curve = target.curve ?? this.options.curve
    const interp = interpolateZoom(p0, p1, curve)
    const speed = target.speed ?? this.options.speed
    const natural = Math.max(interp.duration, spin)
    const duration = target.duration ?? Math.max(240, natural / speed)
    const ease = resolveEase(target.ease ?? 'cubicInOut')

    return this._run(duration, (t) => {
      const e = ease(t)
      turn?.(e)
      const [cx, cy, width] = interp(e)
      const k = w / width
      this.set({ k, x: vp.width / 2 - cx * k, y: vp.height / 2 - cy * k })
    })
  }

  /**
   * Frame a world-space bounding box (padding-aware).
   *
   */
  fitBounds(
    bounds: WorldBounds,
    options: {
      padding?: Padding
      maxZoom?: number
      duration?: number
      transition?: 'fly' | 'ease' | 'jump'
    } = {},
  ): Promise<void> {
    const { transition = 'fly', ...rest } = options
    const next = this.viewport.cameraForBounds(bounds, {
      padding: rest.padding ?? 24,
      maxZoom: rest.maxZoom ?? this.options.maxZoom,
    })
    if (transition === 'jump') {
      this.jumpTo(next)
      return Promise.resolve()
    }
    if (transition === 'ease') return this.easeTo({ ...next, duration: rest.duration })
    return this.flyTo({ ...next, duration: rest.duration })
  }

  /**
   * Zoom by a factor about a fixed screen point, so the geography under the
   * cursor stays under the cursor. This is the single detail that makes wheel
   * zoom feel correct.
   *
   */
  zoomAbout(factor: number, screenPoint: ScreenPoint): void {
    const cam = this.state
    const k = clamp(cam.k * factor, this.options.minZoom, this.options.maxZoom)
    if (k === cam.k) return
    const [sx, sy] = screenPoint
    const scale = k / cam.k
    this.set({ k, x: sx - (sx - cam.x) * scale, y: sy - (sy - cam.y) * scale })
  }

  panBy(dx: number, dy: number): void {
    const cam = this.state
    this.set({ x: cam.x + dx, y: cam.y + dy })
  }

  /**
   * Resolve a target into where the sphere ends up and where the camera ends up.
   *
   * The whole of the pan-or-rotate decision lives here, and it is one question:
   * does re-centring this projection mean turning the sphere? On anything laid
   * out flat the answer is no, `rotation` comes back null, and every number
   * below is what it has always been. On an azimuthal one a `center` becomes a
   * rotation, and the camera state is then resolved **against the sphere in its
   * destination orientation** rather than its current one. That second part is
   * what stops the move counting the same distance twice: measured against the
   * old sphere, the target still reads as being off on the far side, and the
   * camera would dutifully pan the screen there on top of a rotation that had
   * already brought it home.
   */
  private _resolveMove(target: CameraTarget): ResolvedMove {
    const rotation = this._rotationFor(target)
    if (!rotation) return { camera: this._resolveTarget(target), rotation: null }
    return {
      camera: this.viewport.underRotation(rotation, () => this._resolveTarget(target)),
      rotation,
    }
  }

  /** The destination rotation, or null when this move does not turn the sphere. */
  private _rotationFor(target: CameraTarget): Rotation | null {
    if (!target.center || !this.viewport.supportsRecentre()) return null
    const [lon, lat] = target.center
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
    return this.viewport.rotationFor(target.center)
  }

  /**
   * A stepper that slerps from the current rotation to `to`, or null if there is
   * nothing to turn.
   *
   * The starting orientation is captured here, at call time, which is what makes
   * a rotation interruptible on the same terms as everything else: a second
   * `flyTo` arriving mid-turn reads the half-turned sphere as its origin and
   * takes the short way from *there*, rather than snapping back or queueing.
   */
  private _turn(to: Rotation | null): ((t: number) => void) | null {
    if (!to) return null
    const q0 = versor(this.viewport.rotation)
    const q1 = versor(to)
    return (t: number) => {
      // Exact at the end: slerp is numerically excellent but not bit-exact, and
      // a move to a named place should land on it, not next to it.
      this._rotate(t >= 1 ? to : anglesOf(slerp(q0, q1, t)))
    }
  }

  /**
   * Resolve the many accepted target shapes into a concrete camera state.
   *
   */
  private _resolveTarget(target: CameraTarget): CameraState | null {
    const vp = this.viewport
    const cam = this.state

    if (target.bounds) {
      return vp.cameraForBounds(target.bounds, {
        padding: target.padding ?? 24,
        maxZoom: target.maxZoom ?? this.options.maxZoom,
      })
    }

    if (target.center) {
      const k = target.zoom ?? cam.k
      return vp.cameraForCenter(target.center, clamp(k, this.options.minZoom, this.options.maxZoom))
    }

    if (typeof target.zoom === 'number') {
      // Zoom about the viewport centre when no centre is supplied.
      const k = clamp(target.zoom, this.options.minZoom, this.options.maxZoom)
      const scale = k / cam.k
      const cx = vp.width / 2
      const cy = vp.height / 2
      return { k, x: cx - (cx - cam.x) * scale, y: cy - (cy - cam.y) * scale }
    }

    if (
      typeof target.k === 'number' ||
      typeof target.x === 'number' ||
      typeof target.y === 'number'
    ) {
      return {
        k: clamp(target.k ?? cam.k, this.options.minZoom, this.options.maxZoom),
        x: target.x ?? cam.x,
        y: target.y ?? cam.y,
      }
    }

    return null
  }

  private _run(duration: number, step: (t: number) => void): Promise<void> {
    this.stop()
    return new Promise<void>((resolve) => {
      this._resolve = resolve
      // Wall-clock start is captured from the first frame's timestamp so the
      // animation cannot jump when the tab was backgrounded.
      let start: number | null = null
      const tick = (now: number) => {
        if (start === null) start = now
        const t = Math.min(1, (now - start) / duration)
        step(t)
        if (t < 1) {
          this._raf = requestAnimationFrame(tick)
        } else {
          this._raf = null
          const r = this._resolve
          this._resolve = null
          if (r) r()
        }
      }
      this._raf = requestAnimationFrame(tick)
    })
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** The place a rotation puts at the sub-observer point. */
function invertRotation([lambda, phi]: Rotation): LonLat {
  return [-lambda, -phi]
}
