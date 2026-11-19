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
  rampAt,
  sampleRamp,
  contrastRatio,
  readableOn,
  rgbToOklab,
  oklabToRgb,
  luminance,
} from '../src/scales/Color'
import { defaultPaletteFor, getPalette, listPalettes } from '../src/scales/Palettes'

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

  it('colours ordinal categories from apex by default, without a warning', () => {
    const scale = createScale(['a', 'b', 'c'], { type: 'ordinal' })
    expect(scale.colors).toEqual(['#008FFB', '#00E396', '#FEB019'])
    expect(scale.warnings).toEqual([])
    expect(createScale(['a'], { type: 'ordinal', palette: 'okabeIto' }).warnings).toEqual([])
  })

  it('warns about an unknown ordinal palette, as the numeric scales do', () => {
    // Before: the same apex colours and no warning, while the same typo on a
    // numeric scale already warned.
    const scale = createScale(['a', 'b'], { type: 'ordinal', palette: 'tablaeu' })
    expect(scale.colors).toEqual(['#008FFB', '#00E396'])
    expect(scale.warnings).toEqual(['unknown palette "tablaeu", falling back to "apex"'])
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

/**
 * The diverging ramp chosen for signed data is anchored at zero.
 *
 * The ramp was chosen with that promise, but the colour was spread over the
 * whole domain, so on population change from -8.13% to +1.35% zero landed far
 * into the blue half and a small decline looked like growth. The classes broke
 * by population alone, so one class held both shrinking and growing areas.
 */
describe('automatic diverging scale, anchored at zero', () => {
  const rdbu = getPalette('rdbu')!.stops
  const neutral = rdbu[(rdbu.length - 1) / 2]
  /** Mixed-sign data, mostly negative, the shape of a census change map. */
  const change = [
    -8.13, -7.4, -6.9, -6.2, -5.8, -5.5, -5.1, -4.9, -4.6, -4.4, -4.1, -3.9, -3.7, -3.5, -3.2, -3.0,
    -2.8, -2.6, -2.4, -2.1, -1.9, -1.6, -1.2, -0.9, -0.4, 0.3, 0.8, 1.35,
  ]

  it('colours zero at the ramp midpoint on an asymmetric domain', () => {
    const scale = createScale([-8.13, -3, 1.35], { type: 'linear' })
    expect(scale.paletteName).toBe('rdbu')
    expect(scale.color(0)).toBe(rampAt(rdbu, 0.5))
    expect(scale.color(0)).toBe(neutral)
  })

  it('gives equal magnitudes mirror colours on both sides', () => {
    const scale = createScale([-8.13, -3, 1.35], { type: 'linear' })
    const [lo, hi] = scale.domain
    const extent = Math.max(-lo, hi)
    const d = (0.5 * 8.13) / extent
    expect(scale.color(-8.13)).toBe(rampAt(rdbu, 0.5 - d))
    expect(scale.color(8.13)).toBe(rampAt(rdbu, 0.5 + d))
    // +1.35 is paler than -8.13: further from the midpoint is darker.
    expect(luminance(scale.color(1.35))).toBeGreaterThan(luminance(scale.color(-8.13)))
  })

  it('bends a sqrt scale away from zero on both sides alike', () => {
    const scale = createScale([-8, 2], { type: 'sqrt', nice: false })
    expect(scale.color(0)).toBe(neutral)
    expect(scale.color(-2)).toBe(rampAt(rdbu, 0.5 - 0.5 * Math.sqrt(2 / 8)))
    expect(scale.color(2)).toBe(rampAt(rdbu, 0.5 + 0.5 * Math.sqrt(2 / 8)))
  })

  it('keeps the real domain and shows only the ramp it reaches on the legend bar', () => {
    const scale = createScale([-8, 2], { type: 'linear', nice: false })
    expect(scale.domain).toEqual([-8, 2])
    const stops = scale.gradientStops(11)
    expect(stops[0].color).toBe(scale.color(-8))
    expect(stops[stops.length - 1].color).toBe(scale.color(2))
    // Zero is 80% along a bar running from -8 to 2, and the marker and the
    // gradient agree there: both say neutral.
    expect(scale.position(0)).toBeCloseTo(0.8, 10)
    expect(stops[8].color).toBe(neutral)
    const items = scale.legendItems()
    expect(items.map((i) => i.label)).toEqual(['-8', '2'])
    expect(items[0].color).toBe(scale.color(-8))
    expect(items[1].color).toBe(scale.color(2))
  })

  it('puts a quantile break at zero so no class mixes signs', () => {
    const scale = createScale(change)
    expect(scale.classes).toBe(5)
    expect(scale.breaks).toHaveLength(4)
    expect(scale.breaks).toContain(0)
    for (let c = 0; c < scale.colors.length; c++) {
      const members = change.filter((v) => scale.classIndex(v) === c)
      expect(members.length).toBeGreaterThan(0)
      expect(members.every((v) => v < 0) || members.every((v) => v >= 0)).toBe(true)
    }
  })

  it('draws negatives from the lower half and positives from the upper half', () => {
    const scale = createScale(change)
    const zeroAt = scale.breaks.indexOf(0) + 1
    // Red half below zero, blue half above, never the neutral itself.
    for (const color of scale.colors.slice(0, zeroAt)) {
      expect(parseColor(color)![0]).toBeGreaterThan(parseColor(color)![2])
    }
    for (const color of scale.colors.slice(zeroAt)) {
      expect(parseColor(color)![2]).toBeGreaterThan(parseColor(color)![0])
    }
    expect(scale.colors).not.toContain(neutral)
    // Each side steps out from neutral to its own extreme's place on the
    // symmetric ramp: the decline reaches the ramp's end, and the lone growth
    // class stops where +1.35 sits against -8.13, pale, as on a continuous scale.
    const below = zeroAt
    expect(scale.colors[0]).toBe(rdbu[0])
    expect(scale.colors[zeroAt - 1]).toBe(
      sampleRamp(rdbu, below + 1, { from: 0, to: 0.5 })[below - 1],
    )
    expect(scale.colors[zeroAt]).toBe(
      sampleRamp(rdbu, 2, { from: 0.5, to: 0.5 + (0.5 * 1.35) / 8.13 })[1],
    )
  })

  /** OkLab lightness of a hex colour. */
  const lightness = (color: string) => rgbToOklab(parseColor(color)!)[0]
  /** Symmetric data with no zero in it: -40 to -2 and 2 to 40, in steps of 2. */
  const symmetric = [
    ...Array.from({ length: 20 }, (_, i) => -40 + i * 2),
    ...Array.from({ length: 20 }, (_, i) => 2 + i * 2),
  ]

  it('mirrors the classes on mirrored data', () => {
    const mirrored = [...change.map((v) => -v), ...change]
    const scale = createScale(mirrored, { classes: 6 })
    expect(scale.breaks[2]).toBe(0)
    const n = scale.colors.length
    for (let i = 0; i < n / 2; i++) {
      // Same lightness, opposite hue: a mirror on the ramp.
      const gap = Math.abs(lightness(scale.colors[i]) - lightness(scale.colors[n - 1 - i]))
      expect(gap).toBeLessThan(0.03)
    }
  })

  it('reaches both extremes on balanced data when the class count is odd', () => {
    // Five classes split three and two, three split two and one. A shared step
    // size ran the two-class side out of steps short of its end, so -40 was the
    // darkest red and +40 only a mid blue.
    for (const classes of [5, 3]) {
      const scale = createScale(symmetric, { classes })
      expect(scale.breaks, `${classes}`).toContain(0)
      expect(scale.color(-40), `${classes}`).toBe(rdbu[0])
      expect(scale.color(40), `${classes}`).toBe(rdbu[rdbu.length - 1])
      expect(Math.abs(lightness(scale.color(-40)) - lightness(scale.color(40)))).toBeLessThan(0.03)
    }
    const equal = createScale(symmetric, { type: 'equalInterval', classes: 5 })
    expect(Math.abs(lightness(equal.color(-40)) - lightness(equal.color(40)))).toBeLessThan(0.03)
  })

  it('does not let one extra zero decide which side is darker', () => {
    const plain = createScale(symmetric, { classes: 5 })
    const withZero = createScale([...symmetric, 0], { classes: 5 })
    for (const scale of [plain, withZero]) {
      expect(scale.color(-40)).toBe(rdbu[0])
      expect(scale.color(40)).toBe(rdbu[rdbu.length - 1])
    }
  })

  it('puts exact zeros in the first class above zero without breaks or classes of their own', () => {
    // Six zeros used to count as the positive side's values: it took three
    // classes and two of its breaks were zero too, leaving empty classes.
    const values = [-5, -4, -3, -2, -1, 0, 0, 0, 0, 0, 0, 1, 2]
    const scale = createScale(values)
    expect(scale.breaks.filter((b) => b === 0)).toEqual([0])
    expect(new Set(scale.breaks).size).toBe(scale.breaks.length)
    expect(scale.counts.every((c) => c > 0)).toBe(true)
    expect(scale.warnings.join(' ')).not.toMatch(/empty class/)
    // Zero shares the class of the values just above it.
    expect(scale.classIndex(0)).toBe(scale.classIndex(1))
  })

  it('gives a side no more quantile classes than it has distinct values', () => {
    // Nine negatives but only two distinct ones: by count they would take three
    // of five classes and one would be empty, while the five positives have
    // room for the spare one.
    const values = [-2, -1, -1, -1, -1, -1, -1, -1, -1, 1, 2, 3, 4, 5]
    const scale = createScale(values)
    expect(scale.colors).toHaveLength(5)
    expect(scale.breaks.indexOf(0)).toBe(1)
    expect(scale.counts.every((c) => c > 0)).toBe(true)
  })

  it('puts the break at zero for equal intervals and jenks too', () => {
    for (const type of ['equalInterval', 'quantize', 'jenks', 'naturalBreaks'] as const) {
      const scale = createScale(change, { type })
      expect(scale.breaks, type).toContain(0)
      expect(scale.breaks, type).toHaveLength(4)
    }
  })

  it('leaves a named palette, a domain and explicit breaks alone', () => {
    const named = createScale([-8.13, -3, 1.35], { type: 'linear', palette: 'rdbu', nice: false })
    expect(named.color(0)).toBe(rampAt(rdbu, (0 - -8.13) / (1.35 - -8.13)))
    const domained = createScale([-8.13, -3, 1.35], { type: 'linear', domain: [-10, 2] })
    expect(domained.color(0)).toBe(rampAt(rdbu, 10 / 12))
    expect(domained.domain).toEqual([-10, 2])
    const thresholds = createScale(change, { type: 'threshold', breaks: [-5, -2, 1] })
    expect(thresholds.breaks).toEqual([-5, -2, 1])
    expect(thresholds.colors).toEqual(sampleRamp(rdbu, 4))
    const quantile = createScale(change, { palette: 'rdbu' })
    expect(quantile.breaks).not.toContain(0)
    expect(quantile.colors).toEqual(sampleRamp(rdbu, 5))
  })

  it('leaves a sequential, all-positive scale exactly as before', () => {
    const scale = createScale([1, 5, 10, 20, 50], { type: 'linear', nice: false })
    expect(scale.paletteName).toBe('blues')
    expect(scale.position(1)).toBe(0)
    expect(scale.position(50)).toBe(1)
    expect(scale.breaks).toEqual([])
  })
})

/**
 * A palette named after a colour has to be that colour.
 *
 * `teal` shipped ColorBrewer BuPu's stops, so `palette: 'teal'` rendered maps in
 * purple, and nothing failed: the ramp was a valid sequential ramp, just not the
 * one the name promised. Reading a hex list does not catch that, so the name is
 * checked against the measured hue instead.
 */
describe('palette naming and structure', () => {
  /** Conventional colour-wheel hue in degrees, or null when too grey to have one. */
  function hueOf(hex: string): number | null {
    const rgb = parseColor(hex)
    if (!rgb) return null
    const [r, g, b] = rgb.map((c) => c / 255)
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const d = max - min
    // Below this chroma a hue angle is numerical noise, not a colour.
    if (d < 0.03) return null
    const h =
      max === r
        ? (((g - b) / d) % 6) * 60
        : max === g
          ? ((b - r) / d + 2) * 60
          : ((r - g) / d + 4) * 60
    return (h + 360) % 360
  }

  /** Shortest angular distance, so a red ramp straddling 0 degrees still works. */
  function hueDistance(a: number, b: number): number {
    const d = Math.abs(a - b) % 360
    return d > 180 ? 360 - d : d
  }

  const NAMED: { name: string; centre: number; tolerance: number }[] = [
    { name: 'blues', centre: 208, tolerance: 25 },
    { name: 'greens', centre: 123, tolerance: 30 },
    { name: 'oranges', centre: 24, tolerance: 20 },
    { name: 'reds', centre: 6, tolerance: 25 },
    { name: 'purples', centre: 254, tolerance: 25 },
    { name: 'teal', centre: 178, tolerance: 20 },
  ]

  for (const { name, centre, tolerance } of NAMED) {
    it(`"${name}" renders in the hue its name claims`, () => {
      const palette = getPalette(name)!
      expect(palette).toBeDefined()
      for (const stop of palette.stops) {
        const hue = hueOf(stop)
        if (hue === null) continue
        expect(
          hueDistance(hue, centre),
          `${name} stop ${stop} is at hue ${hue?.toFixed(0)}`,
        ).toBeLessThanOrEqual(tolerance)
      }
    })
  }

  it('keeps teal clear of purple, which is the bug this suite exists for', () => {
    const teal = getPalette('teal')!
    const purpleCentre = 254
    for (const stop of teal.stops) {
      const hue = hueOf(stop)
      if (hue === null) continue
      expect(hueDistance(hue, purpleCentre)).toBeGreaterThan(45)
    }
  })

  it('greys stay achromatic', () => {
    for (const stop of getPalette('greys')!.stops) {
      expect(hueOf(stop)).toBeNull()
    }
  })

  it('every sequential ramp moves monotonically in lightness', () => {
    // The defining property of a sequential ramp, and what lets the single-hue
    // ones claim colourblind safety: order is decodable by lightness alone, so it
    // survives every colour-vision deficiency. Direction is free (viridis and
    // magma run dark to light, the ColorBrewer families light to dark).
    for (const name of listPalettes()) {
      const palette = getPalette(name)!
      if (palette.kind !== 'sequential') continue
      const lums = palette.stops.map((s) => luminance(s))
      const ascending = lums.every((l, i) => i === 0 || l > lums[i - 1])
      const descending = lums.every((l, i) => i === 0 || l < lums[i - 1])
      expect(ascending || descending, `${name} reverses direction in lightness`).toBe(true)
    }
  })

  it('spans enough of the lightness range to separate classes', () => {
    // A ramp crowded into the middle produces five classes a reader cannot tell
    // apart, which is a legible-looking map that says nothing.
    for (const name of listPalettes()) {
      const palette = getPalette(name)!
      if (palette.kind !== 'sequential') continue
      const lums = palette.stops.map((s) => luminance(s))
      expect(Math.max(...lums) - Math.min(...lums), `${name} lightness span`).toBeGreaterThan(0.5)
    }
  })

  it('draws a teal choropleth in teal, after OkLab sampling', () => {
    // The anchors being right is not the claim that matters: the class colours are
    // resampled in OkLab with a light-end inset, and those are what a reader sees.
    const scale = createScale([1, 5, 10, 20, 50, 80, 95], { palette: 'teal', classes: 5 })
    expect(scale.colors).toHaveLength(5)
    for (const color of scale.colors) {
      const hue = hueOf(color)
      expect(hue).not.toBeNull()
      expect(hueDistance(hue!, 178)).toBeLessThanOrEqual(20)
    }
  })
})
