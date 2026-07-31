/**
 * Feature labels, with collision avoidance.
 *
 * Label placement is where chart-library maps visibly lose to Mapbox and ArcGIS
 * today, so even the phase-1 version does the
 * things that matter:
 *
 * - **Priority ordering.** Larger and higher-valued features win, so dropping
 *   labels degrades gracefully instead of arbitrarily.
 * - **Axis-aligned collision** against already-placed labels.
 * - **Area gating.** A label wider than its feature is noise.
 * - **Halo by default** via `paint-order`, so text stays readable on any fill.
 *
 * Labels are drawn in the screen-space overlay, not the world group: text must
 * not scale with the camera. They are re-laid-out on camera change, which is
 * cheap because the candidate set is small and pre-sorted.
 *
 * @module components/Labels
 */

import { svg, empty } from '../utils/dom'
import type { SvgRenderer } from '../renderers/SvgRenderer'
import type { Viewport } from '../geo/Viewport'
import type { Anchor, DataLabelOptions, NormalizedFeature, WorldPoint } from '../types'

export interface LabelCandidate {
  text: string
  /** Anchor in world space. */
  world: WorldPoint
  /** Higher wins when labels collide. */
  priority: number
  /** Approximate world-space area, in square pixels. */
  featureArea: number
  color?: string
  key?: string
}

export class Labels {
  readonly renderer: SvgRenderer
  readonly viewport: Viewport
  /** Re-pointed at the live config on every draw; see `_syncComponentOptions`. */
  options: DataLabelOptions
  candidates: LabelCandidate[] = []
  group: SVGGElement | null = null
  placedCount = 0
  droppedCount = 0

  constructor({
    renderer,
    viewport,
    options,
  }: {
    renderer: SvgRenderer
    viewport: Viewport
    options: DataLabelOptions
  }) {
    this.renderer = renderer
    this.viewport = viewport
    this.options = options || {}
  }

  setCandidates(candidates: LabelCandidate[]): void {
    // Sort once: layout runs on every camera change, so ordering must not.
    this.candidates = [...candidates].sort((a, b) => b.priority - a.priority)
  }

  /**
   * Lay out and draw. Called after every render and camera change.
   *
   * @param reserved Screen-space boxes already occupied, currently the
   *   annotation chips. A generated label yields to an annotation rather than
   *   the other way round: the annotation was placed deliberately and the label
   *   was produced by a rule, so the rule is the one that should give way.
   */
  layout(reserved: readonly Box[] = []): void {
    const overlay = this.renderer.overlay()
    if (!overlay) return

    if (!this.group) {
      this.group = svg('g', {
        class: 'apexmaps-labels',
        'pointer-events': 'none',
      })
      overlay.appendChild(this.group)
    }
    empty(this.group)

    if (this.options.enabled === false || !this.candidates.length) {
      this.placedCount = 0
      this.droppedCount = 0
      return
    }

    const style = this.options.style || {}
    const fontSize = style.fontSize ?? 11
    const fontWeight = style.fontWeight ?? 500
    const collide = this.options.collision !== 'none'
    const minArea = this.options.minFeatureArea ?? 240
    const k = this.viewport.camera.k

    const placed: Box[] = [...reserved]
    let dropped = 0

    for (const candidate of this.candidates) {
      const screen = this.viewport.worldToScreen(candidate.world)
      if (!isFinite(screen[0]) || !isFinite(screen[1])) continue

      // Cull offscreen before doing any measurement work.
      if (
        screen[0] < -50 ||
        screen[1] < -50 ||
        screen[0] > this.viewport.width + 50 ||
        screen[1] > this.viewport.height + 50
      ) {
        continue
      }

      // Feature area scales with k^2, so a label that does not fit at low zoom
      // may fit once the reader zooms in. This is the cheap form of
      // zoom-dependent label density.
      if (minArea > 0 && candidate.featureArea * k * k < minArea) {
        dropped++
        continue
      }

      // Character-width approximation: measuring text properly needs a reflow
      // per label, which is exactly the per-frame cost to avoid. 0.58em is a
      // good average for the sans-serif stack in use.
      const width = candidate.text.length * fontSize * 0.58
      const height = fontSize * 1.15
      const box = {
        x0: screen[0] - width / 2,
        y0: screen[1] - height / 2,
        x1: screen[0] + width / 2,
        y1: screen[1] + height / 2,
      }

      if (collide && placed.some((p) => intersects(p, box))) {
        dropped++
        continue
      }
      placed.push(box)

      const text = svg('text', {
        class: 'apexmaps-label',
        x: screen[0],
        y: screen[1],
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
        'font-size': fontSize,
        'font-weight': fontWeight,
        fill: candidate.color || 'currentColor',
        text: candidate.text,
      })

      if (style.halo !== false) {
        // paint-order puts the stroke behind the fill, which is how a halo is
        // done without duplicating the element.
        text.setAttribute('paint-order', 'stroke')
        text.setAttribute(
          'stroke',
          style.haloColor || 'var(--apexmaps-halo, rgba(255,255,255,0.85))',
        )
        text.setAttribute('stroke-width', String(style.haloWidth ?? 2.5))
        text.setAttribute('stroke-linejoin', 'round')
      }

      this.group.appendChild(text)
    }

    // Reserved boxes were never labels, so they must not inflate the count a
    // diagnostic or a test reads.
    this.placedCount = placed.length - reserved.length
    this.droppedCount = dropped
  }

  destroy(): void {
    if (this.group && this.group.parentNode) this.group.parentNode.removeChild(this.group)
    this.group = null
    this.candidates = []
  }
}

/** An axis-aligned screen-space box, the unit of label collision. */
export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

function intersects(a: Box, b: Box): boolean {
  return !(b.x0 > a.x1 || b.x1 < a.x0 || b.y0 > a.y1 || b.y1 < a.y0)
}

/**
 * Label anchor for a feature, in world space.
 *
 * Uses the projected path centroid, then falls back to the bounding-box centre.
 * A proper pole-of-inaccessibility anchor (`polylabel`) is a phase-2 item: it
 * matters for concave shapes such as Florida or Chile where the centroid lands
 * offshore, and it is not worth the dependency until the label engine is doing
 * leader lines too.
 *
 */
export function labelAnchor(viewport: Viewport, feature: NormalizedFeature): Anchor | null {
  if (!viewport.path || !feature.geometry) return null

  const centroid = viewport.path.centroid(feature.geometry)
  const bounds = viewport.path.bounds(feature.geometry)
  if (!bounds || !isFinite(bounds[0][0])) return null

  const area = Math.max(0, (bounds[1][0] - bounds[0][0]) * (bounds[1][1] - bounds[0][1]))
  const world: WorldPoint =
    centroid && Number.isFinite(centroid[0]) && Number.isFinite(centroid[1])
      ? [centroid[0], centroid[1]]
      : [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2]

  return { world, area }
}
