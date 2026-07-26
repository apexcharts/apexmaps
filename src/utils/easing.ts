/**
 * Easing functions and the motion scale.
 *
 * Durations are tokens rather than magic numbers so motion stays consistent
 * across the ecosystem and can be scaled or disabled wholesale.
 *
 * @module utils/easing
 */

export type EasingFn = (t: number) => number

export const EASINGS: Record<string, EasingFn> = {
  linear: (t) => t,
  quadIn: (t) => t * t,
  quadOut: (t) => t * (2 - t),
  quadInOut: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  cubicIn: (t) => t * t * t,
  cubicOut: (t) => --t * t * t + 1,
  cubicInOut: (t) => (t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1),
  quartOut: (t) => 1 - --t * t * t * t,
  expoOut: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  circOut: (t) => Math.sqrt(1 - --t * t),
  backOut: (t) => {
    const c = 1.70158
    return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2)
  },
  elasticOut: (t) => {
    if (t === 0 || t === 1) return t
    const p = 0.3
    return Math.pow(2, -10 * t) * Math.sin(((t - p / 4) * (2 * Math.PI)) / p) + 1
  },
}

/**
 * The motion scale, in milliseconds.
 *
 * `instant` is for state that must not appear to move (a hover swap during rapid
 * pointer travel); `cinematic` is for narrative camera flights. Anything longer
 * than `deliberate` needs a reason.
 */
export const DURATIONS = {
  instant: 0,
  quick: 150,
  normal: 350,
  deliberate: 800,
  cinematic: 1500,
} as const

export type DurationToken = keyof typeof DURATIONS

export function resolveDuration(
  value: number | string | undefined,
  fallback: number = DURATIONS.normal,
): number {
  if (typeof value === 'number') return Math.max(0, value)
  if (typeof value === 'string') {
    if (value in DURATIONS) return DURATIONS[value as DurationToken]
    const n = Number(value)
    if (!Number.isNaN(n)) return Math.max(0, n)
  }
  return fallback
}

/**
 * Map `chart.animations.speed` onto a multiplier applied to every duration, so
 * one option speeds up or slows down the whole map coherently.
 */
export function speedFactor(speed: string | number | undefined): number {
  if (typeof speed === 'number' && speed > 0) return speed
  switch (speed) {
    case 'slow':
      return 0.6
    case 'fast':
      return 1.6
    case 'instant':
      return Number.POSITIVE_INFINITY
    default:
      return 1
  }
}

export function resolveEase(
  ease: string | EasingFn | undefined,
  fallback = 'cubicInOut',
): EasingFn {
  if (typeof ease === 'function') return ease
  if (typeof ease === 'string' && EASINGS[ease]) return EASINGS[ease]
  return EASINGS[fallback] ?? EASINGS.linear
}
