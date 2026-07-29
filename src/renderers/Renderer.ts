/**
 * The renderer contract, and the selection rules that pick one.
 *
 * Two backends implement it: the SVG renderer (always present) and the Canvas
 * tier. The contract is deliberately narrow, covering only what actually
 * differs between them:
 *
 * - **the world-space layers**, whose element count scales with geometry:
 *   feature fills, arcs and routes, the sphere and graticule;
 * - **mark state** (hover, selection, muting), which SVG expresses by mutating
 *   an element and Canvas by recording state and repainting;
 * - **hit testing**, which SVG gets from the browser and Canvas gets from an
 *   R-tree plus an exact `isPointInPath`.
 *
 * Everything else stays SVG in both tiers and is not part of this interface:
 * labels, annotations, the selection box, the focus ring, the accessibility
 * tree, and the screen-space symbol layers (bubbles and markers). That split is
 * a decision, not an omission:
 *
 * - Text on canvas loses selectable, translatable, screen-reader-visible
 *   content, and the accessibility bar (N14) is not negotiable.
 * - Screen-space marks are already bounded by clustering, are already O(marks)
 *   rather than O(features) per frame, and are already hit-tested by
 *   computation rather than by DOM, through the proximity layer. Moving them
 *   would cost the annotation and label contracts nothing and buy nothing.
 *
 * So `renderer: 'canvas'` means "rasterise the geometry layers", and the
 * diagnostics say so rather than implying the whole map changed backend.
 *
 * @module renderers/Renderer
 */

import type { NormalizedFeature, StrokeOptions, WorldBounds } from '../types'
import type { PathSpec } from './SvgRenderer'

/** Backends that can actually be active. `'auto'` and `'webgl'` resolve to these. */
export type ActiveRendererKind = 'svg' | 'canvas'

/** Per-mark visual state, the thing SVG puts in classes and canvas repaints. */
export interface MarkState {
  hovered?: boolean
  selected?: boolean
  muted?: boolean
}

/**
 * What a hit test returns: enough to identify the mark, never the mark itself,
 * so the two backends do not have to agree on any object identity.
 */
export interface HitResult {
  seriesId: string
  /** Feature index for geometry layers, item index for path layers. */
  item: number
}

/**
 * The geometry-layer renderer.
 *
 * Only the members both backends genuinely implement are listed. The SVG
 * renderer has a wider surface (element accessors, the overlay and region
 * layers) that the chart uses directly when SVG is active; the canvas tier
 * reports those as absent rather than faking DOM nodes.
 */
export interface GeometryRenderer {
  readonly kind: ActiveRendererKind
  /**
   * Whether a camera frame needs the renderer to repaint. False for SVG, whose
   * world group carries the transform; true for canvas, which must re-rasterise.
   */
  readonly repaintsOnCamera: boolean
}

/**
 * Marks a render would emit through the geometry layers.
 *
 * This is the number the Canvas tier changes the cost of, so it is the number
 * `'auto'` decides on. It deliberately counts features and world-space path
 * marks and ignores bubbles and markers: those stay in SVG in both tiers, so
 * promoting a map because it has many of them would move the cheap half and
 * leave the expensive half where it was.
 */
export function geometryMarkCount({
  featureCount,
  pathMarkCount,
}: {
  featureCount: number
  pathMarkCount: number
}): number {
  return Math.max(0, featureCount) + Math.max(0, pathMarkCount)
}

/**
 * Whether the spec uses something the canvas tier cannot reproduce, which makes
 * `'auto'` decline silently and explicit `'canvas'` warn and fall back.
 *
 * Kept as a named predicate with an empty list rather than dropped, because the
 * list is the honest place for the next such limit to land, and because the
 * apexcharts-js controller this mirrors has the same gate.
 */
export function canvasUnsupported(): string | null {
  return null
}

/**
 * How many geometry marks make canvas worth its own costs.
 *
 * Set from measurement rather than intuition, and the measurement is not the one
 * the roadmap line implied. Chromium, 1066x520 plot, generated grids, panning at
 * full extent:
 *
 * ```
 *   features   svg frame p95   canvas frame p95   svg dom nodes   canvas
 *      3,231          9.1 ms             9.1 ms           3,247       16
 *     10,000          9.9 ms             9.4 ms          10,016       16
 *     20,000              --             9.8 ms          20,016       16
 *     30,000              --            15.5 ms          30,016       16
 *     40,000              --            20.7 ms          40,016       16
 * ```
 *
 * The honest reading: **canvas does not make panning faster**, because SVG's
 * camera is already one transform on one group and is O(1) in the feature count.
 * Recolouring is actually *slower* on canvas (10.3 ms against 6.2 ms at 20,000),
 * because it re-merges and re-rasterises where SVG rewrites fill attributes. What
 * canvas decisively removes is the DOM: sixteen elements instead of twenty
 * thousand, which is memory, style recalculation and accessibility-tree weight
 * the map imposes on the whole page rather than only on its own frames.
 *
 * So the threshold is the point where the DOM itself is the problem, not where
 * frames are: 20,000 elements is where browsers broadly start to struggle, and it
 * is still inside the frame budget on canvas (9.8 ms). Above roughly 30,000 a
 * canvas pan leaves the 16 ms budget, which is recorded as the tier's ceiling
 * rather than hidden.
 *
 * Every pack the registry ships is far below this, so `'auto'` never silently
 * swaps the backend of a map SVG already draws well: that would trade elements a
 * caller may be styling for a canvas and buy nothing measurable.
 */
export const DEFAULT_RENDERER_THRESHOLD = 20000

/** Draw parameters for the feature layer, identical across backends. */
export interface FeatureLayer {
  features: NormalizedFeature[]
  fill: (feature: NormalizedFeature) => string
  stroke?: StrokeOptions
  opacity?: number
  seriesId: string
}

/** Draw parameters for a world-space path layer (arcs, routes). */
export interface PathLayer {
  paths: PathSpec[]
  seriesId: string
  hitWidth?: number
  markClass?: string
}

/** A base path (sphere, graticule): one shape, no data, no hit testing. */
export interface BasePathLayer {
  d: string
  className: string
  fill?: string
  stroke?: string
  width?: number
}

export type { WorldBounds }
