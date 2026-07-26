/**
 * Size scales for proportional symbols and line widths.
 *
 * The default is `sqrt`, and that default is a correctness decision rather than a
 * preference. Readers judge a circle by its **area**, so mapping value linearly
 * to radius makes area grow with the square of the value: a country with ten
 * times the population gets a hundred times the ink. Square-root scaling makes
 * area proportional to value, which is the only encoding that reads honestly
 * (PRODUCT-RESEARCH.md section 4.2).
 *
 * `linear` is available because line widths and some designs genuinely want it,
 * and it warns in dev mode when used for symbol radii.
 *
 * @module scales/SizeScale
 */

import type { SizeLegendEntry, SizeOptions, SizeScaleType } from '../types'

const DEFAULT_RANGE: [number, number] = [3, 28]

export class SizeScale {
  readonly type: SizeScaleType
  readonly domain: [number, number]
  readonly range: [number, number]
  readonly warnings: string[] = []

  constructor(values: readonly (number | null | undefined)[], options: SizeOptions = {}) {
    this.type = options.scale ?? 'sqrt'
    this.range = options.range ?? DEFAULT_RANGE

    const finite = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))

    if (options.domain) {
      this.domain = options.domain
    } else if (finite.length) {
      // Anchor the domain at zero rather than at the minimum. A bubble scale that
      // starts at the smallest observed value implies the smallest place has zero
      // magnitude, which is a different (and wrong) statement about the data.
      const max = Math.max(...finite)
      const min = Math.min(...finite)
      this.domain = [Math.min(0, min), max]
    } else {
      this.domain = [0, 1]
    }

    if (this.type === 'log' && this.domain[0] <= 0) {
      this.warnings.push(
        'log size scale needs a positive domain; values at or below zero collapse to the minimum radius',
      )
    }
  }

  /** Normalised position of a value within the domain, 0..1. */
  private position(value: number): number {
    const [lo, hi] = this.domain
    if (hi === lo) return 0.5

    switch (this.type) {
      case 'log': {
        const safeLo = Math.max(lo, 1e-9)
        const safeHi = Math.max(hi, safeLo * 10)
        const safeValue = Math.max(value, safeLo)
        return Math.log(safeValue / safeLo) / Math.log(safeHi / safeLo)
      }
      case 'linear':
        return (value - lo) / (hi - lo)
      case 'sqrt':
      default: {
        // Interpolate in area space, then take the root, so equal value steps
        // produce equal area steps.
        const t = (value - lo) / (hi - lo)
        return Math.sqrt(Math.max(0, t))
      }
    }
  }

  /** Radius in screen pixels. Returns null for values that cannot be sized. */
  radius(value: unknown): number | null {
    const n = typeof value === 'number' ? value : Number(value)
    if (value == null || value === '' || !Number.isFinite(n)) return null
    const [rMin, rMax] = this.range
    const t = Math.max(0, Math.min(1, this.position(n)))
    return rMin + (rMax - rMin) * t
  }

  /**
   * Reference sizes for a nested-circle legend.
   *
   * Three circles at round values, drawn concentrically, is the only bubble legend
   * that lets a reader actually decode areas. Datawrapper does this well and
   * almost nobody else ships it at all.
   */
  legendEntries(count = 3, format: (v: number) => string = defaultFormat): SizeLegendEntry[] {
    const [, hi] = this.domain
    if (!Number.isFinite(hi) || hi <= 0) return []

    const values = niceSteps(hi, count)
    const out: SizeLegendEntry[] = []
    for (const value of values) {
      const radius = this.radius(value)
      if (radius == null) continue
      out.push({ radius, value, label: format(value) })
    }
    // Largest first: the legend draws them nested, so the big circle is the
    // backdrop for the smaller ones.
    return out.sort((a, b) => b.value - a.value)
  }
}

export function createSizeScale(
  values: readonly (number | null | undefined)[],
  options?: SizeOptions,
): SizeScale {
  return new SizeScale(values, options)
}

/**
 * Pick `count` round reference values at or below `max`, largest first.
 *
 * Round numbers matter here: a legend reading "1,000 / 500 / 100" is decodable
 * where "987 / 493 / 98" is noise.
 */
function niceSteps(max: number, count: number): number[] {
  const magnitude = Math.pow(10, Math.floor(Math.log10(max)))
  const leading = max / magnitude

  let top: number
  if (leading >= 5) top = 5 * magnitude
  else if (leading >= 2) top = 2 * magnitude
  else top = magnitude

  const out: number[] = []
  const fractions = count >= 3 ? [1, 0.5, 0.1] : [1, 0.25]
  for (let i = 0; i < count; i++) {
    const fraction =
      fractions[i] ?? fractions[fractions.length - 1] / Math.pow(4, i - fractions.length + 1)
    const value = top * fraction
    if (value > 0) out.push(roundNice(value))
  }
  return [...new Set(out)]
}

function roundNice(v: number): number {
  if (v >= 100) return Math.round(v / 10) * 10
  if (v >= 10) return Math.round(v)
  if (v >= 1) return Math.round(v * 10) / 10
  return Math.round(v * 100) / 100
}

function defaultFormat(v: number): string {
  if (!Number.isFinite(v)) return String(v)
  const abs = Math.abs(v)
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (abs >= 1e4) return `${Math.round(v / 1e3)}k`
  if (Number.isInteger(v)) return v.toLocaleString()
  return v.toFixed(1)
}
