/**
 * Flow: what turns a connection into a direction.
 *
 * An arc says two places are related. It does not say which way anything moves,
 * and on a hub map every route leaves the same airport, so the reader cannot even
 * infer it. Beads travelling along the path say it without a legend, an arrowhead
 * or a second encoding.
 *
 * The mechanism is one dashed companion path per route, animated on
 * `stroke-dashoffset`, and the reason it is that rather than a dot moved from
 * JavaScript is arithmetic: a dash pattern only has to advance by one period to
 * loop seamlessly, so the duration is `spacing / speed` and the route's own
 * length never enters into it. Every route then travels at the same speed with no
 * measurement, which matters because measuring would mean `getTotalLength`, and
 * that exists in a browser but not in jsdom or on a server.
 *
 * Three consequences worth knowing:
 *
 * - The phase is a pure function of time, so panning and zooming cannot disturb
 *   it. A dot driven per frame from a projected position has to be recomputed as
 *   the camera moves, and any disagreement with the path underneath shows up as
 *   drift along a 1px line.
 * - The dots ride `vector-effect: non-scaling-stroke` along with the route, so
 *   their size and spacing stay constant in screen pixels at every zoom.
 * - `stroke-dashoffset` restarts the pattern at each subpath, and d3-geo cuts a
 *   trans-Pacific arc in two at the antimeridian. The dots keep travelling in the
 *   right direction across the seam, but not in step across it. That is the one
 *   thing this approach cannot do and a per-frame dot can.
 *
 * An export catches the beads where they were: the pattern and the offset are both
 * ordinary stroke properties, so `export/Exporter` reads them off the live element
 * along with everything else, and a PNG of a travelling map matches the screen it
 * was taken from.
 *
 * @module series/flow
 */

import type { FlowOptions } from '../types'
import type { FlowSpec } from '../renderers/SvgRenderer'

/**
 * Screen pixels per second.
 *
 * Slow enough to read as freight rather than as a loading spinner, brisk enough
 * that a reader who glances at the map for two seconds sees it move.
 */
const DEFAULT_SPEED = 90

/**
 * Screen pixels between one bead and the next.
 *
 * Measured rather than picked. On a hub map at a normal figure width the routes
 * run 130 to 760 screen pixels, so a 22px spacing puts 6 to 35 beads on them and
 * the result reads as a dotted line: the eye sees a texture and stops seeing
 * anything move. At 56 the same routes carry 2 to 14, which reads as things
 * travelling, and the sparse end is the safe end because one bead moving along a
 * route is still unmistakably one bead moving along a route.
 */
const DEFAULT_SPACING = 56

/** Fraction of the period that is ink, under `style: 'dash'`. */
const DASH_DUTY = 0.45

/**
 * A dash length short enough to render as a dot once the round cap is added, and
 * long enough that no engine can decide it is empty and skip it. Zero is what the
 * SVG specification says should paint a circle, and it does in current browsers,
 * but the difference is invisible and this cannot be got wrong.
 */
const DOT_DASH = 0.1

/** Bounds on a bead's diameter, when it is derived from the route's width. */
const MIN_SIZE = 2.8
const MAX_SIZE = 7

/**
 * Resolve a series' `flow` option against one route.
 *
 * Returns undefined when flow is off, so a caller can spread the result into a
 * path spec and let the absence mean "no companion path".
 */
export function resolveFlow(
  flow: boolean | FlowOptions | undefined,
  { key, width, color }: { key: string; width: number; color: string },
): FlowSpec | undefined {
  if (!flow) return undefined
  const options = flow === true ? {} : flow

  // Two pixels of period is already past the point where beads are a texture
  // rather than marks, and zero would divide by nothing below.
  const spacing = Math.max(2, options.spacing ?? DEFAULT_SPACING)
  const speed = Math.max(0, options.speed ?? DEFAULT_SPEED)
  const dash = options.style === 'dash' ? spacing * DASH_DUTY : DOT_DASH

  // Derived from the route's own width by default, so the heavy corridors carry
  // fat beads and the same value is encoded once rather than contradicted twice.
  // Clamped at the bottom because an arc can be 0.75px wide and a 0.75px bead is
  // not a bead, and at the top because a bead wider than about 7px stops reading
  // as something travelling and starts reading as a blob.
  const size = options.size ?? Math.min(MAX_SIZE, Math.max(MIN_SIZE, width * 1.6))

  const duration = speed > 0 ? spacing / speed : 0

  return {
    dash,
    gap: spacing - dash,
    width: size,
    color: options.color ?? color,
    // Full opacity by default even though the route beneath is usually drawn
    // under 1: a bead the same colour and the same opacity as the line it sits on
    // is invisible, and the whole point is that it stands off the line.
    opacity: options.opacity ?? 1,
    duration,
    // Anchored to the ground by default: the numbers above are screen pixels at
    // the view the map opened at, and the renderer scales them by how far the
    // camera has moved from it. Holding them fixed in screen pixels instead means
    // the bead count on a route climbs with the zoom, so a route that read as five
    // beads at the opening view is a dotted line at 3x.
    scale: options.scale ?? 'zoom',
    // Negative, so a staggered route starts part-way through the pattern instead
    // of waiting to begin. Hashed from the key rather than drawn at random, so a
    // re-render, an SSR pass and a screenshot all agree. Guarded on the duration
    // as well as the option, because a phase of a zero-length period is -0, and
    // `-0s` in a stylesheet is a value nobody meant to write.
    delay: options.stagger !== false && duration > 0 ? -phase(key) * duration : 0,
  }
}

/**
 * A stable fraction in [0, 1) from a route's key.
 *
 * FNV-1a, which is small, has no state and spreads adjacent keys apart: `s0-1`
 * and `s0-2` must not land on neighbouring phases, or a hub's routes come out
 * looking like a wave rather than like traffic.
 */
function phase(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return ((h >>> 0) % 997) / 997
}
