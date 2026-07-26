import { describe, it, expect } from 'vitest'
import {
  resolveJoin,
  normalizeKey,
  levenshtein,
  similarity,
  detectPaddedNumericWidth,
  resolveDataKeyField,
} from '../src/data/Join'

/**
 */
function features(pairs) {
  return pairs.map(([key, name], index) => ({
    key,
    name,
    geometry: { type: 'Polygon', coordinates: [] },
    properties: { iso_a3: key, name },
    index,
    raw: {},
  }))
}

describe('normalizeKey', () => {
  it('strips diacritics, case and punctuation', () => {
    expect(normalizeKey("Côte d'Ivoire")).toBe('cotedivoire')
    expect(normalizeKey('UNITED-STATES')).toBe('unitedstates')
    expect(normalizeKey('  Türkiye  ')).toBe('turkiye')
  })

  it('handles nullish input', () => {
    expect(normalizeKey(null)).toBe('')
    expect(normalizeKey(undefined)).toBe('')
  })
})

describe('levenshtein and similarity', () => {
  it('measures edit distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('same', 'same')).toBe(0)
    expect(levenshtein('', 'abc')).toBe(3)
  })

  it('normalises similarity to 0..1', () => {
    expect(similarity('abc', 'abc')).toBe(1)
    expect(similarity('abc', 'xyz')).toBe(0)
    expect(similarity('france', 'frnace')).toBeGreaterThan(0.6)
  })
})

describe('detectPaddedNumericWidth', () => {
  it('detects fixed-width zero-padded codes', () => {
    expect(detectPaddedNumericWidth(['01001', '01003', '13121'])).toBe(5)
  })

  it('returns null when no leading zeros exist', () => {
    expect(detectPaddedNumericWidth(['13121', '48201'])).toBeNull()
  })

  it('returns null for mixed widths or non-numeric keys', () => {
    expect(detectPaddedNumericWidth(['01001', '1003'])).toBeNull()
    expect(detectPaddedNumericWidth(['FRA', 'DEU'])).toBeNull()
  })
})

describe('resolveDataKeyField', () => {
  it('prefers explicit over detected', () => {
    expect(resolveDataKeyField([{ id: 'a', code: 'b' }], 'code')).toBe('code')
  })

  it('detects the conventional key field', () => {
    expect(resolveDataKeyField([{ code: 'FRA', value: 1 }])).toBe('code')
    expect(resolveDataKeyField([{ country: 'France', value: 1 }])).toBe('country')
  })

  it('falls back to the first string field', () => {
    expect(resolveDataKeyField([{ label: 'France', value: 1 }])).toBe('label')
  })
})

describe('resolveJoin with keys shared by several features', () => {
  // Published geometry does this on purpose: Natural Earth gives Australia, the
  // Indian Ocean Territories and Ashmore and Cartier Islands the same iso_a3.
  const shared = features([
    ['AUS', 'Australia'],
    ['AUS', 'Indian Ocean Ter.'],
    ['AUS', 'Ashmore and Cartier Is.'],
    ['NZL', 'New Zealand'],
  ])

  it('applies one row to every feature holding the key', () => {
    const result = resolveJoin({
      features: shared,
      data: [{ code: 'AUS', value: 5 }],
      joinBy: ['iso_a3', 'code'],
    })
    expect(result.byFeatureIndex.get(0)).toEqual({ code: 'AUS', value: 5 })
    expect(result.byFeatureIndex.get(1)).toEqual({ code: 'AUS', value: 5 })
    expect(result.byFeatureIndex.get(2)).toEqual({ code: 'AUS', value: 5 })
    expect(result.byFeatureIndex.has(3)).toBe(false)
  })

  it('counts features, not keys, so the totals reconcile with the screen', () => {
    const result = resolveJoin({
      features: shared,
      data: [{ code: 'AUS', value: 5 }],
      joinBy: ['iso_a3', 'code'],
    })
    expect(result.totalFeatures).toBe(4)
    expect(result.matched).toBe(3)
    expect(result.matched + result.unmatchedFeatures.length).toBe(result.totalFeatures)
  })

  it('lists every unmatched feature, not one per key', () => {
    const result = resolveJoin({
      features: shared,
      data: [{ code: 'NZL', value: 1 }],
      joinBy: ['iso_a3', 'code'],
    })
    expect(result.unmatchedFeatures.map((f) => f.name).sort()).toEqual([
      'Ashmore and Cartier Is.',
      'Australia',
      'Indian Ocean Ter.',
    ])
  })

  it('reports the sharing, because 1 row lighting up 3 shapes needs explaining', () => {
    const result = resolveJoin({
      features: shared,
      data: [{ code: 'AUS', value: 5 }],
      joinBy: ['iso_a3', 'code'],
    })
    expect(result.sharedKeys).toHaveLength(1)
    expect(result.sharedKeys[0]).toMatchObject({ key: 'AUS', count: 3 })
    expect(result.report()).toContain('shared by several features')
  })

  it('says nothing when every key is unique', () => {
    const result = resolveJoin({
      features: features([
        ['FRA', 'France'],
        ['DEU', 'Germany'],
      ]),
      data: [{ code: 'FRA', value: 1 }],
      joinBy: ['iso_a3', 'code'],
    })
    expect(result.sharedKeys).toHaveLength(0)
    expect(result.report()).not.toContain('shared by several features')
  })
})

describe('resolveJoin', () => {
  const geoFeatures = features([
    ['FRA', 'France'],
    ['DEU', 'Germany'],
    ['CIV', "Côte d'Ivoire"],
  ])

  it('matches exactly and reports a clean join', () => {
    const result = resolveJoin({
      features: geoFeatures,
      data: [
        { code: 'FRA', value: 1 },
        { code: 'DEU', value: 2 },
        { code: 'CIV', value: 3 },
      ],
      joinBy: ['iso_a3', 'code'],
    })

    expect(result.matched).toBe(3)
    expect(result.unmatchedData).toHaveLength(0)
    expect(result.unmatchedFeatures).toHaveLength(0)
    expect(result.report()).toContain('clean join')
  })

  it('does NOT fuzzy match by default', () => {
    const result = resolveJoin({
      features: geoFeatures,
      data: [{ code: 'Ivory Coast', value: 3 }],
      joinBy: ['iso_a3', 'code'],
    })

    expect(result.matched).toBe(0)
    expect(result.unmatchedData).toHaveLength(1)
  })

  it('suggests the alias for a failed name match', () => {
    const result = resolveJoin({
      features: geoFeatures,
      data: [{ code: 'Ivory Coast', value: 3 }],
      joinBy: ['iso_a3', 'code'],
    })

    const suggestions = result.unmatchedData[0].suggestions
    expect(suggestions.length).toBeGreaterThan(0)
    expect(suggestions[0].featureKey).toBe('CIV')
    expect(suggestions[0].reason).toBe('alias')
    expect(result.report()).toContain('did you mean')
  })

  it('applies alias matches when fuzzy is enabled, and records what it did', () => {
    const result = resolveJoin({
      features: geoFeatures,
      data: [{ code: 'Ivory Coast', value: 3 }],
      joinBy: ['iso_a3', 'code'],
      fuzzy: true,
    })

    expect(result.matched).toBe(1)
    expect(result.applied).toHaveLength(1)
    expect(result.applied[0]).toContain('Ivory Coast')
  })

  it('matches a normalized name when fuzzy is enabled', () => {
    const result = resolveJoin({
      features: geoFeatures,
      data: [{ code: 'france', value: 9 }],
      joinBy: ['iso_a3', 'code'],
      fuzzy: true,
    })
    expect(result.matched).toBe(1)
    expect(result.index.get('FRA')).toEqual({ code: 'france', value: 9 })
  })

  it('repairs a FIPS code that lost its leading zero, without fuzzy', () => {
    const counties = features([
      ['01001', 'Autauga'],
      ['01003', 'Baldwin'],
      ['13121', 'Fulton'],
    ])

    const result = resolveJoin({
      features: counties,
      data: [
        { code: 1001, value: 5 },
        { code: '13121', value: 7 },
      ],
      joinBy: ['iso_a3', 'code'],
    })

    expect(result.matched).toBe(2)
    expect(result.applied[0]).toContain('padded "1001" to "01001"')
  })

  it('reports features that received no data', () => {
    const result = resolveJoin({
      features: geoFeatures,
      data: [{ code: 'FRA', value: 1 }],
      joinBy: ['iso_a3', 'code'],
    })

    expect(result.unmatchedFeatures.map((f) => f.key).sort()).toEqual(['CIV', 'DEU'])
    expect(result.report()).toContain('no data')
  })

  it('exposes byFeatureIndex for rendering', () => {
    const result = resolveJoin({
      features: geoFeatures,
      data: [{ code: 'DEU', value: 42 }],
      joinBy: ['iso_a3', 'code'],
    })
    expect(result.byFeatureIndex.get(1)).toEqual({ code: 'DEU', value: 42 })
    expect(result.byFeatureIndex.has(0)).toBe(false)
  })

  it('handles empty data without throwing', () => {
    const result = resolveJoin({ features: geoFeatures, data: [] })
    expect(result.matched).toBe(0)
    expect(result.totalFeatures).toBe(3)
    expect(result.unmatchedFeatures).toHaveLength(3)
  })
})
