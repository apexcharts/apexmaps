/**
 * Change detection for the React component.
 *
 * A React caller writes `options={{ geo: { map: 'world' } }}` inline, so a fresh
 * object arrives on every parent render and reference equality is useless: it
 * would report a change every time, redraw the map, and take the tweened
 * transitions and any hover state with it. So the comparison has to be deep, and
 * three of its rules are deliberate rather than obvious.
 *
 * @module equal
 */

import type { ApexMapsOptions } from 'apexmaps'

/** Already-compared (a, b) pairs, so a cyclic structure terminates. */
type Pairs = WeakMap<object, WeakSet<object>>

/**
 * Deep equality, with one rule that is not structural: **functions compare by
 * source, not by identity**.
 *
 * Formatters and `tooltip.custom` are written inline, so their identity changes
 * on every render while their behaviour does not. Comparing by identity makes
 * every render a redraw for anyone who uses a formatter, which is most people.
 * Comparing by `toString()` ignores that churn and still notices a genuine edit.
 *
 * The limit is closures: `(v) => v * rate` has the same source whatever `rate`
 * holds, so a formatter that reads changed state through its closure will not be
 * seen. Identity comparison cannot see it either (it sees *every* render as a
 * change, which is not the same as seeing the right one), so this is strictly
 * better, not a new gap. Callers who need it should lift the value into
 * `options` where it is data, or call `updateOptions` through `mapRef`.
 */
export function equal(a: unknown, b: unknown, seen?: Pairs): boolean {
  if (a === b) return true

  if (typeof a === 'function' && typeof b === 'function') {
    return a.toString() === b.toString()
  }

  // NaN is not `===` itself, and `scale.max: NaN` on both sides is not a change.
  if (typeof a === 'number' && typeof b === 'number') {
    return Number.isNaN(a) && Number.isNaN(b)
  }

  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false

  // Pairs rather than nodes: recording that `a` has been visited would make the
  // second appearance of `a` compare equal to whatever it was paired with there,
  // which is wrong when the same object sits at two positions with different
  // counterparts.
  const pairs: Pairs = seen ?? new WeakMap()
  const partners = pairs.get(a)
  if (partners) {
    if (partners.has(b)) return true
    partners.add(b)
  } else {
    pairs.set(a, new WeakSet([b]))
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!equal(a[i], b[i], pairs)) return false
    }
    return true
  }

  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (!equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], pairs)) {
      return false
    }
  }
  return true
}

/**
 * Whether two option trees are the same, ignoring `series`.
 *
 * `series` is excluded because the component routes a series-only change to
 * `updateSeries`, which tweens, rather than to `updateOptions`, which redraws.
 * Folding it in here would erase that distinction.
 *
 * `geo.map` is compared by **identity**, never walked. Object-form geometry is a
 * possibly multi-megabyte topology, and deep-comparing it on every parent render
 * would cost more than the render it is trying to avoid. This is the same call
 * the core makes for the same reason (`buildConfig` passes object geometry
 * through by reference), so the two agree: a caller who wants new geometry
 * recognised passes a new object or a different pack id, and one who rebuilds an
 * identical topology object every render gets a redraw every render. That is
 * visible and fixable, where a deep walk of a topology would just be slow.
 */
export function sameOptions(a: ApexMapsOptions | undefined, b: ApexMapsOptions | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.geo?.map !== b.geo?.map) return false
  return equal(withoutData(a), withoutData(b))
}

/** A shallow copy without the two things compared separately above. */
function withoutData(options: ApexMapsOptions): Record<string, unknown> {
  const { series: _series, geo, ...rest } = options
  if (!geo) return rest
  const { map: _map, ...restGeo } = geo
  return { ...rest, geo: restGeo }
}
