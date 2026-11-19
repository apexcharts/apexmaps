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

import {
  sampleRamp,
  rampAt,
  readableOn,
  colorScopeElement,
  needsBrowser,
  withColorScope,
} from './Color'
import { THEME_DEFAULTS } from '../core/Theme'
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

const DEFAULT_NULL_COLOR = THEME_DEFAULTS.light.noData

/**
 * No-data on a dark map. Light grey reads as the brightest class there, which is
 * the one thing a no-data fill must never do, so callers that know the theme pass
 * this as `nullColor`.
 */
export const DARK_NULL_COLOR = THEME_DEFAULTS.dark.noData

/**
 * Classed breaks for a scale anchored at zero: a break at 0, with the chosen
 * method run on each side of it.
 *
 * Classes are shared between the sides in proportion to what the method divides
 * (the number of values for quantile and jenks, the length of the side for equal
 * intervals), with at least one class each, so the class count stays what was
 * asked for. Quantile and jenks never give a side more classes than it has
 * distinct values while the other side has room for them, since the surplus
 * could only be empty classes.
 *
 * The side above zero is weighed and divided on values greater than zero. An
 * exact zero falls in the first class at or above the break, the same rule
 * `classIndex` applies to every break, but a run of zeros (census figures
 * rounded to 0.0, say) must not claim classes of its own or become break
 * values: that put several breaks at 0 and left empty classes between them.
 *
 * @returns The interior breaks, the class count below zero, and whether jenks had
 *   to sample.
 */
function zeroAnchoredBreaks(
  type: ScaleType,
  sorted: number[],
  [lo, hi]: [number, number],
  classes: number,
): { breaks: number[]; below: number; sampled: boolean } {
  const negatives = sorted.filter((v) => v < 0)
  const positives = sorted.filter((v) => v > 0)
  const byLength = type === 'quantize' || type === 'equalInterval'
  const weightBelow = byLength ? -lo : negatives.length
  const weightAbove = byLength ? hi : positives.length
  const share = Math.round((classes * weightBelow) / (weightBelow + weightAbove || 1))
  let below = Math.max(1, Math.min(classes - 1, share))
  let above = classes - below

  if (!byLength) {
    const roomBelow = new Set(negatives).size
    const roomAbove = new Set(positives).size
    if (below > roomBelow && above < roomAbove) {
      const move = Math.min(below - roomBelow, roomAbove - above)
      below -= move
      above += move
    } else if (above > roomAbove && below < roomBelow) {
      const move = Math.min(above - roomAbove, roomBelow - below)
      above -= move
      below += move
    }
  }

  if (byLength) {
    return {
      breaks: [...equalIntervalBreaks([lo, 0], below), 0, ...equalIntervalBreaks([0, hi], above)],
      below,
      sampled: false,
    }
  }
  if (type === 'jenks' || type === 'naturalBreaks') {
    const a = jenksBreaks(negatives, below)
    const b = jenksBreaks(positives, above)
    return { breaks: [...a.breaks, 0, ...b.breaks], below, sampled: a.sampled || b.sampled }
  }
  return {
    breaks: [...quantileBreaks(negatives, below), 0, ...quantileBreaks(positives, above)],
    below,
    sampled: false,
  }
}

/**
 * Class colours for a scale anchored at zero: classes below zero from the lower
 * half of the ramp, classes above it from the upper half, and none from the
 * neutral midpoint, which belongs to zero itself and no class contains only that.
 *
 * Each side's classes step evenly out from neutral to the colour its own extreme
 * has on the symmetric ramp, the one the continuous scale uses: the ramp runs
 * from -extent to +extent, extent being the larger magnitude, so a side whose
 * data reaches the extent ends on the ramp's extreme and a side that reaches a
 * fifth of it ends a fifth of the way out. Equal magnitudes therefore get equal
 * intensity however the classes happen to split. Symmetric data reaches both
 * extremes when its five classes divide three and two, and a +1.35 beside a
 * -8.13 stays pale whether it has one class or four.
 */
function zeroAnchoredColors(
  stops: string[],
  below: number,
  above: number,
  [lo, hi]: [number, number],
): string[] {
  const extent = Math.max(-lo, hi)
  // n + 1 samples per side, the neutral midpoint being the one dropped.
  const lower = sampleRamp(stops, below + 1, { from: 0.5 - (0.5 * -lo) / extent, to: 0.5 })
  const upper = sampleRamp(stops, above + 1, { from: 0.5, to: 0.5 + (0.5 * hi) / extent })
  // Outermost class first below zero, innermost first above it.
  return [...lower.slice(0, below), ...upper.slice(1)]
}

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

/** What the map's theme supplies to a scale, below anything its options name. */
export interface ScaleDefaults {
  /**
   * The palette an ordinal scale takes when its options name none. Absent:
   * the built-in `apex` palette.
   */
  categorical?: readonly string[]
}

/**
 * Create a colour scale.
 *
 * @param values Raw values; nulls and non-numerics are tolerated.
 * @param defaults What the theme supplies when `options` leave it open.
 */
export function createScale(
  values: readonly unknown[],
  options: ScaleOptions = {},
  defaults: ScaleDefaults = {},
): Scale {
  return new Scale(values, options, defaults)
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
  /**
   * Where stops only the browser can read (names, `hsl()`, `var()`) resolve:
   * the map element in scope when the scale was built, re-entered by the calls
   * that sample the ramp later (a tooltip, an export). Unset for hex stops.
   */
  private _colorScope: { el: Element | null } | null = null
  /**
   * Set when the scale chose a diverging ramp itself because its data straddles
   * zero: the largest magnitude on either side of zero, which maps to the ends of
   * the ramp while zero maps to its neutral midpoint. Null on every other scale,
   * including one whose caller named the palette or the domain.
   *
   * Symmetric, not stretched per side: the ramp runs from -extent to +extent, so
   * equal magnitudes get equal intensity on both sides and a +1.35 beside a -8.13
   * is drawn paler, as it should be. Stretching each side to its own extreme
   * would paint the largest growth as darkly as the largest decline whatever
   * their sizes. The scale's `domain` stays the data's (or its nice rounding),
   * so the legend bar shows only the part of the ramp the data uses, still
   * linear in value, and its end labels and the accessible description are the
   * real range rather than a mirrored one.
   */
  private _zeroExtent: number | null = null

  constructor(
    values: readonly unknown[],
    options: ScaleOptions = {},
    defaults: ScaleDefaults = {},
  ) {
    const sorted = cleanNumbers(values)

    this.type = options.type || 'quantile'
    this.nullColor = options.nullColor || DEFAULT_NULL_COLOR
    this.nullLabel = options.nullLabel || 'No data'
    this.isOrdinal = this.type === 'ordinal'

    if (this.isOrdinal) {
      this._initOrdinal(values, options, defaults.categorical)
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
    if (stops.some(needsBrowser)) this._colorScope = { el: colorScopeElement() }

    const classes = Math.max(2, Math.min(12, options.classes ?? 5))
    this.classes = classes

    // The automatic diverging ramp is anchored at zero, which is what choosing it
    // promises. Only when the scale made every choice itself: a named palette, a
    // domain or explicit thresholds are the caller's, and are taken as given. Log
    // is left out because a log scale over values at or below zero has no zero to
    // anchor to.
    const anchored =
      options.palette == null &&
      !options.domain &&
      paletteKind === 'diverging' &&
      this.type !== 'log' &&
      !(this.type === 'threshold' && options.breaks?.length) &&
      domain[0] < 0 &&
      domain[1] > 0

    if (anchored && this.continuous) {
      this._zeroExtent = Math.max(-domain[0], domain[1])
      this.breaks = []
      this.colors = sampleRamp(stops, Math.max(2, classes), this._rampWindow())
    } else if (anchored) {
      if (this.type === 'threshold') {
        this.warnings.push("type 'threshold' needs options.breaks; falling back to quantile")
      }
      const { breaks, below, sampled } = zeroAnchoredBreaks(this.type, sorted, domain, classes)
      if (sampled) {
        this.warnings.push(
          `jenks breaks computed from a 2000-value sample of ${sorted.length} values; breaks are approximate`,
        )
      }
      this.breaks = breaks
      this.colors = zeroAnchoredColors(stops, below, classes - below, domain)
    } else if (this.continuous) {
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
   *
   * A continuous scale anchored at zero samples only the part of the ramp its
   * domain reaches, so the legend bar and its end swatches match the map.
   */
  private _rampWindow(): { from: number; to: number } {
    if (this._zeroExtent != null) {
      return { from: this._rampT(this.domain[0]), to: this._rampT(this.domain[1]) }
    }
    return this.paletteKind === 'sequential'
      ? { from: SEQUENTIAL_LIGHT_INSET, to: 1 }
      : { from: 0, to: 1 }
  }

  private _initOrdinal(
    values: readonly unknown[],
    options: ScaleOptions,
    categorical?: readonly string[],
  ): void {
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
    else if (options.palette == null && categorical?.length) stops = categorical.slice()
    else {
      const name = typeof options.palette === 'string' ? options.palette : 'apex'
      const p = getPalette(name)
      if (!p) this.warnings.push(`unknown palette "${name}", falling back to "apex"`)
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
      const t = this._rampT(n)
      // Hex stops, the default, take the direct call: this runs per feature.
      if (!this._colorScope) return rampAt(this.stops, t)
      return this._inScope(() => rampAt(this.stops, t))
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
    this._inScope(() => {
      for (let i = 0; i < steps; i++) {
        const t = i / (steps - 1)
        out.push({
          offset: t,
          color: rampAt(this.stops, from + (to - from) * t),
        })
      }
    })
    return out
  }

  /**
   * Where a value falls along the ramp on a continuous scale, unclamped.
   *
   * Anchored at zero, zero is the midpoint and `_zeroExtent` either end, with the
   * sqrt transform applied to each side's magnitude so it bends away from zero
   * symmetrically rather than from the bottom of the domain.
   */
  private _rampT(n: number): number {
    const extent = this._zeroExtent
    if (extent != null) {
      const r = n / extent
      const bent = this.type === 'sqrt' ? Math.sign(r) * Math.sqrt(Math.abs(r)) : r
      return 0.5 + 0.5 * bent
    }
    const [lo, hi] = this.domain
    let t = hi === lo ? 0.5 : (n - lo) / (hi - lo)
    if (this.type === 'log') {
      const safeLo = Math.max(lo, 1e-9)
      const safeN = Math.max(n, 1e-9)
      t = Math.log(safeN / safeLo) / Math.log(Math.max(hi, 1e-9) / safeLo)
    } else if (this.type === 'sqrt') {
      t = Math.sqrt(Math.max(0, t))
    }
    return t
  }

  private _inScope<T>(fn: () => T): T {
    return this._colorScope ? withColorScope(this._colorScope.el, fn) : fn()
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
   * Where zero sits along a continuous legend bar, from 0 to 1, or null when
   * the scale is not anchored at zero.
   *
   * Only the anchored continuous scale has a zero worth marking: it is where the
   * ramp turns from one hue to the other, and with the bar showing just the part
   * of the ramp the data reaches it is rarely the middle of the bar. A classed
   * scale anchored at zero already has a break there, so its legend ticks it.
   */
  zeroPosition(): number | null {
    return this._zeroExtent == null ? null : this.position(0)
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
      const t = this._rampT(n)
      if (this._zeroExtent == null) return clamp01(t)
      // The bar shows only the ramp window the domain reaches (`_rampWindow`).
      const { from, to } = this._rampWindow()
      return clamp01(to === from ? 0.5 : (t - from) / (to - from))
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
