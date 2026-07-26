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
import { ArcSeries } from './series/Arc'
import { BaseFeatures } from './series/BaseFeatures'
import { Legend } from './components/Legend'
import type { LegendSection } from './components/Legend'
import { Tooltip } from './components/Tooltip'
import { Labels, labelAnchor } from './components/Labels'
import type { LabelCandidate } from './components/Labels'
import { ZoomPan } from './interaction/ZoomPan'
import { registerPalette } from './scales/Palettes'
import type { Palette } from './scales/Palettes'
import { html, remove, resolveSize, pointerPosition, hasDom } from './utils/dom'
import { darken } from './scales/Color'
import type { JoinResult } from './data/Join'
import type {
  Anchor,
  ApexMapsEventMap,
  ApexMapsEventName,
  ApexMapsOptions,
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
type AnySeries = ChoroplethSeries | BubbleSeries | ArcSeries | BaseFeatures

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
  /** DOM key used by the renderer for this mark. */
  markKey: string | number
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
  series: (ChoroplethSeries | BubbleSeries | ArcSeries)[] = []
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

  plot: HTMLElement | null = null
  legend: Legend | null = null
  tooltip: Tooltip | null = null
  labels: Labels | null = null
  a11y: A11y | null = null
  zoomPan: ZoomPan | null = null

  private _listeners: Partial<Record<string, ((payload: never) => void)[]>> = {}
  private readonly _premiumUsed = new Set<string>()
  private _resizeObserver: ResizeObserver | null = null
  private _renderRaf: number | null = null
  private _attribution: HTMLElement | null = null
  private _a11yMounted = false

  private readonly _onMarkPointerOver: (event: Event) => void
  private readonly _onMarkPointerMove: (event: Event) => void
  private readonly _onMarkPointerOut: (event: Event) => void
  private readonly _onMarkClick: (event: Event) => void

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
    this._evaluateLicense()

    this.rendered = true
    this.emit('rendered', { instance: this })
    return this
  }

  private _ingest(data: GeoInput): NormalizedGeo {
    return normalizeGeo(data, {
      // A catalogue pack states its own recommended key, and it is right more
      // often than generic detection can be: an admin-1 pack carries `adm0_a3`
      // (the *country* code, identical for all 47 Japanese prefectures) which
      // scores higher than the correct `iso_3166_2` in any fixed candidate order.
      // Explicit config still wins.
      keyField: this.config.geo.keyField ?? (this.mapMeta?.keyField as string | undefined),
      nameField: this.config.geo.nameField,
      object: this.config.geo.object,
      repairWinding: this.config.geo.repairWinding,
    })
  }

  private _mountShell(): void {
    const { chart } = this.config
    this.element.classList.add('apexmaps')
    this.element.classList.toggle('apexmaps--dark', this._isDark())
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
    this.zoomPan = new ZoomPan({
      container: this.plot,
      camera: this.camera,
      options: this.config.interaction,
      emit: (event, payload) => this.emit(event as ApexMapsEventName, payload as never),
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
    const target = event.target as Element | null
    if (!target?.getAttribute) return null

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

    const mark = (series as BubbleSeries | ArcSeries).itemAt(item)
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
    const mark = this._resolveMark(event)
    if (!mark) return
    if (this.config.interaction.selection?.enabled !== false) this.toggleSelection(mark.key)
    this.emit(mark.feature ? 'featureClick' : 'markClick', this._eventPayload(mark) as never)
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
        const resolved = await resolveMap(this.config.geo.map as MapSource)
        this.mapId = resolved.id
        this.mapMeta = resolved.meta
        this.geo = this._ingest(resolved.data)
      }
      this.labels?.destroy()
      this._buildViewport()
    }

    this.element.classList.toggle('apexmaps--dark', this._isDark())
    this.warnings = []
    this._buildSeries()
    this._draw()
    this.renderer?.applyCamera()
    this._reportDiagnostics()
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
    this._applySelectionStyles()
    this.emit('selectionChange', {
      ids: [...this.selection],
      source: this.getInstanceId(),
    })
    return this
  }

  setSelection(keys: readonly string[]): this {
    this.selection = new Set(keys ?? [])
    this._applySelectionStyles()
    this.emit('selectionChange', {
      ids: [...this.selection],
      source: this.getInstanceId(),
    })
    return this
  }

  clearSelection(): this {
    return this.setSelection([])
  }

  private _applySelectionStyles(): void {
    if (!this.renderer || !this.geo) return
    const active = this.config.states.active ?? {}

    for (const series of this.renderTargets) {
      if (series.kind !== 'features') continue
      for (const feature of this.geo.features) {
        const path = this.renderer.pathFor(series.id, feature.key || feature.index)
        if (!path) continue
        const selected = this.selection.has(feature.key)
        path.classList.toggle('is-selected', selected)
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
      if (!(series instanceof BubbleSeries)) continue
      for (const item of series.items) {
        const el = this.renderer.symbolFor(series.id, item.key)
        if (!el) continue
        const selected = this.selection.has(item.key)
        el.classList.toggle('is-selected', selected)
        el.setAttribute(
          'stroke',
          selected ? (active.stroke ?? '#111111') : (series.config.stroke?.color ?? '#ffffff'),
        )
        el.setAttribute(
          'stroke-width',
          String(selected ? (active.strokeWidth ?? 2) : (series.config.stroke?.width ?? 1)),
        )
      }
    }
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
