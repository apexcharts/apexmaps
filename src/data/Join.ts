/**
 * Data-to-geometry joins, and diagnostics for when they fail.
 *
 * Roughly nine in ten real-world map failures are join failures: "Ivory Coast"
 * against "Côte d'Ivoire", ISO-2 against ISO-3, or a FIPS code that lost its
 * leading zero in a spreadsheet round-trip. Every library today renders the
 * unmatched features in no-data grey and says nothing, so the developer spends
 * an hour diffing strings.
 *
 * Design rules (PRODUCT-RESEARCH.md section 6.4 and idea 24):
 *
 * - **Matching is exact by default.** Silent fuzzy matching would trade an
 *   obvious failure for a plausible wrong answer, which is worse.
 * - **Every mismatch is reported, with a suggestion.** Normalisation, a curated
 *   alias table and edit distance are used to explain failures, not to hide them.
 * - **Opt-in `fuzzy: true` applies normalised matches**, and logs exactly what
 *   it did, so the convenience is auditable.
 *
 * @module data/Join
 */

import type { JoinSpec, NormalizedFeature } from '../types'

export interface JoinSuggestion {
  featureKey: string
  name?: string
  /** 0..1, higher is closer. */
  score: number
  reason: 'alias' | 'normalized' | 'padded' | 'similar'
}

export interface UnmatchedRow {
  key: string
  row: unknown
  suggestions: JoinSuggestion[]
}

export interface JoinResult {
  /** Feature key to datum. */
  index: Map<string, unknown>
  /** Feature position to datum, for rendering. */
  byFeatureIndex: Map<number, unknown>
  matched: number
  totalData: number
  totalFeatures: number
  unmatchedData: UnmatchedRow[]
  unmatchedFeatures: { key: string; name?: string }[]
  /**
   * Keys held by more than one feature, and the features holding them.
   *
   * This is a property of published geometry, not a mistake: Natural Earth gives
   * Australia, the Indian Ocean Territories and Ashmore and Cartier Islands the
   * same `iso_a3`, and Lord Howe Island carries `AU-NSW` alongside New South
   * Wales. One data row legitimately colours all of them. It is reported because
   * a developer counting polygons will otherwise wonder why 4 rows lit up 7
   * shapes.
   */
  sharedKeys: { key: string; count: number; names: string[] }[]
  /** Substitutions that were applied, so the convenience stays auditable. */
  applied: string[]
  geoKeyField: string
  dataKeyField: string
  /** Human-readable multi-line diagnostic. */
  report: () => string
}

/**
 * Alias groups. Members of the same group are considered the same place, which
 * lets the diagnostic say "did you mean Côte d'Ivoire?" instead of listing an
 * edit distance. Curated rather than exhaustive: these are the variants that
 * actually appear in published datasets.
 */
const ALIAS_GROUPS = [
  ['ivorycoast', 'cotedivoire', 'republicofcotedivoire'],
  ['unitedstates', 'unitedstatesofamerica', 'usa', 'us', 'america'],
  ['unitedkingdom', 'uk', 'greatbritain', 'britain', 'gb'],
  ['russia', 'russianfederation'],
  ['southkorea', 'korearep', 'republicofkorea', 'korea'],
  ['northkorea', 'koreadem', 'democraticpeoplesrepublicofkorea', 'dprk'],
  ['myanmar', 'burma'],
  ['netherlands', 'holland', 'thenetherlands'],
  ['czechia', 'czechrepublic'],
  ['eswatini', 'swaziland'],
  ['northmacedonia', 'macedonia', 'fyrmacedonia'],
  ['caboverde', 'capeverde'],
  ['timorleste', 'easttimor'],
  ['holysee', 'vatican', 'vaticancity'],
  [
    'democraticrepublicofthecongo',
    'drcongo',
    'drc',
    'congokinshasa',
    'zaire',
    'congodem',
    'demrepcongo',
  ],
  ['republicofthecongo', 'congobrazzaville', 'congorep'],
  ['turkiye', 'turkey'],
  ['laos', 'laopdr', 'laopeoplesdemocraticrepublic'],
  ['syria', 'syrianarabrepublic'],
  ['iran', 'islamicrepublicofiran'],
  ['venezuela', 'bolivarianrepublicofvenezuela'],
  ['tanzania', 'unitedrepublicoftanzania'],
  ['bolivia', 'plurinationalstateofbolivia'],
  ['moldova', 'republicofmoldova'],
  ['brunei', 'bruneidarussalam'],
  ['vietnam', 'socialistrepublicofvietnam', 'vietnamsocrep'],
  ['egypt', 'arabrepublicofegypt'],
  ['gambia', 'thegambia'],
  ['bahamas', 'thebahamas'],
  ['micronesia', 'federatedstatesofmicronesia'],
  ['palestine', 'palestinianterritories', 'statepalestine', 'westbankandgaza'],
  ['bosniaandherzegovina', 'bosnia', 'bosniaherzegovina'],
  ['macau', 'macao'],
  ['southsudan', 'ssudan'],
  ['unitedarabemirates', 'uae'],
  ['centralafricanrepublic', 'car', 'centralafricanrep'],
  ['dominicanrepublic', 'domrep', 'dominicanrep'],
  ['papuanewguinea', 'png'],
  // Natural Earth (and therefore world-atlas, TopoJSON world atlases, and most
  // D3 tutorials) abbreviates long names. These are the exact strings that
  // dataset carries, so a join against ISO-style names fails on them constantly.
  ['westernsahara', 'wsahara'],
  ['equatorialguinea', 'eqguinea'],
  ['solomonislands', 'solomonis'],
  ['falklandislands', 'falklandis', 'malvinas'],
  ['northerncyprus', 'ncyprus'],
  ['southgeorgiaandtheislands', 'sgeorgiaandtheis'],
  ['frenchsouthernandantarcticlands', 'frsantarcticlands'],
  ['saotomeandprincipe', 'saotomeandprincipe', 'stp'],
  ['antiguaandbarbuda', 'antiguaandbarb'],
  ['stvincentandthegrenadines', 'stvincentandthegrenadines', 'stvin'],
  ['trinidadandtobago', 'trinidadandtobago', 'trinandtobago'],
]

const ALIAS_INDEX = new Map<string, number>()
ALIAS_GROUPS.forEach((group, i) => {
  for (const member of group) ALIAS_INDEX.set(member, i)
})

/**
 * Aggressive normalisation used only for suggestions and opt-in fuzzy matching:
 * strip diacritics, lowercase, drop everything that is not alphanumeric.
 *
 */
export function normalizeKey(value: unknown): string {
  if (value == null) return ''
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

/**
 * Levenshtein distance with a two-row buffer.
 *
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length

  let prev = new Array(b.length + 1)
  let curr = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[b.length]
}

/** Similarity in 0..1. */
export function similarity(a: string, b: string): number {
  if (!a && !b) return 1
  const max = Math.max(a.length, b.length)
  if (!max) return 0
  return 1 - levenshtein(a, b) / max
}

/**
 * Detect the zero-padded-numeric-code shape (FIPS, GEOID, some postcodes).
 *
 * Returns the common width when every feature key is a fixed-width numeric
 * string and at least one carries a leading zero. That combination is the
 * signature of a code system that a spreadsheet will happily destroy.
 *
 */
export function detectPaddedNumericWidth(keys: string[]): number | null {
  if (!keys.length) return null
  let width: number | null = null
  let sawLeadingZero = false
  for (const k of keys) {
    if (!/^\d+$/.test(k)) return null
    if (width === null) width = k.length
    else if (width !== k.length) return null
    if (k[0] === '0') sawLeadingZero = true
  }
  return sawLeadingZero ? width : null
}

function readField(row: unknown, field: string): unknown {
  if (row == null) return undefined
  if (field && typeof row === 'object' && field in (row as object)) {
    return (row as Record<string, unknown>)[field]
  }
  return undefined
}

/**
 * Candidate data-key fields, in the order we would guess. Auto-detection is
 * only ever a starting point: the field actually used is reported back.
 */
const DATA_KEY_CANDIDATES = [
  'id',
  'key',
  'code',
  'iso',
  'iso_a3',
  'iso3',
  'iso_a2',
  'iso2',
  'fips',
  'geoid',
  'hc-key',
  'region',
  'state',
  'country',
  'name',
]

/**
 * Resolve which field on the data rows holds the join key.
 *
 */
export function resolveDataKeyField(data: readonly unknown[], explicit?: string): string {
  if (explicit) return explicit
  const sample = data.find((d) => d && typeof d === 'object') as Record<string, unknown> | undefined
  if (!sample) return 'id'
  for (const c of DATA_KEY_CANDIDATES) {
    if (c in sample && sample[c] != null && sample[c] !== '') return c
  }
  // Fall back to the first string-valued field, which is nearly always the label.
  const stringField = Object.keys(sample).find((k) => typeof sample[k] === 'string')
  return stringField || Object.keys(sample)[0] || 'id'
}

/**
 * Join data rows to normalized features.
 *
 */
export function resolveJoin({
  features,
  data,
  joinBy,
  geoKeyField = '',
  fuzzy = false,
  maxSuggestions = 3,
}: {
  features: NormalizedFeature[]
  data: readonly unknown[]
  joinBy?: JoinSpec
  /** Field the geometry keys came from, used in messages. */
  geoKeyField?: string
  /** Apply normalised and alias matches. Default false. */
  fuzzy?: boolean
  maxSuggestions?: number
}): JoinResult {
  const rows = Array.isArray(data) ? data : []

  let geoField: string | undefined
  let dataField: string | undefined
  if (typeof joinBy === 'string') {
    geoField = joinBy
    dataField = joinBy
  } else if (Array.isArray(joinBy)) {
    geoField = joinBy[0]
    dataField = joinBy[1]
  } else if (joinBy && typeof joinBy === 'object') {
    geoField = joinBy.geo
    dataField = joinBy.data
  }

  const dataKeyField = resolveDataKeyField(rows, dataField)

  // Feature keys: honour an explicit geo field, else use the key GeoData resolved.
  //
  // A key maps to a *list*, because published geometry shares keys: Australia's
  // external territories are separate admin-0 features carrying `AUS`. Keeping
  // only the last one would leave mainland Australia in no-data grey while
  // colouring an uninhabited island, silently, which is the failure this module
  // exists to prevent.
  const featureByKey = new Map<string, NormalizedFeature[]>()
  let keyedFeatures = 0
  for (const f of features) {
    const key = geoField ? String(readField(f.properties, geoField) ?? f.key ?? '') : f.key
    if (!key) continue
    const group = featureByKey.get(key)
    if (group) group.push(f)
    else featureByKey.set(key, [f])
    keyedFeatures++
  }

  const featureKeys = [...featureByKey.keys()]
  const paddedWidth = detectPaddedNumericWidth(featureKeys)

  /** Normalised form to canonical feature key. */
  const normalizedFeatureKeys = new Map<string, string>()
  /** Alias group to canonical feature key. */
  const aliasFeatureKeys = new Map<number, string>()
  for (const [key, group] of featureByKey) {
    const nk = normalizeKey(key)
    if (nk && !normalizedFeatureKeys.has(nk)) normalizedFeatureKeys.set(nk, key)
    const nn = normalizeKey(group[0].name)
    if (nn && !normalizedFeatureKeys.has(nn)) normalizedFeatureKeys.set(nn, key)
    for (const candidate of [nk, nn]) {
      const group = ALIAS_INDEX.get(candidate)
      if (group !== undefined && !aliasFeatureKeys.has(group)) aliasFeatureKeys.set(group, key)
    }
  }

  const index = new Map<string, unknown>()
  const byFeatureIndex = new Map<number, unknown>()
  const unmatchedData: UnmatchedRow[] = []
  const applied: string[] = []
  const usedFeatureKeys = new Set<string>()

  for (const row of rows) {
    const rawKey = readField(row, dataKeyField)
    const key = rawKey == null ? '' : String(rawKey)

    let target = featureByKey.get(key)
    let targetKey = key

    // Padded-numeric rescue: "1001" against a set of "01001" keys. Applied even
    // without `fuzzy` because it is a lossless, unambiguous repair of a known
    // spreadsheet defect, and it is always reported.
    if (!target && paddedWidth && /^\d+$/.test(key) && key.length < paddedWidth) {
      const padded = key.padStart(paddedWidth, '0')
      const candidate = featureByKey.get(padded)
      if (candidate) {
        target = candidate
        targetKey = padded
        applied.push(`padded "${key}" to "${padded}"`)
      }
    }

    if (!target && fuzzy) {
      const nk = normalizeKey(key)
      const viaNormalized = normalizedFeatureKeys.get(nk)
      const group = ALIAS_INDEX.get(nk)
      const viaAlias = group !== undefined ? aliasFeatureKeys.get(group) : undefined
      const resolvedKey = viaNormalized || viaAlias
      if (resolvedKey) {
        target = featureByKey.get(resolvedKey)
        targetKey = resolvedKey
        applied.push(`matched "${key}" to "${resolvedKey}"`)
      }
    }

    if (target) {
      index.set(targetKey, row)
      // Every feature sharing the key gets the datum.
      for (const f of target) byFeatureIndex.set(f.index, row)
      usedFeatureKeys.add(targetKey)
    } else {
      unmatchedData.push({
        key,
        row,
        suggestions: suggestFor(key, {
          featureByKey,
          normalizedFeatureKeys,
          aliasFeatureKeys,
          paddedWidth,
          maxSuggestions,
        }),
      })
    }
  }

  // One entry per feature, not per key, so matched + unmatched reconciles with
  // the feature count a developer sees on screen.
  const unmatchedFeatures: { key: string; name?: string }[] = []
  const sharedKeys: { key: string; count: number; names: string[] }[] = []
  for (const [key, group] of featureByKey) {
    if (!usedFeatureKeys.has(key)) {
      for (const f of group) unmatchedFeatures.push({ key, name: f.name })
    }
    if (group.length > 1) {
      sharedKeys.push({
        key,
        count: group.length,
        names: group.map((f) => f.name ?? f.key).filter(Boolean) as string[],
      })
    }
  }

  const result: JoinResult = {
    index,
    byFeatureIndex,
    matched: byFeatureIndex.size,
    totalData: rows.length,
    totalFeatures: keyedFeatures,
    unmatchedData,
    unmatchedFeatures,
    sharedKeys,
    applied,
    geoKeyField: geoField || geoKeyField,
    dataKeyField,
    report: () => formatReport(result),
  }
  return result
}

/**
 */
function suggestFor(
  key: string,
  {
    featureByKey,
    normalizedFeatureKeys,
    aliasFeatureKeys,
    paddedWidth,
    maxSuggestions,
  }: {
    featureByKey: Map<string, NormalizedFeature[]>
    normalizedFeatureKeys: Map<string, string>
    aliasFeatureKeys: Map<number, string>
    paddedWidth: number | null
    maxSuggestions: number
  },
): JoinSuggestion[] {
  const out: JoinSuggestion[] = []
  const nk = normalizeKey(key)
  if (!key) return out

  const group = ALIAS_INDEX.get(nk)
  if (group !== undefined) {
    const featureKey = aliasFeatureKeys.get(group)
    if (featureKey) {
      out.push({
        featureKey,
        name: featureByKey.get(featureKey)?.[0]?.name,
        score: 1,
        reason: 'alias',
      })
    }
  }

  const exactNormalized = normalizedFeatureKeys.get(nk)
  if (exactNormalized && !out.some((s) => s.featureKey === exactNormalized)) {
    out.push({
      featureKey: exactNormalized,
      name: featureByKey.get(exactNormalized)?.[0]?.name,
      score: 0.99,
      reason: 'normalized',
    })
  }

  if (paddedWidth && /^\d+$/.test(key) && key.length < paddedWidth) {
    const padded = key.padStart(paddedWidth, '0')
    if (featureByKey.has(padded) && !out.some((s) => s.featureKey === padded)) {
      out.push({
        featureKey: padded,
        name: featureByKey.get(padded)?.[0]?.name,
        score: 0.98,
        reason: 'padded',
      })
    }
  }

  if (out.length < maxSuggestions && nk) {
    const scored: JoinSuggestion[] = []
    for (const [normalized, featureKey] of normalizedFeatureKeys) {
      // Cheap length prefilter: edit distance cannot beat the threshold when the
      // lengths differ by more than the allowed error.
      if (Math.abs(normalized.length - nk.length) > 4) continue
      const score = similarity(nk, normalized)
      if (score >= 0.62) {
        scored.push({
          featureKey,
          name: featureByKey.get(featureKey)?.[0]?.name,
          score,
          reason: 'similar',
        })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    for (const s of scored) {
      if (out.length >= maxSuggestions) break
      if (!out.some((existing) => existing.featureKey === s.featureKey)) out.push(s)
    }
  }

  return out.slice(0, maxSuggestions)
}

/**
 * Format the diagnostic a developer actually reads.
 *
 */
function formatReport(r: JoinResult): string {
  const lines: string[] = []
  const okData = r.totalData - r.unmatchedData.length

  lines.push(
    `join: ${okData}/${r.totalData} data rows matched ${r.matched}/${r.totalFeatures} features ` +
      `(geometry key "${r.geoKeyField || 'auto'}", data key "${r.dataKeyField}")`,
  )

  if (r.applied.length) {
    lines.push(`  applied ${r.applied.length} repair(s):`)
    for (const a of r.applied.slice(0, 5)) lines.push(`    ${a}`)
    if (r.applied.length > 5) lines.push(`    +${r.applied.length - 5} more`)
  }

  if (r.sharedKeys.length) {
    const preview = r.sharedKeys
      .slice(0, 3)
      .map((s) => `"${s.key}" (${s.names.join(', ')})`)
      .join('; ')
    lines.push(
      `  ${r.sharedKeys.length} key(s) are shared by several features, so one row colours several shapes: ${preview}` +
        (r.sharedKeys.length > 3 ? `, +${r.sharedKeys.length - 3} more` : ''),
    )
  }

  if (r.unmatchedData.length) {
    lines.push(`  ${r.unmatchedData.length} data row(s) did not match geometry:`)
    for (const u of r.unmatchedData.slice(0, 10)) {
      const hint = u.suggestions.length
        ? ` -> did you mean ${u.suggestions
            .map((s) => `"${s.featureKey}"${s.name ? ` (${s.name})` : ''}`)
            .join(' or ')}?`
        : ' -> no similar geometry key found'
      lines.push(`    "${u.key}"${hint}`)
    }
    if (r.unmatchedData.length > 10) lines.push(`    +${r.unmatchedData.length - 10} more`)
  }

  if (r.unmatchedFeatures.length) {
    const preview = r.unmatchedFeatures
      .slice(0, 10)
      .map((f) => f.key)
      .join(', ')
    lines.push(
      `  ${r.unmatchedFeatures.length} feature(s) had no data (rendered as no-data): ${preview}` +
        (r.unmatchedFeatures.length > 10 ? `, +${r.unmatchedFeatures.length - 10} more` : ''),
    )
  }

  if (!r.unmatchedData.length && !r.unmatchedFeatures.length) {
    lines.push('  clean join: every data row matched a feature and every feature has data')
  }

  return lines.join('\n')
}
