/**
 * Choropleth series.
 *
 * Fills administrative areas by value. The series owns three decisions that
 * change what the map says, so all three are explicit and inspectable:
 *
 * 1. **The join** (which datum belongs to which feature), delegated to
 *    `data/Join.js` and reported rather than silently failed.
 * 2. **Normalisation** (`normalizeBy`), because mapping counts across unequal
 *    areas is the most common way to publish a misleading choropleth. When it is
 *    used, the legend title says so.
 * 3. **Classification**, delegated to `scales/Scale.js` and exposed in the legend.
 *
 * @module series/Choropleth
 */

import { resolveJoin } from '../data/Join'
import { resolvePattern } from '../renderers/Paint'
import { createScale, DARK_NULL_COLOR, Scale } from '../scales/Scale'
import { readNumber } from './accessors'
import type { JoinResult } from '../data/Join'
import type { FeaturePaint } from '../renderers/Paint'
import type {
  ChoroplethSeriesOptions,
  FillContext,
  LegendItem,
  NormalizedFeature,
  NormalizedGeo,
} from '../types'

export class ChoroplethSeries {
  static readonly type = 'choropleth' as const
  static readonly kind = 'features' as const

  readonly type = 'choropleth' as const
  readonly kind = 'features' as const
  readonly config: ChoroplethSeriesOptions
  readonly geo: NormalizedGeo
  readonly index: number
  readonly id: string
  readonly theme: { palette?: string }
  readonly dark: boolean
  readonly warnings: string[] = []
  /** Class indices muted via the legend. */
  readonly mutedClasses = new Set<number>()
  readonly join: JoinResult
  readonly values: Map<number, number | null>
  readonly scale: Scale

  constructor({
    config,
    geo,
    index,
    theme,
    dark = false,
  }: {
    /** Series config, already merged with defaults. */
    config: ChoroplethSeriesOptions
    geo: NormalizedGeo
    /** Series index, used for the stable series id. */
    index: number
    theme?: { palette?: string }
    /** Dark mode, already resolved from `theme.mode` (`'auto'` included). */
    dark?: boolean
  }) {
    this.config = config
    this.geo = geo
    this.index = index
    this.id = `s${index}`
    this.theme = theme ?? {}
    this.dark = dark

    this.join = resolveJoin({
      features: geo.features,
      data: config.data || [],
      joinBy: config.joinBy,
      geoKeyField: geo.keyField,
      fuzzy: !!config.fuzzyJoin,
    })

    this.values = this._computeValues()
    this.scale = createScale([...this.values.values()], this._scaleOptions())
    this.warnings.push(...this.scale.warnings)
  }

  private _scaleOptions() {
    const s = this.config.scale ?? {}
    return {
      ...s,
      palette: s.palette ?? this.theme.palette,
      // No-data follows the theme, so the legend's last swatch and every
      // unmatched feature stay no-data rather than reading as the top class.
      nullColor: s.nullColor ?? (this.dark ? DARK_NULL_COLOR : undefined),
    }
  }

  /** Resolve one numeric value per feature index, applying `normalizeBy`. */
  private _computeValues(): Map<number, number | null> {
    const { valueField = 'value', normalizeBy } = this.config
    const out = new Map<number, number | null>()
    let normalizeMisses = 0

    for (const feature of this.geo.features) {
      const datum = this.join.byFeatureIndex.get(feature.index)
      if (datum == null) {
        out.set(feature.index, null)
        continue
      }

      let raw = readNumber(datum, valueField)
      if (raw == null) {
        out.set(feature.index, null)
        continue
      }

      if (normalizeBy) {
        const denom = readNumber(datum, normalizeBy) ?? readNumber(feature.properties, normalizeBy)
        if (denom == null || denom === 0) {
          normalizeMisses++
          out.set(feature.index, null)
          continue
        }
        raw = raw / denom
      }

      out.set(feature.index, raw)
    }

    if (normalizeMisses) {
      this.warnings.push(
        `normalizeBy "${normalizeBy}" was missing or zero for ${normalizeMisses} feature(s); they render as no-data`,
      )
    }
    return out
  }

  valueFor(feature: NormalizedFeature): number | null {
    return this.values.get(feature.index) ?? null
  }

  datumFor(feature: NormalizedFeature): unknown {
    return this.join.byFeatureIndex.get(feature.index)
  }

  /**
   * Fill for a feature, honouring legend muting.
   *
   */
  fillFor(feature: NormalizedFeature): string {
    const value = this.valueFor(feature)
    if (value == null) return this.scale.nullColor
    if (this.mutedClasses.size && this.mutedClasses.has(this.scale.classIndex(value))) {
      return this.scale.nullColor
    }
    return this.scale.color(value)
  }

  /**
   * Texture for a feature, or null to leave it on its flat fill.
   *
   * No-data and legend-muted features are never textured. Both are absences, and
   * a pattern over an absence reads as one more category: the reader would see
   * six things on a five-class map.
   */
  paintFor(feature: NormalizedFeature): FeaturePaint | null {
    const fill = this.config.fill
    if (!fill?.pattern && !fill?.image) return null

    const value = this.valueFor(feature)
    if (value == null) return null
    if (this.mutedClasses.size && this.mutedClasses.has(this.scale.classIndex(value))) return null

    const color = this.scale.color(value)
    const context: FillContext = {
      key: feature.key,
      name: feature.name,
      value,
      datum: this.datumFor(feature),
      properties: feature.properties,
      color,
      classIndex: this.scale.continuous ? -1 : this.scale.classIndex(value),
    }

    // Image before pattern: a picture and a texture in the same area fight, and
    // the picture is the more specific request.
    if (fill.image) {
      const { src, fit = 'cover', background, opacity = 1 } = fill.image
      const resolved = typeof src === 'function' ? src(context) : src
      if (resolved) {
        return {
          kind: 'image',
          color,
          image: { src: resolved, fit, background: background ?? color, opacity },
        }
      }
    }

    if (fill.pattern) {
      const options = typeof fill.pattern === 'function' ? fill.pattern(context) : fill.pattern
      if (options) return { kind: 'pattern', color, pattern: resolvePattern(options, color) }
    }

    return null
  }

  /** Whether any feature could be textured, which decides how cheap a redraw can be. */
  get painted(): boolean {
    return !!(this.config.fill?.pattern || this.config.fill?.image)
  }

  /** Returns the new muted state. */
  toggleClass(classIndex: number): boolean {
    if (this.mutedClasses.has(classIndex)) {
      this.mutedClasses.delete(classIndex)
      return false
    }
    this.mutedClasses.add(classIndex)
    return true
  }

  /**
   * Legend title, made honest automatically: a normalised series says what it is
   * a rate of, so the reader is never left guessing whether they are looking at
   * counts or rates.
   *
   */
  legendTitle(): string | undefined {
    const name = this.config.name
    if (!this.config.normalizeBy) return name
    const per = `per ${this.config.normalizeBy}`
    return name ? `${name} (${per})` : per
  }

  legendItems(options?: { includeNull?: boolean; format?: (v: number) => string }): LegendItem[] {
    const hasNull = [...this.values.values()].some((v) => v == null)
    const items = this.scale.legendItems({ includeNull: hasNull, ...options })
    return this.config.fill?.pattern ? items.map((item, i) => this._patternedItem(item, i)) : items
  }

  /**
   * Put the class's own tile on its swatch.
   *
   * A patterned map with flat swatches tells the reader the texture is decoration,
   * which is the opposite of the point when the tile is what distinguishes two
   * classes on a photocopy. Skipped for the no-data entry, which is never textured,
   * and for a continuous scale, whose legend is a bar rather than swatches.
   */
  private _patternedItem(item: LegendItem, index: number): LegendItem {
    const pattern = this.config.fill?.pattern
    if (!pattern || item.isNull || this.scale.continuous) return item

    // The value the class stands for. A function form asks about a feature, and the
    // honest answer for a swatch is the middle of the range it covers.
    const value =
      item.from != null && item.to != null ? (item.from + item.to) / 2 : (item.from ?? 0)
    const options =
      typeof pattern === 'function'
        ? pattern({
            key: '',
            value,
            datum: undefined,
            color: item.color,
            classIndex: index,
          })
        : pattern
    if (!options) return item

    return { ...item, pattern: resolvePattern(options, item.color) }
  }

  /**
   * Cartographic sanity checks, surfaced in dev mode only.
   *
   * The count-versus-rate check is the one that matters: it is the difference
   * between "where are the people" and "where is the phenomenon", and it is the
   * error that gets published most often.
   *
   */
  describe(feature: NormalizedFeature): string {
    const name = feature.name ?? feature.key
    const value = this.valueFor(feature)
    if (value == null) return `${name}, no data`
    const label = this.legendTitle() ?? 'value'
    return `${name}, ${label} ${Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2)}`
  }

  advise(): string[] {
    const notes: string[] = []
    const values = [...this.values.values()].filter((v): v is number => v != null)
    if (!values.length) return notes

    const looksLikeCounts =
      !this.config.normalizeBy &&
      values.every((v) => Number.isInteger(v)) &&
      Math.max(...values) > 1000

    if (looksLikeCounts) {
      notes.push(
        'values look like raw counts (large integers) on an area fill. Choropleths of counts mostly redraw ' +
          'the population map. Consider normalizeBy, or a bubble series which is immune to area bias.',
      )
    }

    if (this.scale.classes > 7 && !this.scale.continuous) {
      notes.push(
        `${this.scale.classes} classes exceeds what most readers can distinguish in a filled map; 5 to 7 is the practical ceiling.`,
      )
    }

    const [lo, hi] = this.scale.domain
    if (lo < 0 && hi > 0 && this.scale.paletteName && !isDiverging(this.scale.paletteName)) {
      notes.push(
        `data straddles zero but palette "${this.scale.paletteName}" is sequential, which hides the sign. Use a diverging palette such as "rdbu".`,
      )
    }

    return notes
  }
}

function isDiverging(name: string): boolean {
  return ['rdbu', 'brbg', 'piyg', 'spectral', 'rdylgn'].includes(name)
}
