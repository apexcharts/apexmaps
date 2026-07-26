/**
 * Tooltip.
 *
 * An HTML overlay rather than SVG text: real text wrapping, real CSS, and no
 * clipping by the SVG viewport. Positioning flips near the container edges so a
 * tooltip on a feature at the right margin does not fall off the map.
 *
 * @module components/Tooltip
 */

import { html, remove, escapeHtml } from '../utils/dom'
import type { ScreenPoint, TooltipOptions } from '../types'

export class Tooltip {
  readonly container: HTMLElement
  readonly options: TooltipOptions
  el: HTMLElement | null = null
  visible = false

  constructor({ container, options }: { container: HTMLElement; options: TooltipOptions }) {
    this.container = container
    this.options = options || {}
  }

  mount(): void {
    if (this.el || this.options.enabled === false) return
    this.el = html('div', {
      class: 'apexmaps-tooltip',
      role: 'tooltip',
      'aria-hidden': 'true',
      style: { display: 'none' },
    })
    this.container.appendChild(this.el)
  }

  show({ point, html: markup }: { point: ScreenPoint; html: string }): void {
    if (!this.el) return
    this.el.innerHTML = markup
    this.el.style.display = 'block'
    this.el.setAttribute('aria-hidden', 'false')
    this.visible = true
    this.move(point)
  }

  move([x, y]: ScreenPoint): void {
    if (!this.el || !this.visible) return
    const [ox, oy] = this.options.offset || [12, 12]
    const bounds = this.container.getBoundingClientRect()
    const size = this.el.getBoundingClientRect()

    // Flip rather than clamp: a tooltip that slides along the edge covers the
    // feature the reader is pointing at.
    let left = x + ox
    let top = y + oy
    if (left + size.width > bounds.width) left = Math.max(0, x - size.width - ox)
    if (top + size.height > bounds.height) top = Math.max(0, y - size.height - oy)

    this.el.style.left = `${left}px`
    this.el.style.top = `${top}px`
  }

  hide(): void {
    if (!this.el) return
    this.el.style.display = 'none'
    this.el.setAttribute('aria-hidden', 'true')
    this.visible = false
  }

  destroy(): void {
    remove(this.el)
    this.el = null
    this.visible = false
  }

  /**
   * Default tooltip content: name, value, and the join key when it differs from
   * the name (which is exactly when a developer is debugging a join).
   *
   */
  static defaultContent({
    feature,
    value,
    datum,
    series,
    format,
  }: {
    feature: { key?: string; name?: string }
    value: number | null
    datum: unknown
    series?: { config?: { name?: string }; scale?: { nullLabel?: string } }
    format?: (v: number) => string
  }): string {
    const title = feature.name || feature.key || 'Unknown'
    const seriesName = series?.config?.name
    const formatted =
      value == null
        ? (series?.scale?.nullLabel ?? 'No data')
        : format
          ? format(value)
          : String(value)

    const rows: string[] = []
    rows.push(`<div class="apexmaps-tooltip-title">${escapeHtml(title)}</div>`)
    if (feature.key && feature.name && feature.key !== feature.name) {
      rows.push(`<div class="apexmaps-tooltip-key">${escapeHtml(feature.key)}</div>`)
    }
    rows.push(
      `<div class="apexmaps-tooltip-row">` +
        (seriesName
          ? `<span class="apexmaps-tooltip-label">${escapeHtml(seriesName)}</span>`
          : '') +
        `<span class="apexmaps-tooltip-value">${escapeHtml(formatted)}</span>` +
        `</div>`,
    )

    // Surface the raw datum's other numeric fields, which saves a round trip to
    // the console when the value looks wrong.
    if (datum && typeof datum === 'object') {
      const extras = Object.entries(datum as Record<string, unknown>)
        .filter(([k, v]) => k !== 'value' && (typeof v === 'number' || typeof v === 'string'))
        .slice(0, 3)
      for (const [k, v] of extras) {
        rows.push(
          `<div class="apexmaps-tooltip-row apexmaps-tooltip-extra">` +
            `<span class="apexmaps-tooltip-label">${escapeHtml(k)}</span>` +
            `<span class="apexmaps-tooltip-value">${escapeHtml(String(v))}</span>` +
            `</div>`,
        )
      }
    }

    return rows.join('')
  }
}
