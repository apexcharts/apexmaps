/**
 * Static export: the current view as a standalone SVG file or a PNG raster.
 *
 * The exported SVG must survive leaving the page, and on the page its
 * appearance comes from two different places: marks carry presentation
 * attributes (`fill` from the colour scale), while everything else is styled by
 * the injected stylesheet through classes and `--apexmaps-*` custom properties.
 * A serialized clone keeps the first and silently loses the second, which is
 * the classic broken map export: right shapes, wrong everything else.
 *
 * So the clone gets the *computed* style of every node inlined onto it, for a
 * whitelist of visual properties. Computed values have custom properties and
 * dark mode already resolved, so what leaves the page is what was on it, with
 * no second copy of the stylesheet to keep in sync.
 *
 * What this deliberately does not cover in P1: the legend and tooltips are
 * HTML outside the SVG, so the export is the map plot itself. Fonts are named,
 * not embedded; a viewer without the page's font falls back.
 *
 * @module export/Exporter
 */

import { SVG_NS } from '../utils/dom'

export interface ExportOptions {
  /**
   * Painted behind the map. SVG defaults to none (transparent, like the live
   * chart); PNG defaults to the container's own background so a dark-mode
   * screenshot does not arrive as text floating on nothing, falling back to
   * white.
   */
  background?: string
  /** PNG pixel-density multiplier. 2 survives print and retina. */
  scale?: number
  /** Without extension. Defaults to the map id, or `apexmaps`. */
  filename?: string
}

/**
 * The visual properties worth carrying, split by how CSS propagates them,
 * because that decides when a value can be omitted. Layout properties are
 * absent on purpose: geometry lives in attributes (`d`, `transform`,
 * `viewBox`) and the clone keeps attributes for free.
 *
 * Inherited properties are written on the root as the document's baseline and
 * on a descendant only where its computed value differs from its parent's.
 * Without that, every one of a large map's thousands of nodes carries an
 * identical blob of inherited values and the export balloons by a megabyte
 * saying nothing.
 */
const INHERITED = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'visibility',
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'letter-spacing',
  'text-anchor',
  'dominant-baseline',
  'paint-order',
] as const

/** Not inherited, so "same as parent" proves nothing; compare to the initial value. */
const NON_INHERITED_INITIALS: Record<string, string[]> = {
  opacity: ['1'],
  display: ['inline', 'block'],
  'mix-blend-mode': ['normal'],
}

/**
 * Serialize the live SVG root into a standalone document.
 *
 * Walks the original and the clone in parallel: `querySelectorAll('*')` returns
 * document order, so index N in one is index N in the other, and an element's
 * parent has always been visited before it.
 */
export function serializeSvg(root: SVGSVGElement, options: ExportOptions = {}): string {
  const clone = root.cloneNode(true) as SVGSVGElement

  const sources = [root, ...Array.from(root.querySelectorAll('*'))]
  const targets = [clone, ...Array.from(clone.querySelectorAll('*'))]

  // Computed styles of already-visited originals, so each parent lookup is a
  // map hit rather than a second getComputedStyle pass.
  const seen = new Map<Element, CSSStyleDeclaration>()

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]
    const computed = getComputedStyle(source)
    seen.set(source, computed)

    const style = (targets[i] as SVGElement | HTMLElement).style
    if (!style) continue

    const parent = source === root ? null : seen.get(source.parentElement as Element)

    for (const property of INHERITED) {
      const value = computed.getPropertyValue(property)
      // jsdom computes almost nothing for SVG; an empty value written out as
      // `fill:;` would be worse than the omission.
      if (!value) continue
      if (parent && parent.getPropertyValue(property) === value) continue
      style.setProperty(property, value)
    }

    for (const [property, initials] of Object.entries(NON_INHERITED_INITIALS)) {
      const value = computed.getPropertyValue(property)
      if (!value || initials.includes(value)) continue
      style.setProperty(property, value)
    }
  }

  // A standalone file has no enclosing document to inherit from.
  clone.setAttribute('xmlns', SVG_NS)
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')

  // Interaction residue that means nothing outside the page.
  clone.style.touchAction = ''
  clone.removeAttribute('tabindex')

  if (options.background) {
    const rect = clone.ownerDocument.createElementNS(SVG_NS, 'rect')
    rect.setAttribute('width', '100%')
    rect.setAttribute('height', '100%')
    rect.setAttribute('fill', options.background)
    clone.insertBefore(rect, clone.firstChild)
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`
}

/**
 * The first opaque background above (and including) the element, so a PNG of a
 * dark-mode map arrives dark rather than as pale strokes on transparency.
 */
export function inheritedBackground(element: Element | null): string | null {
  for (let node = element; node; node = node.parentElement) {
    const value = getComputedStyle(node).backgroundColor
    if (value && value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)') return value
  }
  return null
}

/**
 * Rasterize SVG markup through an offscreen image and canvas.
 *
 * Everything the markup references must be inline, which `serializeSvg`
 * guarantees: an SVG loaded as an image fetches nothing.
 */
export function rasterize(
  markup: string,
  { width, height, scale = 2 }: { width: number; height: number; scale?: number },
): Promise<Blob> {
  return new Promise((resolvePng, reject) => {
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))

    let context: CanvasRenderingContext2D | null
    try {
      context = canvas.getContext('2d')
    } catch {
      context = null
    }
    if (!context) {
      reject(
        new Error(
          'PNG export needs a canvas 2d context, which this environment does not provide. ' +
            'Export SVG instead, or run in a browser.',
        ),
      )
      return
    }
    const ctx = context

    // An object URL keeps large maps off the data-URI size cliff; the data URI
    // remains as the fallback for environments without createObjectURL.
    const hasObjectUrl = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
    const source = hasObjectUrl
      ? URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }))
      : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
    const release = () => {
      if (hasObjectUrl) URL.revokeObjectURL(source)
    }

    const image = new Image()
    image.onload = () => {
      try {
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
        if (typeof canvas.toBlob === 'function') {
          canvas.toBlob((blob) => {
            release()
            if (blob) resolvePng(blob)
            else reject(new Error('The canvas produced no PNG data.'))
          }, 'image/png')
        } else {
          const dataUrl = canvas.toDataURL('image/png')
          release()
          resolvePng(dataUrlToBlob(dataUrl))
        }
      } catch (error) {
        release()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    image.onerror = () => {
      release()
      reject(new Error('The browser could not decode the exported SVG as an image.'))
    }
    image.src = source
  })
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(',')
  const mime = head.match(/data:([^;]+)/)?.[1] ?? 'image/png'
  const bytes = atob(body)
  const buffer = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) buffer[i] = bytes.charCodeAt(i)
  return new Blob([buffer], { type: mime })
}

/** Trigger a client-side download without navigating. */
export function download(data: Blob | string, filename: string): void {
  const hasObjectUrl = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
  const isBlob = typeof data !== 'string'

  const href =
    isBlob && hasObjectUrl
      ? URL.createObjectURL(data)
      : isBlob
        ? '' // no way to reference a blob; caller should have passed a string fallback
        : data

  if (!href) throw new Error('This environment cannot create a download URL.')

  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()

  if (isBlob && hasObjectUrl) {
    // Not synchronously: the click's navigation may still be reading it.
    setTimeout(() => URL.revokeObjectURL(href), 1000)
  }
}

/** Blob → data URI, for `dataURI()` consumers embedding the image directly. */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolveUri, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolveUri(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the exported blob.'))
    reader.readAsDataURL(blob)
  })
}
