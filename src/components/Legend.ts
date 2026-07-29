/**
 * Legend.
 *
 * A choropleth is won or lost here: the legend is the only place a reader learns
 * what the colours mean and where the class boundaries fell. So it renders the
 * actual computed breaks (never a decorative gradient), shows the no-data swatch
 * whenever any feature lacks data, and is interactive by default because muting a
 * class is the cheapest useful exploration available.
 *
 * Bubble series get a **nested-circle** legend instead: three reference circles
 * drawn concentrically at round values. It is the only bubble legend that lets a
 * reader decode areas rather than guess them, and almost nobody ships it.
 *
 * @module components/Legend
 */

import { html, svg, remove, empty } from '../utils/dom'
import type { LegendItem, LegendOptions, SizeLegendEntry } from '../types'

export interface LegendSection {
  title?: string
  /** Classed or gradient colour legend. */
  items?: LegendItem[]
  continuous?: boolean
  gradient?: { offset: number; color: string }[]
  /** Nested-circle size legend, for proportional symbols. */
  sizes?: SizeLegendEntry[]
  /** Index of the series this section describes, for muting callbacks. */
  seriesIndex?: number
}

export class Legend {
  readonly container: HTMLElement
  /** Re-pointed at the live config on every draw; see `_syncComponentOptions`. */
  options: LegendOptions
  readonly onToggle: (classIndex: number, muted: boolean, seriesIndex: number) => void
  el: HTMLElement | null = null
  /** Muted class indices, keyed by series index. */
  readonly muted = new Map<number, Set<number>>()

  constructor({
    container,
    options,
    onToggle,
  }: {
    container: HTMLElement
    options: LegendOptions
    onToggle?: (classIndex: number, muted: boolean, seriesIndex: number) => void
  }) {
    this.container = container
    this.options = options || {}
    this.onToggle = onToggle ?? (() => {})
  }

  /** Render one section per series that has something to explain. */
  render(sections: LegendSection[]): void {
    if (this.options.show === false) return

    const meaningful = sections.filter(
      (s) => (s.items && s.items.length) || (s.sizes && s.sizes.length) || s.gradient?.length,
    )
    if (!meaningful.length) {
      remove(this.el)
      this.el = null
      return
    }

    if (!this.el) {
      this.el = html('div')
      this.container.appendChild(this.el)
    }
    // Re-applied on every render, not only at creation: `position` and `align`
    // are the two legend options a caller is most likely to change through
    // `updateOptions` or a responsive rule, and setting the class once meant
    // both changed the config and moved nothing.
    this.el.setAttribute(
      'class',
      `apexmaps-legend apexmaps-legend--${this.options.position || 'bottom'}` +
        ` apexmaps-legend--align-${this.options.align || 'center'}`,
    )
    empty(this.el)

    for (const section of meaningful) {
      this.el.appendChild(this.renderSection(section))
    }
  }

  private renderSection(section: LegendSection): HTMLElement {
    const wrap = html('div', { class: 'apexmaps-legend-section' })

    const title = this.options.title ?? section.title
    if (title) {
      wrap.appendChild(html('div', { class: 'apexmaps-legend-title', text: title }))
    }

    if (section.sizes?.length) {
      wrap.appendChild(this.sizeLegend(section.sizes))
      return wrap
    }

    // The no-data swatch is always the last item, so dropping it leaves the
    // class indices the muting callback reports unchanged.
    const items =
      this.options.showNull === false
        ? (section.items ?? []).filter((i) => !i.isNull)
        : (section.items ?? [])

    const style =
      this.options.style === 'auto' || !this.options.style
        ? section.continuous
          ? 'gradient'
          : 'classes'
        : this.options.style

    if (style === 'gradient' && section.gradient?.length) {
      wrap.appendChild(this.gradientBar(items, section.gradient))
    } else {
      wrap.appendChild(this.classList(items, section.seriesIndex ?? 0))
    }
    return wrap
  }

  private classList(items: LegendItem[], seriesIndex: number): HTMLElement {
    const list = html('div', { class: 'apexmaps-legend-items', role: 'list' })
    const mutedSet = this.mutedFor(seriesIndex)

    items.forEach((item, i) => {
      const interactive = this.options.interactive !== false && !item.isNull
      const isMuted = mutedSet.has(i)
      const label = this.options.formatter ? this.options.formatter(item, i) : item.label

      const entry = html(
        interactive ? 'button' : 'div',
        {
          class: `apexmaps-legend-item${isMuted ? ' is-muted' : ''}${item.isNull ? ' is-null' : ''}`,
          role: interactive ? undefined : 'listitem',
          type: interactive ? 'button' : undefined,
          'aria-pressed': interactive ? String(!isMuted) : undefined,
          title:
            item.count != null
              ? `${item.label} (${item.count} ${item.count === 1 ? 'feature' : 'features'})`
              : item.label,
        },
        [
          html('span', {
            class: 'apexmaps-legend-swatch',
            style: { background: item.color },
            'aria-hidden': 'true',
          }),
          html('span', { class: 'apexmaps-legend-label', text: label }),
        ],
      )

      if (interactive) {
        entry.addEventListener('click', () => {
          const nowMuted = !mutedSet.has(i)
          if (nowMuted) mutedSet.add(i)
          else mutedSet.delete(i)
          entry.classList.toggle('is-muted', nowMuted)
          entry.setAttribute('aria-pressed', String(!nowMuted))
          this.onToggle(i, nowMuted, seriesIndex)
        })
      }

      list.appendChild(entry)
    })

    return list
  }

  private gradientBar(
    items: LegendItem[],
    gradient: { offset: number; color: string }[],
  ): HTMLElement {
    const stops = gradient.map((s) => `${s.color} ${(s.offset * 100).toFixed(1)}%`).join(', ')
    const nullItem = items.find((i) => i.isNull)
    const first = items.find((i) => !i.isNull)
    const last = [...items].reverse().find((i) => !i.isNull)

    const wrap = html('div', { class: 'apexmaps-legend-gradient-wrap' }, [
      html('div', {
        class: 'apexmaps-legend-gradient',
        style: { background: `linear-gradient(to right, ${stops})` },
        'aria-hidden': 'true',
      }),
      html('div', { class: 'apexmaps-legend-gradient-labels' }, [
        html('span', { text: first?.label ?? '' }),
        html('span', { text: last?.label ?? '' }),
      ]),
    ])

    if (nullItem) {
      wrap.appendChild(
        html('div', { class: 'apexmaps-legend-item is-null' }, [
          html('span', {
            class: 'apexmaps-legend-swatch',
            style: { background: nullItem.color },
            'aria-hidden': 'true',
          }),
          html('span', {
            class: 'apexmaps-legend-label',
            text: nullItem.label,
          }),
        ]),
      )
    }

    return wrap
  }

  /**
   * Nested circles, sharing a bottom edge so their diameters line up and the areas
   * can be compared directly.
   */
  private sizeLegend(sizes: SizeLegendEntry[]): HTMLElement {
    const largest = sizes[0]
    if (!largest) return html('div')

    const pad = 2
    const width = largest.radius * 2 + pad * 2 + 56
    const height = largest.radius * 2 + pad * 2 + 14
    const baseline = height - pad - 1
    const centreX = largest.radius + pad

    const children: SVGElement[] = []
    for (const entry of sizes) {
      children.push(
        svg('circle', {
          cx: centreX,
          cy: baseline - entry.radius,
          r: entry.radius,
          fill: 'none',
          stroke: 'currentColor',
          'stroke-opacity': 0.55,
        }),
      )
      // Tick plus label at the top of each circle, which is where its diameter is
      // easiest to read against the shared baseline.
      children.push(
        svg('line', {
          x1: centreX,
          x2: centreX + largest.radius + 6,
          y1: baseline - entry.radius * 2,
          y2: baseline - entry.radius * 2,
          stroke: 'currentColor',
          'stroke-opacity': 0.25,
          'stroke-dasharray': '2 2',
        }),
      )
      children.push(
        svg('text', {
          x: centreX + largest.radius + 9,
          y: baseline - entry.radius * 2,
          'dominant-baseline': 'middle',
          'font-size': 10,
          fill: 'currentColor',
          text: entry.label,
        }),
      )
    }

    const chart = svg(
      'svg',
      {
        class: 'apexmaps-legend-sizes',
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        'aria-label': `Circle sizes: ${sizes.map((s) => s.label).join(', ')}`,
      },
      children,
    )

    return html('div', { class: 'apexmaps-legend-size-wrap' }, [chart])
  }

  private mutedFor(seriesIndex: number): Set<number> {
    let set = this.muted.get(seriesIndex)
    if (!set) {
      set = new Set<number>()
      this.muted.set(seriesIndex, set)
    }
    return set
  }

  /** Screen-reader text describing a colour scale, used by the a11y description. */
  static describe(items: LegendItem[]): string {
    const real = items.filter((i) => !i.isNull)
    if (!real.length) return ''
    // Class labels are ranges, so naming the lowest and highest label produced
    // "5 classes from 12 to 19 to 82 to 92": four numbers and three "to"s, which a
    // screen reader has no way to parse. Say the span, then the lowest class.
    const lowest = real[0]
    const highest = real[real.length - 1]
    const from = lowest.from ?? lowest.label
    const to = highest.to ?? highest.label
    return `${real.length} classes spanning ${from} to ${to}, the lowest being ${lowest.label}`
  }

  reset(): void {
    this.muted.clear()
  }

  destroy(): void {
    remove(this.el)
    this.el = null
    this.muted.clear()
  }
}
