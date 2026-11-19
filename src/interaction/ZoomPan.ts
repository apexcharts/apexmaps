/**
 * Zoom, pan, pinch and box selection.
 *
 * Three details separate a map that feels right from one that feels cheap, and
 * all three are implemented here rather than left to the host app:
 *
 * - **Anchored zoom**: the geography under the pointer stays under the pointer.
 * - **Inertial pan**: releasing a drag decelerates instead of stopping dead.
 * - **A drag that ends on a feature is not a click on it.** Without that, panning
 *   the map and releasing over a country selects the country, and box-selecting
 *   over one drills into it.
 *
 * A drag means pan, and a drag with a modifier means "select what is in this box",
 * because a map has one drag gesture and panning has the stronger claim on it.
 * On a globe the drag is handed to `GlobeRotation` instead, which spins the
 * sphere; everything else here (the click slop, the pinch, the marquee) is
 * unchanged by that, because only the meaning of the movement differs.
 *
 * @module interaction/ZoomPan
 */

import { pointerPosition } from '../utils/dom'
import { prefersReducedMotion } from '../utils/motion'
import type { Camera } from '../geo/Camera'
import type { GlobeRotation } from './GlobeRotation'
import type { InteractionOptions, ScreenPoint } from '../types'

/** A screen-space selection box, `[[x0, y0], [x1, y1]]`, already normalised. */
export type SelectBox = [ScreenPoint, ScreenPoint]

export type SelectBoxPhase = 'move' | 'end' | 'cancel'

const INERTIA_FRICTION = 0.92
const INERTIA_MIN_VELOCITY = 0.04
/** Below this drag distance a pointer-up is a click, not a pan. */
const CLICK_SLOP = 4

/**
 * Write the first `touch-action` this browser accepts, and return it.
 *
 * The candidates come from {@link ZoomPan.touchAction}, most specific first, and
 * the last one is a value every browser that has `touch-action` at all
 * understands. A browser that does not know a value ignores the assignment and
 * keeps the old one, so reading it back is the feature test: without it, a map
 * that pans and asks for `pinch-zoom` would keep whatever it had before on a
 * browser without that value, which could be a value that hands the drag to the
 * page.
 */
export function applyTouchAction(
  el: HTMLElement | SVGElement,
  candidates: readonly string[],
): string {
  for (const value of candidates) {
    el.style.touchAction = value
    if (el.style.touchAction === value) return value
  }
  return el.style.touchAction
}

export class ZoomPan {
  readonly container: HTMLElement
  /**
   * The element touch gestures land on: the map's SVG, which carries the
   * `touch-action` from {@link touchAction}. The pinch guard listens here rather
   * than on `container`, so a pinch or a scroll that starts on the zoom buttons
   * or the attribution beside the SVG stays the page's. Defaults to `container`.
   */
  readonly surface: Element
  readonly camera: Camera
  readonly options: InteractionOptions
  readonly emit: (event: string, payload?: unknown) => void
  readonly onSelectBox: (box: SelectBox | null, phase: SelectBoxPhase, additive: boolean) => void
  /** Present on every map; it decides for itself whether this projection spins. */
  readonly globe: GlobeRotation | null

  /** Whether the drag in progress (or about to start) turns the globe. */
  private _rotating = false
  private _dragging = false
  private _moved = 0
  private _last: ScreenPoint = [0, 0]
  private _velocity: [number, number] = [0, 0]
  private _inertiaRaf: number | null = null
  private readonly _pointers = new Map<number, ScreenPoint>()
  private _pinchDistance = 0
  private _marquee: { start: ScreenPoint; current: ScreenPoint; additive: boolean } | null = null
  /**
   * Set when a gesture travelled far enough to be a drag rather than a click.
   *
   * The browser still fires `click` after a drag that begins and ends on the same
   * element, so without this a pan that finishes over a country selects it. Cleared
   * by the next pointerdown, so a stale flag can never outlive one gesture, which a
   * timer-based version could.
   */
  private _swallowClick = false

  private readonly _onPointerDown: (event: PointerEvent) => void
  private readonly _onPointerMove: (event: PointerEvent) => void
  private readonly _onPointerUp: (event: PointerEvent) => void
  private readonly _onWheel: (event: WheelEvent) => void
  private readonly _onDblClick: (event: MouseEvent) => void
  private readonly _onTouchMove: (event: TouchEvent) => void

  constructor({
    container,
    camera,
    options,
    emit,
    onSelectBox,
    globe,
    surface,
  }: {
    container: HTMLElement
    surface?: Element | null
    camera: Camera
    options: InteractionOptions
    emit?: (event: string, payload?: unknown) => void
    /** Called as a selection box is dragged, and once when it is released. */
    onSelectBox?: (box: SelectBox | null, phase: SelectBoxPhase, additive: boolean) => void
    globe?: GlobeRotation | null
  }) {
    this.container = container
    this.surface = surface ?? container
    this.camera = camera
    this.options = options
    this.emit = emit ?? (() => {})
    this.onSelectBox = onSelectBox ?? (() => {})
    this.globe = globe ?? null

    this._onPointerDown = this._handlePointerDown.bind(this)
    this._onPointerMove = this._handlePointerMove.bind(this)
    this._onPointerUp = this._handlePointerUp.bind(this)
    this._onWheel = this._handleWheel.bind(this)
    this._onDblClick = this._handleDblClick.bind(this)
    this._onTouchMove = this._handleTouchMove.bind(this)
  }

  /**
   * The CSS `touch-action` the map's surface needs, most specific first.
   *
   * Touch gestures go to the browser unless the surface says otherwise, and once
   * the browser takes one (a scroll, a page zoom) the map gets `pointercancel`
   * and nothing more. So the surface has to claim exactly the gestures this map
   * handles and leave every other one to the page:
   *
   * - a one-finger drag, when it pans, spins the globe, or draws a selection box;
   * - a two-finger pinch, when the map zooms.
   *
   * Claiming more than that is the worse failure. A full-width map that neither
   * zooms nor pans but still swallows every swipe leaves a phone reader unable
   * to scroll past it. Wheel and double-click are not touch gestures, so they are
   * unaffected and keep following `zoom.wheel` and `zoom.doubleClick`.
   *
   * A list rather than one value because `pinch-zoom` is not universal: where it
   * is missing, a map that pans falls back to `none`, keeping the drag (which it
   * needs) and giving up the page's pinch (which it can do without). Live, since
   * whether a drag spins the globe follows the projection, which can change
   * without the interaction options changing.
   */
  get touchAction(): readonly string[] {
    const pinch = this.options.zoom?.enabled !== false
    const drag =
      this.options.pan?.enabled !== false || !!this.globe?.enabled || this._plainDragSelects()
    if (drag && pinch) return ['none']
    if (drag) return ['pinch-zoom', 'none']
    // The page scrolls with one finger and the pinch is the map's. `manipulation`
    // is the fallback because losing the map's pinch to the page is a lesser fault
    // than trapping the scroll.
    if (pinch) return ['pan-x pan-y', 'manipulation']
    // Scroll and pinch both stay with the page. `manipulation` rather than `auto`
    // only drops the double-tap page zoom, whose wait is what delays a tap that
    // selects a region.
    return ['manipulation']
  }

  attach(): void {
    const { zoom, pan } = this.options
    this.container.addEventListener('pointerdown', this._onPointerDown)
    if (zoom?.enabled !== false) {
      // Not passive, for the same reason as the wheel: see `_handleTouchMove`.
      // On the surface only, so the furniture beside it keeps the page's pinch.
      // `Element`'s event map has no touch events, hence the listener cast.
      this.surface.addEventListener('touchmove', this._onTouchMove as EventListener, {
        passive: false,
      })
    }
    if (zoom?.wheel !== false && zoom?.enabled !== false) {
      // Not passive: zooming must be able to preventDefault the page scroll.
      this.container.addEventListener('wheel', this._onWheel, {
        passive: false,
      })
    }
    if (zoom?.doubleClick !== false && zoom?.enabled !== false) {
      this.container.addEventListener('dblclick', this._onDblClick)
    }
    if (pan?.enabled !== false || zoom?.enabled !== false || this.globe?.enabled) {
      this.container.style.cursor = 'grab'
    }
  }

  detach(): void {
    this._stopInertia()
    this._marquee = null
    this.container.removeEventListener('pointerdown', this._onPointerDown)
    this.container.removeEventListener('wheel', this._onWheel)
    this.container.removeEventListener('dblclick', this._onDblClick)
    this.surface.removeEventListener('touchmove', this._onTouchMove as EventListener)
    this._detachWindowListeners()
    // The cursor was set by attach() from options this instance no longer speaks
    // for; a successor's attach() decides it again.
    this.container.style.cursor = ''
  }

  private _handlePointerDown(event: PointerEvent): void {
    this._swallowClick = false
    const marquee = this._marqueeWanted(event)
    if (
      !marquee &&
      !this.globe?.enabled &&
      this.options.pan?.enabled === false &&
      this.options.zoom?.enabled === false
    ) {
      return
    }
    if (event.button !== 0 && event.pointerType === 'mouse') return

    this._stopInertia()
    this.camera.stop()

    if (marquee) {
      // A modifier-drag would otherwise start a native text selection across the
      // page, which outlives the gesture and reads as a bug.
      event.preventDefault()
      const start = pointerPosition(this.container, event)
      this._marquee = { start, current: start, additive: event.altKey }
      this._dragging = false
      this._pointers.clear()
      this.container.style.cursor = 'crosshair'
      window.addEventListener('pointermove', this._onPointerMove)
      window.addEventListener('pointerup', this._onPointerUp)
      window.addEventListener('pointercancel', this._onPointerUp)
      return
    }

    this._pointers.set(event.pointerId, pointerPosition(this.container, event))
    if (this._pointers.size === 2) {
      this._pinchDistance = this._currentPinchDistance()
      this._dragging = false
      this._rotating = false
    } else {
      this._dragging = true
      this._moved = 0
      this._last = pointerPosition(this.container, event)
      this._velocity = [0, 0]
      this.container.style.cursor = 'grabbing'
      // Decided once per gesture, not once per move: a projection change
      // mid-drag is not a thing, and re-asking every frame would let a drag
      // switch meaning underneath the reader's hand.
      this._rotating = this.globe?.enabled ?? false
      if (this._rotating) this.globe?.start(this._last)
    }

    window.addEventListener('pointermove', this._onPointerMove)
    window.addEventListener('pointerup', this._onPointerUp)
    window.addEventListener('pointercancel', this._onPointerUp)
  }

  private _handlePointerMove(event: PointerEvent): void {
    if (this._marquee) {
      this._marquee.current = pointerPosition(this.container, event)
      this.onSelectBox(this._marqueeBox(), 'move', this._marquee.additive)
      return
    }
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

    if (!this._dragging) return
    if (!this._rotating && this.options.pan?.enabled === false) return

    const dx = point[0] - this._last[0]
    const dy = point[1] - this._last[1]
    this._moved += Math.abs(dx) + Math.abs(dy)
    this._velocity = [dx, dy]
    this._last = point
    if (this._rotating) this.globe?.move(point)
    else this.camera.panBy(dx, dy)
  }

  private _handlePointerUp(event: PointerEvent): void {
    if (this._marquee) {
      const box = this._marqueeBox()
      const { additive } = this._marquee
      const dragged = this._boxSize(box) > CLICK_SLOP
      this._marquee = null
      this._detachWindowListeners()
      this.container.style.cursor = 'grab'
      // A box of nothing is a click, and a shift-click is not a selection box.
      this.onSelectBox(dragged ? box : null, dragged ? 'end' : 'cancel', additive)
      if (dragged) this._swallowClick = true
      return
    }

    this._pointers.delete(event.pointerId)

    if (this._pointers.size < 2) this._pinchDistance = 0
    if (this._pointers.size > 0) return

    const wasDragging = this._dragging
    const wasRotating = this._rotating
    this._dragging = false
    this._rotating = false
    this.container.style.cursor = 'grab'
    this._detachWindowListeners()

    if (!wasDragging) return

    if (wasRotating) {
      // Released regardless of distance, so a grab that never moved still tidies
      // up the anchor it took.
      this.globe?.release()
    }
    if (this._moved > CLICK_SLOP) {
      // A pan that ends over a feature must not also count as a click on it.
      this._swallowClick = true
      if (wasRotating) return
      if (this.options.pan?.inertia !== false && !prefersReducedMotion()) this._startInertia()
      this.emit('panEnd')
    }
  }

  /**
   * Whether the click now arriving is the tail of a drag, consuming the flag.
   *
   * Consume-once rather than a time window: the flag is set on pointerup and
   * cleared either by the click that follows or by the next pointerdown, so it
   * cannot leak into an unrelated click however long the reader waits.
   */
  shouldSwallowClick(): boolean {
    if (!this._swallowClick) return false
    this._swallowClick = false
    return true
  }

  /** Abandon an in-progress selection box, e.g. on Escape. */
  cancelSelectBox(): boolean {
    if (!this._marquee) return false
    this._marquee = null
    this._detachWindowListeners()
    this.container.style.cursor = 'grab'
    this.onSelectBox(null, 'cancel', false)
    return true
  }

  get selecting(): boolean {
    return this._marquee !== null
  }

  /**
   * A pinch on a map that zooms but leaves one-finger scrolling to the page.
   *
   * `touch-action: pan-x pan-y` already stops the page zooming, but not the page
   * scrolling under two fingers: their midpoint drifts during any real pinch, and
   * once that drift reads as a scroll the browser takes the gesture and the map
   * gets `pointercancel`. Cancelling the move while two fingers are down keeps the
   * pinch whole. One finger is never cancelled, so the page still scrolls, and a
   * move the browser has already committed to a scroll is not cancelable, so a
   * second finger landing mid-scroll does not stop the page with a jolt.
   */
  private _handleTouchMove(event: TouchEvent): void {
    if (event.touches.length > 1 && event.cancelable) event.preventDefault()
  }

  /** Whether a selection box exists at all under these options. */
  private _boxSelectable(): boolean {
    const selection = this.options.selection ?? {}
    if (selection.enabled === false || selection.rectangle === false) return false
    // A box that can only ever hold one thing is a click with extra steps.
    return selection.multiple !== false
  }

  /**
   * Whether a drag with no modifier draws a selection box, which makes the
   * one-finger drag the map's even with panning off: a finger has no modifier
   * keys, so this is the only selection box a touch reader can draw.
   */
  private _plainDragSelects(): boolean {
    return (
      this._boxSelectable() &&
      this.options.selection?.modifier === 'none' &&
      this.options.pan?.enabled === false
    )
  }

  private _marqueeWanted(event: PointerEvent): boolean {
    if (!this._boxSelectable()) return false
    const selection = this.options.selection ?? {}

    const modifier = selection.modifier ?? 'shift'
    if (modifier === 'none') {
      // One gesture cannot mean both. ApexMaps warns about this configuration; here
      // it simply loses to panning.
      return this.options.pan?.enabled === false
    }
    if (modifier === 'shift') return event.shiftKey
    if (modifier === 'alt') return event.altKey
    if (modifier === 'meta') return event.metaKey
    return event.ctrlKey
  }

  private _marqueeBox(): SelectBox {
    const { start, current } = this._marquee as {
      start: ScreenPoint
      current: ScreenPoint
    }
    return [
      [Math.min(start[0], current[0]), Math.min(start[1], current[1])],
      [Math.max(start[0], current[0]), Math.max(start[1], current[1])],
    ]
  }

  private _boxSize(box: SelectBox): number {
    return Math.max(box[1][0] - box[0][0], box[1][1] - box[0][1])
  }

  private _detachWindowListeners(): void {
    if (typeof window === 'undefined') return
    window.removeEventListener('pointermove', this._onPointerMove)
    window.removeEventListener('pointerup', this._onPointerUp)
    window.removeEventListener('pointercancel', this._onPointerUp)
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
    // The globe's glide is momentum too, and every caller of this means "stop
    // whatever is still moving before I start something new".
    this.globe?.stop()
    if (this._inertiaRaf !== null) {
      cancelAnimationFrame(this._inertiaRaf)
      this._inertiaRaf = null
    }
  }
}
