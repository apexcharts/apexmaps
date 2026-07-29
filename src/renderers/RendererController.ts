/**
 * Selects the active geometry renderer and owns fallback.
 *
 * The semantics mirror `RendererController` in apexcharts-js deliberately, so
 * `renderer: 'auto'` means the same thing to someone who sets it on a chart and
 * on a map: SVG is always available and is the fallback; non-SVG backends
 * register a factory so they stay tree-shakeable; `'auto'` promotes once the
 * mark count crosses a threshold; a backend that is requested but not bundled
 * warns when it was asked for explicitly and declines silently when `'auto'`
 * merely preferred it; and SSR always renders SVG.
 *
 * It is a mirror rather than an import. The recorded decision (2026-07-26) was
 * to reuse the chart controller and its reversal condition was "a map-specific
 * requirement that the controller genuinely cannot express", which is what this
 * turned out to be:
 *
 * - It takes `(w, ctx)`, the chart's globals object and instance. ApexMaps has
 *   neither, and manufacturing a fake `w` to satisfy the signature would be a
 *   worse coupling than a shared contract.
 * - Its `computeMarkCount` reads `w.config.series[].data.length` against chart
 *   types (heatmap cells, scatter, bubble). The number that decides a *map* is
 *   the feature count, which that function cannot express at all: 3,231
 *   counties with no series data at all is the case that needs canvas most.
 * - Its `hasCanvasUnsupportedFeature` gates on `fill.type` gradients and state
 *   colour-matrix filters, none of which exist in the map options tree.
 * - It is not in apexcharts-js's package exports, so reuse would mean deep
 *   importing internals and taking the whole chart library as a dependency of
 *   the maps package: a hundred-plus kB against a 150 kB budget, to share 172
 *   lines.
 *
 * What is genuinely shared is the *behaviour*, which is what a caller
 * experiences, and it is pinned by tests here so the two cannot drift.
 *
 * @module renderers/RendererController
 */

import { hasDom } from '../utils/dom'
import { DEFAULT_RENDERER_THRESHOLD, canvasUnsupported, geometryMarkCount } from './Renderer'
import type { ActiveRendererKind } from './Renderer'
import type { CanvasRenderer } from './CanvasRenderer'
import type { Viewport } from '../geo/Viewport'
import type { RendererKind } from '../types'

/**
 * A backend factory, registered by the tier's own module.
 *
 * Typed to the canvas tier because it is the only non-SVG backend today, and a
 * `GeometryRenderer` interface wide enough to cover both would be an interface
 * with exactly one implementation pretending otherwise. The WebGL tier is the
 * point at which this widens, and widening it then is a smaller job than
 * guessing the shape now.
 */
export type RendererFactory = (options: { viewport: Viewport }) => CanvasRenderer | null

const REGISTRY_KEY = '__apexmaps_renderers__'

/**
 * kind -> factory. Held on `globalThis`, matching the chart controller and the
 * map/projection/palette registries here, so a backend registered against one
 * copy of the bundle (a page with both an ESM and a UMD build loaded) is
 * visible to maps created by the other.
 */
function registry(): Map<string, RendererFactory> {
  const scope = (typeof globalThis !== 'undefined' ? globalThis : {}) as Record<string, unknown>
  if (!scope[REGISTRY_KEY]) scope[REGISTRY_KEY] = new Map()
  return scope[REGISTRY_KEY] as Map<string, RendererFactory>
}

export interface SelectionInput {
  /** `chart.renderer` as the caller set it. */
  mode: RendererKind | undefined
  /** `chart.rendererThreshold`, the `'auto'` promotion point. */
  threshold?: number
  featureCount: number
  pathMarkCount: number
}

export interface Selection {
  kind: ActiveRendererKind
  /** The kind selection wanted, before availability. */
  desired: string
  /** Dev-visible explanation, when the outcome is not what was asked for. */
  warning?: string
  /** Why this tier, for the diagnostics block. */
  note?: string
}

export class RendererController {
  static registerRenderer(kind: string, factory: RendererFactory): void {
    registry().set(kind, factory)
  }

  /**
   * Build the backend a `resolve()` chose. Returns null when the kind is not
   * registered, which the caller treats the same as a failed mount: render SVG.
   */
  static create(kind: string, options: { viewport: Viewport }): CanvasRenderer | null {
    return registry().get(kind)?.(options) ?? null
  }

  /** Remove a backend. Maps fall back to SVG on their next resolve. */
  static unregisterRenderer(kind: string): void {
    registry().delete(kind)
  }

  static isRegistered(kind: string): boolean {
    return registry().has(kind)
  }

  /** Registered non-SVG backends, for diagnostics and tests. */
  static registered(): string[] {
    return [...registry().keys()]
  }

  /**
   * The kind selection wants, before asking whether it is available. Pure, so
   * the decision is testable without a DOM or a registry.
   */
  static desiredKind(input: SelectionInput): string {
    const mode = input.mode || 'svg'

    // SSR renders SVG: there is no canvas to rasterise into, and markup is the
    // only useful output.
    if (!hasDom()) return 'svg'
    if (mode === 'svg') return 'svg'

    // A spec feature canvas cannot reproduce forces SVG whatever the mode.
    if (canvasUnsupported()) return 'svg'

    // `'webgl'` is not built. It resolves to the best tier that is, rather than
    // silently to SVG, because a caller asking for the fastest backend wants the
    // fastest one that exists.
    if (mode === 'canvas' || mode === 'webgl') return 'canvas'

    const marks = geometryMarkCount(input)
    const threshold = input.threshold ?? DEFAULT_RENDERER_THRESHOLD
    return marks >= threshold ? 'canvas' : 'svg'
  }

  /**
   * Resolve to a backend that actually exists, with the reason.
   *
   * Nothing is instantiated here: the caller owns renderer lifetimes, because a
   * renderer holds mounted DOM and must be torn down with the map rather than
   * with a selection pass.
   */
  static resolve(input: SelectionInput): Selection {
    const mode = input.mode || 'svg'
    const desired = RendererController.desiredKind(input)

    if (desired === 'svg') {
      const blocked = canvasUnsupported()
      if (blocked && (mode === 'canvas' || mode === 'webgl')) {
        return {
          kind: 'svg',
          desired,
          warning: `chart.renderer '${mode}' was declined because this map uses ${blocked}, which the canvas tier cannot reproduce; rendering SVG`,
        }
      }
      return { kind: 'svg', desired }
    }

    if (registry().has(desired)) {
      const marks = geometryMarkCount(input)
      const note =
        mode === 'auto'
          ? `renderer 'auto' selected canvas: ${marks} geometry marks at or above the ${input.threshold ?? DEFAULT_RENDERER_THRESHOLD} threshold`
          : undefined
      const warning =
        mode === 'webgl'
          ? "chart.renderer 'webgl' is not built yet; the canvas tier was used instead, which is the fastest available"
          : undefined
      return { kind: desired as ActiveRendererKind, desired, warning, note }
    }

    // Requested but not bundled. Explicit asks say so; `'auto'` stays quiet,
    // because a caller who did not name canvas has not been let down.
    return {
      kind: 'svg',
      desired,
      warning:
        mode === desired || mode === 'webgl'
          ? `chart.renderer '${mode}' was requested but the ${desired} tier is not bundled ` +
            `(import 'apexmaps/renderers/canvas', or use the full build); rendering SVG`
          : undefined,
    }
  }
}
