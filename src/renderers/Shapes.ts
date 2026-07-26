/**
 * Marker shape paths.
 *
 * Generated rather than shipped as a sprite sheet or icon font: a path scales to
 * any size without a second asset, needs no image load, and cannot fail CORS.
 * Seven shapes is the whole set, and `shape: 'custom'` is not offered because a
 * caller who needs their own glyph can pass a path through `markerPath`.
 *
 * Every shape is centred on the origin and sized so that `size` is the width of
 * its bounding box, so a square and a circle of the same `size` read as the same
 * weight on the page. The exception is `pin`, which is anchored at its point,
 * because a pin that floats above the place it marks is a pin pointing at
 * nothing.
 *
 * @module renderers/Shapes
 */

import type { MarkerShape } from '../types'

/** Rounded to keep path strings short: sub-pixel precision is invisible here. */
function r(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Path data for a shape, centred on (0, 0), except `pin` whose tip is at (0, 0).
 *
 */
export function markerPath(shape: MarkerShape, size: number): string {
  const s = Math.max(1, size)
  const h = s / 2

  switch (shape) {
    case 'square':
      return `M${r(-h)},${r(-h)}h${r(s)}v${r(s)}h${r(-s)}Z`

    case 'diamond':
      return `M0,${r(-h)}L${r(h)},0L0,${r(h)}L${r(-h)},0Z`

    case 'triangle': {
      // Equal-area with the circle of the same size, so a mixed-shape map does not
      // silently weight one category heavier than another.
      const side = s * 1.1
      const height = (side * Math.sqrt(3)) / 2
      return `M0,${r(-height * 0.62)}L${r(side / 2)},${r(height * 0.38)}L${r(-side / 2)},${r(height * 0.38)}Z`
    }

    case 'star': {
      const outer = h * 1.15
      const inner = outer * 0.4
      const points: string[] = []
      for (let i = 0; i < 10; i++) {
        const radius = i % 2 === 0 ? outer : inner
        const angle = (Math.PI / 5) * i - Math.PI / 2
        points.push(`${r(Math.cos(angle) * radius)},${r(Math.sin(angle) * radius)}`)
      }
      return `M${points.join('L')}Z`
    }

    case 'cross': {
      const arm = h * 0.36
      return (
        `M${r(-arm)},${r(-h)}h${r(arm * 2)}v${r(h - arm)}h${r(h - arm)}` +
        `v${r(arm * 2)}h${r(-(h - arm))}v${r(h - arm)}h${r(-arm * 2)}` +
        `v${r(-(h - arm))}h${r(-(h - arm))}v${r(-arm * 2)}h${r(h - arm)}Z`
      )
    }

    case 'pin': {
      // A teardrop: a circle of radius `h` centred at (0, -1.6h), tapering to the
      // origin. Drawn with two symmetric quadratic curves.
      const radius = h
      const cy = -radius * 1.6
      return (
        `M0,0` +
        `C${r(-radius * 0.55)},${r(cy * 0.55)} ${r(-radius)},${r(cy * 0.75)} ${r(-radius)},${r(cy)}` +
        `a${r(radius)},${r(radius)} 0 1,1 ${r(radius * 2)},0` +
        `c0,${r(-cy * 0.25)} ${r(-radius * 0.45)},${r(-cy * 0.45)} ${r(-radius)},${r(-cy)}` +
        `Z`
      )
    }

    case 'circle':
    default:
      // Two arcs, because a <path> keeps every shape on one code path in the
      // renderer instead of branching on element type.
      return `M${r(-h)},0a${r(h)},${r(h)} 0 1,0 ${r(s)},0a${r(h)},${r(h)} 0 1,0 ${r(-s)},0Z`
  }
}

/** Shapes whose anchor is their tip rather than their centre. */
export function isPointAnchored(shape: MarkerShape): boolean {
  return shape === 'pin'
}

export const MARKER_SHAPES: MarkerShape[] = [
  'circle',
  'square',
  'diamond',
  'triangle',
  'star',
  'cross',
  'pin',
]
