/**
 * The no-data basemap.
 *
 * A map with geometry and no series must still draw. "Show me the countries" is
 * a normal request (a locator map, a backdrop for markers, the first thing anyone
 * tries), and rendering an empty container for it would be an obvious defect.
 *
 * This implements the same surface the real series expose, so the renderer,
 * hover, selection, tooltip and accessibility paths need no special-casing for
 * the series-less case.
 *
 * @module series/BaseFeatures
 */

import { THEME_DEFAULTS } from '../core/Theme'
import { darken } from '../scales/Color'
import type { NormalizedFeature, SeriesLabelOptions, StrokeOptions } from '../types'

export interface BaseFeaturesConfig {
  name?: string
  stroke?: StrokeOptions
  opacity?: number
  fill?: string
  /** Present so the basemap can be treated interchangeably with a real series. */
  labels?: SeriesLabelOptions
}

export class BaseFeatures {
  static readonly type = 'base' as const
  static readonly kind = 'features' as const

  readonly type = 'base' as const
  readonly kind = 'features' as const
  readonly id = 'base'
  readonly index = 0
  readonly config: BaseFeaturesConfig
  readonly fill: string
  readonly warnings: string[] = []
  readonly values = new Map<number, number | null>()
  readonly join = null
  readonly mutedClasses = new Set<number>()
  readonly scale: {
    nullColor: string
    nullLabel: string
    continuous: boolean
    classes: number
    domain: [number, number]
    classIndex: () => number
    color: () => string
    legendItems: () => never[]
    gradientStops: () => never[]
  }

  /**
   * @param config.fill `geo.fill`, else the theme's basemap colour.
   * @param outline The theme's outline colour, for the default stroke.
   */
  constructor({
    config = {},
    dark = false,
    outline,
  }: {
    config?: BaseFeaturesConfig
    dark?: boolean
    outline?: string
  }) {
    const defaults = THEME_DEFAULTS[dark ? 'dark' : 'light']
    this.config = { stroke: { color: outline || defaults.outline, width: 0.5 }, ...config }
    this.fill = config.fill || defaults.basemap
    // A minimal scale-shaped object so tooltip and legend code can read the
    // no-data labels without knowing whether a real scale exists.
    this.scale = {
      nullColor: this.fill,
      nullLabel: '',
      continuous: false,
      classes: 0,
      domain: [0, 0],
      classIndex: () => 0,
      color: () => this.fill,
      legendItems: () => [],
      gradientStops: () => [],
    }
  }

  valueFor(): null {
    return null
  }

  datumFor(): undefined {
    return undefined
  }

  fillFor(): string {
    return this.fill
  }

  hoverFill(color: string): string {
    return darken(color, 0.08)
  }

  /**
   * No texture on the basemap: it is a backdrop, and it carries no value to
   * encode. Takes the feature it ignores so the two feature series stay callable
   * through the same union.
   */
  paintFor(_feature?: NormalizedFeature): null {
    return null
  }

  readonly painted = false

  toggleClass(): boolean {
    return false
  }

  legendTitle(): string | undefined {
    return this.config.name
  }

  legendItems(): never[] {
    return []
  }

  /** A feature with no value to read: its name, as the map's tooltip gives it. */
  describe(_feature: NormalizedFeature, { name }: { name: string }): string {
    return name
  }

  advise(): string[] {
    return []
  }
}
