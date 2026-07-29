/**
 * Default options and merge semantics.
 *
 * The whole spec is a plain, JSON-serialisable object tree. That is not an
 * aesthetic preference: serialisability is what later makes saved dashboards,
 * server-side rendering, static story export, a visual editor and LLM authoring
 * all possible from one source of truth.
 * Functions are permitted for formatters, but every field that can be expressed
 * declaratively has a declarative form.
 *
 * @module core/Config
 */

import type { ApexMapsOptions, ResolvedOptions, Series, SeriesType } from '../types'

/** A fresh defaults tree. Never shared between instances. */
export function defaults(): ResolvedOptions {
  return {
    chart: {
      /** Container width. Numbers are pixels; strings are CSS. */
      width: '100%',
      height: 400,
      /** Sets sensible defaults for the whole spec. */
      type: 'choropleth',
      /** `'auto' | 'svg' | 'canvas' | 'webgl'`. A hint, not a contract. */
      renderer: 'auto',
      /**
       * Geometry marks at which `'auto'` promotes to the canvas tier. Set where
       * the DOM itself becomes the problem, not where frames do: canvas does not
       * make panning faster, it removes the elements. See
       * DEFAULT_RENDERER_THRESHOLD for the measurements.
       */
      rendererThreshold: 20000,
      background: 'transparent',
      fontFamily: 'inherit',
      /**
       * `'story'` animates entrances by default; `'dashboard'` does not, because
       * a dashboard reader wants the number now, not a performance.
       */
      context: 'dashboard',
      animations: {
        enabled: true,
        /** `'slow' | 'normal' | 'fast' | 'instant' | number` (ms). */
        speed: 'normal',
        /**
         * Fade the mark layers in on first paint. Off by default: a dashboard
         * reader wants the number now, not a performance. `context: 'story'`
         * turns it on (see `buildConfig`), and an explicit value always wins.
         */
        entrance: false,
      },
      events: {},
    },

    geo: {
      /** Registry id, URL, GeoJSON object, or TopoJSON object. */
      map: null,
      /** TopoJSON object name, when the topology has several. */
      object: undefined,
      /** Force the geometry join-key property. */
      keyField: undefined,
      /** Force the label property. */
      nameField: undefined,
      /** Repair RFC 7946 ring winding. On by default: the failure mode is silent and catastrophic. */
      repairWinding: true,
      /**
       * Equal Earth by default. A world thematic map in Web Mercator
       * misrepresents area by an order of magnitude at high latitudes, and most
       * developers do not pick a projection at all, so the default has to be the
       * defensible one.
       */
      projection: 'equalEarth',
      view: {
        /** `'data' | 'world' | 'none'` or a bbox. */
        fit: 'data',
        padding: 16,
      },
      graticule: {
        show: false,
        step: 20,
        color: 'rgba(128,128,128,0.25)',
        width: 0.5,
      },
      sphere: {
        show: false,
        fill: 'none',
        stroke: 'rgba(128,128,128,0.4)',
        width: 0.5,
      },
      /** Disputed-territory rendering policy. Declared but not applied yet. */
      boundaries: 'neutral-dashed',
    },

    /** Data-bound marks. Non-data substrate belongs in `basemap` / `layers`. */
    series: [],

    legend: {
      show: true,
      /** `'bottom' | 'top' | 'left' | 'right'` */
      position: 'bottom',
      align: 'center',
      title: undefined,
      /** Click a class to mute it. */
      interactive: true,
      showNull: true,
      /** `'auto' | 'classes' | 'gradient'` */
      style: 'auto',
      formatter: undefined,
    },

    tooltip: {
      enabled: true,
      followCursor: true,
      /** `(datum, context) => string` returning HTML. */
      formatter: undefined,
      valueFormatter: undefined,
      offset: [12, 12],
    },

    dataLabels: {
      enabled: false,
      /** Property or accessor for the label text. Defaults to the feature name. */
      field: undefined,
      formatter: undefined,
      /** `'hide' | 'none'`. `'hide'` drops labels that would overlap. */
      collision: 'hide',
      /** Skip labels for features smaller than this many square pixels. */
      minFeatureArea: 240,
      style: { fontSize: 11, fontWeight: 500, halo: true },
    },

    states: {
      hover: {
        enabled: true,
        brightness: 0.08,
        stroke: undefined,
        strokeWidth: undefined,
      },
      active: { enabled: true, stroke: '#111111', strokeWidth: 1.5 },
      muted: { opacity: 0.25 },
    },

    theme: {
      /** `'light' | 'dark' | 'auto'` */
      mode: 'light',
      /** Default palette when a series does not specify one. */
      palette: undefined,
    },

    interaction: {
      zoom: {
        enabled: true,
        min: 0.8,
        max: 4096,
        wheel: true,
        doubleClick: true,
        step: 1.6,
      },
      pan: { enabled: true, inertia: true },
      selection: { enabled: true, multiple: true },
      /** Nearest point mark within this many px catches the pointer. */
      nearest: { enabled: true, radius: 20 },
    },

    a11y: {
      enabled: true,
      /** `'auto'` generates a description from the spec and data. */
      description: 'auto',
      label: undefined,
      /** Expose a hidden data table alongside the map. */
      dataTable: false,
      /** Make individual features focusable below this feature count. */
      keyboardFeatureLimit: 500,
    },

    annotations: { points: [], features: [], areas: [] },

    /** Cross-filter group shared with other Apex products. */
    link: { group: undefined, filter: 'bidirectional' },

    /** Developer diagnostics. `'auto'` enables them on localhost. */
    debug: { enabled: 'auto', joinDiagnostics: true },

    responsive: [],
  } as unknown as ResolvedOptions
}

/** Per-series defaults, merged under the series' own options. */
export function seriesDefaults(type: SeriesType): Record<string, unknown> {
  const base = {
    type,
    name: undefined,
    data: [],
    /** `string | [geoKey, dataKey] | {geo, data}` */
    joinBy: undefined,
    /** Apply normalised and alias matches, and report what was applied. */
    fuzzyJoin: false,
    visible: true,
    scale: undefined,
    /** Divide the value by another field before mapping (e.g. per-capita). */
    normalizeBy: undefined,
    valueField: 'value',
    labels: { show: false },
    drilldown: undefined,
  }

  // Opacity and stroke are per type, not shared.
  //
  // A single default here silently overrides whatever each series class thinks its
  // default is, because config always wins over `?? fallback` in the class. That
  // made arcs fully opaque and bubble outlines half as thick as intended, with the
  // intended values sitting in unreachable code. Whatever a series wants, it has to
  // be stated here, and `test/config.test.ts` checks the two agree.
  switch (type) {
    case 'choropleth':
      return {
        ...base,
        scale: { type: 'quantile', classes: 5 },
        stroke: { color: '#ffffff', width: 0.5, opacity: 1 },
        opacity: 1,
      }
    case 'bubble':
      // Slightly transparent so overlapping bubbles stay readable as overlaps.
      return { ...base, stroke: { color: '#ffffff', width: 1 }, opacity: 0.85 }
    case 'arc':
      // Route networks overlap heavily; opaque arcs read as a solid mass.
      return { ...base, stroke: undefined, opacity: 0.75 }
    case 'line':
      // Routes are fewer and deliberate, so they stay closer to opaque than a
      // network of arcs. They are strokes themselves; no outline.
      return { ...base, stroke: undefined, opacity: 0.9 }
    case 'marker':
      return { ...base, stroke: { color: '#ffffff', width: 1.5 }, opacity: 0.9 }
    default:
      return { ...base, stroke: { color: '#ffffff', width: 0.5, opacity: 1 }, opacity: 1 }
  }
}

/**
 * Deep merge for plain-object option trees.
 *
 * Arrays replace rather than merge: an eight-element `series` array merged
 * element-wise into a two-element one is never what the caller meant.
 *
 */
export function merge<T>(target: T, source: unknown): T {
  if (!source || typeof source !== 'object') return target
  const out: Record<string, unknown> = Array.isArray(target)
    ? ([...target] as unknown as Record<string, unknown>)
    : { ...(target as unknown as Record<string, unknown>) }

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      out[key] = value.slice()
    } else if (isPlainObject(value)) {
      out[key] = isPlainObject(out[key]) ? merge(out[key], value) : merge({}, value)
    } else {
      out[key] = value
    }
  }
  return out as unknown as T
}

/**
 * `merge`, but object-form geometry is carried by reference rather than cloned.
 *
 * The same rule `buildConfig` applies, in the one other place that merges caller
 * options. It was missing here until 2026-07-29, and the guard in `buildConfig`
 * only held for callers who left `geo` out of every update: a framework binding
 * hands over the whole options tree on every change, so it cloned a possibly
 * multi-megabyte topology each time, and the clone then made the next call's
 * identity check see a different map, which re-resolved it, re-ingested it, and
 * abandoned the drilldown trail. For a legend tweak.
 *
 * Geometry is data, not configuration. There is nothing to merge inside it.
 */
export function mergeOptions<T extends { geo?: { map?: unknown } }>(target: T, source: unknown): T {
  const map = (source as T | undefined)?.geo?.map
  if (map == null || typeof map !== 'object') return merge(target, source)

  // `merge` skips undefined values, so blanking the key here leaves whatever the
  // target held, and the assignment below then sets the caller's own reference.
  const out = merge(target, {
    ...(source as Record<string, unknown>),
    geo: { ...(source as T).geo, map: undefined },
  })
  const geo = (out.geo ?? {}) as Record<string, unknown>
  geo.map = map
  out.geo = geo as T['geo']
  return out
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false
  if (Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * Build the effective config for an instance.
 *
 */
export function buildConfig(options?: ApexMapsOptions): ResolvedOptions {
  // Object-form geometry passes through by reference. It is data, not
  // configuration: deep-merging it clones a possibly multi-megabyte topology on
  // every rebuild (and rebuilds happen on every measure), and the clone breaks
  // the identity check `updateOptions` uses to decide whether the map changed,
  // which re-ingested the geometry and reset the drill state on every call.
  const map = options?.geo?.map
  const opaqueMap = map != null && typeof map === 'object'
  const source = opaqueMap ? { ...options, geo: { ...options?.geo, map: undefined } } : options

  const cfg = merge(defaults(), source ?? {})
  if (opaqueMap) cfg.geo.map = map

  // `chart.type` seeds series that omit their own type, so the single-series
  // shorthand `{ chart: { type: 'choropleth' }, series: [{ data }] }` works.
  cfg.series = (cfg.series ?? []).map((s) => {
    const type = (s?.type ?? cfg.chart.type ?? 'choropleth') as SeriesType
    return merge(seriesDefaults(type), s ?? {}) as unknown as Series
  })

  if (cfg.chart.context === 'story' && options?.chart?.animations?.entrance === undefined) {
    cfg.chart.animations = { ...cfg.chart.animations, entrance: true }
  }

  return cfg
}

/**
 * Apply matching `responsive` overrides for a width.
 *
 */
export function applyResponsive(config: ResolvedOptions, width: number): ResolvedOptions {
  const rules = config.responsive
  if (!Array.isArray(rules) || !rules.length) return config

  // Narrowest matching breakpoint wins, so rules can be declared in any order.
  const matching = rules
    .filter((r) => typeof r?.breakpoint === 'number' && width <= r.breakpoint)
    .sort((a, b) => a.breakpoint - b.breakpoint)

  let out = config
  for (const rule of matching) if (rule.options) out = merge(out, rule.options)
  return out
}
