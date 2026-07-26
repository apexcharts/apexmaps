/**
 * Package entry point.
 *
 * Re-exports the public types alongside the class so consumers can annotate their
 * own option objects, which is the main reason this package is TypeScript.
 *
 * @module index
 */

import ApexMaps from './ApexMaps'

export { ApexMaps }
export default ApexMaps

export type {
  ApexMapsOptions,
  ApexMapsEventMap,
  ApexMapsEventName,
  ArcDatum,
  ArcSeriesOptions,
  BubbleDatum,
  BubbleSeriesOptions,
  ChoroplethSeriesOptions,
  ChartOptions,
  DataLabelOptions,
  FeatureEventPayload,
  GeoInput,
  GeoOptions,
  InteractionOptions,
  JoinSpec,
  LegendItem,
  LegendOptions,
  LonLat,
  MapSource,
  Padding,
  PaletteName,
  ProjectionName,
  ProjectionSpec,
  ScaleOptions,
  ScaleType,
  Series,
  SeriesType,
  SizeOptions,
  SizeLegendEntry,
  StrokeOptions,
  TooltipContext,
  TooltipOptions,
} from './types'

export type { MapMeta } from './core/MapRegistry'
export type { Palette, PaletteKind } from './scales/Palettes'
export type { JoinResult, JoinSuggestion } from './data/Join'
