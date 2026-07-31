/**
 * On-screen zoom controls.
 *
 * Wheel, pinch and double-click are gestures, and a map whose only way to change
 * scale is a gesture is unusable for a whole class of reader: there is no keyboard
 * path, a trackpad wheel over a scrolling page is a fight, and on a narrow screen
 * a pinch competes with the page. So the buttons render by default, for the same
 * reason the breadcrumb does: a view you can enter but not navigate is a trap.
 *
 * They are HTML rather than SVG, positioned over the plot. Two consequences worth
 * having: each control is a real `<button>`, so it is focusable, announced and
 * disabled by the platform rather than by imitation, and none of it lands in the
 * exported SVG, where a zoom button would be furniture printed onto the map.
 *
 * Every gesture ends up in `ZoomPan`, which listens on the plot; a pointerdown on
 * a button that reached it would start a pan, and a rapid double-tap on `+` would
 * be read as a double-click zoom on the geography underneath. Both are stopped
 * here, at the only place that knows the pointer was on furniture.
 *
 * @module components/ZoomControls
 */

import { html, svg, remove } from '../utils/dom'
import type { ZoomControlsOptions, ZoomControlsPosition } from '../types'

const DEFAULT_POSITION: ZoomControlsPosition = 'top-right'

/** State the buttons describe, which is the camera plus "is the globe turned". */
export interface ZoomControlsState {
  k: number
  minZoom: number
  maxZoom: number
  /** Whether anything (scale, pan, rotation) is left for reset to undo. */
  moved: boolean
}

export class ZoomControls {
  readonly container: HTMLElement
  readonly onStep: (direction: 1 | -1) => void
  readonly onReset: () => void
  options: ZoomControlsOptions

  private root: HTMLElement | null = null
  private inButton: HTMLButtonElement | null = null
  private outButton: HTMLButtonElement | null = null
  private resetButton: HTMLButtonElement | null = null
  /**
   * The last state written, so `sync` is free to be called from every camera
   * frame. A pan emits changes at 60Hz and none of them move a button.
   */
  private _synced = ''

  constructor({
    container,
    options,
    onStep,
    onReset,
  }: {
    container: HTMLElement
    options: ZoomControlsOptions
    /** `1` steps in, `-1` steps out, by the configured zoom step. */
    onStep: (direction: 1 | -1) => void
    onReset: () => void
  }) {
    this.container = container
    this.options = options
    this.onStep = onStep
    this.onReset = onReset
  }

  /** Build the controls, or take them down when this config turns them off. */
  render(state: ZoomControlsState): void {
    if (this.options.show === false) {
      this.destroy()
      return
    }

    const wantReset = this.options.reset !== false
    // A reset button appearing or disappearing is a different set of children, and
    // the cheapest correct answer to that is to build the group again.
    if (this.root && Boolean(this.resetButton) !== wantReset) this.destroy()

    if (!this.root) {
      this.root = html('div', {
        class: 'apexmaps-zoom',
        role: 'group',
        'aria-label': 'Zoom',
      })
      // Furniture, not geography: whatever the pointer does here, the map beneath
      // must not also read it as a gesture.
      for (const type of ['pointerdown', 'dblclick', 'click'] as const) {
        this.root.addEventListener(type, (event) => event.stopPropagation())
      }

      this.inButton = this._button('Zoom in', plusIcon(), () => this.onStep(1))
      this.outButton = this._button('Zoom out', minusIcon(), () => this.onStep(-1))
      this.root.appendChild(this.inButton)
      this.root.appendChild(this.outButton)
      if (wantReset) {
        // Zooming in eight times at the default step passes 40x, and at that scale
        // no gesture takes the reader back to the whole map in one move.
        this.resetButton = this._button('Reset view', homeIcon(), () => this.onReset())
        this.root.appendChild(this.resetButton)
      }
      this.container.appendChild(this.root)
    }

    this.root.setAttribute(
      'class',
      `apexmaps-zoom apexmaps-zoom--${this.options.position ?? DEFAULT_POSITION}`,
    )
    this._synced = ''
    this.sync(state)
  }

  /**
   * Reflect the camera in the buttons' disabled state.
   *
   * A `+` that still looks live at maximum scale is a control that lies, and the
   * pair going flat is also how a reader learns the range has an end.
   */
  sync(state: ZoomControlsState): void {
    if (!this.root) return
    // Compared against the *rounded* limits, because a clamped camera lands a hair
    // off the bound in floating point and would leave the button enabled forever.
    const atMax = state.k >= state.maxZoom * 0.999
    const atMin = state.k <= state.minZoom * 1.001
    const key = `${atMax}|${atMin}|${state.moved}`
    if (key === this._synced) return
    this._synced = key

    if (this.inButton) this.inButton.disabled = atMax
    if (this.outButton) this.outButton.disabled = atMin
    if (this.resetButton) this.resetButton.disabled = !state.moved
  }

  private _button(label: string, icon: SVGElement, onClick: () => void): HTMLButtonElement {
    const button = html('button', {
      type: 'button',
      class: 'apexmaps-zoom-button',
      'aria-label': label,
      title: label,
    })
    button.appendChild(icon)
    button.addEventListener('click', onClick)
    return button
  }

  destroy(): void {
    remove(this.root)
    this.root = null
    this.inButton = null
    this.outButton = null
    this.resetButton = null
    this._synced = ''
  }
}

/**
 * Icons are drawn rather than typed. A `+` glyph inherits the host's font, which
 * puts the weight, the width and the optical centre of every control outside our
 * hands; `currentColor` strokes keep them consistent and theme-aware.
 */
function icon(children: (Element | null)[]): SVGElement {
  return svg(
    'svg',
    {
      viewBox: '0 0 16 16',
      width: 16,
      height: 16,
      'aria-hidden': 'true',
      focusable: 'false',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.6,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
    children,
  )
}

function plusIcon(): SVGElement {
  return icon([
    svg('line', { x1: 8, y1: 3.5, x2: 8, y2: 12.5 }),
    svg('line', { x1: 3.5, y1: 8, x2: 12.5, y2: 8 }),
  ])
}

function minusIcon(): SVGElement {
  return icon([svg('line', { x1: 3.5, y1: 8, x2: 12.5, y2: 8 })])
}

function homeIcon(): SVGElement {
  // A framing bracket rather than a house: the button returns the *view* to where
  // the map opened, which is not the same idea as "home page".
  return icon([
    svg('path', { d: 'M2.5 5.5V2.5H5.5' }),
    svg('path', { d: 'M13.5 5.5V2.5H10.5' }),
    svg('path', { d: 'M2.5 10.5V13.5H5.5' }),
    svg('path', { d: 'M13.5 10.5V13.5H10.5' }),
  ])
}
