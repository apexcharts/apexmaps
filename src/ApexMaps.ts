/**
 * ApexMaps: interactive geographic data visualization for the ApexCharts
 * ecosystem.
 *
 * The public surface is a single declarative, JSON-serialisable options tree
 * (tier 1), a layer engine underneath (tier 2), and imperative controllers for
 * anything inherently temporal (tier 3, currently `map.camera`). See
 * PRODUCT-RESEARCH.md section 6.3 for why that split, and section 6.6 for the
 * ecosystem primitives this reuses rather than reinvents.
 *
 * @module ApexMaps
 */

import { LicenseManager, Watermark } from 'apex-commons'
import { geoGraticule } from 'd3-geo'

import './ApexMaps.css'
import { BaseChart } from './core/BaseChart'
import { buildConfig, applyResponsive, merge } from './core/Config'
import { A11y } from './core/A11y'
import { resolveMap, registerMap, listMaps, mapMeta, attributionFor } from './core/MapRegistry'
import {
  installCatalogue,
  setGeoSource,
  geoPacks,
  type GeoFetcher,
  type GeoPack,
} from './core/GeoCatalogue'
import type { MapMeta } from './core/MapRegistry'
import { normalizeGeo } from './geo/GeoData'
import { Viewport } from './geo/Viewport'
import { Camera } from './geo/Camera'
import { registerProjection, listProjections } from './geo/Projections'
import type { ProjectionFactory } from './geo/Projections'
import { SvgRenderer } from './renderers/SvgRenderer'
import { ChoroplethSeries } from './series/Choropleth'
import { BubbleSeries } from './series/Bubble'
import { MarkerSeries } from './series/Marker'
import { ArcSeries } from './series/Arc'
import { BaseFeatures } from './series/BaseFeatures'
import { Legend } from './components/Legend'
import type { LegendSection } from './components/Legend'
import { Tooltip } from './components/Tooltip'
import { Labels, labelAnchor } from './components/Labels'
import type { LabelCandidate } from './components/Labels'
import { Breadcrumb } from './components/Breadcrumb'
import type { Crumb } from './components/Breadcrumb'
import { scopeToParent } from './data/Hierarchy'
import { ZoomPan } from './interaction/ZoomPan'
import type { SelectBox, SelectBoxPhase } from './interaction/ZoomPan'
import { registerPalette } from './scales/Palettes'
import type { Palette } from './scales/Palettes'
import { html, remove, resolveSize, pointerPosition, hasDom } from './utils/dom'
import { darken } from './scales/Color'
import type { JoinResult } from './data/Join'
import type { Cluster } from './geo/Cluster'
import type {
  Anchor,
  ApexMapsEventMap,
  ApexMapsEventName,
  ApexMapsOptions,
  CameraState,
  DrilldownContext,
  DrilldownOptions,
  GeoInput,
  LonLat,
  MapSource,
  NormalizedFeature,
  NormalizedGeo,
  Padding,
  ProjectionName,
  ProjectionSpec,
  ResolvedOptions,
  ScreenPoint,
  Series,
} from './types'

const VERSION = '0.1.0'

/**
 * Features that require a licence. Basic maps are deliberately absent: the free
 * tier carries no watermark, and the watermark exists only as the trial state for
 * premium capability (see the pricing decision in SCOPE.md). Nothing shipped so
 * far is premium, so an unlicensed map renders clean.
 */
const PREMIUM_FEATURES = new Set([
  'story',
  'presentation',
  'morph',
  'webgl',
  'timePlayback',
  'linkGroup',
])

/** Anything the renderer can draw. */
type AnySeries = ChoroplethSeries | BubbleSeries | ArcSeries | MarkerSeries | BaseFeatures

/** The series kinds bound to geometry, which are the ones a drilldown applies to. */
type FeatureSeries = ChoroplethSeries | BaseFeatures

function isFeatureSeries(series: AnySeries): series is FeatureSeries {
  return series.kind === 'features'
}

/** A resolved mark, uniform across series types, for events and tooltips. */
interface ResolvedMark {
  series: AnySeries
  seriesIndex: number
  key: string
  name?: string
  value: number | null
  datum: unknown
  properties?: Record<string, unknown>
  anchor?: [number, number]
  /** Present only for feature-based series. */
  feature?: NormalizedFeature
  /** Present only when the mark is a point cluster. */
  cluster?: Cluster
  /** DOM key used by the renderer for this mark. */
  markKey: string | number
}

/**
 * One level of a drilldown, held so that climbing back is exact and synchronous:
 * the geometry that was on screen, where the camera was, and what the caller had
 * set as `geo.map`.
 */
interface DrillFrame {
  /** `geo.map` as the caller had it at this level. */
  mapSource: MapSource | null | undefined
  mapId?: string
  mapMeta?: MapMeta
  /** The geometry that was displayed, already scoped if that level was drilled. */
  geo: NormalizedGeo
  camera: CameraState
  /** Key of the feature that was clicked to leave this level. */
  key: string
}

interface GlobalScope {
  instances: { id: string; instance: ApexMaps; group?: string }[]
}

const GLOBAL: GlobalScope = (() => {
  const scope = (typeof globalThis !== 'undefined' ? globalThis : {}) as Record<string, unknown>
  scope.ApexMapsGlobal = (scope.ApexMapsGlobal as GlobalScope) ?? {
    instances: [],
  }
  return scope.ApexMapsGlobal as GlobalScope
})()

// Install the built-in geometry catalogue: loader closures only, so this costs no
// network and no geometry bytes. Called here rather than by a bare side-effect
// import because the package declares `sideEffects: false`, and a bundler is
// entitled to drop an import whose result nothing references.
installCatalogue()

class ApexMaps extends BaseChart {
  userOptions: ApexMapsOptions
  config: ResolvedOptions

  readonly viewport = new Viewport()
  renderer: SvgRenderer | null = null
  camera: Camera | null = null
  geo: NormalizedGeo | null = null

  /** Data series, excluding the basemap pseudo-series. */
  series: (ChoroplethSeries | BubbleSeries | ArcSeries | MarkerSeries)[] = []
  /** What actually gets drawn: the series, or the basemap when there are none. */
  renderTargets: AnySeries[] = []
  /** World-space label anchors per feature index. */
  anchors = new Map<number, Anchor>()

  selection = new Set<string>()
  hovered: { seriesId: string; markKey: string | number } | null = null
  warnings: string[] = []
  rendered = false
  mapId?: string
  mapMeta?: MapMeta

  /** Levels drilled into, outermost first. Empty at the top level. */
  readonly drillPath: { key: string; name?: string; mapId?: string }[] = []

  plot: HTMLElement | null = null
  legend: Legend | null = null
  tooltip: Tooltip | null = null
  labels: Labels | null = null
  a11y: A11y | null = null
  zoomPan: ZoomPan | null = null
  breadcrumb: Breadcrumb | null = null

  private _listeners: Partial<Record<string, ((payload: never) => void)[]>> = {}
  private readonly _premiumUsed = new Set<string>()
  private _resizeObserver: ResizeObserver | null = null
  private _renderRaf: number | null = null
  private _attribution: HTMLElement | null = null
  private _a11yMounted = false
  private _warnedLinkKeys = false
  private readonly _drillStack: DrillFrame[] = []
  /** Guards against a second click landing while a level is still loading. */
  private _drilling = false

  private readonly _onMarkPointerOver: (event: Event) => void
  private readonly _onMarkPointerMove: (event: Event) => void
  private readonly _onMarkPointerOut: (event: Event) => void
  private readonly _onMarkClick: (event: Event) => void
  private readonly _onKeyDown: (event: KeyboardEvent) => void

  constructor(element: HTMLElement, options: ApexMapsOptions = {}) {
    super(element)
    if (!element) throw new TypeError('ApexMaps: a container element is required')

    this.element = element
    this.userOptions = options ?? {}
    this.config = buildConfig(this.userOptions)

    this._onMarkPointerOver = this._handleMarkPointerOver.bind(this)
    this._onMarkPointerMove = this._handleMarkPointerMove.bind(this)
    this._onMarkPointerOut = this._handleMarkPointerOut.bind(this)
    this._onMarkClick = this._handleMarkClick.bind(this)
    this._onKeyDown = this._handleKeyDown.bind(this)

    GLOBAL.instances.push({
      id: this.getInstanceId(),
      instance: this,
      group: this.config.link?.group,
    })
  }

  // --- lifecycle ------------------------------------------------------------

  /** Build and draw. Async because geometry may be a URL or a lazy pack. */
  async render(): Promise<this> {
    if (!hasDom()) {
      // SSR: importing and constructing must not throw. Rendering is a no-op until
      // the component hydrates.
      return this
    }

    this._mountShell()
    this._measure()

    const resolved = await resolveMap(this.config.geo.map as MapSource)
    this.mapId = resolved.id
    this.mapMeta = resolved.meta ?? (resolved.id ? mapMeta(resolved.id) : undefined)

    this.geo = this._ingest(resolved.data)
    this.warnings.push(...this.geo.warnings)

    this._buildViewport()
    this._buildSeries()
    this._draw()
    this._attachInteraction()
    this._observeResize()
    this._reportDiagnostics()
    this._checkPremium()
    this._evaluateLicense()

    this.rendered = true
    this.emit('rendered', { instance: this })
    return this
  }

  /**
   * @param meta Provenance for the geometry being ingested. Defaults to the
   *   current map's, and is passed explicitly while drilling, where the child
   *   pack's recommended key is not yet the instance's.
   */
  private _ingest(data: GeoInput, meta: MapMeta | undefined = this.mapMeta): NormalizedGeo {
    return normalizeGeo(data, {
      // A catalogue pack states its own recommended key, and it is right more
      // often than generic detection can be: an admin-1 pack carries `adm0_a3`
      // (the *country* code, identical for all 47 Japanese prefectures) which
      // scores higher than the correct `iso_3166_2` in any fixed candidate order.
      // Explicit config still wins.
      keyField: this.config.geo.keyField ?? (meta?.keyField as string | undefined),
      nameField: this.config.geo.nameField,
      object: this.config.geo.object,
      repairWinding: this.config.geo.repairWinding,
    })
  }

  private _mountShell(): void {
    const { chart } = this.config
    this.element.classList.add('apexmaps')
    this.element.classList.toggle('apexmaps--dark', this._isDark())
    this._applyStateVars()
    if (chart.fontFamily && chart.fontFamily !== 'inherit') {
      this.element.style.fontFamily = chart.fontFamily
    }

    this.plot = html('div', { class: 'apexmaps-plot' })
    this.element.appendChild(this.plot)

    this.legend = new Legend({
      container: this.element,
      options: this.config.legend,
      onToggle: (classIndex, _muted, seriesIndex) => this._onLegendToggle(classIndex, seriesIndex),
    })
    this.tooltip = new Tooltip({
      container: this.plot,
      options: this.config.tooltip,
    })
    this.tooltip.mount()

    this.breadcrumb = new Breadcrumb({
      container: this.element,
      onSelect: (up) => void this.drillUp(up),
    })

    this.a11y = new A11y({
      container: this.element,
      options: this.config.a11y,
      access: () => ({
        features: this.geo?.features ?? [],
        describe: (f) => this._describeFeature(f),
        focus: (f) => this._focusFeature(f),
        select: (f) => this.toggleSelection(f.key),
      }),
    })
  }

  private _measure(): void {
    const { chart } = this.config
    const rect = this.element.getBoundingClientRect()
    const width = Math.max(1, Math.round(resolveSize(chart.width, rect.width || 0, 600)))
    const height = Math.max(1, Math.round(resolveSize(chart.height, rect.height || 0, 400)))

    // Responsive overrides resolve against the measured width, so a legend
    // position or a label threshold can differ on mobile.
    this.config = applyResponsive(buildConfig(this.userOptions), width)
    this.viewport.resize(width, height)
    if (this.plot) {
      this.plot.style.width = `${width}px`
      this.plot.style.height = `${height}px`
    }
  }

  private _buildViewport(): void {
    if (!this.geo) return
    const { geo } = this.config

    // A pack can recommend how it is meant to be seen, and for several packs the
    // generic default is unusable rather than merely suboptimal: NUTS geometry
    // includes Guadeloupe and Réunion, so fitting its extent shrinks Europe to a
    // speck, and Alaska's Aleutians cross the antimeridian, so the United States
    // fills the whole width of the world. Both are cartography decisions that
    // belong with the geometry, not with every caller.
    //
    // Checked against `userOptions`, not the resolved config, because the resolved
    // config always carries the global defaults and cannot say whether the caller
    // asked for them.
    const asked = this.userOptions.geo ?? {}
    const recommended = (this.mapMeta ?? {}) as {
      projection?: ProjectionName | ProjectionSpec
      bounds?: [number, number, number, number]
    }

    this.viewport.setProjection(
      asked.projection ?? recommended.projection ?? geo.projection ?? 'equalEarth',
    )

    const fit = asked.view?.fit ?? recommended.bounds ?? geo.view?.fit ?? 'data'
    const padding = (geo.view?.padding ?? 16) as Padding
    if (fit === 'world') {
      this.viewport.fit({ type: 'Sphere' }, padding)
    } else if (Array.isArray(fit) && fit.length === 4) {
      this.viewport.fit(bboxToPolygon(fit), padding)
    } else {
      this.viewport.fit(this.geo.collection, padding)
    }

    // Anchors live in a side map keyed by feature index rather than on the feature
    // objects, which hold the caller's properties and geometry. They are
    // world-space, so they survive camera changes and only need recomputing when
    // the projection changes.
    this.anchors = new Map()
    for (const feature of this.geo.features) {
      const anchor = labelAnchor(this.viewport, feature)
      if (anchor) this.anchors.set(feature.index, anchor)
    }

    if (!this.renderer) {
      this.renderer = new SvgRenderer({ viewport: this.viewport })
      this.renderer.mount(this.plot as HTMLElement, {
        width: this.viewport.width,
        height: this.viewport.height,
        background: this.config.chart.background,
        fontFamily: this.config.chart.fontFamily,
      })
    } else {
      this.renderer.resize(this.viewport.width, this.viewport.height)
    }

    if (!this.camera) {
      this.camera = new Camera({
        viewport: this.viewport,
        onChange: () => this._onCameraChange(),
        options: {
          minZoom: this.config.interaction.zoom?.min ?? 0.8,
          maxZoom: this.config.interaction.zoom?.max ?? 4096,
        },
      })
    }

    this.labels = new Labels({
      renderer: this.renderer,
      viewport: this.viewport,
      options: this.config.dataLabels,
    })
  }

  private _buildSeries(): void {
    if (!this.geo) return
    // Series ids are positional, so dropping a series shifts the next one into
    // its id. Tracking the kind too means a bubble replaced by an arc under the
    // same id has its stale marks cleared rather than left orphaned on screen.
    const previousKinds = new Map(this.renderTargets.map((s) => [s.id, s.kind]))
    this.series = []

    const geo = this.geo

    // Switching on `cfg.type` directly is what lets TypeScript narrow the
    // discriminated union: hoisting it into a variable first would erase the
    // narrowing and each constructor would receive the whole union.
    this.config.series.forEach((cfg: Series, i: number) => {
      if (cfg.visible === false) return

      switch (cfg.type) {
        case 'bubble':
          this.series.push(
            new BubbleSeries({
              config: cfg,
              geo,
              index: i,
              viewport: this.viewport,
            }),
          )
          break
        case 'marker':
          this.series.push(
            new MarkerSeries({
              config: cfg,
              geo,
              index: i,
              viewport: this.viewport,
            }),
          )
          break
        case 'arc':
          this.series.push(
            new ArcSeries({
              config: cfg,
              geo,
              index: i,
              viewport: this.viewport,
            }),
          )
          break
        case 'choropleth':
        case undefined:
          this.series.push(
            new ChoroplethSeries({
              config: cfg,
              geo,
              index: i,
              theme: this.config.theme,
            }),
          )
          break
        default:
          this.warnings.push(
            `unknown series type "${String((cfg as { type?: unknown }).type)}"; series ${i} was skipped`,
          )
      }
    })

    for (const s of this.series) this.warnings.push(...s.warnings)

    // Render targets are the data series, or a single basemap pseudo-series when
    // there are none, so every downstream path (draw, hover, selection, tooltip)
    // has something to iterate and no branch for "no data yet".
    //
    // A basemap is also drawn underneath point-only series: bubbles floating in
    // the void with no coastline is not a map.
    const needsBasemap = !this.series.length || this.series.every((s) => s.kind !== 'features')

    const targets: AnySeries[] = []
    if (needsBasemap) {
      targets.push(
        new BaseFeatures({
          config: {
            stroke: this.config.series?.[0]?.stroke,
            fill: this.config.geo?.fill,
          },
          dark: this._isDark(),
        }),
      )
    }
    targets.push(...this.series)
    this.renderTargets = targets

    // Drop marks belonging to series that disappeared or changed type.
    const currentKinds = new Map(targets.map((s) => [s.id, s.kind]))
    for (const [id, kind] of previousKinds) {
      if (currentKinds.get(id) !== kind) {
        this.renderer?.clearSeries(id)
        // Endpoint dots are a separate synthetic series id.
        this.renderer?.clearSeries(`${id}-ends`)
      }
    }
  }

  // --- drawing --------------------------------------------------------------

  private _draw(): void {
    if (!this.renderer || !this.geo) return

    this._drawBaseLayers()

    for (const series of this.renderTargets) {
      switch (series.kind) {
        case 'features':
          this.renderer.drawFeatures({
            features: this.geo.features,
            fill: (f) => series.fillFor(f),
            stroke: series.config.stroke,
            opacity: series.config.opacity ?? 1,
            seriesId: series.id,
          })
          break

        case 'symbols':
          this.renderer.drawSymbols({
            symbols: (series as BubbleSeries).symbols(),
            seriesId: series.id,
          })
          break

        case 'marks':
          this.renderer.drawMarks({
            marks: (series as MarkerSeries).marks(this.viewport.camera.k),
            seriesId: series.id,
          })
          break

        case 'paths': {
          const arc = series as ArcSeries
          this.renderer.drawPaths({ paths: arc.paths(), seriesId: arc.id })
          const endpoints = arc.endpoints(this.viewport)
          if (endpoints.length) {
            this.renderer.drawSymbols({
              symbols: endpoints.map((e) => ({ ...e, stroke: { width: 0 } })),
              seriesId: `${arc.id}-ends`,
            })
          }
          break
        }
      }
    }

    this._bindMarkEvents()
    this._drawLabels()
    this._drawLegend()
    this._drawAttribution()
    this._setupA11y()
  }

  private _drawBaseLayers(): void {
    if (!this.renderer || !this.viewport.path) return
    const { sphere, graticule } = this.config.geo

    if (sphere?.show) {
      const d = this.viewport.path({ type: 'Sphere' })
      if (d) {
        this.renderer.drawBasePath(
          d,
          {
            fill: sphere.fill || 'none',
            stroke: sphere.stroke ?? 'rgba(128,128,128,0.4)',
            'stroke-width': sphere.width ?? 0.5,
          },
          'apexmaps-sphere',
        )
      }
    } else {
      this.renderer.clearBasePath('apexmaps-sphere')
    }

    if (graticule?.show) {
      const generator = geoGraticule()
      if (graticule.step) generator.step([graticule.step, graticule.step])
      const d = this.viewport.path(generator())
      if (d) {
        this.renderer.drawBasePath(
          d,
          {
            fill: 'none',
            stroke: graticule.color ?? 'rgba(128,128,128,0.25)',
            'stroke-width': graticule.width ?? 0.5,
          },
          'apexmaps-graticule',
        )
      }
    } else {
      this.renderer.clearBasePath('apexmaps-graticule')
    }
  }

  private _drawLabels(): void {
    if (!this.labels || !this.geo) return
    const cfg = this.config.dataLabels
    const featureSeries = this.renderTargets.find((s) => s.kind === 'features')
    const labelledSeries = this.renderTargets.find((s) => s.config.labels?.show)
    const enabled = cfg.enabled || !!labelledSeries

    if (!enabled || !featureSeries) {
      this.labels.setCandidates([])
      this.labels.layout()
      return
    }

    const field = cfg.field ?? labelledSeries?.config?.labels?.field
    const candidates: LabelCandidate[] = []

    for (const feature of this.geo.features) {
      const anchor = this.anchors.get(feature.index)
      if (!anchor) continue

      const value = featureSeries.valueFor(feature)
      const text = resolveLabelText({
        feature,
        field,
        value,
        formatter: cfg.formatter,
      })
      if (!text) continue

      candidates.push({
        text,
        world: anchor.world,
        // Bigger features and larger values win when labels collide, which keeps
        // the surviving labels the informative ones.
        priority: anchor.area + (value == null ? 0 : Math.abs(value)) * 1e-6,
        featureArea: anchor.area,
        key: feature.key,
      })
    }

    this.labels.setCandidates(candidates)
    this.labels.layout()
  }

  private _drawLegend(): void {
    if (!this.legend) return

    const sections: LegendSection[] = []
    for (const series of this.renderTargets) {
      if (series instanceof BubbleSeries) {
        sections.push({
          title: series.legendTitle(),
          sizes: series.sizeLegend(),
          seriesIndex: series.index,
        })
        if (series.colorScale) {
          sections.push({
            items: series.colorScale.legendItems(),
            continuous: series.colorScale.continuous,
            gradient: series.colorScale.continuous ? series.colorScale.gradientStops() : undefined,
            seriesIndex: series.index,
          })
        }
        continue
      }

      if (series instanceof MarkerSeries) {
        if (series.colorScale) {
          sections.push({
            title: series.legendTitle(),
            items: series.colorScale.legendItems(),
            continuous: false,
            seriesIndex: series.index,
          })
        }
        continue
      }

      if (series instanceof ArcSeries) {
        if (series.colorScale) {
          sections.push({
            title: series.legendTitle(),
            items: series.colorScale.legendItems(),
            continuous: series.colorScale.continuous,
            gradient: series.colorScale.continuous ? series.colorScale.gradientStops() : undefined,
            seriesIndex: series.index,
          })
        }
        continue
      }

      if (series instanceof ChoroplethSeries) {
        sections.push({
          title: series.legendTitle(),
          items: series.legendItems(),
          continuous: series.scale.continuous,
          gradient: series.scale.continuous ? series.scale.gradientStops() : undefined,
          seriesIndex: series.index,
        })
      }
    }

    this.legend.render(sections)
  }

  private _drawAttribution(): void {
    const text = attributionFor([this.mapId])
    remove(this._attribution)
    this._attribution = null
    if (!text) return
    // Rendered automatically: a licence obligation that depends on the developer
    // remembering it is a licence obligation that gets breached.
    this._attribution = html('div', { class: 'apexmaps-attribution', text })
    this.plot?.appendChild(this._attribution)
  }

  private _setupA11y(): void {
    if (!this.a11y || !this.renderer?.root || !this.geo) return
    const primary = this.renderTargets.find((s) => s.kind === 'features') ?? this.renderTargets[0]

    const values = primary instanceof ChoroplethSeries ? [...primary.values.values()] : []
    const withValues = values.filter((v) => v != null)

    const featureSeries = primary?.kind === 'features' ? primary : undefined
    const extremes = this.geo.features
      .map((f) => ({
        name: String(f.name ?? f.key),
        value: featureSeries?.valueFor(f) ?? null,
      }))
      .filter((e): e is { name: string; value: number } => e.value != null)
      .sort((a, b) => b.value - a.value)
      .slice(0, 3)

    const description =
      this.config.a11y.description === 'auto'
        ? A11y.describe({
            type: this.config.chart.type ?? 'choropleth',
            featureCount: this.geo.features.length,
            seriesName: primary?.legendTitle(),
            domain: primary instanceof ChoroplethSeries ? primary.scale.domain : undefined,
            extremes,
            classDescription:
              primary instanceof ChoroplethSeries
                ? Legend.describe(primary.legendItems())
                : undefined,
            noDataCount: values.length - withValues.length,
          })
        : (this.config.a11y.description ?? '')

    const label = this.config.a11y.label ?? description.split('.')[0]

    if (!this._a11yMounted) {
      this.a11y.mount(this.renderer.root, { label, description })
      this._a11yMounted = true
    } else {
      // Drilling and `updateSeries` both change what the map says, so the
      // description has to change with them. A stale description is worse than a
      // generic one: it describes a level the reader has already left.
      this.a11y.update({ label, description })
    }
    this.a11y.setNavigationOrder(this.geo.features, (f) => this.anchors.get(f.index)?.world)

    if (primary instanceof ChoroplethSeries) {
      this.a11y.renderTable({
        caption: primary.legendTitle() ?? 'Map data',
        columns: ['Area', primary.legendTitle() ?? 'Value'],
        rows: this.geo.features.map((f) => {
          const v = primary.valueFor(f)
          return [String(f.name ?? f.key), v == null ? primary.scale.nullLabel : v]
        }),
      })
    }
  }

  // --- interaction ----------------------------------------------------------

  private _attachInteraction(): void {
    if (!this.camera || !this.plot) return
    // On the container rather than the plot, so Escape works while focus is on the
    // breadcrumb or the legend, and in the capture phase so a drilldown can claim
    // it before the a11y handler treats it as "leave the map".
    this.element.addEventListener('keydown', this._onKeyDown, true)
    const selection = this.config.interaction.selection ?? {}
    if (selection.modifier === 'none' && this.config.interaction.pan?.enabled !== false) {
      this.warnings.push(
        "interaction.selection.modifier 'none' makes every drag a selection box, so it needs " +
          'pan.enabled: false. Panning keeps the drag, and the selection box is inactive.',
      )
    }

    this.zoomPan = new ZoomPan({
      container: this.plot,
      camera: this.camera,
      options: this.config.interaction,
      emit: (event, payload) => this.emit(event as ApexMapsEventName, payload as never),
      onSelectBox: (box, phase, additive) => this._handleSelectBox(box, phase, additive),
    })
    this.zoomPan.attach()
  }

  private _bindMarkEvents(): void {
    // One delegated listener per event per layer, rather than per mark: a
    // 3,000-county map would otherwise attach 12,000 listeners.
    for (const layer of [this.renderer?.marksLayer, this.renderer?.symbolLayer]) {
      if (!layer || layer.dataset.apexmapsBound === 'true') continue
      layer.addEventListener('pointerover', this._onMarkPointerOver)
      layer.addEventListener('pointermove', this._onMarkPointerMove)
      layer.addEventListener('pointerout', this._onMarkPointerOut)
      layer.addEventListener('click', this._onMarkClick)
      layer.dataset.apexmapsBound = 'true'
    }
  }

  /** Resolve a DOM event target to a mark, uniformly across series types. */
  private _resolveMark(event: Event): ResolvedMark | null {
    const hit = event.target as Element | null
    if (!hit?.getAttribute) return null

    // A shaped mark is a group holding a path, a label and a hit circle, so the
    // pointer lands on a child. Walk up to whichever element carries the data.
    const target = hit.getAttribute('data-series')
      ? hit
      : (hit.closest?.('[data-series]') as Element | null)
    if (!target) return null

    const seriesId = target.getAttribute('data-series')
    const itemAttr = target.getAttribute('data-item')
    if (!seriesId || itemAttr == null) return null

    // Endpoint dots belong to their arc series but carry no data of their own.
    const ownerId = seriesId.endsWith('-ends') ? seriesId.slice(0, -5) : seriesId
    const series = this.renderTargets.find((s) => s.id === ownerId)
    if (!series || seriesId.endsWith('-ends')) return null

    const item = Number(itemAttr)
    const seriesIndex = series.index

    if (series.kind === 'features') {
      const feature = this.geo?.features[item]
      if (!feature) return null
      return {
        series,
        seriesIndex,
        key: feature.key,
        name: feature.name,
        value: series.valueFor(feature),
        datum: series.datumFor(feature),
        properties: feature.properties,
        anchor: this.anchors.get(feature.index)?.world,
        feature,
        markKey: feature.key || feature.index,
      }
    }

    // Clusters are not data rows: they stand for a set of them.
    const clusterAttr = target.getAttribute('data-cluster')
    if (clusterAttr != null && series instanceof MarkerSeries) {
      const cluster = series.clusterAt(Number(clusterAttr))
      if (!cluster) return null
      return {
        series,
        seriesIndex,
        key: `cluster-${clusterAttr}`,
        name: series.describeCluster(cluster),
        value: cluster.count,
        datum: cluster.members.map((m) => series.itemAt(m)?.datum),
        anchor: cluster.world,
        markKey: `cluster-${clusterAttr}`,
        cluster,
      }
    }

    const mark = (series as BubbleSeries | ArcSeries | MarkerSeries).itemAt(item)
    if (!mark) return null
    return {
      series,
      seriesIndex,
      key: mark.key,
      name: mark.name,
      value: mark.value,
      datum: mark.datum,
      anchor: mark.anchor,
      markKey: mark.key,
    }
  }

  private _handleMarkPointerOver(event: Event): void {
    const mark = this._resolveMark(event)
    if (!mark) return
    this._setHover(mark)
    this.emit(mark.feature ? 'featureHover' : 'markHover', this._eventPayload(mark) as never)
  }

  private _handleMarkPointerMove(event: Event): void {
    if (!this.tooltip?.visible || this.config.tooltip.followCursor === false) return
    if (!this._resolveMark(event)) return
    this.tooltip.move(pointerPosition(this.plot as HTMLElement, event as MouseEvent))
  }

  private _handleMarkPointerOut(event: Event): void {
    if (!this._resolveMark(event)) return
    this._clearHover()
  }

  private _handleMarkClick(event: Event): void {
    // The click that ends a drag is not a click on whatever the pointer happened
    // to be over: panning the map or dragging a selection box across a feature
    // must not also select or drill into it.
    if (this.zoomPan?.shouldSwallowClick()) return

    const mark = this._resolveMark(event)
    if (!mark) return

    // Clicking a cluster means "show me what is in there", so fly to its members
    // rather than selecting an aggregate that is not a data row.
    if (mark.cluster && mark.series instanceof MarkerSeries) {
      this.emit('clusterClick', this._eventPayload(mark) as never)
      if (mark.series.clusterOptions.zoomOnClick !== false) {
        this._zoomToCluster(mark.cluster)
        return
      }
      return
    }

    // A feature on a series with a drilldown means "go deeper", so it does not
    // also toggle selection: the key would belong to a level that is about to
    // disappear. The click event still fires first, before anything moves.
    const drilldown = mark.feature && isFeatureSeries(mark.series) ? drilldownOf(mark.series) : null
    if (drilldown && mark.feature && isFeatureSeries(mark.series)) {
      this.emit('featureClick', this._eventPayload(mark) as never)
      void this._drill(mark.feature, mark.series, drilldown)
      return
    }

    if (this.config.interaction.selection?.enabled !== false) this.toggleSelection(mark.key)
    this.emit(mark.feature ? 'featureClick' : 'markClick', this._eventPayload(mark) as never)
  }

  private _handleKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return

    // A box being dragged is the most immediate thing Escape can abandon, so it
    // wins over climbing a level.
    if (this.zoomPan?.cancelSelectBox()) {
      event.stopPropagation()
      event.preventDefault()
      return
    }

    if (!this._drillStack.length) return
    // Capture phase, so this beats the a11y handler's "leave the map" Escape.
    // With somewhere to go back to, Escape means "up one level"; at the top level
    // this returns early and the a11y meaning stands.
    event.stopPropagation()
    event.preventDefault()
    void this.drillUp()
  }

  /**
   * Frame a cluster's members.
   *
   * Members that share a position give a zero-size box, which would ask the camera
   * for infinite zoom, so that case steps in by a fixed factor instead.
   */
  private _zoomToCluster(cluster: Cluster): void {
    if (!this.camera) return
    const [[x0, y0], [x1, y1]] = cluster.bounds

    // Members sharing a position give a zero-size box, which would ask the camera
    // for infinite zoom. Padding it by a fixed number of screen pixels, converted
    // to world units at the current scale, keeps one code path and lands on a
    // sensible zoom instead.
    const spread = Math.max(x1 - x0, y1 - y0)
    const pad = spread < 1e-6 ? 40 / Math.max(this.viewport.camera.k, 1e-9) : 0

    this.camera.fitBounds(
      [
        [x0 - pad, y0 - pad],
        [x1 + pad, y1 + pad],
      ],
      { padding: 60, maxZoom: 64 },
    )
  }

  // --- drilldown ------------------------------------------------------------

  /** Levels below the top level currently displayed. */
  get drillDepth(): number {
    return this._drillStack.length
  }

  /**
   * Drill into a feature by key, exactly as a click on it would.
   *
   * @returns Whether a deeper level was entered. False means the drilldown
   *   declined: no such feature, no `drilldown` configured, the child map is the
   *   one already on screen, or no child feature belongs to this parent. Each
   *   case explains itself in the dev-mode diagnostics.
   */
  async drillTo(key: string): Promise<boolean> {
    const feature = this.geo?.features.find((f) => f.key === key)
    if (!feature) return false
    const series = this.renderTargets.find(
      (s): s is FeatureSeries => isFeatureSeries(s) && !!drilldownOf(s),
    )
    const options = series ? drilldownOf(series) : null
    if (!series || !options) return false
    return this._drill(feature, series, options)
  }

  /**
   * Climb back out. `levels` of `Infinity` returns to the top.
   *
   * Synchronous work, awaited only for the camera move: the geometry for each
   * level above is still held, so going back never refetches or re-ingests.
   */
  async drillUp(levels = 1): Promise<boolean> {
    if (this._drilling || !this._drillStack.length) return false
    const steps = Math.min(Math.max(1, Math.floor(levels) || 1), this._drillStack.length)

    this._drilling = true
    try {
      let frame = this._drillStack.pop() as DrillFrame
      for (let i = 1; i < steps; i++) {
        this.drillPath.pop()
        frame = this._drillStack.pop() as DrillFrame
      }
      this.drillPath.pop()

      const animate = this._drillAnimation() !== 'none'
      const cameFrom = frame.key

      this._restoreLevel(frame)

      // Frame where the reader just was, then pull back out to where they left
      // the camera: the reverse of the move that brought them in, so the two
      // levels stay visually connected.
      if (animate && this.camera) {
        const feature = this.geo?.features.find((f) => f.key === cameFrom)
        const bounds = feature
          ? this.viewport.measure({
              type: 'Feature',
              geometry: feature.geometry,
              properties: {},
            })
          : null
        if (bounds) {
          this.viewport.camera = this.viewport.cameraForBounds(bounds, { padding: 24 })
        }
      }

      this._buildSeries()
      this._draw()
      this.renderer?.applyCamera()
      this._renderBreadcrumb()
      this._reportDiagnostics()

      if (animate && this.camera) {
        await this.camera.easeTo({ ...frame.camera, duration: 320 })
      }

      this.a11y?.announce(this._drillAnnouncement())
      this.emit('drillup', {
        to: this.mapId,
        depth: this._drillStack.length,
        instance: this,
      })
      return true
    } finally {
      this._drilling = false
    }
  }

  /**
   * Replace the map with a deeper level, scoped to one feature.
   *
   * The two halves are deliberately ordered: geometry starts loading immediately
   * but the camera move runs first, so a cold child pack downloads while the
   * reader watches the parent feature fill the frame, and the swap then happens
   * between two views of the same geography at the same size. Ordering it the
   * other way makes the click feel unresponsive for as long as the fetch takes.
   */
  private async _drill(
    feature: NormalizedFeature,
    series: FeatureSeries,
    options: DrilldownOptions,
  ): Promise<boolean> {
    if (this._drilling || !this.geo || !this.renderer) return false

    const context: DrilldownContext = {
      key: feature.key,
      name: feature.name,
      datum: series.datumFor(feature),
      properties: feature.properties,
      depth: this._drillStack.length + 1,
      from: this.mapId,
    }
    const target = typeof options.map === 'function' ? options.map(context) : options.map
    if (!target) return false

    if (this._isCurrentMap(target)) {
      this.warnings.push(
        `drilldown from "${feature.key}" was declined: its child map is the one already on screen. ` +
          'Use the function form of drilldown.map to choose a different map per level, or return null to stop.',
      )
      this._reportDiagnostics()
      return false
    }

    this._drilling = true
    const camera: CameraState = { ...this.viewport.camera }

    try {
      const loading = resolveMap(target as MapSource)
      if (options.animate !== 'none') {
        await this.frameFeature(feature.key, {
          padding: 24,
          duration: 320,
          transition: 'ease',
        })
      }

      let resolved: Awaited<ReturnType<typeof resolveMap>>
      try {
        resolved = await loading
      } catch (error) {
        this.camera?.jumpTo(camera)
        this.warnings.push(
          `drilldown into "${feature.key}" failed: ${(error as Error).message ?? String(error)}`,
        )
        this._reportDiagnostics()
        return false
      }

      const meta = resolved.meta ?? (resolved.id ? mapMeta(resolved.id) : undefined)
      const ingested = this._ingest(resolved.data, meta)
      const scoped = scopeToParent(ingested, feature.key, options)

      if (!scoped.count) {
        // Landing on an empty map is worse than not drilling: the reader loses the
        // level they were reading and gets nothing in exchange.
        this.camera?.jumpTo(camera)
        this.warnings.push(`drilldown into "${feature.key}" was cancelled: ${scoped.note}`)
        this._reportDiagnostics()
        return false
      }

      this._drillStack.push({
        mapSource: this.userOptions.geo?.map,
        mapId: this.mapId,
        mapMeta: this.mapMeta,
        geo: this.geo,
        camera,
        key: feature.key,
      })
      this.drillPath.push({
        key: feature.key,
        name: feature.name,
        mapId: resolved.id,
      })

      this._enterLevel({ mapSource: target, mapId: resolved.id, mapMeta: meta, geo: scoped.geo })
      this.warnings.push(...ingested.warnings, `drilldown: ${scoped.note}`)

      // The child level is fitted to its own extent, so the camera starts neutral.
      // Whatever zoom brought the reader here describes the parent projection and
      // is meaningless under the new fit.
      this.camera?.stop()
      this.viewport.camera = { k: 1, x: 0, y: 0 }

      this._buildSeries()
      this._draw()
      this.renderer.applyCamera()
      this._renderBreadcrumb()
      this._reportDiagnostics()

      this.a11y?.announce(this._drillAnnouncement())
      this.emit('drilldown', {
        key: feature.key,
        name: feature.name,
        from: context.from,
        to: resolved.id,
        depth: this._drillStack.length,
        featureCount: scoped.count,
        instance: this,
      })
      return true
    } finally {
      this._drilling = false
    }
  }

  /** Swap in a level's geometry, keeping `geo.map` honest for later updates. */
  private _enterLevel({
    mapSource,
    mapId,
    mapMeta: meta,
    geo,
  }: {
    mapSource: MapSource | null | undefined
    mapId?: string
    mapMeta?: MapMeta
    geo: NormalizedGeo
  }): void {
    // `userOptions` has to move with the level, not just `config`: every later
    // rebuild starts from `userOptions`, so leaving the parent id there would make
    // the next `updateOptions` call silently drill back up.
    this.userOptions = {
      ...this.userOptions,
      geo: { ...(this.userOptions.geo ?? {}), map: mapSource ?? undefined },
    }
    this.config = applyResponsive(buildConfig(this.userOptions), this.viewport.width)
    this.mapId = mapId
    this.mapMeta = meta
    this.geo = geo
    // Selected keys belong to the level being left, so they are dropped rather
    // than carried into a level where they match nothing.
    this.selection.clear()
    this.warnings = []
    this.labels?.destroy()
    this._buildViewport()
  }

  private _resetDrill(): void {
    if (!this._drillStack.length) return
    this._drillStack.length = 0
    this.drillPath.length = 0
    this.breadcrumb?.destroy()
  }

  private _restoreLevel(frame: DrillFrame): void {
    this._enterLevel({
      mapSource: frame.mapSource,
      mapId: frame.mapId,
      mapMeta: frame.mapMeta,
      geo: frame.geo,
    })
    this.camera?.stop()
    this.viewport.camera = { ...frame.camera }
  }

  private _isCurrentMap(target: MapSource): boolean {
    if (typeof target !== 'string') return target === this.config.geo.map
    if (target === this.mapId) return true
    const packId = this.mapMeta?.packId
    return !!packId && mapMeta(target)?.packId === packId
  }

  private _drilldownOptions(): DrilldownOptions | null {
    for (const series of this.renderTargets) {
      const options = drilldownOf(series)
      if (options) return options
    }
    return null
  }

  private _drillAnimation(): 'zoom' | 'none' {
    return this._drilldownOptions()?.animate ?? 'zoom'
  }

  private _renderBreadcrumb(): void {
    if (!this.breadcrumb) return
    const setting = this._drilldownOptions()?.breadcrumb
    if (setting === false) {
      this.breadcrumb.destroy()
      return
    }

    const rootLabel =
      (typeof setting === 'object' ? setting.rootLabel : undefined) ??
      (this._drillStack[0]?.mapMeta?.levelName as string | undefined) ??
      'All areas'

    const crumbs: Crumb[] = [{ label: rootLabel, up: this.drillPath.length }]
    this.drillPath.forEach((level, i) => {
      crumbs.push({
        label: level.name ?? level.key,
        up: this.drillPath.length - 1 - i,
      })
    })
    this.breadcrumb.render(crumbs)
  }

  private _drillAnnouncement(): string {
    const where = this.drillPath.map((l) => l.name ?? l.key).join(', ')
    const count = this.geo?.features.length ?? 0
    const level = (this.mapMeta?.levelName as string | undefined)?.toLowerCase() ?? 'areas'
    return where
      ? `Showing ${count} ${level} in ${where}. Press Escape to go back.`
      : `Showing ${count} ${level}.`
  }

  private _eventPayload(mark: ResolvedMark) {
    return {
      key: mark.key,
      name: mark.name,
      value: mark.value,
      datum: mark.datum,
      properties: mark.properties,
      seriesName: mark.series.config.name,
      seriesIndex: mark.seriesIndex,
      instance: this,
    }
  }

  private _setHover(mark: ResolvedMark): void {
    this.hovered = { seriesId: mark.series.id, markKey: mark.markKey }

    const el = this.renderer?.markFor(mark.series.id, mark.markKey)
    const states = this.config.states?.hover
    if (el && states?.enabled !== false) {
      if (mark.series.kind === 'paths') {
        // Darkening a thin line barely registers; raising its opacity does.
        el.setAttribute('opacity', '1')
      } else {
        const base = el.getAttribute('fill')
        if (base) el.setAttribute('fill', darken(base, states?.brightness ?? 0.08))
      }
      el.classList.add('is-hovered')
    }

    if (this.config.tooltip.enabled !== false && this.tooltip) {
      const markup = this.config.tooltip.formatter
        ? this.config.tooltip.formatter({
            key: mark.key,
            name: mark.name,
            value: mark.value,
            datum: mark.datum,
            properties: mark.properties,
            series: mark.series.config as Series,
          })
        : Tooltip.defaultContent({
            feature: { key: mark.key, name: mark.name },
            value: mark.value,
            datum: mark.datum,
            series: mark.series,
            format: this.config.tooltip.valueFormatter,
          })

      const point: ScreenPoint = mark.anchor
        ? this.viewport.worldToScreen(mark.anchor)
        : [this.viewport.width / 2, this.viewport.height / 2]
      this.tooltip.show({ point, html: markup })
    }
  }

  private _clearHover(): void {
    if (this.hovered) {
      const { seriesId, markKey } = this.hovered
      const series = this.renderTargets.find((s) => s.id === seriesId)
      const el = this.renderer?.markFor(seriesId, markKey)
      if (el && series) {
        el.classList.remove('is-hovered')
        if (series.kind === 'paths') {
          el.setAttribute('opacity', String(series.config.opacity ?? 0.75))
        } else if (series.kind === 'features') {
          const feature = this.geo?.features.find((f) => (f.key || f.index) === markKey)
          if (feature) el.setAttribute('fill', series.fillFor(feature))
        } else {
          const bubble = series as BubbleSeries
          const item = bubble.items.find((b) => b.key === markKey)
          if (item) el.setAttribute('fill', bubble.fillFor(item))
        }
      }
    }
    this.hovered = null
    this.tooltip?.hide()
  }

  private _focusFeature(feature: NormalizedFeature): void {
    const series = this.renderTargets.find((s) => s.kind === 'features')
    if (!series) return
    this._clearHover()
    this._setHover({
      series,
      seriesIndex: series.index,
      key: feature.key,
      name: feature.name,
      value: series.valueFor(feature),
      datum: series.datumFor(feature),
      properties: feature.properties,
      anchor: this.anchors.get(feature.index)?.world,
      feature,
      markKey: feature.key || feature.index,
    })
    this.emit('featureFocus', {
      key: feature.key,
      name: feature.name,
      value: series.valueFor(feature),
      datum: series.datumFor(feature),
      properties: feature.properties,
      seriesName: series.config.name,
      seriesIndex: series.index,
      instance: this,
    })
  }

  private _describeFeature(feature: NormalizedFeature): string {
    const series = this.renderTargets.find((s) => s.kind === 'features')
    return series ? series.describe(feature) : String(feature.name ?? feature.key)
  }

  private _onLegendToggle(classIndex: number, seriesIndex: number): void {
    for (const series of this.renderTargets) {
      if (series.index === seriesIndex) series.toggleClass(classIndex)
    }
    this._redrawFills()
    this.emit('legendToggle', { classIndex, instance: this })
  }

  private _redrawFills(): void {
    if (!this.renderer || !this.geo) return
    for (const series of this.renderTargets) {
      if (series.kind !== 'features') continue
      for (const feature of this.geo.features) {
        const path = this.renderer.pathFor(series.id, feature.key || feature.index)
        if (path) path.setAttribute('fill', series.fillFor(feature))
      }
    }
  }

  private _onCameraChange(): void {
    // Applies the world transform and repositions screen-space symbols.
    this.renderer?.applyCamera()

    // Clustered markers depend on the camera scale, but only in steps: the level
    // is quantized, so panning never reclusters and a smooth zoom crosses a
    // boundary a handful of times rather than once a frame.
    const zoom = this.viewport.camera.k
    for (const series of this.renderTargets) {
      if (series instanceof MarkerSeries && series.needsRedraw(zoom)) {
        this.renderer?.drawMarks({ marks: series.marks(zoom), seriesId: series.id })
      }
    }
    // Labels live in screen space, so they must be re-laid-out, but only once per
    // frame no matter how many camera writes happened.
    if (this._renderRaf === null) {
      this._renderRaf = requestAnimationFrame(() => {
        this._renderRaf = null
        this.labels?.layout()
      })
    }
  }

  private _observeResize(): void {
    if (typeof ResizeObserver === 'undefined') return
    const isFluid =
      typeof this.config.chart.width === 'string' || typeof this.config.chart.height === 'string'
    if (!isFluid) return

    this._resizeObserver = new ResizeObserver(() => {
      const rect = this.element.getBoundingClientRect()
      const width = Math.max(1, Math.round(resolveSize(this.config.chart.width, rect.width, 600)))
      if (Math.abs(width - this.viewport.width) < 2) return
      this._relayout()
    })
    this._resizeObserver.observe(this.element)
  }

  private _relayout(): void {
    if (!this.rendered) return
    const previousCenter = this.viewport.center()
    const previousZoom = this.viewport.camera.k

    this._measure()
    this.renderer?.resize(this.viewport.width, this.viewport.height)
    this.labels?.destroy()
    this._buildViewport()
    this._reprojectSeries()

    // Preserve the reader's position across a resize: refitting to the data would
    // silently discard wherever they had navigated to.
    if (previousCenter && previousZoom !== 1) {
      const next = this.viewport.cameraForCenter(previousCenter, previousZoom)
      if (next) this.viewport.camera = next
    }

    this._draw()
    this.renderer?.applyCamera()
    this.emit('resized', {
      width: this.viewport.width,
      height: this.viewport.height,
    })
  }

  /** Rebuild projection-dependent geometry after a projection or size change. */
  private _reprojectSeries(): void {
    for (const series of this.series) {
      if (series instanceof BubbleSeries || series instanceof ArcSeries) {
        series.reproject(this.viewport)
      }
    }
  }

  // --- public API -----------------------------------------------------------

  /** Replace series data, tweening fills rather than rebuilding the DOM. */
  updateSeries(series: readonly Series[]): this {
    this.userOptions = merge(this.userOptions, { series })
    this.config = applyResponsive(buildConfig(this.userOptions), this.viewport.width)
    this.warnings = []
    this._buildSeries()
    this._draw()
    this._reportDiagnostics()
    this.emit('updated', { instance: this })
    return this
  }

  /**
   * Merge new options and redraw.
   *
   * @param flags.redrawGeometry Force reprojection. Inferred for map and
   *   projection changes, so it is only needed for exotic cases.
   */
  async updateOptions(
    options: ApexMapsOptions,
    { redrawGeometry }: { redrawGeometry?: boolean } = {},
  ): Promise<this> {
    const previous = this.config
    this.userOptions = merge(this.userOptions, options ?? {})
    this.config = applyResponsive(buildConfig(this.userOptions), this.viewport.width)

    const mapChanged = previous.geo?.map !== this.config.geo?.map
    const projectionChanged =
      JSON.stringify(previous.geo?.projection) !== JSON.stringify(this.config.geo?.projection)

    if (redrawGeometry || mapChanged || projectionChanged) {
      if (mapChanged) {
        // A caller changing the map is a new starting point, so any drilldown
        // trail is abandoned rather than left pointing at levels that no longer
        // relate to what is on screen. Drilling changes the map through its own
        // path, so it never reaches here.
        this._resetDrill()
        const resolved = await resolveMap(this.config.geo.map as MapSource)
        this.mapId = resolved.id
        this.mapMeta = resolved.meta ?? (resolved.id ? mapMeta(resolved.id) : undefined)
        this.geo = this._ingest(resolved.data, this.mapMeta)
      }
      this.labels?.destroy()
      this._buildViewport()
    }

    this.element.classList.toggle('apexmaps--dark', this._isDark())
    this._applyStateVars()
    this.warnings = []
    this._buildSeries()
    this._draw()
    this.renderer?.applyCamera()
    this._reportDiagnostics()
    this._checkPremium()
    this._evaluateLicense()
    this.emit('updated', { instance: this })
    return this
  }

  toggleSelection(key: string): this {
    if (!key) return this
    if (this.selection.has(key)) {
      this.selection.delete(key)
    } else if (this.config.interaction.selection?.multiple === false) {
      this.selection.clear()
      this.selection.add(key)
    } else {
      this.selection.add(key)
    }
    this._selectionChanged()
    return this
  }

  setSelection(keys: readonly string[]): this {
    this.selection = new Set(keys ?? [])
    this._selectionChanged()
    return this
  }

  clearSelection(): this {
    return this.setSelection([])
  }

  /**
   * Restyle, announce, and propagate to the link group.
   *
   * @param source Instance the change originated from. A selection arriving from a
   *   peer is applied and re-emitted locally but never rebroadcast, which is what
   *   keeps a bidirectional group from ringing.
   */
  private _selectionChanged(source: string = this.getInstanceId()): void {
    this._applySelectionStyles()
    this.emit('selectionChange', { ids: [...this.selection], source })
    if (source === this.getInstanceId()) this._broadcastSelection()
  }

  private _applySelectionStyles(): void {
    if (!this.renderer || !this.geo) return
    const active = this.config.states.active ?? {}
    // Dimming the rest is what makes a selection legible at all on a dense map: an
    // outline on 3 of 3,000 counties is nearly invisible, while 2,997 dimmed ones
    // read instantly. Done with a class so it costs one write per mark and the
    // original opacity is simply uncovered again when the selection clears.
    const muting = this.selection.size > 0 && (this.config.states.muted?.opacity ?? 0.25) < 1

    for (const series of this.renderTargets) {
      if (series.kind !== 'features') continue
      for (const feature of this.geo.features) {
        const path = this.renderer.pathFor(series.id, feature.key || feature.index)
        if (!path) continue
        const selected = this.selection.has(feature.key)
        path.classList.toggle('is-selected', selected)
        path.classList.toggle('is-muted', muting && !selected)
        if (selected && active.enabled !== false) {
          path.setAttribute('stroke', active.stroke ?? '#111111')
          path.setAttribute('stroke-width', String(active.strokeWidth ?? 1.5))
        } else {
          path.setAttribute('stroke', series.config.stroke?.color ?? 'none')
          path.setAttribute('stroke-width', String(series.config.stroke?.width ?? 0.5))
        }
      }
    }

    for (const series of this.series) {
      if (series instanceof BubbleSeries) {
        for (const item of series.items) {
          const el = this.renderer.symbolFor(series.id, item.key)
          if (!el) continue
          const selected = this.selection.has(item.key)
          el.classList.toggle('is-selected', selected)
          el.classList.toggle('is-muted', muting && !selected)
          el.setAttribute(
            'stroke',
            selected ? (active.stroke ?? '#111111') : (series.config.stroke?.color ?? '#ffffff'),
          )
          el.setAttribute(
            'stroke-width',
            String(selected ? (active.strokeWidth ?? 2) : (series.config.stroke?.width ?? 1)),
          )
        }
        continue
      }

      if (series instanceof MarkerSeries) {
        for (const item of series.items) {
          const el = this.renderer.markGroupFor(series.id, item.key)
          if (!el) continue
          const selected = this.selection.has(item.key)
          el.classList.toggle('is-selected', selected)
          el.classList.toggle('is-muted', muting && !selected)
        }
      }
    }
  }

  // --- box selection and linked maps ----------------------------------------

  private _handleSelectBox(box: SelectBox | null, phase: SelectBoxPhase, additive: boolean): void {
    this.renderer?.drawSelectBox(phase === 'move' ? box : null)
    if (phase !== 'end' || !box) return
    this._selectInBox(box, additive)
  }

  /**
   * Select everything whose anchor falls inside a screen-space box.
   *
   * **Anchors, not bounding boxes.** A feature's bbox is the wrong test: Alaska's
   * spans the Pacific, so any box touching the Aleutians would select it, and a box
   * over the Great Lakes would select half a dozen states it does not visibly
   * cover. Testing the label anchor (the point already computed for labelling, which
   * sits inside the shape) matches what the reader thinks they are enclosing.
   *
   * A box that catches nothing clears the selection, which is the only obvious way
   * a reader can undo one.
   */
  private _selectInBox(box: SelectBox, additive: boolean): void {
    const a = this.viewport.screenToWorld(box[0])
    const b = this.viewport.screenToWorld(box[1])
    const x0 = Math.min(a[0], b[0])
    const x1 = Math.max(a[0], b[0])
    const y0 = Math.min(a[1], b[1])
    const y1 = Math.max(a[1], b[1])
    const inside = (p: [number, number] | undefined) =>
      !!p && p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1

    const keys = new Set<string>(additive ? this.selection : [])

    for (const series of this.renderTargets) {
      // The basemap is substrate, not data: selecting a country drawn only so the
      // bubbles have a coastline to sit on cannot filter anything, and its keys
      // would pollute a linked group. Clicking it still selects it.
      if (series instanceof BaseFeatures) continue

      if (series.kind === 'features') {
        for (const feature of this.geo?.features ?? []) {
          if (feature.key && inside(this.anchors.get(feature.index)?.world)) keys.add(feature.key)
        }
        continue
      }
      for (const item of (series as BubbleSeries | ArcSeries | MarkerSeries).items) {
        if (item.key && inside(item.anchor)) keys.add(item.key)
      }
    }

    this.setSelection([...keys])
  }

  /**
   * Push this map's selection to the others in its `link.group`.
   *
   * Peers are read from their live config rather than from what they registered
   * with, so a group changed through `updateOptions` takes effect.
   */
  private _broadcastSelection(): void {
    const group = this.config.link?.group
    if (!group) return
    const filter = this.config.link?.filter ?? 'bidirectional'
    if (filter !== 'bidirectional' && filter !== 'emit') return

    const ids = [...this.selection]
    for (const entry of GLOBAL.instances) {
      const peer = entry.instance
      if (!peer || peer === this || peer.config.link?.group !== group) continue
      const peerFilter = peer.config.link?.filter ?? 'bidirectional'
      if (peerFilter !== 'bidirectional' && peerFilter !== 'receive') continue
      peer._receiveSelection(ids, this.getInstanceId())
    }
  }

  private _receiveSelection(ids: readonly string[], source: string): void {
    this.selection = new Set(ids)
    this._selectionChanged(source)

    // Cross-filtering only works when keys mean the same thing on both maps, and
    // the failure is silent: the other map dims everything and highlights nothing.
    if (ids.length && !this._matchesAnyKey(ids) && this._isDebug() && !this._warnedLinkKeys) {
      this._warnedLinkKeys = true
      console.warn(
        `ApexMaps: received ${ids.length} selected id(s) from link group "${this.config.link?.group}", ` +
          'none of which match a key on this map. Cross-filtering needs both maps keyed the same way.',
      )
    }
  }

  private _matchesAnyKey(ids: readonly string[]): boolean {
    const wanted = new Set(ids)
    for (const feature of this.geo?.features ?? []) if (wanted.has(feature.key)) return true
    for (const series of this.series) {
      if (series.kind === 'features') continue
      for (const item of (series as BubbleSeries | ArcSeries | MarkerSeries).items) {
        if (wanted.has(item.key)) return true
      }
    }
    return false
  }

  /** Frame a feature by key. */
  async frameFeature(
    key: string,
    options: {
      padding?: Padding
      duration?: number
      transition?: 'fly' | 'ease' | 'jump'
    } = {},
  ): Promise<void> {
    const feature = this.geo?.features.find((f) => f.key === key)
    if (!feature || !this.camera) return
    // Measure the normalized geometry, never `raw`: raw may carry unrepaired
    // winding, which d3-geo reads as the inverse of the intended polygon.
    const bounds = this.viewport.measure({
      type: 'Feature',
      geometry: feature.geometry,
      properties: {},
    })
    if (!bounds) return
    await this.camera.fitBounds(bounds, options)
  }

  /** Reset the camera to the initial fit. */
  async resetView(
    options: {
      padding?: Padding
      duration?: number
      transition?: 'fly' | 'ease' | 'jump'
    } = {},
  ): Promise<void> {
    if (!this.camera || !this.geo) return
    const bounds = this.viewport.measure(this.geo.collection)
    if (!bounds) return
    await this.camera.fitBounds(bounds, {
      padding: (this.config.geo.view?.padding ?? 16) as Padding,
      ...options,
    })
  }

  /**
   * The join diagnostic for a series, as data. The console version prints
   * automatically in dev mode; this is the programmatic form for tests and CI.
   */
  diagnoseJoin(seriesIndex = 0): JoinResult | null {
    const series = this.series[seriesIndex]
    if (!series) return null
    return 'join' in series ? (series.join ?? null) : null
  }

  /**
   * Serialise the effective spec. The round-trip that later makes saved
   * dashboards, static export and agent authoring possible.
   */
  toSpec(): ApexMapsOptions {
    return JSON.parse(
      JSON.stringify(this.config, (_key, value) =>
        typeof value === 'function' ? undefined : value,
      ),
    ) as ApexMapsOptions
  }

  // --- events ---------------------------------------------------------------

  on<K extends ApexMapsEventName>(event: K, handler: (payload: ApexMapsEventMap[K]) => void): this {
    if (typeof handler !== 'function') return this
    const list = (this._listeners[event] ??= [])
    list.push(handler as (payload: never) => void)
    return this
  }

  off<K extends ApexMapsEventName>(
    event: K,
    handler?: (payload: ApexMapsEventMap[K]) => void,
  ): this {
    if (!this._listeners[event]) return this
    if (!handler) delete this._listeners[event]
    else this._listeners[event] = this._listeners[event]!.filter((h) => h !== handler)
    return this
  }

  emit<K extends ApexMapsEventName>(event: K, payload?: ApexMapsEventMap[K]): void {
    const configHandler = this.config.chart?.events?.[event]
    if (typeof configHandler === 'function') {
      try {
        ;(configHandler as (p: unknown) => void)(payload)
      } catch (error) {
        console.error(`ApexMaps: error in chart.events.${event} handler`, error)
      }
    }
    for (const handler of this._listeners[event] ?? []) {
      try {
        ;(handler as (p: unknown) => void)(payload)
      } catch (error) {
        console.error(`ApexMaps: error in "${event}" listener`, error)
      }
    }
  }

  // --- diagnostics and licensing -------------------------------------------

  private _isDebug(): boolean {
    const flag = this.config.debug?.enabled
    if (flag === true) return true
    if (flag === false) return false
    if (typeof location === 'undefined') return false
    return (
      /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || location.protocol === 'file:'
    )
  }

  /**
   * Print join diagnostics and cartographic advice.
   *
   * Dev-mode only and grouped, so it is useful during development and invisible in
   * production. This is the cheapest high-goodwill feature in the product: it turns
   * "my map is grey" from an hour of string-diffing into a one-line answer.
   */
  private _reportDiagnostics(): void {
    if (!this._isDebug()) return

    const lines: string[] = []
    for (const warning of this.warnings) lines.push(`  ${warning}`)

    for (const series of this.series) {
      const join = 'join' in series ? series.join : null
      if (join && this.config.debug?.joinDiagnostics !== false) {
        if (join.unmatchedData.length > 0 || join.applied.length > 0 || join.matched === 0) {
          lines.push(join.report())
          // One data array covering several levels is the declarative way to feed a
          // drilldown, and it leaves every other level's rows unmatched here. Saying
          // so keeps a normal setup from reading as a broken join.
          if (join.unmatchedData.length > 0 && drilldownOf(series)) {
            lines.push(
              '  this series has a drilldown, so rows belonging to other levels are expected to be unmatched here',
            )
          }
        }
      }
      for (const note of series.advise()) lines.push(`  advice: ${note}`)
    }

    if (!lines.length) return
    const label = `ApexMaps diagnostics (${this.getInstanceId()})`
    if (typeof console.groupCollapsed === 'function') {
      console.groupCollapsed(label)
      console.log(lines.join('\n'))
      console.groupEnd()
    } else {
      console.log(`${label}\n${lines.join('\n')}`)
    }
  }

  /**
   * Declare which premium features this spec actually uses.
   *
   * Called on render and on every options change, so a map that gains a link group
   * later is evaluated then rather than staying on whatever the first render
   * decided.
   */
  private _checkPremium(): void {
    if (this.config.link?.group) this._requirePremium('linkGroup')
  }

  /**
   * Mark a premium feature as in use. Basic maps never call this, which is how the
   * free tier stays watermark-free.
   */
  private _requirePremium(feature: string): boolean {
    if (!PREMIUM_FEATURES.has(feature)) return true
    this._premiumUsed.add(feature)
    const licensed = LicenseManager.isLicenseValid()
    if (!licensed && this._isDebug()) {
      console.warn(
        `ApexMaps: "${feature}" is a licensed feature. It works for evaluation, with a watermark. ` +
          'Call ApexMaps.setLicense(key) to remove it.',
      )
    }
    this._evaluateLicense()
    return licensed
  }

  private _evaluateLicense(): void {
    if (!hasDom()) return
    // The watermark is the trial state for premium capability, not a tax on the
    // free tier: with no premium feature in use it is never added.
    if (this._premiumUsed.size === 0 || LicenseManager.isLicenseValid()) {
      Watermark.remove(this.element)
    } else {
      Watermark.add(this.element)
    }
  }

  /**
   * Publish state options that CSS applies, rather than writing them per mark.
   * Muting 3,000 features is then a class toggle each instead of 3,000 style writes.
   */
  private _applyStateVars(): void {
    this.element.style.setProperty(
      '--apexmaps-muted-opacity',
      String(this.config.states.muted?.opacity ?? 0.25),
    )
  }

  private _isDark(): boolean {
    const mode = this.config.theme?.mode
    if (mode === 'dark') return true
    if (mode === 'auto' && typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    }
    return false
  }

  /** Tear down: listeners, observers, animation frames, DOM. */
  override destroy(): void {
    if (this._renderRaf !== null) cancelAnimationFrame(this._renderRaf)
    this.camera?.stop()
    this.zoomPan?.detach()
    this._resizeObserver?.disconnect()
    this.element.removeEventListener('keydown', this._onKeyDown, true)

    for (const layer of [this.renderer?.marksLayer, this.renderer?.symbolLayer]) {
      if (!layer) continue
      layer.removeEventListener('pointerover', this._onMarkPointerOver)
      layer.removeEventListener('pointermove', this._onMarkPointerMove)
      layer.removeEventListener('pointerout', this._onMarkPointerOut)
      layer.removeEventListener('click', this._onMarkClick)
    }

    this.labels?.destroy()
    this.legend?.destroy()
    this.tooltip?.destroy()
    this.breadcrumb?.destroy()
    this.a11y?.destroy()
    this.renderer?.destroy()
    remove(this._attribution)
    remove(this.plot)

    this.element.classList.remove('apexmaps', 'apexmaps--dark')
    Watermark.remove(this.element)

    const i = GLOBAL.instances.findIndex((entry) => entry.id === this.getInstanceId())
    if (i !== -1) GLOBAL.instances.splice(i, 1)

    this._listeners = {}
    this.series = []
    this.renderTargets = []
    this.geo = null
    this.rendered = false
    super.destroy()
  }

  // --- statics --------------------------------------------------------------

  /**
   * Set the global licence key. Shared across the whole ApexCharts family, so one
   * customer key works everywhere.
   */
  static setLicense(key: string): typeof ApexMaps {
    LicenseManager.setLicense(key)
    for (const entry of GLOBAL.instances) entry.instance?._evaluateLicense?.()
    return ApexMaps
  }

  static registerMap(
    id: string,
    geometry: GeoInput | (() => Promise<GeoInput>),
    meta?: MapMeta,
  ): typeof ApexMaps {
    registerMap(id, geometry, meta)
    return ApexMaps
  }

  static registerProjection(name: string, factory: ProjectionFactory): typeof ApexMaps {
    registerProjection(name, factory)
    return ApexMaps
  }

  static registerPalette(name: string, palette: Palette): typeof ApexMaps {
    registerPalette(name, palette)
    return ApexMaps
  }

  /**
   * Point the geometry catalogue at a copy of the dataset: a base URL, or a
   * loader function for bundler and air-gapped use.
   */
  static setGeoSource(source: string | GeoFetcher): typeof ApexMaps {
    setGeoSource(source)
    return ApexMaps
  }

  static listMaps(): string[] {
    return listMaps()
  }

  /**
   * The built-in catalogue with provenance, for a picker UI or a docs table.
   * Excludes anything registered by hand through `registerMap()`.
   */
  static catalogue(): GeoPack[] {
    return geoPacks()
  }

  /**
   * Provenance for a registered map: source, licence, vintage, boundary policy,
   * recommended join key.
   */
  static mapMeta(id: string): MapMeta | undefined {
    return mapMeta(id)
  }

  static listProjections(): string[] {
    return listProjections()
  }

  static getInstance(id: string): ApexMaps | undefined {
    return GLOBAL.instances.find((entry) => entry.id === id)?.instance
  }

  static get version(): string {
    return VERSION
  }
}

/**
 * A series' drilldown config, if it has a usable one.
 *
 * Read off the config rather than the class, because the basemap pseudo-series is
 * also a feature series and a caller can configure a drilldown on a map with no
 * data at all.
 */
function drilldownOf(series: AnySeries): DrilldownOptions | null {
  if (series.kind !== 'features') return null
  const options = (series.config as { drilldown?: DrilldownOptions }).drilldown
  return options && options.map ? options : null
}

function resolveLabelText({
  feature,
  field,
  value,
  formatter,
}: {
  feature: NormalizedFeature
  field?: string | ((datum: unknown) => string)
  value: number | null
  formatter?: (context: { value: number | null; name?: string; key?: string }) => string
}): string {
  if (typeof formatter === 'function') {
    const out = formatter({ value, name: feature.name, key: feature.key })
    return out == null ? '' : String(out)
  }
  if (typeof field === 'function') {
    const out = field(feature)
    return out == null ? '' : String(out)
  }
  if (typeof field === 'string') {
    const out = feature.properties?.[field] ?? (field === 'value' ? value : undefined)
    return out == null ? '' : String(out)
  }
  return feature.name ?? ''
}

/**
 * `[west, south, east, north]` to a closed polygon, for `geo.view.fit`.
 *
 * The ring winds **clockwise** in lon/lat, which for `d3-geo` means "the inside is
 * this box". Wind it the other way, the intuitive left-to-right reading order, and
 * d3 fits the entire sphere *minus* the box: ask for Europe and get the world with
 * Europe as a hole. This is the same winding convention that governs ingested
 * geometry (see `geo/GeoData`), and it has now cost this project four mistakes, so
 * the order below is load-bearing and covered by a test.
 */
function bboxToPolygon([west, south, east, north]: [number, number, number, number]) {
  return {
    type: 'Polygon' as const,
    coordinates: [
      [
        [west, south] as LonLat,
        [west, north] as LonLat,
        [east, north] as LonLat,
        [east, south] as LonLat,
        [west, south] as LonLat,
      ],
    ],
  }
}

// Default-only on purpose. This module is the entry for the IIFE and UMD builds,
// where a single default export is what makes `window.ApexMaps` the class itself
// rather than a module namespace object. The named export lives in `index.ts`.
export default ApexMaps
