/**
 * Colour maths, in OkLab.
 *
 * Interpolating through sRGB turns the midpoint of most ramps muddy grey, which
 * is why every ramp here is sampled in OkLab (Ottosson, 2020): a perceptual
 * space where equal numeric steps read as equal visual steps. This is a
 * correctness property of a choropleth, not a nicety, because the reader infers
 * magnitude from perceived lightness.
 *
 * The primitives the Apex products share (the OkLab conversions, the
 * `oklab()`/`oklch()` reader, hex and `rgba()` formatting, WCAG luminance and
 * contrast) come from apex-commons, which took them from this file verbatim.
 * What stays here is what only the maps do: the lax parser and its browser
 * probe with the per-map cache, the OkLab ramps, and the lightness step behind
 * hover, whose clamping differs from the shared shade at the ends of the range.
 *
 * @module scales/Color
 */

import {
  contrastRatio as channelContrast,
  formatColor,
  luminance as channelLuminance,
  oklabToRgb,
  parseOklab,
  rgbToOklab,
} from 'apex-commons'

import { hasDom } from '../utils/dom'

export { oklabToRgb, rgbToOklab }

/** Components in 0..255. */
export type RGB = [number, number, number]
/** Components in 0..255, then alpha in 0..1. */
export type RGBA = [number, number, number, number]
/** Perceptual lightness plus two opponent axes. */
export type OkLab = [number, number, number]

/**
 * Parse any CSS colour into 0..255 components, dropping alpha. See `parseRgba`.
 */
export function parseColor(input: string): RGB | null {
  const c = parseRgba(input)
  return c ? [c[0], c[1], c[2]] : null
}

/**
 * Parse any CSS colour into 0..255 components plus alpha.
 *
 * Hex and every `rgb()` syntax are read here, as are the `oklab()`, `oklch()`
 * and `color(srgb ...)` forms, because those are what a browser hands back for
 * colours it does not convert to rgb. Everything else (names, `hsl()`, `var()`)
 * is resolved by the browser, inside the map's element when one is in scope (see
 * `withColorScope`), so a token defined on the map's container resolves. With no
 * DOM, or for a value the browser cannot resolve either, the result is null and
 * each helper below keeps the literal it was given.
 */
export function parseRgba(input: string): RGBA | null {
  if (typeof input !== 'string') return null
  const s = input.trim()
  return parseLegacy(s) ?? parseModern(s) ?? resolveInBrowser(s)
}

/**
 * Hex, and `rgb()`/`rgba()` with plain numbers: the forms this module has always
 * read. Kept as its own first pass so their channels, and every hex the helpers
 * derive from them, stay exactly what they were.
 */
function parseLegacy(s: string): RGBA | null {
  if (s[0] === '#') {
    const hex = s.slice(1)
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16)
      const g = parseInt(hex[1] + hex[1], 16)
      const b = parseInt(hex[2] + hex[2], 16)
      if (Number.isNaN(r + g + b)) return null
      return [r, g, b, hex.length === 4 ? hexAlpha(hex[3] + hex[3]) : 1]
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16)
      const g = parseInt(hex.slice(2, 4), 16)
      const b = parseInt(hex.slice(4, 6), 16)
      if (Number.isNaN(r + g + b)) return null
      return [r, g, b, hex.length === 8 ? hexAlpha(hex.slice(6, 8)) : 1]
    }
    return null
  }

  const m = s.match(/^rgba?\(([^)]+)\)$/i)
  if (m) {
    const raw = m[1].split(/[\s,/]+/).filter(Boolean)
    const parts = raw.map(Number)
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => !Number.isNaN(n))) {
      return [parts[0], parts[1], parts[2], raw.length > 3 ? alphaOf(raw[3]) : 1]
    }
  }
  return null
}

function hexAlpha(pair: string): number {
  const a = parseInt(pair, 16)
  return Number.isNaN(a) ? 1 : a / 255
}

/** An alpha token, `0.5` or `50%`. Unreadable alpha means opaque, as it always did. */
function alphaOf(token: string | undefined): number {
  if (token == null) return 1
  const a = channel(token, 1)
  return Number.isNaN(a) ? 1 : Math.max(0, Math.min(1, a))
}

/** A number, a percentage of `full`, or `none` (zero). NaN when unreadable. */
function channel(token: string, full: number): number {
  if (!token) return NaN
  if (token === 'none') return 0
  if (token.endsWith('%')) return (Number(token.slice(0, -1)) / 100) * full
  return Number(token)
}

/**
 * The CSS colour functions read without a browser: the rest of the `rgb()`
 * syntax (percentages, `none`), `oklab()`, `oklch()`, `color(srgb ...)` and
 * `transparent`. Out-of-gamut OkLab colours are clipped to sRGB.
 */
function parseModern(s: string): RGBA | null {
  if (/^transparent$/i.test(s)) return [0, 0, 0, 0]
  const m = s.match(/^([a-z-]+)\(([^()]*)\)$/i)
  if (!m) return null
  const fn = m[1].toLowerCase()
  const args = m[2].split(/[\s,/]+/).filter(Boolean)

  let rgb: number[] | null = null
  let alpha = args[3]
  if (fn === 'rgb' || fn === 'rgba') {
    rgb = args.slice(0, 3).map((t) => channel(t, 255))
  } else if (fn === 'oklab' || fn === 'oklch') {
    return parseOklab(s)
  } else if (fn === 'color' && (args[0] === 'srgb' || args[0] === 'srgb-linear')) {
    const linear = args[0] === 'srgb-linear'
    rgb = args.slice(1, 4).map((t) => {
      const v = channel(t, 1)
      return (linear ? toGamma(Math.max(0, Math.min(1, v))) : v) * 255
    })
    alpha = args[4]
  }
  if (!rgb || rgb.length < 3 || rgb.some(Number.isNaN)) return null
  return [rgb[0], rgb[1], rgb[2], alphaOf(alpha)]
}

// --- browser resolution ------------------------------------------------------

interface ColorScope {
  el: Element | null
  unresolved?: Set<string>
}

let scope: ColorScope | null = null

/**
 * Browser resolutions per map element. They outlive one call because a scale
 * keeps sampling its ramp after the build (every feature, a tooltip, an export),
 * and probing the DOM each time would force a style recalc per sample. The map
 * clears its entry with `clearColorCache` whenever it rebuilds, which is when a
 * changed token can first matter.
 */
const caches = new WeakMap<Element, Map<string, RGBA | null>>()

/**
 * Run `fn` with colours the browser has to resolve resolved inside `el`, so a
 * `var()` set on the map's container (or a theme class around it) means what it
 * means there. With no `el` they resolve against the document, uncached. Values
 * the browser cannot resolve either are added to `unresolved`.
 */
export function withColorScope<T>(
  el: Element | null | undefined,
  fn: () => T,
  unresolved?: Set<string>,
): T {
  const outer = scope
  const same = outer !== null && outer.el === (el ?? null)
  scope = { el: el ?? null, unresolved: unresolved ?? (same ? outer.unresolved : undefined) }
  try {
    return fn()
  } finally {
    scope = outer
  }
}

/** Forget what colours resolved to inside `el`, so the next read sees current tokens. */
export function clearColorCache(el: Element | null | undefined): void {
  if (el) caches.delete(el)
}

/** The element colours currently resolve in, for work that runs later. */
export function colorScopeElement(): Element | null {
  return scope?.el ?? null
}

/** Whether reading `color` needs the browser: false for hex, rgb(), oklab() and the like. */
export function needsBrowser(color: string): boolean {
  if (typeof color !== 'string') return false
  const s = color.trim()
  return parseLegacy(s) === null && parseModern(s) === null
}

/** Valid SVG paints that are not colours: kept as written, and never reported. */
const NOT_A_COLOR = /^(none|url\(.*\)|context-fill|context-stroke)$/i

function resolveInBrowser(s: string): RGBA | null {
  if (!s || !hasDom()) return null
  const el = scope?.el ?? null
  // A detached element computes no style, so nothing can be read inside it.
  // Names, `hsl()` and `hwb()` mean the same anywhere and are read against the
  // document instead. A `var()` or `currentColor` depends on where the map ends
  // up, so it stays as written, neither cached nor reported, until a build after
  // the element is attached.
  const detached = el !== null && el.isConnected === false
  if (detached && /var\(|currentcolor/i.test(s)) return null
  let cache = el ? caches.get(el) : undefined
  let out = cache?.get(s)
  if (out === undefined) {
    let got: RGBA | null | undefined
    try {
      const doc = el && !detached ? null : (el?.ownerDocument ?? document)
      got = probe(s, doc ? (doc.body ?? doc.documentElement) : el!)
    } catch {
      got = null
    }
    // Nowhere to compute it: not an answer, so it is neither kept nor reported.
    if (got === undefined) return null
    out = got
    if (el) {
      if (!cache) caches.set(el, (cache = new Map()))
      cache.set(s, out)
    }
  }
  if (!out && !NOT_A_COLOR.test(s)) scope?.unresolved?.add(s)
  return out
}

/**
 * Let the browser compute `input` as a `color` value inside `host`. An unknown
 * `var()` computes to the inherited colour, which would read as an answer, so the
 * probe inherits from a sentinel instead and a match means "not resolved".
 * `currentColor` is meant to inherit, so it keeps the host's colour. Undefined
 * when the host computes no style at all.
 */
function probe(input: string, host: Element): RGBA | null | undefined {
  const doc = host.ownerDocument
  const view = doc.defaultView
  if (!view) return null
  const wrap = doc.createElement('span')
  const span = doc.createElement('span')
  wrap.style.display = 'none'
  const current = /^currentcolor$/i.test(input)
  if (!current) wrap.style.color = 'rgba(1, 2, 3, 0.01)'
  span.style.color = input
  // The style parser drops what it cannot read, so an empty value is a refusal.
  if (!span.style.color) return null
  wrap.appendChild(span)
  host.appendChild(wrap)
  try {
    const got = view.getComputedStyle(span).color
    const inherited = view.getComputedStyle(wrap).color
    if (!inherited) return undefined
    if (!current && got === inherited) return null
    return parseLegacy(got) ?? parseModern(got)
  } finally {
    wrap.remove()
  }
}

/** Opaque colours as hex, as always; translucent ones as `rgba()`, alpha to 3 places. */
function format(rgb: RGB, alpha: number): string {
  return formatColor([rgb[0], rgb[1], rgb[2], alpha], 3)
}

/**
 * `color` as `#rrggbb`, or `rgba()` when translucent, clipped to sRGB: what it
 * computes to inside the map in scope (see `withColorScope`). Null when it
 * cannot be read, so a caller can treat it as absent.
 */
export function normalizeColor(color: string): string | null {
  const c = parseRgba(color)
  return c ? format([c[0], c[1], c[2]], c[3]) : null
}

/** Whether `color` is one of the forms read before any CSS colour was. */
function isLegacy(color: string): boolean {
  return typeof color === 'string' && parseLegacy(color.trim()) !== null
}

/** `#rrggbb`, each channel clipped to 0..255 and rounded. */
export function toHex([r, g, b]: RGB): string {
  return formatColor([r, g, b, 1])
}

/** Linear to gamma-encoded 0..1, for `color(srgb-linear ...)`. */
function toGamma(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

/**
 * A ramp stop's channels. A fully see-through stop in a form not read before
 * (`transparent`, `oklch(... / 0)`) has no colour to blend toward, and its zero
 * channels would paint the ramp black, so it stays unreadable and the ramp keeps
 * it as written, as it always did.
 */
function rampRgb(s: string): RGB | null {
  const c = parseRgba(s)
  if (!c || (c[3] === 0 && !isLegacy(s))) return null
  return [c[0], c[1], c[2]]
}

/**
 * Interpolate two colours in OkLab. Returns hex: ramps are opaque and ignore
 * alpha, as they always have. At `t` 0 a colour the browser had to resolve comes
 * back as written, so a `var()` stop stays live and a named one is not rewritten.
 */
export function mix(a: string, b: string, t: number): string {
  if (t === 0 && !isLegacy(a)) return a
  const ca = rampRgb(a)
  const cb = rampRgb(b)
  if (!ca || !cb) return a
  const la = rgbToOklab(ca)
  const lb = rgbToOklab(cb)
  return toHex(
    oklabToRgb([
      la[0] + (lb[0] - la[0]) * t,
      la[1] + (lb[1] - la[1]) * t,
      la[2] + (lb[2] - la[2]) * t,
    ]),
  )
}

/**
 * Sample `count` evenly spaced colours from a list of anchor stops.
 *
 * `from` exists because the light end of a sequential ramp is nearly white: on a
 * white page, with the white borders a choropleth wants, the lowest class becomes
 * invisible and the reader loses a whole category. ColorBrewer solves this by
 * designing each class count separately rather than sampling the 9-class ramp, so
 * its 5-class Blues starts at #eff3ff, not #f7fbff. Starting slightly inside the
 * ramp reproduces that without shipping a table per class count.
 *
 * @param stops Anchor colours.
 * @param count How many colours to return.
 * @param options.from Lower end of the ramp to sample from, 0..1.
 * @param options.to Upper end, 0..1.
 */
export function sampleRamp(
  stops: string[],
  count: number,
  { from = 0, to = 1 }: { from?: number; to?: number } = {},
): string[] {
  if (!Array.isArray(stops) || !stops.length) return []
  if (count <= 0) return []
  if (count === 1) return [stops[Math.floor((stops.length - 1) / 2)]]

  const labs = stops.map((s): OkLab | null => {
    const rgb = rampRgb(s)
    return rgb ? rgbToOklab(rgb) : null
  })

  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const t = from + (to - from) * (i / (count - 1))
    const pos = t * (stops.length - 1)
    const i0 = Math.floor(pos)
    const i1 = Math.min(stops.length - 1, i0 + 1)
    const f = pos - i0
    const a = labs[i0]
    const b = labs[i1]
    // A sample landing exactly on a stop the browser had to resolve keeps the
    // stop as written, the same rule `mix` applies.
    if (!a || !b || (f === 0 && !isLegacy(stops[i0]))) {
      out.push(stops[i0])
      continue
    }
    out.push(
      oklabHex([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]),
    )
  }
  return out
}

/** Continuous sampler: position 0..1 along a ramp. */
export function rampAt(stops: string[], t: number): string {
  if (!stops.length) return '#000000'
  if (stops.length === 1) return stops[0]
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t
  const pos = clamped * (stops.length - 1)
  const i0 = Math.floor(pos)
  const i1 = Math.min(stops.length - 1, i0 + 1)
  return mix(stops[i0], stops[i1], pos - i0)
}

function oklabHex(lab: OkLab): string {
  return toHex(oklabToRgb(lab))
}

/** What a colour that cannot be read counts as: black, luminance 0. */
const BLACK: RGB = [0, 0, 0]

/** Relative luminance per WCAG 2.x, 0..1. A colour that cannot be read is 0. */
export function luminance(color: string): number {
  return channelLuminance(parseColor(color) ?? BLACK)
}

/** WCAG contrast ratio between two colours, 1..21. */
export function contrastRatio(a: string, b: string): number {
  return channelContrast(parseColor(a) ?? BLACK, parseColor(b) ?? BLACK)
}

/**
 * Pick whichever of two candidates is more readable on `background`. Used for
 * data labels sitting on top of a choropleth fill, where a fixed label colour is
 * guaranteed to fail at one end of the ramp.
 *
 */
export function readableOn(background: string, dark = '#1a1a1a', light = '#ffffff'): string {
  return contrastRatio(background, dark) >= contrastRatio(background, light) ? dark : light
}

/**
 * Reduce OkLab lightness by `amount` (0..1). A translucent colour stays as
 * translucent, and a fully transparent one comes back unchanged since there is
 * nothing visible to darken, unless `keepAlpha` is false: then the result is
 * the opaque darkened colour.
 */
export function darken(color: string, amount = 0.12, keepAlpha = true): string {
  return withLightness(color, keepAlpha, (L) => Math.max(0, L - amount))
}

/** Increase OkLab lightness by `amount` (0..1). Alpha as for `darken`. */
export function lighten(color: string, amount = 0.12, keepAlpha = true): string {
  return withLightness(color, keepAlpha, (L) => Math.min(1, L + amount))
}

function rgbOf(c: RGBA): RGB {
  return [c[0], c[1], c[2]]
}

function withLightness(color: string, keepAlpha: boolean, next: (L: number) => number): string {
  const c = parseRgba(color)
  if (!c || (keepAlpha && c[3] === 0)) return color
  const lab = rgbToOklab(rgbOf(c))
  return format(oklabToRgb([next(lab[0]), lab[1], lab[2]]), keepAlpha ? c[3] : 1)
}
