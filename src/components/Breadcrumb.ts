/**
 * Drilldown trail.
 *
 * A drilldown with no visible way back is a trap: the reader clicks California,
 * the map becomes counties, and nothing on screen says where they are or how to
 * leave. The trail is therefore rendered by default rather than left to the host
 * application, and every level except the current one is a real `<button>`, so it
 * is reachable by keyboard and announced as a control rather than as decoration.
 *
 * Rendered above the plot, in the flow, so it cannot cover geography. A floating
 * overlay would sit on top of exactly the part of the map the reader just zoomed
 * into.
 *
 * @module components/Breadcrumb
 */

import { html, empty, remove } from '../utils/dom'

export interface Crumb {
  label: string
  /** Levels to climb when this crumb is chosen. 0 is the current level. */
  up: number
}

export class Breadcrumb {
  readonly container: HTMLElement
  readonly onSelect: (up: number) => void
  private nav: HTMLElement | null = null

  constructor({ container, onSelect }: { container: HTMLElement; onSelect: (up: number) => void }) {
    this.container = container
    this.onSelect = onSelect
  }

  /** Render a trail, or remove it when there is nothing to go back to. */
  render(crumbs: readonly Crumb[]): void {
    if (crumbs.length < 2) {
      remove(this.nav)
      this.nav = null
      return
    }

    if (!this.nav) {
      this.nav = html('nav', {
        class: 'apexmaps-breadcrumb',
        'aria-label': 'Drilldown trail',
      })
      // First child, so the trail sits above the plot however the host has
      // ordered the legend.
      this.container.insertBefore(this.nav, this.container.firstChild)
    }
    empty(this.nav)

    crumbs.forEach((crumb, i) => {
      const last = i === crumbs.length - 1
      if (i > 0) {
        this.nav!.appendChild(
          html('span', { class: 'apexmaps-breadcrumb-sep', 'aria-hidden': 'true', text: '›' }),
        )
      }
      if (last) {
        this.nav!.appendChild(
          html('span', {
            class: 'apexmaps-breadcrumb-current',
            'aria-current': 'location',
            text: crumb.label,
          }),
        )
        return
      }
      const button = html('button', {
        type: 'button',
        class: 'apexmaps-breadcrumb-item',
        text: crumb.label,
      })
      button.addEventListener('click', () => this.onSelect(crumb.up))
      this.nav!.appendChild(button)
    })
  }

  destroy(): void {
    remove(this.nav)
    this.nav = null
  }
}
