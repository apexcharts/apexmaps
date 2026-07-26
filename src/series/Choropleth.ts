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
import { createScale, Scale } from '../scales/Scale'
import { readNumber } from './accessors'
import type { JoinResult } from '../data/Join'
import type {
  ChoroplethSeriesOptions,
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
  }: {
    /** Series config, already merged with defaults. */
    config: ChoroplethSeriesOptions
    geo: NormalizedGeo
    /** Series index, used for the stable series id. */
    index: number
    theme?: { palette?: string }
  }) {
    this.config = config
    this.geo = geo
    this.index = index
    this.id = `s${index}`
    this.theme = theme ?? {}

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
    return this.scale.legendItems({ includeNull: hasNull, ...options })
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
