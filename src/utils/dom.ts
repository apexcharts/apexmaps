/**
 * Minimal DOM and SVG helpers.
 *
 * Deliberately dependency-free and namespace-correct: `createElement` on an SVG
 * tag silently produces an unrenderable HTML element, which is a bug class worth
 * designing out rather than debugging.
 *
 * @module utils/dom
 */

export const SVG_NS = 'http://www.w3.org/2000/svg'
export const XHTML_NS = 'http://www.w3.org/1999/xhtml'

/** Attribute values accepted by {@link setAttrs}. */
export type AttrValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Partial<CSSStyleDeclaration>
  | Record<string, string | number>
  | ((event: Event) => void)

export type Attrs = Record<string, AttrValue>

/**
 * Create an SVG element in the correct namespace.
 */
export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Element | null)[] = [],
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag)
  setAttrs(el, attrs)
  for (const child of children) if (child) el.appendChild(child)
  return el
}

export function html<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | null)[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  setAttrs(el, attrs)
  for (const child of children) if (child) el.appendChild(child)
  return el
}

/**
 * Set attributes, with `class`, `style`, `text`, `dataset` and `on*` handled
 * specially. `null`, `undefined` and `false` are skipped so callers can pass
 * conditional values inline.
 */
export function setAttrs(el: Element, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue

    if (key === 'class' || key === 'className') {
      el.setAttribute('class', String(value))
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign((el as HTMLElement).style, value)
    } else if (key === 'text') {
      el.textContent = String(value)
    } else if (key === 'dataset' && typeof value === 'object') {
      for (const [dk, dv] of Object.entries(value as Record<string, unknown>)) {
        el.setAttribute(`data-${dk}`, String(dv))
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    } else {
      el.setAttribute(key, value === true ? '' : String(value))
    }
  }
}

export function remove(el: Element | null | undefined): void {
  if (el && el.parentNode) el.parentNode.removeChild(el)
}

export function empty(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild)
}

/**
 * Resolve a CSS size (`'100%'`, `400`, `'50vh'`) against a container.
 */
export function resolveSize(
  value: string | number | undefined,
  containerSize: number,
  fallback: number,
): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.endsWith('%')) {
      const pct = Number.parseFloat(trimmed)
      if (Number.isFinite(pct) && containerSize > 0) return (containerSize * pct) / 100
      return fallback
    }
    const n = Number.parseFloat(trimmed)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

/**
 * Pointer position relative to an element, correct under CSS transforms and
 * scrolling, which `offsetX` is not.
 */
export function pointerPosition(el: Element, event: MouseEvent | Touch): [number, number] {
  const rect = el.getBoundingClientRect()
  return [event.clientX - rect.left, event.clientY - rect.top]
}

export function escapeHtml(text: unknown): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Whether a usable DOM exists. Guards every render path so the bundle stays
 * importable under SSR.
 */
export function hasDom(): boolean {
  return typeof document !== 'undefined' && typeof window !== 'undefined'
}
