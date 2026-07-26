/**
 * Parent-child relationships between two levels of geometry.
 *
 * Drilling from states into counties is only a map swap if the child level is
 * also *restricted* to the parent that was clicked. Showing all 3,231 US counties
 * after clicking California is not a drilldown, it is a zoom, and the reader has
 * to find California again themselves.
 *
 * Which counties belong to California is a question about the data, and published
 * hierarchical geometry nearly always answers it in one of two ways:
 *
 * 1. **A property naming the parent.** TIGER counties carry `state_abbr` and
 *    `state_fips`, Eurostat NUTS carries `cntr_code`, Natural Earth admin-1
 *    carries `adm0_a3`. Detecting the field beats asking for it, because the
 *    caller would have to know the internals of a pack they never opened.
 * 2. **A key prefix.** County FIPS `06037` sits under state FIPS `06`, and NUTS
 *    `DE12` under `DE1`, because both code systems are hierarchical by design.
 *
 * Property detection runs first because it is exact: a prefix test can only be
 * as good as the code system, while a property either equals the parent key or
 * does not. Prefix is the fallback, and it is what carries NUTS below level 1,
 * where `cntr_code` stops distinguishing the levels.
 *
 * Both are checked against real features rather than assumed, so a pack that does
 * neither reports that it does neither instead of quietly drawing an empty map.
 *
 * @module data/Hierarchy
 */

import type { DrilldownOptions, NormalizedFeature, NormalizedGeo } from '../types'

/** How a set of child features was matched to its parent. */
export type ScopeMethod = 'property' | 'keyPrefix' | 'all' | 'none'

export interface ScopeResult {
  /** Child geometry restricted to the parent, with feature indices renumbered. */
  geo: NormalizedGeo
  method: ScopeMethod
  /** Property that matched, for `method: 'property'`. */
  field?: string
  count: number
  /** Dev-mode explanation of what was matched and how. */
  note: string
}

/**
 * Find a child property whose value is the parent's key.
 *
 * Scores every candidate by how many children it matches and takes the winner,
 * rather than the first hit: one county whose `name` happens to equal a state
 * abbreviation must not beat the `state_abbr` field that matches all fifty-eight.
 *
 * @returns The field name, or null when no property matches any child.
 */
export function detectParentField(
  features: readonly NormalizedFeature[],
  parentKey: string,
): string | null {
  if (!parentKey) return null

  const counts = new Map<string, number>()
  for (const feature of features) {
    const props = feature.properties
    if (!props) continue
    for (const field in props) {
      const value = props[field]
      if (value == null) continue
      if (String(value) !== parentKey) continue
      counts.set(field, (counts.get(field) ?? 0) + 1)
    }
  }

  let best: string | null = null
  let bestCount = 0
  for (const [field, count] of counts) {
    if (count > bestCount) {
      best = field
      bestCount = count
    }
  }
  return best
}

/**
 * Restrict child geometry to the descendants of one parent key.
 *
 * Returns the whole child level unchanged when `scope: 'all'`, and reports
 * `method: 'none'` when a restriction was wanted but nothing matched, which the
 * caller must treat as a refusal: a drilldown that lands on an empty map is worse
 * than one that does not happen.
 */
export function scopeToParent(
  geo: NormalizedGeo,
  parentKey: string,
  options: Pick<DrilldownOptions, 'scope' | 'parentField'> = {},
): ScopeResult {
  const scope = options.scope ?? 'auto'

  if (scope === 'all') {
    return {
      geo,
      method: 'all',
      count: geo.features.length,
      note: `showing all ${geo.features.length} feature(s) (scope: 'all')`,
    }
  }

  const explicit = options.parentField
  const wantsProperty = scope === 'auto' || scope === 'property'
  const field = wantsProperty ? (explicit ?? detectParentField(geo.features, parentKey)) : undefined

  if (field) {
    const matched = geo.features.filter((f) => String(f.properties?.[field] ?? '') === parentKey)
    if (matched.length) {
      return {
        ...take(geo, matched),
        method: 'property',
        field,
        note: `matched ${matched.length} feature(s) on "${field}" = "${parentKey}"`,
      }
    }
    if (explicit && scope === 'property') {
      return {
        geo: take(geo, []).geo,
        method: 'none',
        field,
        count: 0,
        note: `no feature has "${field}" = "${parentKey}"`,
      }
    }
  }

  if (scope === 'auto' || scope === 'keyPrefix') {
    // Strictly longer, so a child level that also contains the parent itself (a
    // NUTS file holding several levels, say) does not match it as its own child.
    const matched = geo.features.filter(
      (f) => f.key.length > parentKey.length && f.key.startsWith(parentKey),
    )
    if (matched.length) {
      return {
        ...take(geo, matched),
        method: 'keyPrefix',
        note: `matched ${matched.length} feature(s) whose key starts with "${parentKey}"`,
      }
    }
  }

  const tried =
    scope === 'keyPrefix'
      ? 'no key starts with it'
      : 'no property holds that value and no key starts with it'
  return {
    geo: take(geo, []).geo,
    method: 'none',
    count: 0,
    note:
      `no child feature belongs to "${parentKey}": ${tried}. ` +
      "Pass drilldown.parentField, or scope: 'all' to draw the whole child map.",
  }
}

/**
 * A NormalizedGeo holding a subset of features.
 *
 * Indices are renumbered to array positions, because everything downstream treats
 * `feature.index` as a position: it is the DOM key, the anchor map key and the
 * join's feature index. Leaving the parent level's indices in place would point
 * hit-testing at the wrong feature, or at no feature at all.
 */
function take(geo: NormalizedGeo, features: readonly NormalizedFeature[]) {
  const renumbered: NormalizedFeature[] = features.map((f, i) => ({ ...f, index: i }))
  return {
    geo: {
      ...geo,
      features: renumbered,
      collection: {
        type: 'FeatureCollection' as const,
        features: renumbered.map((f) => ({
          type: 'Feature' as const,
          properties: f.properties,
          geometry: f.geometry,
        })),
      },
    } satisfies NormalizedGeo,
    count: renumbered.length,
  }
}
