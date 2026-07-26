/**
 * Default options and merge semantics.
 *
 * The whole spec is a plain, JSON-serialisable object tree. That is not an
 * aesthetic preference: serialisability is what later makes saved dashboards,
 * server-side rendering, static story export, a visual editor and LLM authoring
 * all possible from one source of truth (PRODUCT-RESEARCH.md section 6.3).
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
      background: 'transparent',
      fontFamily: 'inherit',
      /**
       * `'story'` animates entrances by default; `'dashboard'` does not, because
       * a dashboard reader wants the number now, not a performance.
       */
      context: 'dashboard',
      animations: {
        enabled: true,
        /** `'slow' | 'normal' | 'fast' | number` */
        speed: 'normal',
        /** Entrance animation for series marks. */
        entrance: true,
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
      /** Disputed-territory rendering policy. See PRODUCT-RESEARCH.md section 5.7. */
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
    stroke: { color: '#ffffff', width: 0.5, opacity: 1 },
    opacity: 1,
    drilldown: undefined,
  }

  switch (type) {
    case 'choropleth':
      return { ...base, scale: { type: 'quantile', classes: 5 } }
    default:
      return base
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
  const cfg = merge(defaults(), options ?? {})

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
