/**
 * A fading copy of the level a drilldown is leaving.
 *
 * A drilldown replaces the geometry in one synchronous draw, and no camera move
 * can hide that: the parent's neighbours (the rest of the United States around
 * California) do not exist at the child level, so they blink out, and the
 * child's internal boundaries have nothing to fade up from. Framing the feature
 * first only lines up the *one* shape both levels share.
 *
 * So the outgoing level is copied to a layer above the incoming one and faded
 * out. Only the copy animates: the incoming level stays fully opaque
 * underneath, which is what keeps a cross-fade from dipping through the
 * background in the middle. What the reader sees is the parent fill dissolving
 * to reveal the counties already drawn under it, and the neighbours dissolving
 * with it.
 *
 * The copy is a snapshot, so it cannot follow the camera by itself. `track`
 * pushes the affine between the camera the copy is registered with and the live
 * one, so a settle move after the swap carries both together instead of sliding
 * the copy off its original. That transform scales the copy's screen-space
 * content (labels, bubbles) which a real camera move would only reposition, and
 * it is left that way on purpose: the settle is a few percent, and the layer it
 * distorts is on its way to zero opacity.
 *
 * The camera it is registered with is the one set *after* the swap, not the one
 * it was captured under: `anchor` exists to say so. A level change replaces the
 * projection, so the outgoing level's camera describes world coordinates that no
 * longer mean anything, and treating it as the reference would scale the copy by
 * the ratio between two unrelated fits the moment the new level landed.
 *
 * A clone is stripped of the classes and keys its original was found by, so for
 * the length of the transition the map still answers "one path per feature" to
 * a hit test, an export, a `querySelectorAll` or an assertion. A copy that kept
 * them would be indistinguishable from live content for a quarter of a second,
 * which is exactly long enough for a `drilldown` handler to read the wrong
 * count.
 *
 * @module renderers/LevelGhost
 */

import { html, remove } from '../utils/dom'
import type { CameraState } from '../types'

export interface GhostSource {
  /** The plot box, which is the positioning context the copy is laid over. */
  plot: HTMLElement | null
  svg: SVGSVGElement | null
  /**
   * Clone the SVG. A clone is DOM proportional to the outgoing mark count, so
   * the caller decides against its motion budget.
   */
  cloneSvg?: boolean
}

export class LevelGhost {
  private container: HTMLElement | null
  /** The camera the copy is registered with. Null until `anchor` says. */
  private from: CameraState | null = null

  private constructor(container: HTMLElement) {
    this.container = container
  }

  /**
   * Copy what is currently on screen, mounted above it.
   *
   * Returns null when there was nothing to copy: no plot, no SVG, or the clone
   * declined by the motion budget. A caller treats that as "no cross-fade"
   * rather than as an error.
   */
  static capture({ plot, svg, cloneSvg = true }: GhostSource): LevelGhost | null {
    if (!plot) return null

    const container = html('div', {
      class: 'apexmaps-ghost',
      // Inert in every sense: no pointer events for the live level's hit
      // testing to lose, and nothing for a screen reader to read twice.
      'aria-hidden': 'true',
      style: {
        position: 'absolute',
        inset: '0',
        pointerEvents: 'none',
        // Carried here rather than left to the stripped `apexmaps-*` classes,
        // which is where the copy's contents would otherwise have got it.
        userSelect: 'none',
        transformOrigin: '0 0',
      },
    })

    let copied = false

    if (svg && cloneSvg) {
      const clone = svg.cloneNode(true) as SVGSVGElement
      anonymize(clone)
      // The original is the map's one tab stop and carries the a11y tree; a
      // second focusable copy of it would put a stop in the order that vanishes
      // mid-transition.
      clone.removeAttribute('tabindex')
      clone.removeAttribute('role')
      clone.setAttribute('aria-hidden', 'true')
      clone.style.position = 'absolute'
      clone.style.inset = '0'
      // From `.apexmaps-svg`, which the copy no longer matches.
      clone.style.display = 'block'
      // The background is deliberately kept: the live level paints the same one,
      // so the two cancel through the blend instead of washing it out.
      container.appendChild(clone)
      copied = true
    }

    if (!copied) return null

    // Last child of the plot, so it paints over the SVG with no z-index for
    // anything else to have to beat.
    plot.appendChild(container)
    return new LevelGhost(container)
  }

  /**
   * Declare the camera the copy currently lines up with, which is the one the
   * incoming level was handed. Until this is called the copy is left alone, since
   * a snapshot with nothing to be relative to is already in the right place.
   */
  anchor(camera: CameraState): void {
    this.from = { ...camera }
    if (this.container) this.container.style.transform = ''
  }

  /** Keep the copy registered with the live level as its camera settles. */
  track(camera: CameraState): void {
    const el = this.container
    if (!el || !this.from) return
    const scale = camera.k / this.from.k
    if (!Number.isFinite(scale) || scale <= 0) return
    // A world point sits at `k0*w + x0` in the copy and at `k1*w + x1` now, so
    // the screen-space map between them is scale `k1/k0` about the origin.
    const tx = camera.x - scale * this.from.x
    const ty = camera.y - scale * this.from.y
    el.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`
  }

  /** Start the fade. The caller removes the copy when the move it rides ends. */
  fade(duration: number): void {
    const el = this.container
    if (!el || duration <= 0) return
    el.style.transition = `opacity ${duration}ms ease-out`
    el.style.opacity = '1'
    // A transition needs two committed values. Setting both in one frame gives
    // it one, and the copy would disappear instantly rather than fade.
    if (typeof requestAnimationFrame !== 'function') return
    requestAnimationFrame(() => {
      if (this.container) this.container.style.opacity = '0'
    })
  }

  destroy(): void {
    remove(this.container)
    this.container = null
  }
}

/** Everything a live mark is found by: a hit test, a query, an export. */
const IDENTITY = ['id', 'data-key', 'data-index', 'data-item', 'data-series', 'data-cluster']

/** Take the identity off a clone, in place, so only the pixels are left. */
function anonymize(root: SVGSVGElement): void {
  strip(root)
  for (const node of root.querySelectorAll('*')) strip(node)
}

function strip(el: Element): void {
  for (const attribute of IDENTITY) el.removeAttribute(attribute)

  const classes = el.getAttribute('class')
  if (!classes) return
  // `apexmaps-*` tokens are what selectors match on, so the copy gives them up.
  // `is-*` state tokens stay: `is-muted` is the one class-driven paint in the
  // tree, and dropping it would flash a legend-filtered level back to full
  // opacity at the very start of the fade. `ApexMaps.css` restores that rule for
  // the copy, since the element it hangs off is gone.
  const kept = classes.split(/\s+/).filter((token) => token && !token.startsWith('apexmaps-'))
  if (kept.length) el.setAttribute('class', kept.join(' '))
  else el.removeAttribute('class')
}
