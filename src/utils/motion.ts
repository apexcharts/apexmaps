/**
 * Motion policy.
 *
 * `prefers-reduced-motion` is honoured globally and by default, degrading to
 * instant state changes rather than to broken layouts. The sibling Apex products
 * already behave this way, so ApexMaps inherits the rule rather than inventing a
 * different one (PRODUCT-RESEARCH.md section 8.4).
 *
 * @module utils/motion
 */

/**
 * True when the user has asked for reduced motion, or when there is no window to
 * ask (SSR), where animation is meaningless anyway.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export interface MotionBudget {
  animate: boolean
  properties: 'all' | 'cheap'
  reason?: string
}

/**
 * A motion budget: above a mark threshold, animate only cheap properties
 * (opacity, fill) and skip per-vertex work. Degrading *which* properties animate
 * is preferable to dropping frames, because dropped frames read as a bug while a
 * simpler transition just reads as restraint.
 */
export function motionBudget(
  markCount: number,
  {
    fullBudget = 4000,
    reducedBudget = 40000,
  }: { fullBudget?: number; reducedBudget?: number } = {},
): MotionBudget {
  if (prefersReducedMotion()) {
    return {
      animate: false,
      properties: 'cheap',
      reason: 'prefers-reduced-motion',
    }
  }
  if (markCount <= fullBudget) return { animate: true, properties: 'all' }
  if (markCount <= reducedBudget) {
    return {
      animate: true,
      properties: 'cheap',
      reason: `${markCount} marks exceeds the full motion budget`,
    }
  }
  return {
    animate: false,
    properties: 'cheap',
    reason: `${markCount} marks exceeds the reduced motion budget`,
  }
}
