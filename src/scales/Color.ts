/**
 * Colour maths, in OkLab.
 *
 * Interpolating through sRGB turns the midpoint of most ramps muddy grey, which
 * is why every ramp here is sampled in OkLab (Ottosson, 2020): a perceptual
 * space where equal numeric steps read as equal visual steps. This is a
 * correctness property of a choropleth, not a nicety, because the reader infers
 * magnitude from perceived lightness (PRODUCT-RESEARCH.md section 8.3).
 *
 * @module scales/Color
 */

/** Components in 0..255. */
export type RGB = [number, number, number]
/** Perceptual lightness plus two opponent axes. */
export type OkLab = [number, number, number]

/** Parse `#rgb`, `#rrggbb`, `rgb()` and `rgba()` into 0..255 components. */
export function parseColor(input: string): RGB | null {
  if (typeof input !== 'string') return null
  const s = input.trim()

  if (s[0] === '#') {
    const hex = s.slice(1)
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16)
      const g = parseInt(hex[1] + hex[1], 16)
      const b = parseInt(hex[2] + hex[2], 16)
      return Number.isNaN(r + g + b) ? null : [r, g, b]
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16)
      const g = parseInt(hex.slice(2, 4), 16)
      const b = parseInt(hex.slice(4, 6), 16)
      return Number.isNaN(r + g + b) ? null : [r, g, b]
    }
    return null
  }

  const m = s.match(/^rgba?\(([^)]+)\)$/i)
  if (m) {
    const parts = m[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number)
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => !Number.isNaN(n))) {
      return [parts[0], parts[1], parts[2]]
    }
  }
  return null
}

export function toHex([r, g, b]: RGB): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/** Gamma-encoded 0..1 to linear. */
function toLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

/** Linear to gamma-encoded 0..1. */
function toGamma(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

export function rgbToOklab([r8, g8, b8]: RGB): OkLab {
  const r = toLinear(r8 / 255)
  const g = toLinear(g8 / 255)
  const b = toLinear(b8 / 255)

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b

  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)

  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ]
}

export function oklabToRgb([L, A, B]: OkLab): RGB {
  const l_ = L + 0.3963377774 * A + 0.2158037573 * B
  const m_ = L - 0.1055613458 * A - 0.0638541728 * B
  const s_ = L - 0.0894841775 * A - 1.291485548 * B

  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_

  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s

  return [
    Math.max(0, Math.min(255, toGamma(r) * 255)),
    Math.max(0, Math.min(255, toGamma(g) * 255)),
    Math.max(0, Math.min(255, toGamma(b) * 255)),
  ]
}

/** Interpolate two colours in OkLab. Returns hex. */
export function mix(a: string, b: string, t: number): string {
  const ca = parseColor(a)
  const cb = parseColor(b)
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
    const rgb = parseColor(s)
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
    if (!a || !b) {
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

/** Relative luminance per WCAG 2.x, 0..1. */
export function luminance(color: string): number {
  const rgb = parseColor(color)
  if (!rgb) return 0
  const [r, g, b] = rgb.map((v) => toLinear(v / 255)) as RGB
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two colours, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
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

/** Reduce OkLab lightness by `amount` (0..1). */
export function darken(color: string, amount = 0.12): string {
  const rgb = parseColor(color)
  if (!rgb) return color
  const lab = rgbToOklab(rgb)
  return oklabHex([Math.max(0, lab[0] - amount), lab[1], lab[2]])
}

/** Increase OkLab lightness by `amount` (0..1). */
export function lighten(color: string, amount = 0.12): string {
  const rgb = parseColor(color)
  if (!rgb) return color
  const lab = rgbToOklab(rgb)
  return oklabHex([Math.min(1, lab[0] + amount), lab[1], lab[2]])
}
