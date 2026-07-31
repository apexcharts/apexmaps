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
  /**
   * The tile this class is painted with, when the series has a pattern fill, so
   * the swatch shows what the map shows. Filled in by the series; there is nothing
   * to set here.
   */
  pattern?: ResolvedPattern
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
   * `'zoom'` (default) frames the clicked feature, hands the child level the exact
   * place on screen that feature had, dissolves the level being left out over it,
   * and develops the child out of the parent's own colour from the middle
   * outwards. So the geography never moves across the swap and the child is never
   * simply *there*: what the reader sees is the parent shape dividing into its
   * children. `'none'` swaps with no motion, which is also what a reader who has
   * asked for reduced motion gets either way.
   */
  animate?: 'zoom' | 'none'
  /** Trail above the map, with a way back up. Default true. */
  breadcrumb?: boolean | { rootLabel?: string }
}

/**
 * What a per-feature fill decision gets told about the feature it is deciding
 * for. `color` is the colour the scale already resolved, so a pattern can tint
 * itself from the data rather than being told a colour twice.
 */
export interface FillContext {
  key: string
  name?: string
  value: number | null
  datum: unknown
  properties?: Record<string, unknown>
  /** What the feature would have been filled with, flat. */
  color: string
  /** Class index on the scale, or -1 on a continuous scale. */
  classIndex: number
}

/**
 * Built-in pattern tiles. `'custom'` takes `path` instead.
 *
 * Shape tiles (`dots`, `squares`, `checks`) are filled; line tiles (`lines`,
 * `grid`, `diagonal`, `crosshatch`) are stroked at `strokeWidth`.
 */
export type PatternType =
  'dots' | 'squares' | 'checks' | 'lines' | 'grid' | 'diagonal' | 'crosshatch' | 'custom'

export interface PatternFillOptions {
  /** Default `'dots'`. */
  type?: PatternType
  /** Tile geometry for `type: 'custom'`, drawn in a `size` by `size` box. */
  path?: string
  /**
   * Spacing between one mark and the next, in screen pixels. Default 10.
   *
   * Screen pixels, not world: the tile is rescaled as the reader zooms so the
   * texture holds its size, on the same reasoning as `non-scaling-stroke`. A
   * texture that grows with the camera stops reading as a texture and starts
   * reading as geometry.
   *
   * The marks are deliberately small against it (a dot covers about a twelfth of
   * its tile), because the fill is still the colour and the tile is a mark on it.
   * Tightening the spacing is how a patterned map turns muddy: the ink averages
   * with the colour into a shade that is on no scale.
   */
  size?: number
  /**
   * Ink colour. Defaults to white on a background dark enough to carry it, and to
   * a darkened tint of the background otherwise, so the texture stays legible
   * across a whole sequential ramp without being configured per class.
   */
  color?: string
  /** Tile background. Defaults to the colour the scale resolved for the feature. */
  background?: string
  /** Ink weight for line tiles. Default a fifth of `size`, so gaps dominate. */
  strokeWidth?: number
  /** Rotate the tile, in degrees. Default 0. */
  angle?: number
  /** Ink opacity. Default 1. */
  opacity?: number
}

/**
 * A pattern with every default applied: what the renderer draws, and what a legend
 * swatch is handed so it can draw the same tile. `resolvePattern` produces it.
 */
export interface ResolvedPattern {
  type: PatternType
  path?: string
  size: number
  color: string
  background: string
  strokeWidth: number
  angle: number
  opacity: number
}

export interface ImageFillOptions {
  /**
   * Image URL. The function form runs per feature, which is the useful one: it is
   * how each region gets its own picture (a flag, a satellite tile, a portrait).
   * Returning `null` leaves that feature on its flat colour.
   */
  src: string | ((context: FillContext) => string | null | undefined)
  /**
   * How the image sits in the feature's bounding box. `'cover'` (default) fills
   * the box and crops the overflow, `'contain'` fits the whole image inside it,
   * `'fill'` stretches. The feature's own outline does the clipping either way.
   */
  fit?: 'cover' | 'contain' | 'fill'
  /**
   * Painted under the image. Defaults to the feature's flat colour, which is what
   * shows through a `'contain'` fit and while the image is still loading.
   */
  background?: string
  /** Image opacity. Default 1. */
  opacity?: number
}

/**
 * Texture instead of, or over, a flat fill.
 *
 * Both are licensed features: they work without a key for evaluation, with a
 * watermark.
 *
 * `image` wins where both are set. No-data features are never textured: an
 * absence has to keep reading as an absence, and a pattern over it reads as one
 * more category.
 */
export interface SeriesFillOptions {
  /** One pattern for the series, or a decision per feature. */
  pattern?: PatternFillOptions | ((context: FillContext) => PatternFillOptions | null | undefined)
  image?: ImageFillOptions
}

export interface ChoroplethSeriesOptions extends SeriesCommon {
  type?: 'choropleth'
  joinBy?: JoinSpec
  data?: readonly unknown[]
  /** Apply normalised and alias matches, reporting each substitution. */
  fuzzyJoin?: boolean
  scale?: ScaleOptions
  /**
   * Pattern or image fills, on top of what `scale` decided.
   *
   * Licensed feature: works without a key for evaluation, with a watermark.
   */
  fill?: SeriesFillOptions
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
   *
   * Licensed feature: works without a key for evaluation, with a watermark.
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
  /** Licensed feature: works without a key for evaluation, with a watermark. */
  cluster?: ClusterOptions
}

/**
 * Beads travelling along a route, so a connection reads as a direction.
 *
 * An arc says two places are related; it does not say which way anything moves,
 * and on a hub map every route leaves the same airport, so the reader cannot
 * infer it either. Drawn as a dashed companion path animated on its dash offset,
 * which is why `speed` and `spacing` are in screen pixels and the route's length
 * never enters into it: see `series/flow`.
 *
 * `prefers-reduced-motion`, `chart.animations.enabled: false` and a route count
 * past the flow budget all leave the beads in place and stop them moving, because
 * a dotted route still reads as a route.
 */
export interface FlowOptions {
  /**
   * `'dots'` beads the route, which is the one that reads as traffic. `'dash'`
   * marches a dashed highlight along it instead.
   */
  style?: 'dots' | 'dash'
  /**
   * Whether the beads belong to the ground or to the screen.
   *
   * `'zoom'`, the default, anchors them to the route: zooming in spreads them out
   * with the geography and enlarges them, so a bead stays over the same stretch of
   * route and the number of beads on it does not change. `'screen'` holds their
   * size and spacing fixed however far the reader zooms, which is what a dashboard
   * wants when the beads are furniture rather than geography, and which turns a
   * route into a dotted line once it is a few times longer than it opened.
   *
   * Each of the three is bounded under `'zoom'`, because each degenerates in its
   * own way at the far end of the camera. Beads reach three times their opening
   * size (past which they are a blob on a route that kept its own width), twice
   * their opening pace (past which they read as agitation), and six times their
   * opening spacing (past which they thin out until none is in view, because the
   * viewport does not grow with the zoom). Beyond all three the flow looks the same
   * however far the reader keeps going.
   */
  scale?: 'zoom' | 'screen'
  /**
   * Travel speed in screen pixels per second, at the zoom the map opened at.
   * Default 90.
   *
   * Under `scale: 'zoom'` a bead covers the same ground per second whatever the
   * zoom, so it appears faster the closer the reader gets, as anything moving over
   * a map does, up to twice this and then no faster.
   */
  speed?: number
  /**
   * Screen pixels between one bead and the next, at the zoom the map opened at, and
   * up to six times that as the reader zooms in. Default 56, which is chosen so that
   * a route of ordinary length carries a handful of beads rather than a dotted
   * texture.
   *
   * Lower it for a map of short routes: the pattern repeats along the path, so a
   * route shorter than the spacing carries at most one bead, and for part of each
   * cycle none.
   */
  spacing?: number
  /**
   * Bead diameter, or dash weight, in screen pixels. Defaults to the route's own
   * width so the heavy corridors carry the fat beads.
   */
  size?: number
  /** Defaults to the route's colour. */
  color?: string
  /** Default 1, so the beads stand off a route drawn under full opacity. */
  opacity?: number
  /**
   * Offset each route's phase, so a corridor of parallel routes reads as traffic
   * rather than as one synchronised pulse. Default true.
   */
  stagger?: boolean
}

/** Licensed feature: works without a key for evaluation, with a watermark. */
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
  /** Send beads along the route, from `from` towards `to`. `true` for defaults. */
  flow?: boolean | FlowOptions
  /** Resolve string endpoints against geometry keys. */
  joinBy?: JoinSpec
}

/**
 * A route drawn through the vertices it is given, in order. Unlike an arc,
 * which derives the great circle between two endpoints, the caller supplies
 * the whole path: a GPS trace, a shipping lane, a transit line.
 *
 * Licensed feature: works without a key for evaluation, with a watermark.
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
  /** Send beads along the route, in the order its vertices were given. */
  flow?: boolean | FlowOptions
}

export type Series =
  | ChoroplethSeriesOptions
  | BubbleSeriesOptions
  | ArcSeriesOptions
  | MarkerSeriesOptions
  | LineSeriesOptions

export type SeriesType = NonNullable<Series['type']>

// --- top-level options ------------------------------------------------------

export interface ChartOptions {
  width?: number | string
  height?: number | string
  /** Seeds the default `type` for series that omit it. */
  type?: SeriesType
  background?: string
  fontFamily?: string
  /**
   * `'story'` animates entrances; `'dashboard'` does not, because a dashboard
   * reader wants the number now rather than a performance.
   *
   * `'story'` is a licensed feature: works without a key for evaluation, with a watermark.
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
  /**
   * Which side of the plot the legend sits on. `'left'` and `'right'` make it a
   * column: the plot is measured against what is left of the container, and a
   * gradient bar turns vertical.
   */
  position?: 'bottom' | 'top' | 'left' | 'right'
  /** Column width in pixels for `position: 'left' | 'right'`. Default 180. */
  width?: number
  align?: 'start' | 'center' | 'end'
  title?: string
  /** Click a class to mute it. */
  interactive?: boolean
  showNull?: boolean
  style?: 'auto' | 'classes' | 'gradient'
  formatter?: (item: LegendItem, index: number) => string
  /** Numbers printed under a gradient bar: class boundaries, or the two ends. */
  tickFormatter?: (value: number) => string
  /**
   * The arrow that rides the gradient bar and tracks the hovered feature, so a
   * reader sees where it falls on the scale instead of matching colours by eye.
   * Gradient-style legends only; on by default. `label: false` keeps the arrow
   * and drops the value that rides above it.
   */
  marker?: boolean | { show?: boolean; label?: boolean }
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

export type ZoomControlsPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/**
 * On-screen `+` / `-` buttons, and a control that returns the opening view.
 *
 * Rendered by default wherever zoom is enabled, because every other way to
 * change scale is a gesture: without them there is no keyboard path to a closer
 * look, and on a trackpad over a scrolling page there is barely a mouse one.
 * A dashboard that wants a clean tile sets `interaction.zoom.controls: false`.
 */
export interface ZoomControlsOptions {
  show?: boolean
  /** Corner of the plot the group sits in. Default `'top-right'`. */
  position?: ZoomControlsPosition
  /**
   * Include the reset control. Default true: at the default step, eight clicks
   * of `+` pass 40x, and no gesture takes the reader back to the whole map in
   * one move. Turn it off where a breadcrumb or the host's own chrome says
   * "back" already.
   */
  reset?: boolean
}

export interface InteractionOptions {
  zoom?: {
    enabled?: boolean
    min?: number
    max?: number
    wheel?: boolean
    doubleClick?: boolean
    /**
     * Scale factor per step, used by the buttons, the keyboard and a
     * double-click. Default 1.6.
     */
    step?: number
    /** `false` removes the on-screen controls. See {@link ZoomControlsOptions}. */
    controls?: boolean | ZoomControlsOptions
  }
  pan?: { enabled?: boolean; inertia?: boolean }
  /**
   * Spin the sphere on drag instead of panning the plane.
   *
   * `'auto'` (the default) turns it on for globe projections (`orthographic`)
   * and leaves every other projection panning, since on a flat map a drag means
   * "move the map". `true` forces it on for any projection that can rotate and
   * invert, which is how a stereographic or azimuthal view opts in; `false`
   * gives the drag back to panning.
   *
   * `inertia` defaults to `pan.inertia`, so a map that opted out of momentum
   * once does not have to opt out twice.
   */
  rotate?: { enabled?: boolean | 'auto'; inertia?: boolean }
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

// --- annotations -------------------------------------------------------------

/**
 * A text chip on an annotation.
 *
 * The chip (background, border, radius) rather than bare text is the default
 * because an annotation has to stay readable over whatever the map puts
 * underneath it, and editorial text sitting directly on a choropleth is
 * legible on some classes and not others. `background: 'none'` gives bare
 * haloed text for callers who want it.
 *
 * Naming follows `pointAnnotation` in apexcharts core, so the shape is
 * recognisable to anyone who has annotated a chart.
 */
export interface AnnotationLabel {
  text?: string
  /** Side of the anchor the chip sits on. Default `'top'`. */
  position?: 'top' | 'bottom' | 'left' | 'right' | 'center'
  offsetX?: number
  offsetY?: number
  color?: string
  fontSize?: number
  fontWeight?: number | string
  /** Chip fill. `'none'` draws haloed text with no chip. */
  background?: string
  borderColor?: string
  borderWidth?: number
  borderRadius?: number
  padding?: number
}

/** A symbol at an annotation's anchor, drawn with the marker shape set. */
export interface AnnotationMarker {
  show?: boolean
  shape?: MarkerShape
  size?: number
  fill?: string
  stroke?: StrokeOptions
}

/** A leader line from an anchor to its offset label. */
export type AnnotationConnector = boolean | { color?: string; width?: number; dashArray?: string }

interface AnnotationCommon {
  /** Stable identity, for `updateOptions` reconciliation and CSS targeting. */
  id?: string
  /** `'Some text'` is shorthand for `{ text: 'Some text' }`. */
  label?: AnnotationLabel | string
  marker?: AnnotationMarker
  connector?: AnnotationConnector
  /** Extra class on the annotation group. */
  className?: string
}

/** An annotation pinned to a coordinate. */
export interface PointAnnotation extends AnnotationCommon {
  /** `[lon, lat]`. */
  at: LonLat
}

/**
 * An annotation attached to a feature by key, anchored at the same point the
 * label engine uses, so it tracks the geometry through projection changes and
 * lands where a reader would put it by hand.
 */
export interface FeatureAnnotation extends AnnotationCommon {
  key: string
  /** Trace the feature's own outline. `true` uses the theme's focus colour. */
  outline?: boolean | StrokeOptions
}

/**
 * A region highlight: a lon/lat bounding box, or any GeoJSON geometry.
 *
 * Drawn in world space through the projection, so it warps with the map rather
 * than staying a screen-space rectangle over a curved graticule.
 */
export interface AreaAnnotation extends AnnotationCommon {
  /** `[west, south, east, north]`. */
  bounds?: BBox4
  /** Any GeoJSON geometry, when a box is the wrong shape. */
  geometry?: unknown
  fill?: string
  fillOpacity?: number
  stroke?: StrokeOptions
}

/**
 * Editorial overlay: the layer that says what the map is about.
 *
 * Annotations are deliberate statements, so they are never dropped for
 * collision the way generated labels are, and generated labels yield to them
 * instead. They are also inert to the pointer, so an annotation can be placed
 * over data without stealing its hover or click.
 */
export interface AnnotationOptions {
  points?: PointAnnotation[]
  features?: FeatureAnnotation[]
  areas?: AreaAnnotation[]
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
  /** Licensed feature: works without a key for evaluation, with a watermark. */
  annotations?: AnnotationOptions
  /**
   * Cross-filter group. Maps naming the same group share their selection, so
   * brushing one brushes the others, and non-selected features dim on all of them.
   * Keys have to mean the same thing across the group, which they do whenever the
   * maps are of the same geography.
   *
   * `filter` controls direction: `'emit'` sends without receiving, `'receive'`
   * follows without leading.
   *
   * Licensed feature: works without a key for evaluation, with a watermark.
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
  /** The globe turned. `rotate` is the projection's `[lambda, phi, gamma]`. */
  rotate: { rotate: [number, number, number] }
  /** The globe came to rest, after any inertial glide. */
  rotateEnd: { rotate: [number, number, number] }
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
