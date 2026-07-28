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
  A11yOptions,
  ApexMapsOptions,
  ApexMapsEventMap,
  ApexMapsEventName,
  ArcDatum,
  ArcSeriesOptions,
  BubbleDatum,
  BubbleSeriesOptions,
  CameraState,
  ChoroplethSeriesOptions,
  ChartOptions,
  ClusterOptions,
  DataLabelOptions,
  DrilldownContext,
  DrilldownOptions,
  FeatureEventPayload,
  GeoInput,
  GeoOptions,
  InteractionOptions,
  JoinSpec,
  LegendItem,
  LegendOptions,
  LonLat,
  MapSource,
  MarkerDatum,
  MarkerSeriesOptions,
  MarkerShape,
  Padding,
  PaletteName,
  ProjectionName,
  ProjectionSpec,
  ResponsiveRule,
  ScaleOptions,
  ScaleType,
  SelectionOptions,
  Series,
  SeriesLabelOptions,
  SeriesType,
  SizeOptions,
  SizeLegendEntry,
  StatesOptions,
  StrokeOptions,
  TooltipContext,
  TooltipOptions,
} from './types'

export type { ExportOptions } from './export/Exporter'
export type { MapMeta } from './core/MapRegistry'
export type { Palette, PaletteKind } from './scales/Palettes'
export type { JoinResult, JoinSuggestion } from './data/Join'
