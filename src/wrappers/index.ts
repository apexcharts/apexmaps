/**
 * Change detection for the framework wrappers, published as `apexmaps/wrappers`.
 *
 * A caller writes `options={{ geo: { map: 'world' } }}` inline, so a fresh object
 * arrives on every parent render and reference equality is useless: it would
 * report a change every time, redraw the map, and take the tweened transitions and
 * any hover state with it. So the comparison has to be deep, and three of its
 * rules are deliberate rather than obvious.
 *
 * This entry exists for the official wrappers and makes no independent semver
 * promises; nothing here is part of the map API. It lives in the *core* package,
 * as a separate export that costs the main bundle nothing, for two reasons:
 *
 * - The rules below are decisions about the core's semantics rather than about
 *   any framework: geometry is passed by reference, `updateSeries` tweens where
 *   `updateOptions` redraws, an inline formatter is not a change. When the core
 *   changes one of those semantics, the diffing that encodes it changes in the
 *   same commit and ships in the same version, and every wrapper picks it up
 *   through the peer dependency it already has. The first design bundled a copy
 *   into each wrapper, which froze the rules at each wrapper's publish date and
 *   let them drift from the core they describe.
 * - The wrappers cannot all bundle it anyway: ng-packagr requires every source
 *   file under the package's own root, so the Angular wrapper can neither
 *   compile a shared sibling in nor depend on something unpublished.
 *
 * @module wrappers
 */

import type { ApexMapsOptions } from '../types'

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

/**
 * A shallow copy without `series` or `geo.map`, the two things compared separately.
 *
 * Exported because Vue needs it as a *watch source* rather than for comparison. A
 * deep watcher on the options object would traverse whatever `geo.map` holds, and
 * if the caller put a topology in reactive state that is thousands of proxies
 * walked on every check. Watching this instead keeps the deep traversal over the
 * configuration and leaves the geometry to a separate reference watcher, which is
 * the same division `sameOptions` makes.
 */
export function withoutData(options: ApexMapsOptions): Record<string, unknown> {
  const { series: _series, geo, ...rest } = options
  if (!geo) return rest
  const { map: _map, ...restGeo } = geo
  return { ...rest, geo: restGeo }
}

/**
 * A structural copy of the options, for frameworks whose callers mutate state in
 * place rather than replacing it.
 *
 * React always hands over a new object, so keeping a reference to the last applied
 * options is enough to compare against. Vue and Svelte callers write
 * `options.scale.type = 'quantize'` on reactive state, and then the last applied
 * options and the current props are *the same object*: every comparison says
 * nothing changed and the map never updates. So those wrappers keep a snapshot
 * instead of a reference.
 *
 * Two things are kept by reference on purpose. Functions, because cloning one
 * would break `equal`'s source comparison and could detach a formatter from its
 * closure. And `geo.map`, because cloning a topology is the cost this whole module
 * exists to avoid, and because it is compared by identity anyway. Copying it would
 * make every comparison report new geometry, which is the worst of both.
 */
export function snapshotOptions(options: ApexMapsOptions): ApexMapsOptions {
  const copy = clone(withoutData(options)) as ApexMapsOptions
  const map = options.geo?.map
  if (map !== undefined) copy.geo = { ...(copy.geo ?? {}), map }
  return copy
}

/** As above, for a series array. */
export function snapshotSeries<T>(series: T): T {
  return clone(series) as T
}

function clone(value: unknown): unknown {
  if (typeof value === 'function') return value
  if (Array.isArray(value)) return value.map(clone)
  if (value === null || typeof value !== 'object') return value
  // A Date, a RegExp or a class instance is not option data. Copying it key by key
  // would quietly produce a plain object that no longer behaves like the original,
  // so it is passed through and compared by reference.
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) out[key] = clone(entry)
  return out
}
