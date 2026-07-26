import { describe, it, expect } from 'vitest'
import {
  createScale,
  quantileBreaks,
  equalIntervalBreaks,
  jenksBreaks,
  niceDomain,
} from '../src/scales/Scale'
import {
  parseColor,
  toHex,
  mix,
  sampleRamp,
  contrastRatio,
  readableOn,
  rgbToOklab,
  oklabToRgb,
} from '../src/scales/Color'
import { defaultPaletteFor, getPalette } from '../src/scales/Palettes'

describe('Color', () => {
  it('parses hex and rgb forms', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255])
    expect(parseColor('#08519c')).toEqual([8, 81, 156])
    expect(parseColor('rgb(10, 20, 30)')).toEqual([10, 20, 30])
    expect(parseColor('rgba(10,20,30,0.5)')).toEqual([10, 20, 30])
    expect(parseColor('not a color')).toBeNull()
  })

  it('round-trips through OkLab within rounding tolerance', () => {
    for (const hex of ['#000000', '#ffffff', '#08519c', '#fd8d3c', '#4d9221']) {
      const rgb = parseColor(hex as any)
      const back = oklabToRgb(rgbToOklab(rgb))
      expect(toHex(back)).toBe(hex)
    }
  })

  it('interpolates without a muddy midpoint', () => {
    // Straight sRGB averaging of blue and yellow gives a desaturated grey around
    // #808080; OkLab keeps chroma through the midpoint.
    const mid = mix('#0000ff', '#ffff00', 0.5)
    const [r, g, b] = parseColor(mid as any)
    const chroma = Math.max(r, g, b) - Math.min(r, g, b)
    expect(chroma).toBeGreaterThan(40)
  })

  it('samples a ramp to an exact class count', () => {
    const stops = getPalette('blues' as any).stops
    expect(sampleRamp(stops, 5)).toHaveLength(5)
    expect(sampleRamp(stops, 1)).toHaveLength(1)
    expect(sampleRamp(stops, 0)).toHaveLength(0)
  })

  it('picks a readable label colour for both ends of a ramp', () => {
    expect(readableOn('#f7fbff')).toBe('#1a1a1a')
    expect(readableOn('#08306b')).toBe('#ffffff')
  })

  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0)
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
  })
})

describe('breaks', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

  it('computes quantile breaks with populated classes', () => {
    const breaks = quantileBreaks(values, 5)
    expect(breaks).toHaveLength(4)
    for (let i = 1; i < breaks.length; i++) expect(breaks[i]).toBeGreaterThanOrEqual(breaks[i - 1])
  })

  it('computes equal-interval breaks', () => {
    expect(equalIntervalBreaks([0, 100], 4)).toEqual([25, 50, 75])
  })

  it('computes jenks breaks that separate obvious clusters', () => {
    const clustered = [1, 2, 3, 50, 51, 52, 100, 101, 102]
    const { breaks } = jenksBreaks(clustered, 3)
    expect(breaks).toHaveLength(2)
    expect(breaks[0]).toBeGreaterThan(3)
    expect(breaks[1]).toBeGreaterThan(52)
  })

  it('flags sampling for very large inputs', () => {
    const many = Array.from({ length: 5000 }, (_, i) => i)
    const { sampled } = jenksBreaks(many, 5)
    expect(sampled).toBe(true)
  })

  it('rounds domains outward', () => {
    const [lo, hi] = niceDomain([3.2, 96.4])
    expect(lo).toBeLessThanOrEqual(3.2)
    expect(hi).toBeGreaterThanOrEqual(96.4)
  })
})

describe('createScale', () => {
  const values = [1, 5, 10, 20, 50, 80, 95]

  it('defaults to a 5-class quantile scale', () => {
    const scale = createScale(values)
    expect(scale.type).toBe('quantile')
    expect(scale.classes).toBe(5)
    expect(scale.colors).toHaveLength(5)
    expect(scale.breaks).toHaveLength(4)
  })

  it('maps null, undefined and non-numeric to the no-data colour', () => {
    const scale = createScale(values)
    expect(scale.color(null)).toBe(scale.nullColor)
    expect(scale.color(undefined)).toBe(scale.nullColor)
    expect(scale.color('abc')).toBe(scale.nullColor)
    expect(scale.color(NaN)).toBe(scale.nullColor)
  })

  it('keeps no-data out of the classification, not at zero', () => {
    // `Number(null)` is 0, so a coercion-first pass files every feature with no
    // data as a zero. On a map where a third of the areas have data, that puts
    // most of the breaks at zero and publishes classes that contain nothing.
    const sparse = [40, 55, 70, 83, null, undefined, '', null, null, null, null, null]
    const scale = createScale(sparse)

    expect(scale.domain).toEqual([40, 83])
    expect(scale.breaks.every((b) => b >= 40)).toBe(true)
    // Every class boundary distinct: no "0 to 0" entries in the legend.
    const labels = scale.legendItems({}).map((i) => i.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('does not count booleans as values', () => {
    // `Number(false)` is 0 and `Number(true)` is 1, either of which would move the
    // domain of a scale built from a field that turned out to be a flag.
    expect(createScale([10, 20, true, false]).domain).toEqual([10, 20])
  })

  it('never maps a real value to the no-data colour', () => {
    const scale = createScale(values)
    for (const v of values) expect(scale.color(v)).not.toBe(scale.nullColor)
  })

  it('auto-selects a diverging palette when the domain straddles zero', () => {
    expect(defaultPaletteFor([-5, 5])).toBe('rdbu')
    expect(defaultPaletteFor([0, 5])).toBe('blues')
    const scale = createScale([-10, -2, 0, 4, 9])
    expect(scale.paletteName).toBe('rdbu')
  })

  it('warns rather than throwing on an unknown palette', () => {
    const scale = createScale(values, { palette: 'nope' })
    expect(scale.warnings.join(' ')).toContain('unknown palette')
    expect(scale.colors).toHaveLength(5)
  })

  it('produces monotonic class indices', () => {
    const scale = createScale(values)
    let last = -1
    for (const v of [...values].sort((a, b) => a - b)) {
      const i = scale.classIndex(v)
      expect(i).toBeGreaterThanOrEqual(last)
      last = i
    }
  })

  it('builds legend items covering every class plus no-data', () => {
    const scale = createScale(values)
    const items = scale.legendItems({ includeNull: true })
    expect(items).toHaveLength(6)
    expect(items[items.length - 1].isNull).toBe(true)
    expect(items[0].count).toBeGreaterThan(0)
  })

  it('supports a continuous scale with gradient stops', () => {
    const scale = createScale(values, { type: 'linear' })
    expect(scale.continuous).toBe(true)
    expect(scale.gradientStops(8)).toHaveLength(8)
    expect(scale.color(values[0])).not.toBe(scale.color(values[values.length - 1]))
  })

  it('supports explicit thresholds', () => {
    const scale = createScale(values, { type: 'threshold', breaks: [10, 50] })
    expect(scale.breaks).toEqual([10, 50])
    expect(scale.colors).toHaveLength(3)
    expect(scale.classIndex(5)).toBe(0)
    expect(scale.classIndex(10)).toBe(1)
    expect(scale.classIndex(60)).toBe(2)
  })

  it('falls back from threshold to quantile when breaks are missing', () => {
    const scale = createScale(values, { type: 'threshold' })
    expect(scale.warnings.join(' ')).toContain('needs options.breaks')
  })

  it('supports ordinal categories', () => {
    const scale = createScale(['a', 'b', 'a', 'c'], { type: 'ordinal' })
    expect(scale.categories).toEqual(['a', 'b', 'c'])
    expect(scale.color('a')).not.toBe(scale.color('b'))
    expect(scale.color('zzz')).toBe(scale.nullColor)
  })

  it('handles an empty dataset without throwing', () => {
    const scale = createScale([])
    expect(scale.color(1)).toBeTruthy()
    expect(() => scale.legendItems()).not.toThrow()
  })

  it('handles a single-value dataset', () => {
    const scale = createScale([7, 7, 7])
    expect(scale.color(7)).not.toBe(scale.nullColor)
  })
})
