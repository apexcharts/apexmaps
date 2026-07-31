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
  AnnotationConnector,
  AnnotationLabel,
  AnnotationMarker,
  AnnotationOptions,
  ApexMapsOptions,
  ApexMapsEventMap,
  ApexMapsEventName,
  ArcDatum,
  ArcSeriesOptions,
  AreaAnnotation,
  BubbleDatum,
  BubbleSeriesOptions,
  CameraState,
  ChoroplethSeriesOptions,
  ChartOptions,
  ClusterOptions,
  DataLabelOptions,
  DrilldownContext,
  DrilldownOptions,
  FeatureAnnotation,
  FeatureEventPayload,
  FillContext,
  GeoInput,
  GeoOptions,
  ImageFillOptions,
  InteractionOptions,
  JoinSpec,
  LegendItem,
  LineDatum,
  LineSeriesOptions,
  LegendOptions,
  LonLat,
  MapSource,
  MarkerDatum,
  MarkerSeriesOptions,
  MarkerShape,
  Padding,
  PatternFillOptions,
  PatternType,
  PointAnnotation,
  PaletteName,
  ProjectionName,
  ProjectionSpec,
  ResponsiveRule,
  ScaleOptions,
  ScaleType,
  SelectionOptions,
  Series,
  SeriesFillOptions,
  SeriesLabelOptions,
  SeriesType,
  SizeOptions,
  SizeLegendEntry,
  StatesOptions,
  StrokeOptions,
  TooltipContext,
  TooltipOptions,
  ZoomControlsOptions,
  ZoomControlsPosition,
} from './types'

export type { ExportOptions } from './export/Exporter'
export type { MapMeta } from './core/MapRegistry'
export type { Palette, PaletteKind } from './scales/Palettes'
export type { JoinResult, JoinSuggestion } from './data/Join'
