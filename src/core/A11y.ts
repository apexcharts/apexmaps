/**
 * Accessibility.
 *
 * Ships in phase 1, not phase 3, and is free in every licence tier. Two reasons:
 * gating accessibility blocks the public-sector buyer, and a map is the chart
 * type screen-reader users are most often locked out of entirely
 * (PRODUCT-RESEARCH.md section 12.2 and the decision log in SCOPE.md).
 *
 * What this provides:
 *
 * - An `aria-label` plus `<desc>` auto-generated from the spec and the data, so
 *   the map announces what it shows and how the values are distributed.
 * - **Roving-tabindex keyboard navigation.** One tab stop for the whole map, then
 *   arrow keys to walk features in reading order. A tab stop per feature would
 *   make a 3,000-county map unusable by keyboard, which is the usual mistake.
 * - An optional hidden data table, which is the only reliable fallback for
 *   assistive technology that cannot interpret spatial output at all.
 *
 * @module core/A11y
 */

import { svg, html, remove } from '../utils/dom'
import type { A11yOptions, NormalizedFeature, WorldPoint } from '../types'

/** What the host must expose for keyboard navigation to work. */
export interface A11yAccess {
  features: NormalizedFeature[]
  describe: (feature: NormalizedFeature) => string
  focus: (feature: NormalizedFeature) => void
  select: (feature: NormalizedFeature) => void
}

export class A11y {
  readonly container: HTMLElement
  readonly options: A11yOptions
  readonly access: () => A11yAccess
  svgRoot: SVGSVGElement | null = null
  liveRegion: HTMLElement | null = null
  table: HTMLElement | null = null
  cursor = -1
  order: NormalizedFeature[] = []
  private readonly _onKeyDown: (event: KeyboardEvent) => void

  constructor({
    container,
    options,
    access,
  }: {
    container: HTMLElement
    options: A11yOptions
    access: () => A11yAccess
  }) {
    this.container = container
    this.options = options || {}
    this.access = access
    this._onKeyDown = this._handleKeyDown.bind(this)
  }

  mount(
    svgRoot: SVGSVGElement,
    { label, description }: { label: string; description: string },
  ): void {
    if (this.options.enabled === false) return
    this.svgRoot = svgRoot

    svgRoot.setAttribute('role', 'application')
    svgRoot.setAttribute('aria-label', label)
    svgRoot.setAttribute('tabindex', '0')

    const desc = svg('desc', { text: description })
    svgRoot.insertBefore(desc, svgRoot.firstChild)

    // Announcements are throttled by replacing the text, not appending, so rapid
    // arrow-key travel does not flood the screen reader.
    this.liveRegion = html('div', {
      class: 'apexmaps-sr-only',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true',
    })
    this.container.appendChild(this.liveRegion)

    svgRoot.addEventListener('keydown', this._onKeyDown)
  }

  /**
   * @param anchorOf World-space anchor lookup, used only for reading order.
   */
  setNavigationOrder(
    features: NormalizedFeature[],
    anchorOf: (feature: NormalizedFeature) => WorldPoint | undefined,
  ): void {
    const limit = this.options.keyboardFeatureLimit ?? 500
    if (features.length > limit) {
      // Above the limit, keyboard walking is not a useful interaction. The data
      // table (and the description) remain the accessible path.
      this.order = []
      return
    }
    // Reading order: top to bottom, then left to right, in bands. Raw y-sorting
    // zigzags across a wide map and is disorienting to walk.
    const band = 24
    this.order = [...features].sort((a, b) => {
      const pa = anchorOf(a)
      const pb = anchorOf(b)
      const ay = Math.round((pa?.[1] ?? 0) / band)
      const by = Math.round((pb?.[1] ?? 0) / band)
      if (ay !== by) return ay - by
      return (pa?.[0] ?? 0) - (pb?.[0] ?? 0)
    })
  }

  private _handleKeyDown(event: KeyboardEvent): void {
    if (!this.order.length) return
    const { key } = event

    if (key === 'ArrowRight' || key === 'ArrowDown') {
      event.preventDefault()
      this._moveCursor(1)
    } else if (key === 'ArrowLeft' || key === 'ArrowUp') {
      event.preventDefault()
      this._moveCursor(-1)
    } else if (key === 'Home') {
      event.preventDefault()
      this.cursor = 0
      this._announceCursor()
    } else if (key === 'End') {
      event.preventDefault()
      this.cursor = this.order.length - 1
      this._announceCursor()
    } else if (key === 'Enter' || key === ' ') {
      if (this.cursor >= 0) {
        event.preventDefault()
        this.access().select(this.order[this.cursor])
      }
    } else if (key === 'Escape') {
      this.cursor = -1
      this.svgRoot?.blur()
    }
  }

  private _moveCursor(delta: number): void {
    if (this.cursor === -1) this.cursor = delta > 0 ? 0 : this.order.length - 1
    else this.cursor = (this.cursor + delta + this.order.length) % this.order.length
    this._announceCursor()
  }

  private _announceCursor(): void {
    const feature = this.order[this.cursor]
    if (!feature) return
    const api = this.access()
    api.focus(feature)
    this.announce(api.describe(feature))
  }

  announce(message: string): void {
    if (this.liveRegion) this.liveRegion.textContent = message
  }

  /**
   * Hidden data table fallback.
   *
   */
  renderTable({
    caption,
    columns,
    rows,
  }: {
    caption: string
    columns: string[]
    rows: (string | number)[][]
  }): void {
    if (this.options.dataTable !== true) return
    remove(this.table)

    const thead = html('thead', {}, [
      html(
        'tr',
        {},
        columns.map((c) => html('th', { scope: 'col', text: c })),
      ),
    ])
    const tbody = html(
      'tbody',
      {},
      rows.map((r) =>
        html(
          'tr',
          {},
          r.map((cell, i) =>
            i === 0
              ? html('th', { scope: 'row', text: String(cell) })
              : html('td', { text: String(cell) }),
          ),
        ),
      ),
    )

    this.table = html('table', { class: 'apexmaps-data-table apexmaps-sr-only' }, [
      html('caption', { text: caption }),
      thead,
      tbody,
    ])
    this.container.appendChild(this.table)
  }

  /**
   * Auto-generate the map description.
   *
   * Says what kind of map it is, what it shows, the range, and the extremes,
   * because "a map of Europe" tells a screen-reader user nothing they can act on.
   *
   */
  static describe({
    type,
    featureCount,
    seriesName,
    domain,
    extremes = [],
    classDescription,
    noDataCount = 0,
  }: {
    type: string
    featureCount: number
    seriesName?: string
    domain?: [number, number]
    extremes?: { name: string; value: number }[]
    classDescription?: string
    noDataCount?: number
  }): string {
    const parts: string[] = []
    parts.push(`${type} map of ${featureCount} ${featureCount === 1 ? 'area' : 'areas'}`)
    if (seriesName) parts.push(`showing ${seriesName}`)
    if (domain && Number.isFinite(domain[0]) && Number.isFinite(domain[1])) {
      parts.push(`values range from ${formatValue(domain[0])} to ${formatValue(domain[1])}`)
    }
    if (classDescription) parts.push(classDescription)
    if (extremes.length) {
      parts.push(
        `highest: ${extremes.map((e) => `${e.name} at ${formatValue(e.value)}`).join(', ')}`,
      )
    }
    if (noDataCount > 0) {
      parts.push(`${noDataCount} ${noDataCount === 1 ? 'area has' : 'areas have'} no data`)
    }
    return `${parts.join('. ')}.`
  }

  destroy(): void {
    if (this.svgRoot) this.svgRoot.removeEventListener('keydown', this._onKeyDown)
    remove(this.liveRegion)
    remove(this.table)
    this.liveRegion = null
    this.table = null
    this.svgRoot = null
    this.order = []
    this.cursor = -1
  }
}

function formatValue(v: number): string {
  if (!Number.isFinite(v)) return String(v)
  if (Number.isInteger(v)) return v.toLocaleString()
  return v.toFixed(2)
}
