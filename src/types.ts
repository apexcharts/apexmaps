/**
 * Public option types.
 *
 * This file is the product's main API surface, and the reason ApexMaps is
 * TypeScript rather than checked JavaScript: `Series` is a **discriminated
 * union**, so `type: 'arc'` requires `from`/`to` while `type: 'choropleth'`
 * requires `joinBy`, and getting it wrong is a compile error rather than a
 * dev-mode console warning. JSDoc cannot express that.
 *
 * Everything here stays JSON-serialisable in its declarative form. Function
 * forms are offered alongside (formatters, accessors) but never required, because
 * serialisability is what later makes saved dashboards, SSR, static story export
 * and agent authoring possible from one source of truth.
 *
 * @module types
 */

import type { Feature, FeatureCollection, Geometry, Position } from 'geojson'

// --- primitives -------------------------------------------------------------

/** `[longitude, latitude]` in degrees, WGS84. Always lon first, matching GeoJSON. */
export type LonLat = [number, number]

/** A point in projected world space, in pixels at camera scale 1. */
export type WorldPoint = [number, number]

/** A point in screen space, in CSS pixels relative to the plot. */
export type ScreenPoint = [number, number]

/** `[west, south, east, north]` in degrees. */
export type BBox4 = [number, number, number, number]

/** A box in world space: `[[x0, y0], [x1, y1]]`. */
export type WorldBounds = [WorldPoint, WorldPoint]

export interface PaddingObject {
  top?: number
  right?: number
  bottom?: number
  left?: number
}

export type Padding = number | PaddingObject

// --- geometry and projection ------------------------------------------------

/** Anything accepted as geometry input. */
export type GeoInput =
  | FeatureCollection
  | Feature
  | Geometry
  | Feature[]
  /** A TopoJSON topology. Typed loosely because topojson-specification is optional. */
  | {
      type: 'Topology'
      objects: Record<string, unknown>
      arcs: unknown[]
      [key: string]: unknown
    }

/** Registry id, URL, or geometry. */
export type MapSource = string | GeoInput

export type ProjectionName =
  | 'equalEarth'
  | 'mercator'
  | 'webMercator'
  | 'epsg:3857'
  | 'equirectangular'
  | 'plateCarree'
  | 'epsg:4326'
  | 'naturalEarth'
  | 'orthographic'
  | 'albers'
  | 'albersUsa'
  | 'conicConformal'
  | 'conicEqualArea'
  | 'conicEquidistant'
  | 'azimuthalEqualArea'
  | 'azimuthalEquidistant'
  | 'gnomonic'
  | 'stereographic'
  | 'transverseMercator'
  | 'identity'
  /** Anything registered via `ApexMaps.registerProjection()`. */
  | (string & {})

export interface ProjectionSpec {
  name?: ProjectionName
  /** `[lambda, phi]` or `[lambda, phi, gamma]` in degrees. */
  rotate?: [number, number] | [number, number, number]
  center?: LonLat
  /** Standard parallels, for conic projections. */
  parallels?: [number, number]
  angle?: number
  clipAngle?: number
  clipExtent?: WorldBounds
  reflectX?: boolean
  reflectY?: boolean
}

// --- scales -----------------------------------------------------------------

export type ScaleType =
  | 'quantile'
  | 'quantize'
  | 'equalInterval'
  | 'jenks'
  | 'naturalBreaks'
  | 'threshold'
  | 'linear'
  | 'log'
  | 'sqrt'
  | 'ordinal'

export type PaletteName =
  | 'blues'
  | 'greens'
  | 'oranges'
  | 'reds'
  | 'purples'
  | 'greys'
  | 'viridis'
  | 'magma'
  | 'teal'
  | 'rdbu'
  | 'brbg'
  | 'piyg'
  | 'spectral'
  | 'rdylgn'
  | 'apex'
  | 'tableau'
  | 'okabeIto'
  | (string & {})

export interface ScaleOptions {
  type?: ScaleType
  /** Number of classes for classed scales. Default 5. */
  classes?: number
  /** Registered palette name, or an explicit colour list (taken literally). */
  palette?: PaletteName | string[]
  domain?: [number, number]
  /** Explicit breaks, required by `type: 'threshold'`. */
  breaks?: number[]
  reverse?: boolean
  /** Round the domain outward. Default true for continuous scales. */
  nice?: boolean
  nullColor?: string
  nullLabel?: string
}

export type SizeScaleType = 'sqrt' | 'linear' | 'log'

export interface SizeOptions {
  /** Field or accessor supplying the magnitude. Defaults to the series' `valueField`. */
  field?: string | ((datum: unknown) => number | null | undefined)
  /**
   * `'sqrt'` by default, and deliberately: radius proportional to value makes a
   * circle's *area* grow with the square of the value, which overstates large
   * values by a wide margin. Linear is available and warns in dev mode.
   */
  scale?: SizeScaleType
  /** `[minRadius, maxRadius]` in screen pixels. */
  range?: [number, number]
  domain?: [number, number]
}

export interface LegendItem {
  color: string
  label: string
  from?: number
  to?: number
  count?: number
  isNull?: boolean
}

export interface SizeLegendEntry {
  radius: number
  value: number
  label: string
}

// --- series -----------------------------------------------------------------

/** `'name'`, `['iso_a3', 'code']`, or `{ geo, data }`. */
export type JoinSpec = string | [string, string] | { geo?: string; data?: string }

export interface StrokeOptions {
  color?: string
  width?: number
  opacity?: number
  /** SVG dash pattern, e.g. `'4 2'`. */
  dashArray?: string
}

export interface SeriesLabelOptions {
  show?: boolean
  field?: string | ((datum: unknown) => string)
}

export interface MarkAnimationOptions {
  /** `'grow'` for symbols, `'draw'` for paths, `'fade'` for either. */
  type?: 'grow' | 'draw' | 'fade' | 'none'
  duration?: number
  /** Per-mark delay, in ms, applied in render order. */
  stagger?: number
  ease?: string
}

interface SeriesCommon {
  name?: string
  visible?: boolean
  opacity?: number
  stroke?: StrokeOptions
  labels?: SeriesLabelOptions
  animation?: MarkAnimationOptions
  /** Field or accessor for the primary value. Default `'value'`. */
  valueField?: string | ((datum: unknown) => number | null | undefined)
}

/** What a drilldown decision gets told about the feature that was clicked. */
export interface DrilldownContext {
  /** Join key of the clicked feature: the key the child level is scoped by. */
  key: string
  name?: string
  /** The joined data row, when the feature had one. */
  datum: unknown
  properties?: Record<string, unknown>
  /** Level being entered. 1 is the first level below the top. */
  depth: number
  /** Map currently displayed, when it came from the registry. */
  from?: string
}

export interface DrilldownOptions {
  /**
   * The child map: a registry id, a URL, or geometry. The function form receives
   * the clicked feature and may return `null` to refuse, which is how a map with
   * children for only some features declines the rest.
   */
  map: string | ((context: DrilldownContext) => MapSource | null | undefined)
  /**
   * Which child features belong to the clicked parent.
   *
   * `'auto'` (default) looks for a child property holding the parent's key
   * (`state_abbr`, `cntr_code`, `adm0_a3`), then falls back to a key prefix
   * (county FIPS `06037` under state `06`, NUTS `DE12` under `DE1`). Published
   * hierarchical geometry nearly always carries one or the other, so the common
   * case needs no configuration. `'all'` draws the whole child map.
   */
  scope?: 'auto' | 'property' | 'keyPrefix' | 'all'
  /** Child property holding the parent's key. Skips detection. */
  parentField?: string
  /**
   * `'zoom'` (default) frames the clicked feature before the child level appears,
   * so the two views line up and the swap reads as a zoom rather than a cut.
   */
  animate?: 'zoom' | 'none'
  /** Trail above the map, with a way back up. Default true. */
  breadcrumb?: boolean | { rootLabel?: string }
}

export interface ChoroplethSeriesOptions extends SeriesCommon {
  type?: 'choropleth'
  joinBy?: JoinSpec
  data?: readonly unknown[]
  /** Apply normalised and alias matches, reporting each substitution. */
  fuzzyJoin?: boolean
  scale?: ScaleOptions
  /**
   * Divide the value by another field before mapping, e.g. `'population'`. The
   * legend retitles itself, because a choropleth of counts across unequal areas
   * mostly redraws the population map.
   */
  normalizeBy?: string
  /**
   * Click a feature to replace the map with a deeper level.
   *
   * The series keeps its own `data` across levels, so a single array holding rows
   * for both levels (states and counties, keyed the same way) needs no extra
   * wiring. For data fetched per level, listen for the `drilldown` event and call
   * `updateSeries` from the handler: the child level is already on screen by then.
   */
  drilldown?: DrilldownOptions
}

/** A bubble datum: either an explicit position, or a join key resolved to a centroid. */
export interface BubbleDatum {
  lon?: number
  lat?: number
  /** Alias for `lon`, for data that came from a `[lat, lng]` world. */
  lng?: number
  value?: number | null
  name?: string
  [key: string]: unknown
}

export interface BubbleSeriesOptions extends SeriesCommon {
  type: 'bubble'
  data?: readonly BubbleDatum[]
  /** Join to geometry centroids when the data has no coordinates. */
  joinBy?: JoinSpec
  fuzzyJoin?: boolean
  size?: SizeOptions
  /** A single fill, or a scale to colour bubbles by a second variable. */
  color?: string
  colorScale?: ScaleOptions
  /** Field or accessor for the colour value, when `colorScale` is set. */
  colorField?: string | ((datum: unknown) => number | null | undefined)
  /**
   * Draw largest first so small bubbles stay clickable on top. Default true.
   * Turning it off is almost always a mistake.
   */
  sortBySize?: boolean
}

/**
 * An arc datum. `from` and `to` are required, because an arc without endpoints is
 * not an arc: catching that at compile time is precisely what the discriminated
 * union buys. Each may be a `[lon, lat]` pair or a geometry key to resolve against
 * the current map.
 */
export interface ArcDatum {
  from: LonLat | string
  to: LonLat | string
  value?: number | null
  name?: string
  [key: string]: unknown
}

export interface LineDatum {
  /** Vertex sequence the route passes through, in order. */
  path?: readonly LonLat[]
  /** Accepted as a synonym for `path`, because the data often arrives as GeoJSON. */
  coordinates?: readonly LonLat[]
  id?: string
  name?: string
  value?: number | null
  /** Per-route override of the series colour. */
  color?: string
  [key: string]: unknown
}

/**
 * Built-in marker shapes. Every one is drawn from a generated path so it scales
 * cleanly and needs no sprite sheet, no image load and no CORS.
 *
 * `pin` is the teardrop everyone expects from a map, and it is the one shape that
 * is anchored at its point rather than its centre.
 */
export type MarkerShape = 'circle' | 'square' | 'diamond' | 'triangle' | 'star' | 'cross' | 'pin'

export interface MarkerDatum {
  lon?: number
  lat?: number
  /** Accepted as a synonym for `lon`, because half the world's data uses it. */
  lng?: number
  name?: string
  value?: number | null
  /** Groups markers for colouring and the legend. */
  category?: string
  /** Per-point overrides. */
  shape?: MarkerShape
  color?: string
  size?: number
  [key: string]: unknown
}

/**
 * Clustering is an option on the marker series, not a series of its own.
 *
 * The data is identical either way: clustering is a decision about how to draw
 * points that would otherwise pile up, in the same way that a choropleth's
 * classification is a decision about how to colour values. Making it a separate
 * series type would fork position resolution, hit testing, colouring and the
 * legend for no gain, and would force callers to swap series types at a zoom
 * threshold.
 */
export interface ClusterOptions {
  /** Default true when a `cluster` object is present at all. */
  enabled?: boolean
  /** Screen-space merge distance in pixels. Default 60. */
  radius?: number
  /** Above this zoom, draw individual markers. Default 8. */
  maxZoom?: number
  /** Fewer members than this stay as individual markers. Default 2. */
  minPoints?: number
  /** Radius range in pixels for the cluster circle, smallest to largest count. */
  size?: [number, number]
  color?: string
  /** Show the member count inside the circle. Default true. */
  showCount?: boolean
  /** Zoom to the members' bounds when a cluster is clicked. Default true. */
  zoomOnClick?: boolean
}

export interface MarkerSeriesOptions extends SeriesCommon {
  type: 'marker'
  data?: readonly MarkerDatum[]
  /** Join to geometry centroids when the data carries no coordinates. */
  joinBy?: JoinSpec
  fuzzyJoin?: boolean
  /** Shape for every marker, or a function of the datum. */
  shape?: MarkerShape | ((datum: unknown) => MarkerShape)
  /**
   * Pixel size, the width of the shape's bounding box. Default 10.
   *
   * Fixed on purpose: a marker says "something is here". When size should encode
   * a quantity, that is the bubble series, which scales by area.
   */
  size?: number
  color?: string
  /** Field holding the category, for categorical colour and a legend. */
  colorBy?: string
  palette?: string
  cluster?: ClusterOptions
}

export interface ArcSeriesOptions extends SeriesCommon {
  type: 'arc'
  data?: readonly ArcDatum[]
  /**
   * Follow the great circle. Default true, and it matters: a straight line
   * between Tokyo and New York in Mercator is not the route a plane flies, and
   * naive straight lines break at the antimeridian.
   */
  geodesic?: boolean
  /**
   * Bulge the arc perpendicular to its chord, 0 to about 1. Decorative rather
   * than geographic: a curved arc is no longer the true path, so it is off by
   * default and mutually exclusive with `geodesic` accuracy.
   */
  curvature?: number
  /** Line width scale driven by `value`. */
  width?: SizeOptions
  color?: string
  colorScale?: ScaleOptions
  /** Draw a dot at each end. */
  endpoints?: { show?: boolean; radius?: number; color?: string }
  /** Resolve string endpoints against geometry keys. */
  joinBy?: JoinSpec
}

/**
 * A route drawn through the vertices it is given, in order. Unlike an arc,
 * which derives the great circle between two endpoints, the caller supplies
 * the whole path: a GPS trace, a shipping lane, a transit line.
 */
export interface LineSeriesOptions extends SeriesCommon {
  type: 'line'
  data?: readonly LineDatum[]
  /** Line width scale driven by `value`. */
  width?: SizeOptions
  color?: string
  colorScale?: ScaleOptions
  /** Draw a dot at each route's start and end. */
  endpoints?: { show?: boolean; radius?: number; color?: string }
}

export type Series =
  | ChoroplethSeriesOptions
  | BubbleSeriesOptions
  | ArcSeriesOptions
  | MarkerSeriesOptions
  | LineSeriesOptions

export type SeriesType = NonNullable<Series['type']>

// --- top-level options ------------------------------------------------------

export type RendererKind = 'auto' | 'svg' | 'canvas' | 'webgl'

export interface ChartOptions {
  width?: number | string
  height?: number | string
  /** Seeds the default `type` for series that omit it. */
  type?: SeriesType
  renderer?: RendererKind
  background?: string
  fontFamily?: string
  /**
   * `'story'` animates entrances; `'dashboard'` does not, because a dashboard
   * reader wants the number now rather than a performance.
   */
  context?: 'story' | 'dashboard'
  /**
   * Value transitions. Data updates (`updateSeries`, palette changes, legend
   * toggles) tween fills, radii and stroke widths at `speed`; camera-driven
   * geometry never animates, because it is written per frame while panning.
   * Past a few thousand marks the engine degrades on its own: geometry stops
   * animating first, then everything, because dropped frames read as a bug
   * while a simpler transition reads as restraint. `prefers-reduced-motion`
   * disables all of it. `entrance` fades the mark layers in on first paint,
   * and defaults on only under `chart.context: 'story'`.
   */
  animations?: {
    enabled?: boolean
    speed?: 'slow' | 'normal' | 'fast' | 'instant' | number
    entrance?: boolean
  }
  events?: Partial<Record<ApexMapsEventName, (payload: never) => void>>
}

export interface GeoOptions {
  map?: MapSource | null
  /** TopoJSON object name, when the topology holds several. */
  object?: string
  keyField?: string
  nameField?: string
  /** Normalise ring winding on ingest. Default true; see `geo/GeoData`. */
  repairWinding?: boolean
  projection?: ProjectionName | ProjectionSpec
  view?: {
    fit?: 'data' | 'world' | 'none' | BBox4
    padding?: Padding
  }
  graticule?: { show?: boolean; step?: number; color?: string; width?: number }
  sphere?: { show?: boolean; fill?: string; stroke?: string; width?: number }
  /** Fill for the no-data basemap drawn when no series is configured. */
  fill?: string
  /** Disputed-territory policy. Declared but not applied yet. */
  boundaries?: 'de-facto' | 'un' | 'neutral-dashed' | 'none'
}

export interface LegendOptions {
  show?: boolean
  position?: 'bottom' | 'top' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  title?: string
  /** Click a class to mute it. */
  interactive?: boolean
  showNull?: boolean
  style?: 'auto' | 'classes' | 'gradient'
  formatter?: (item: LegendItem, index: number) => string
}

export interface TooltipContext {
  key: string
  name?: string
  value: number | null
  datum: unknown
  properties?: Record<string, unknown>
  series: Series
}

export interface TooltipOptions {
  enabled?: boolean
  followCursor?: boolean
  /** Returns HTML. Responsible for its own escaping. */
  formatter?: (context: TooltipContext) => string
  valueFormatter?: (value: number) => string
  offset?: [number, number]
}

export interface DataLabelOptions {
  enabled?: boolean
  field?: string | ((datum: unknown) => string)
  formatter?: (context: { value: number | null; name?: string; key?: string }) => string
  /** `'hide'` drops labels that would overlap. */
  collision?: 'hide' | 'none'
  /** Skip labels for features smaller than this many square pixels. */
  minFeatureArea?: number
  style?: {
    fontSize?: number
    fontWeight?: number | string
    halo?: boolean
    haloColor?: string
    haloWidth?: number
  }
}

export interface StatesOptions {
  hover?: {
    enabled?: boolean
    brightness?: number
    stroke?: string
    strokeWidth?: number
  }
  active?: { enabled?: boolean; stroke?: string; strokeWidth?: number }
  muted?: { opacity?: number }
}

export interface SelectionOptions {
  enabled?: boolean
  multiple?: boolean
  /**
   * Drag a box to select everything inside it. Default true, since it costs
   * nothing when unused: a plain drag still pans.
   */
  rectangle?: boolean
  /**
   * Modifier that turns a drag into a selection box. Default `'shift'`, which is
   * the convention everywhere a drag already means something else.
   *
   * `'none'` makes every drag a selection box, and therefore requires
   * `pan.enabled: false`: one gesture cannot mean both.
   */
  modifier?: 'shift' | 'alt' | 'meta' | 'ctrl' | 'none'
}

export interface InteractionOptions {
  zoom?: {
    enabled?: boolean
    min?: number
    max?: number
    wheel?: boolean
    doubleClick?: boolean
    step?: number
  }
  pan?: { enabled?: boolean; inertia?: boolean }
  selection?: SelectionOptions
  /**
   * Proximity hit assistance for point marks (bubbles, markers, clusters): a
   * pointer within `radius` screen pixels of a mark hovers and clicks it as if
   * it were on it, so a 3px bubble does not demand a 3px hit. Nearest mark
   * wins, the way a Voronoi tessellation would decide it. Direct hits on other
   * point or path marks still take precedence; area features yield, because on
   * a choropleth-with-bubbles map everything near a bubble is over a feature.
   */
  nearest?: { enabled?: boolean; radius?: number }
}

export interface A11yOptions {
  enabled?: boolean
  /** `'auto'` generates a description from the spec and the data. */
  description?: 'auto' | string
  label?: string
  dataTable?: boolean
  /** Make individual features keyboard-reachable below this count. */
  keyboardFeatureLimit?: number
}

export interface ResponsiveRule {
  breakpoint: number
  options: ApexMapsOptions
}

export interface ApexMapsOptions {
  chart?: ChartOptions
  geo?: GeoOptions
  series?: readonly Series[]
  legend?: LegendOptions
  tooltip?: TooltipOptions
  dataLabels?: DataLabelOptions
  states?: StatesOptions
  theme?: { mode?: 'light' | 'dark' | 'auto'; palette?: PaletteName }
  interaction?: InteractionOptions
  a11y?: A11yOptions
  annotations?: { points?: unknown[]; features?: unknown[]; areas?: unknown[] }
  /**
   * Cross-filter group. Maps naming the same group share their selection, so
   * brushing one brushes the others, and non-selected features dim on all of them.
   * Keys have to mean the same thing across the group, which they do whenever the
   * maps are of the same geography.
   *
   * `filter` controls direction: `'emit'` sends without receiving, `'receive'`
   * follows without leading.
   */
  link?: { group?: string; filter?: 'bidirectional' | 'emit' | 'receive' }
  debug?: { enabled?: boolean | 'auto'; joinDiagnostics?: boolean }
  responsive?: ResponsiveRule[]
}

/** The options tree after defaults are merged in: same shape, nothing optional. */
export type ResolvedOptions = Required<{
  [K in keyof ApexMapsOptions]: NonNullable<ApexMapsOptions[K]>
}>

// --- events -----------------------------------------------------------------

export interface FeatureEventPayload {
  key: string
  name?: string
  value: number | null
  datum: unknown
  properties?: Record<string, unknown>
  seriesName?: string
  seriesIndex: number
  instance: unknown
}

export interface ApexMapsEventMap {
  rendered: { instance: unknown }
  updated: { instance: unknown }
  resized: { width: number; height: number }
  featureClick: FeatureEventPayload
  featureHover: FeatureEventPayload
  featureFocus: FeatureEventPayload
  markClick: FeatureEventPayload
  markHover: FeatureEventPayload
  /** A point cluster was clicked. Fires before the camera moves to its members. */
  clusterClick: FeatureEventPayload
  /** A deeper level is on screen. Fires after it renders, so a handler can update data. */
  drilldown: {
    key: string
    name?: string
    /** Map left behind. */
    from?: string
    /** Map now displayed. */
    to?: string
    depth: number
    /** Features the child level was scoped to. */
    featureCount: number
    instance: unknown
  }
  drillup: { to?: string; depth: number; instance: unknown }
  selectionChange: { ids: string[]; source: string }
  legendToggle: { classIndex: number; instance: unknown }
  zoom: { k: number }
  panEnd: undefined
}

export type ApexMapsEventName = keyof ApexMapsEventMap

// --- internal shared shapes -------------------------------------------------

/** A feature after ingest, with a resolved join key. */
export interface NormalizedFeature {
  key: string
  name?: string
  /**
   * Null is legal in GeoJSON and means "this feature has no location". Such a
   * feature still carries properties, so it is kept rather than dropped: it can
   * still satisfy a join and appear in the accessible data table. It simply
   * renders nothing.
   */
  geometry: Geometry | null
  properties: Record<string, unknown>
  index: number
  /** The original input feature, kept for round-tripping. Never measured against. */
  raw?: Feature | Geometry | unknown
}

export interface NormalizedGeo {
  features: NormalizedFeature[]
  /** Valid GeoJSON built from repaired geometry, safe to hand to d3-geo. */
  collection: FeatureCollection<Geometry | null>
  keyField: string
  nameField?: string
  source: 'geojson' | 'topojson'
  objectName?: string
  warnings: string[]
}

export interface CameraState {
  k: number
  x: number
  y: number
}

/** World-space label anchor plus the feature's approximate projected area. */
export interface Anchor {
  world: WorldPoint
  area: number
}

/** What a series contributes to hit-testing, tooltips and accessibility. */
export interface MarkItem {
  /** Stable identity within the series. */
  key: string
  name?: string
  value: number | null
  datum: unknown
  /** Position for tooltips and keyboard focus. */
  anchor?: WorldPoint
  properties?: Record<string, unknown>
}

export type { Feature, FeatureCollection, Geometry, Position }
