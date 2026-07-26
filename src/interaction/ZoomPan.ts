/**
 * Zoom, pan and pinch.
 *
 * Two details separate a map that feels right from one that feels cheap, and
 * both are implemented here rather than left to the host app:
 *
 * - **Anchored zoom**: the geography under the pointer stays under the pointer.
 * - **Inertial pan**: releasing a drag decelerates instead of stopping dead.
 *
 * @module interaction/ZoomPan
 */

import { pointerPosition } from '../utils/dom'
import { prefersReducedMotion } from '../utils/motion'
import type { Camera } from '../geo/Camera'
import type { InteractionOptions, ScreenPoint } from '../types'

const INERTIA_FRICTION = 0.92
const INERTIA_MIN_VELOCITY = 0.04
/** Below this drag distance a pointer-up is a click, not a pan. */
const CLICK_SLOP = 4

export class ZoomPan {
  readonly container: HTMLElement
  readonly camera: Camera
  readonly options: InteractionOptions
  readonly emit: (event: string, payload?: unknown) => void

  private _dragging = false
  private _moved = 0
  private _last: ScreenPoint = [0, 0]
  private _velocity: [number, number] = [0, 0]
  private _inertiaRaf: number | null = null
  private readonly _pointers = new Map<number, ScreenPoint>()
  private _pinchDistance = 0

  private readonly _onPointerDown: (event: PointerEvent) => void
  private readonly _onPointerMove: (event: PointerEvent) => void
  private readonly _onPointerUp: (event: PointerEvent) => void
  private readonly _onWheel: (event: WheelEvent) => void
  private readonly _onDblClick: (event: MouseEvent) => void

  constructor({
    container,
    camera,
    options,
    emit,
  }: {
    container: HTMLElement
    camera: Camera
    options: InteractionOptions
    emit?: (event: string, payload?: unknown) => void
  }) {
    this.container = container
    this.camera = camera
    this.options = options
    this.emit = emit ?? (() => {})

    this._onPointerDown = this._handlePointerDown.bind(this)
    this._onPointerMove = this._handlePointerMove.bind(this)
    this._onPointerUp = this._handlePointerUp.bind(this)
    this._onWheel = this._handleWheel.bind(this)
    this._onDblClick = this._handleDblClick.bind(this)
  }

  attach(): void {
    const { zoom, pan } = this.options
    this.container.addEventListener('pointerdown', this._onPointerDown)
    if (zoom?.wheel !== false && zoom?.enabled !== false) {
      // Not passive: zooming must be able to preventDefault the page scroll.
      this.container.addEventListener('wheel', this._onWheel, {
        passive: false,
      })
    }
    if (zoom?.doubleClick !== false && zoom?.enabled !== false) {
      this.container.addEventListener('dblclick', this._onDblClick)
    }
    if (pan?.enabled !== false || zoom?.enabled !== false) {
      this.container.style.cursor = 'grab'
    }
  }

  detach(): void {
    this._stopInertia()
    this.container.removeEventListener('pointerdown', this._onPointerDown)
    this.container.removeEventListener('wheel', this._onWheel)
    this.container.removeEventListener('dblclick', this._onDblClick)
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointermove', this._onPointerMove)
      window.removeEventListener('pointerup', this._onPointerUp)
      window.removeEventListener('pointercancel', this._onPointerUp)
    }
  }

  private _handlePointerDown(event: PointerEvent): void {
    if (this.options.pan?.enabled === false && this.options.zoom?.enabled === false) return
    if (event.button !== 0 && event.pointerType === 'mouse') return

    this._stopInertia()
    this.camera.stop()

    this._pointers.set(event.pointerId, pointerPosition(this.container, event))
    if (this._pointers.size === 2) {
      this._pinchDistance = this._currentPinchDistance()
      this._dragging = false
    } else {
      this._dragging = true
      this._moved = 0
      this._last = pointerPosition(this.container, event)
      this._velocity = [0, 0]
      this.container.style.cursor = 'grabbing'
    }

    window.addEventListener('pointermove', this._onPointerMove)
    window.addEventListener('pointerup', this._onPointerUp)
    window.addEventListener('pointercancel', this._onPointerUp)
  }

  private _handlePointerMove(event: PointerEvent): void {
    if (!this._pointers.has(event.pointerId)) return
    const point = pointerPosition(this.container, event)
    this._pointers.set(event.pointerId, point)

    if (this._pointers.size >= 2) {
      if (this.options.zoom?.enabled === false) return
      const distance = this._currentPinchDistance()
      if (this._pinchDistance > 0 && distance > 0) {
        this.camera.zoomAbout(distance / this._pinchDistance, this._pinchCentre())
      }
      this._pinchDistance = distance
      return
    }

    if (!this._dragging || this.options.pan?.enabled === false) return

    const dx = point[0] - this._last[0]
    const dy = point[1] - this._last[1]
    this._moved += Math.abs(dx) + Math.abs(dy)
    this._velocity = [dx, dy]
    this._last = point
    this.camera.panBy(dx, dy)
  }

  private _handlePointerUp(event: PointerEvent): void {
    this._pointers.delete(event.pointerId)

    if (this._pointers.size < 2) this._pinchDistance = 0
    if (this._pointers.size > 0) return

    const wasDragging = this._dragging
    this._dragging = false
    this.container.style.cursor = 'grab'
    window.removeEventListener('pointermove', this._onPointerMove)
    window.removeEventListener('pointerup', this._onPointerUp)
    window.removeEventListener('pointercancel', this._onPointerUp)

    if (wasDragging && this._moved > CLICK_SLOP) {
      if (this.options.pan?.inertia !== false && !prefersReducedMotion()) this._startInertia()
      this.emit('panEnd')
    }
  }

  private _handleWheel(event: WheelEvent): void {
    event.preventDefault()
    this._stopInertia()
    this.camera.stop()

    // Normalise across deltaMode (pixels, lines, pages) so a trackpad and a
    // notched wheel produce comparable steps.
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1
    const delta = event.deltaY * unit
    const factor = Math.pow(2, -delta / 500)
    this.camera.zoomAbout(factor, pointerPosition(this.container, event))
    this.emit('zoom', { k: this.camera.state.k })
  }

  private _handleDblClick(event: MouseEvent): void {
    event.preventDefault()
    const step = this.options.zoom?.step ?? 1.6
    const factor = event.shiftKey ? 1 / step : step
    const point = pointerPosition(this.container, event)

    // Compute the anchored target, then animate to it: a double-click zoom that
    // teleports loses the reader's sense of where they were.
    const before = { ...this.camera.state }
    this.camera.zoomAbout(factor, point)
    const target = { ...this.camera.state }
    this.camera.set(before)
    this.camera.easeTo({
      k: target.k,
      x: target.x,
      y: target.y,
      duration: 260,
    })
    this.emit('zoom', { k: target.k })
  }

  private _currentPinchDistance(): number {
    const points = [...this._pointers.values()]
    if (points.length < 2) return 0
    const dx = points[0][0] - points[1][0]
    const dy = points[0][1] - points[1][1]
    return Math.hypot(dx, dy)
  }

  private _pinchCentre(): ScreenPoint {
    const points = [...this._pointers.values()]
    if (points.length < 2) return [0, 0]
    return [(points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2]
  }

  private _startInertia(): void {
    let [vx, vy] = this._velocity
    if (Math.hypot(vx, vy) < INERTIA_MIN_VELOCITY) return

    const step = () => {
      vx *= INERTIA_FRICTION
      vy *= INERTIA_FRICTION
      if (Math.hypot(vx, vy) < INERTIA_MIN_VELOCITY) {
        this._inertiaRaf = null
        return
      }
      this.camera.panBy(vx, vy)
      this._inertiaRaf = requestAnimationFrame(step)
    }
    this._inertiaRaf = requestAnimationFrame(step)
  }

  private _stopInertia(): void {
    if (this._inertiaRaf !== null) {
      cancelAnimationFrame(this._inertiaRaf)
      this._inertiaRaf = null
    }
  }
}
