/**
 * Colour scales and class breaks.
 *
 * Classification is the invisible decision that changes a choropleth's
 * conclusion, so the breaks are always computed explicitly, exposed on the scale
 * object, and rendered in the legend. Quantile is the default because it
 * guarantees every class is populated, which is what a reader assumes when they
 * see five classes.
 *
 * @module scales/Scale
 */

import { sampleRamp, rampAt, readableOn } from './Color'
import { getPalette, defaultPaletteFor } from './Palettes'
import type { PaletteKind } from './Palettes'
import type { LegendItem, ScaleOptions, ScaleType } from '../types'

/**
 * How far inside the light end of a sequential ramp to start sampling.
 *
 * A choropleth's lowest class must stay visible against a white page next to
 * white borders. See `sampleRamp` for why this is a fixed inset rather than a
 * per-class-count colour table.
 */
const SEQUENTIAL_LIGHT_INSET = 0.1

const DEFAULT_NULL_COLOR = '#eeeeee'

/** Finite numbers only, ascending. */
function cleanNumbers(values: readonly unknown[]): number[] {
  const out: number[] = []
  for (const v of values) {
    // No-data is skipped before any coercion, because `Number(null)`, `Number('')`
    // and `Number(false)` are all 0. Coercing first files every feature with no
    // data as a zero, which is the worst possible failure here: the map renders it
    // as no-data (`color()` checks for null explicitly) while the classification
    // silently counts it. A US map with 15 of 51 states carrying data then puts
    // three of its five quantile breaks at zero, and publishes a legend reading
    // "0 to 0" for classes that contain nothing.
    if (v == null || v === '' || typeof v === 'boolean') continue
    const n = typeof v === 'number' ? v : Number(v)
    if (Number.isFinite(n)) out.push(n)
  }
  out.sort((a, b) => a - b)
  return out
}

/**
 * Quantile breaks: interior boundaries at even population intervals.
 *
 * @returns `classes - 1` interior breaks.
 */
export function quantileBreaks(sorted: number[], classes: number): number[] {
  const breaks: number[] = []
  if (!sorted.length || classes < 2) return breaks
  for (let i = 1; i < classes; i++) {
    const pos = (sorted.length - 1) * (i / classes)
    const lo = Math.floor(pos)
    const hi = Math.min(sorted.length - 1, lo + 1)
    breaks.push(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo))
  }
  return breaks
}

/**
 * Equal-interval breaks.
 *
 */
export function equalIntervalBreaks([min, max]: [number, number], classes: number): number[] {
  const breaks: number[] = []
  if (classes < 2) return breaks
  const step = (max - min) / classes
  for (let i = 1; i < classes; i++) breaks.push(min + step * i)
  return breaks
}

/**
 * Fisher-Jenks natural breaks.
 *
 * O(n^2 k), so the input is sampled above `maxSample` values. Sampling changes
 * the breaks slightly; that is preferable to freezing the main thread, and the
 * caller is told via the returned scale's `warnings`.
 *
 */
export function jenksBreaks(
  sorted: number[],
  classes: number,
  maxSample = 2000,
): { breaks: number[]; sampled: boolean } {
  if (sorted.length <= classes || classes < 2) {
    return { breaks: quantileBreaks(sorted, classes), sampled: false }
  }

  let values = sorted
  let sampled = false
  if (sorted.length > maxSample) {
    values = new Array(maxSample)
    const stride = (sorted.length - 1) / (maxSample - 1)
    for (let i = 0; i < maxSample; i++) values[i] = sorted[Math.round(i * stride)]
    sampled = true
  }

  const n = values.length
  const k = classes
  // mat1: index of the lower class limit; mat2: running variance.
  const mat1 = Array.from({ length: n + 1 }, () => new Array(k + 1).fill(0))
  const mat2 = Array.from({ length: n + 1 }, () => new Array(k + 1).fill(Infinity))

  for (let j = 1; j <= k; j++) {
    mat1[1][j] = 1
    mat2[1][j] = 0
  }

  for (let l = 2; l <= n; l++) {
    let sum = 0
    let sumSq = 0
    let count = 0
    for (let m = 1; m <= l; m++) {
      const lowerIndex = l - m + 1
      const val = values[lowerIndex - 1]
      count++
      sum += val
      sumSq += val * val
      const variance = sumSq - (sum * sum) / count
      if (lowerIndex > 1) {
        for (let j = 2; j <= k; j++) {
          if (mat2[l][j] >= variance + mat2[lowerIndex - 1][j - 1]) {
            mat1[l][j] = lowerIndex
            mat2[l][j] = variance + mat2[lowerIndex - 1][j - 1]
          }
        }
      }
    }
    mat1[l][1] = 1
    mat2[l][1] = sumSq - (sum * sum) / count
  }

  const breaks: number[] = []
  let end = n
  for (let j = k; j >= 2; j--) {
    const start = mat1[end][j] - 1
    breaks.unshift(values[start])
    end = start
  }
  return { breaks, sampled }
}

/**
 * Round a domain outward to human-friendly bounds.
 *
 */
export function niceDomain([min, max]: [number, number]): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [min, max]
  if (min === max) return min === 0 ? [0, 1] : [Math.min(0, min), Math.max(0, max)]
  const span = max - min
  const step = Math.pow(10, Math.floor(Math.log10(span / 4)))
  return [Math.floor(min / step) * step, Math.ceil(max / step) * step]
}

export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return String(v)
  const abs = Math.abs(v)
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (abs >= 1e4) return `${(v / 1e3).toFixed(0)}k`
  if (Number.isInteger(v)) return String(v)
  if (abs >= 100) return v.toFixed(0)
  if (abs >= 1) return v.toFixed(1)
  return v.toFixed(2)
}

/**
 * Create a colour scale.
 *
 * @param values Raw values; nulls and non-numerics are tolerated.
 */
export function createScale(values: readonly unknown[], options: ScaleOptions = {}): Scale {
  return new Scale(values, options)
}

export class Scale {
  readonly warnings: string[] = []
  readonly type: ScaleType
  readonly nullColor: string
  readonly nullLabel: string
  readonly isOrdinal: boolean

  /** Class boundaries. Empty for continuous and ordinal scales. */
  breaks: number[] = []
  /** One colour per class, or ramp samples for a continuous scale. */
  colors: string[] = []
  /** Feature count per class, for the legend. */
  counts: number[] = []
  domain: [number, number] = [0, 1]
  continuous = false
  classes = 5
  stops: string[] = []
  paletteName = ''
  paletteKind: PaletteKind | 'explicit' = 'sequential'
  /** Distinct categories, for ordinal scales. */
  categories: string[] = []

  constructor(values: readonly unknown[], options: ScaleOptions = {}) {
    const sorted = cleanNumbers(values)

    this.type = options.type || 'quantile'
    this.nullColor = options.nullColor || DEFAULT_NULL_COLOR
    this.nullLabel = options.nullLabel || 'No data'
    this.isOrdinal = this.type === 'ordinal'

    if (this.isOrdinal) {
      this._initOrdinal(values, options)
      return
    }

    const dataMin = sorted.length ? sorted[0] : 0
    const dataMax = sorted.length ? sorted[sorted.length - 1] : 0

    this.continuous = this.type === 'linear' || this.type === 'log' || this.type === 'sqrt'
    const wantsNice = options.nice ?? this.continuous
    let domain: [number, number] = options.domain
      ? [options.domain[0], options.domain[1]]
      : [dataMin, dataMax]
    if (wantsNice && !options.domain) domain = niceDomain(domain)
    this.domain = domain

    const paletteName =
      typeof options.palette === 'string'
        ? options.palette
        : options.palette
          ? ''
          : defaultPaletteFor(domain)
    let stops: string[]
    let paletteKind: PaletteKind | 'explicit'
    if (Array.isArray(options.palette)) {
      // An explicit colour list is taken literally: the caller has already chosen
      // their exact classes and must not have them resampled.
      stops = options.palette.slice()
      paletteKind = 'explicit'
    } else {
      const p = getPalette(paletteName)
      if (!p) {
        this.warnings.push(`unknown palette "${paletteName}", falling back to "blues"`)
        const fallback = getPalette('blues')!
        stops = fallback.stops.slice()
        paletteKind = fallback.kind
      } else {
        stops = p.stops.slice()
        paletteKind = p.kind
      }
    }
    this.paletteKind = paletteKind
    if (options.reverse) stops.reverse()
    this.stops = stops
    this.paletteName = paletteName

    const classes = Math.max(2, Math.min(12, options.classes ?? 5))
    this.classes = classes

    if (this.continuous) {
      this.breaks = []
      this.colors = sampleRamp(stops, Math.max(2, classes), this._rampWindow())
    } else {
      switch (this.type) {
        case 'threshold':
          if (!options.breaks?.length) {
            this.warnings.push("type 'threshold' needs options.breaks; falling back to quantile")
            this.breaks = quantileBreaks(sorted, classes)
          } else {
            this.breaks = [...options.breaks].sort((a, b) => a - b)
          }
          break
        case 'quantize':
        case 'equalInterval':
          this.breaks = equalIntervalBreaks(this.domain, classes)
          break
        case 'jenks':
        case 'naturalBreaks': {
          const { breaks, sampled } = jenksBreaks(sorted, classes)
          this.breaks = breaks
          if (sampled) {
            this.warnings.push(
              `jenks breaks computed from a 2000-value sample of ${sorted.length} values; breaks are approximate`,
            )
          }
          break
        }
        case 'quantile':
        default:
          this.breaks = quantileBreaks(sorted, classes)
          break
      }
      this.colors = sampleRamp(stops, this.breaks.length + 1, this._rampWindow())
    }

    // Class population counts drive the legend, and a zero-population class is a
    // signal that the classification is wrong for this data.
    this.counts = this._countClasses(sorted)
    if (!this.continuous && this.counts.some((c) => c === 0)) {
      // Quantile cannot be the advice when quantile is what produced the empty
      // class, which happens when there are fewer distinct values than classes.
      const remedy =
        this.type === 'quantile'
          ? `fewer than ${classes} classes (there are ${new Set(sorted).size} distinct values)`
          : "'quantile', or fewer classes"
      this.warnings.push(
        `classification "${this.type}" produced an empty class; consider ${remedy}`,
      )
    }
  }

  /**
   * The slice of the palette to sample. Only sequential ramps get a light-end
   * inset: a diverging ramp needs both of its extremes and its true midpoint, and
   * an explicit colour list is the caller's own decision.
   */
  private _rampWindow(): { from: number; to: number } {
    return this.paletteKind === 'sequential'
      ? { from: SEQUENTIAL_LIGHT_INSET, to: 1 }
      : { from: 0, to: 1 }
  }

  private _initOrdinal(values: readonly unknown[], options: ScaleOptions): void {
    const seen: string[] = []
    const set = new Set<string>()
    for (const v of values) {
      if (v == null || v === '') continue
      const key = String(v)
      if (!set.has(key)) {
        set.add(key)
        seen.push(key)
      }
    }
    this.categories = seen
    let stops: string[]
    if (Array.isArray(options.palette)) stops = options.palette.slice()
    else {
      const p = getPalette(typeof options.palette === 'string' ? options.palette : 'apex')
      stops = (p ?? getPalette('apex')!).stops.slice()
    }
    this.paletteKind = 'explicit'
    this.stops = stops
    this.colors = seen.map((_, i) => stops[i % stops.length])
    this.breaks = []
    this.domain = [0, Math.max(0, seen.length - 1)]
    this.continuous = false
    this.classes = seen.length
    this.counts = seen.map((c) => values.filter((v) => String(v) === c).length)
  }

  private _countClasses(sorted: number[]): number[] {
    const n = this.continuous ? this.colors.length : this.breaks.length + 1
    const counts = new Array(n).fill(0)
    if (this.continuous) return counts
    for (const v of sorted) counts[this.classIndex(v)]++
    return counts
  }

  /** Class index for a value. */
  classIndex(value: number): number {
    const { breaks } = this
    let i = 0
    while (i < breaks.length && value >= breaks[i]) i++
    return i
  }

  /**
   * Fill colour for a value. Null, undefined, NaN and non-numerics all resolve
   * to `nullColor`, so an unmatched join renders as explicit no-data rather than
   * as the bottom class (which would silently understate it).
   *
   */
  color(value: unknown): string {
    if (this.isOrdinal) {
      if (value == null || value === '') return this.nullColor
      const i = this.categories.indexOf(String(value))
      return i === -1 ? this.nullColor : this.colors[i]
    }

    const n = typeof value === 'number' ? value : Number(value)
    if (value == null || value === '' || !Number.isFinite(n)) return this.nullColor

    if (this.continuous) {
      const [lo, hi] = this.domain
      let t = hi === lo ? 0.5 : (n - lo) / (hi - lo)
      if (this.type === 'log') {
        const safeLo = Math.max(lo, 1e-9)
        const safeN = Math.max(n, 1e-9)
        t = Math.log(safeN / safeLo) / Math.log(Math.max(hi, 1e-9) / safeLo)
      } else if (this.type === 'sqrt') {
        t = Math.sqrt(Math.max(0, t))
      }
      return rampAt(this.stops, t)
    }

    return this.colors[this.classIndex(n)] || this.nullColor
  }

  /** A label colour guaranteed to be readable on the fill for `value`. */
  labelColorFor(value: unknown): string {
    return readableOn(this.color(value))
  }

  /**
   * Legend entries, including the no-data swatch when relevant.
   *
   */
  legendItems({
    includeNull = false,
    format = formatNumber,
  }: {
    includeNull?: boolean
    format?: (v: number) => string
  } = {}): LegendItem[] {
    const items: LegendItem[] = []

    if (this.isOrdinal) {
      this.categories.forEach((c, i) => {
        items.push({ color: this.colors[i], label: c, count: this.counts[i] })
      })
    } else if (this.continuous) {
      const [lo, hi] = this.domain
      items.push({
        color: this.colors[0],
        label: format(lo),
        from: lo,
        to: hi,
      })
      items.push({
        color: this.colors[this.colors.length - 1],
        label: format(hi),
        from: lo,
        to: hi,
      })
    } else {
      const [lo, hi] = this.domain
      const edges = [lo, ...this.breaks, hi]
      for (let i = 0; i < this.colors.length; i++) {
        const from = edges[i]
        const to = edges[i + 1]
        items.push({
          color: this.colors[i],
          label: `${format(from)} to ${format(to)}`,
          from,
          to,
          count: this.counts[i],
        })
      }
    }

    if (includeNull)
      items.push({
        color: this.nullColor,
        label: this.nullLabel,
        isNull: true,
      })
    return items
  }

  /**
   * A gradient stop list for a continuous legend bar.
   *
   */
  gradientStops(steps = 16): { offset: number; color: string }[] {
    const { from, to } = this._rampWindow()
    const out: { offset: number; color: string }[] = []
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1)
      out.push({
        offset: t,
        color: rampAt(this.stops, from + (to - from) * t),
      })
    }
    return out
  }

  /**
   * Stop list for a *classed* legend bar: each class repeated at both edges of
   * its band, so the bar reads as the hard steps the map actually uses instead
   * of implying a continuum the classification does not have.
   */
  classStops(): { offset: number; color: string }[] {
    const n = this.colors.length
    if (!n) return []
    const out: { offset: number; color: string }[] = []
    this.colors.forEach((color, i) => {
      out.push({ offset: i / n, color })
      out.push({ offset: (i + 1) / n, color })
    })
    return out
  }

  /**
   * Where a value sits along the legend bar, as a fraction from 0 to 1, or null
   * when it has no place on it (no data, or a category this scale never saw).
   *
   * On a continuous bar this is the same transform the colour uses, so the
   * marker lands on the exact shade the feature was painted. On a classed bar
   * the classes are drawn as equal-width bands regardless of how wide their
   * value ranges are, so the position is the band index plus the value's
   * progress through that band: the marker stays inside the band whose colour
   * the reader is being asked to match.
   */
  position(value: unknown): number | null {
    if (this.isOrdinal) {
      if (value == null || value === '') return null
      const i = this.categories.indexOf(String(value))
      return i === -1 ? null : (i + 0.5) / Math.max(1, this.categories.length)
    }

    const n = typeof value === 'number' ? value : Number(value)
    if (value == null || value === '' || !Number.isFinite(n)) return null

    const [lo, hi] = this.domain

    if (this.continuous) {
      let t = hi === lo ? 0.5 : (n - lo) / (hi - lo)
      if (this.type === 'log') {
        const safeLo = Math.max(lo, 1e-9)
        const safeN = Math.max(n, 1e-9)
        t = Math.log(safeN / safeLo) / Math.log(Math.max(hi, 1e-9) / safeLo)
      } else if (this.type === 'sqrt') {
        t = Math.sqrt(Math.max(0, t))
      }
      return clamp01(t)
    }

    const bands = this.breaks.length + 1
    const index = Math.min(this.classIndex(n), bands - 1)
    const edges = [lo, ...this.breaks, hi]
    const from = edges[index]
    const to = edges[index + 1]
    const within = to === from ? 0.5 : clamp01((n - from) / (to - from))
    return clamp01((index + within) / bands)
  }
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}
