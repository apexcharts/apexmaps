/**
 * Colour maths on CSS colours beyond hex and comma `rgb()`, without a DOM.
 *
 * The helpers used to read only hex and numeric `rgb()`, and silently treated
 * anything else as black (luminance 0) or handed it back untouched (no ramp, no
 * hover). What can be read without a browser is read here; names, `hsl()` and
 * `var()` need the browser and are covered in `color-dom.test.ts`. The first
 * block pins the hex and comma `rgb()` results, which must not move by a digit.
 */

import { describe, it, expect } from 'vitest'
import {
  parseColor,
  parseRgba,
  darken,
  lighten,
  mix,
  sampleRamp,
  rampAt,
  luminance,
  readableOn,
  needsBrowser,
} from '../src/scales/Color'
import { createScale } from '../src/scales/Scale'
import { patternInk } from '../src/renderers/Paint'

describe('hex and comma rgb() keep their exact results', () => {
  // Values recorded from 1.2.1, before any other CSS colour was read.
  it('darken, lighten, mix, sampleRamp and ink', () => {
    expect(darken('#3b82f6')).toBe('#125ccd')
    expect(darken('#3b82f6', 0.35)).toBe('#000880')
    expect(darken('#3b82f6', -0.2)).toBe('#79c3ff')
    expect(lighten('#3b82f6')).toBe('#60a9ff')
    expect(darken('rgb(200,100,50)')).toBe('#a03f00')
    expect(darken('rgba(10,20,30,1)')).toBe('#000105')
    expect([0, 0.25, 0.5, 1].map((t) => mix('#3b82f6', '#000080', t))).toEqual([
      '#3b82f6',
      '#2465d8',
      '#0e49ba',
      '#000080',
    ])
    expect(mix('#ff0000', '#0000ff', 0.5)).toBe('#8c53a2')
    expect(sampleRamp(['#3b82f6', '#000080'], 5, { from: 0.1 })).toEqual([
      '#3276ea',
      '#1e5dcf',
      '#0943b4',
      '#00279a',
      '#000080',
    ])
    expect(sampleRamp(['#ffffff', '#000080'], 5)).toEqual([
      '#ffffff',
      '#b4c4e3',
      '#6e8ac4',
      '#2c50a3',
      '#000080',
    ])
    expect(readableOn('#f4d35e')).toBe('#1a1a1a')
    expect(readableOn('rgba(10,20,30,1)')).toBe('#ffffff')
    expect(patternInk('#f4d35e')).toBe('#856600')
    expect(patternInk('#3b82f6')).toBe('#ffffff')
    expect(luminance('#3b82f6')).toBeCloseTo(0.2354889123162347, 15)
  })

  it('a built-in palette scale samples the same colours', () => {
    const s = createScale([1, 2, 3, 5, 8, 13, 21, 34, 55, 89], { type: 'linear', palette: 'blues' })
    expect(
      s
        .gradientStops()
        .slice(0, 4)
        .map((g) => g.color),
    ).toEqual(['#e3eef9', '#d7e7f5', '#ccdff1', '#bdd7ec'])
    expect(s.warnings).toEqual([])
  })
})

describe('every rgb() syntax', () => {
  it('reads percentages, space separation, slash alpha and none', () => {
    expect(parseColor('rgb(50% 20% 10%)')).toEqual([127.5, 51, 25.5])
    expect(parseColor('rgb(100%, 0%, 0%)')).toEqual([255, 0, 0])
    expect(parseColor('rgb(none 0 255)')).toEqual([0, 0, 255])
    expect(parseRgba('rgb(10 20 30 / 50%)')).toEqual([10, 20, 30, 0.5])
    expect(parseRgba('rgb(10 20 30 / 0.25)')).toEqual([10, 20, 30, 0.25])
    expect(parseRgba('rgba(10,20,30,0.5)')).toEqual([10, 20, 30, 0.5])
    expect(parseRgba('rgb(10, 20, 30)')).toEqual([10, 20, 30, 1])
  })

  it('a percent rgb() ramp interpolates instead of stepping', () => {
    // Before: ['rgb(100% 100% 100%)' x4, 'rgb(0% 0% 50%)'], one class for the map.
    expect(sampleRamp(['rgb(100% 100% 100%)', 'rgb(0% 0% 50%)'], 5)).toEqual([
      'rgb(100% 100% 100%)',
      '#b4c4e3',
      '#6e8ac4',
      '#2c50a3',
      'rgb(0% 0% 50%)',
    ])
  })
})

describe('the forms a browser reports back', () => {
  it('reads oklch(), oklab(), color(srgb) and transparent', () => {
    expect(parseColor('oklch(0.6 0.15 250)')).toEqual(parseColor('oklch(60% 0.15 250deg)'))
    expect(darken('oklch(0.6 0.15 250)')).toBe('#005fad')
    expect(parseColor('oklch(1 0 0)')!.map(Math.round)).toEqual([255, 255, 255])
    expect(parseColor('oklab(0 0 0)')!.map(Math.round)).toEqual([0, 0, 0])
    expect(parseColor('color(srgb 0.5 0 0.5)')).toEqual([127.5, 0, 127.5])
    expect(parseRgba('transparent')).toEqual([0, 0, 0, 0])
    expect(parseColor('oklch(0.6)')).toBeNull()
    expect(parseColor('color(display-p3 1 0 0)')).toBeNull()
  })

  it('a see-through stop is kept as written in ramps rather than ramping from black', () => {
    // 1.2.1 could not read 'transparent' and kept it; reading it as rgba(0, 0, 0, 0)
    // must not turn the low classes of a fade-in ramp near-black.
    expect(sampleRamp(['transparent', '#08519c'], 5)).toEqual([
      'transparent',
      'transparent',
      'transparent',
      'transparent',
      '#08519c',
    ])
    expect(mix('transparent', '#08519c', 0.5)).toBe('transparent')
    expect(rampAt(['transparent', '#08519c'], 0.5)).toBe('transparent')
    expect(sampleRamp(['oklch(0.5 0.1 200 / 0)', '#08519c'], 3)[1]).toBe('oklch(0.5 0.1 200 / 0)')
    const q = createScale([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], {
      type: 'quantile',
      classes: 5,
      palette: ['transparent', '#08519c'],
    })
    expect(q.colors).toEqual([
      'transparent',
      'transparent',
      'transparent',
      'transparent',
      '#08519c',
    ])
    // The comma forms were always read, and ramp from their channels exactly as before.
    expect(sampleRamp(['rgba(0,0,0,0)', '#08519c'], 5)).toEqual([
      '#000000',
      '#000410',
      '#011a39',
      '#033469',
      '#08519c',
    ])
    expect(sampleRamp(['rgba(255,255,255,0)', '#08306b'], 5)).toEqual([
      '#ffffff',
      '#bdc8da',
      '#7e94b5',
      '#436190',
      '#08306b',
    ])
  })

  it('an oklch continuous scale interpolates and its legend follows', () => {
    const s = createScale([10, 50, 90], {
      type: 'linear',
      palette: ['oklch(1 0 0)', 'oklch(0.3 0.15 265)'],
      domain: [0, 100],
    })
    const fills = [10, 50, 90].map((v) => s.color(v))
    expect(new Set(fills).size).toBe(3)
    expect(fills.every((f) => /^#[0-9a-f]{6}$/.test(f))).toBe(true)
    // The legend gradient is not white until its last stop any more.
    const stops = s.gradientStops().map((g) => g.color)
    expect(stops[0]).toBe('oklch(1 0 0)')
    expect(new Set(stops).size).toBe(stops.length)
  })

  it('a stop landing exactly on an anchor keeps it as written', () => {
    expect(mix('oklch(0.6 0.15 250)', '#000000', 0)).toBe('oklch(0.6 0.15 250)')
    expect(rampAt(['oklch(0.6 0.15 250)', '#000000'], 0)).toBe('oklch(0.6 0.15 250)')
  })
})

describe('alpha', () => {
  it('darken keeps a translucent fill translucent', () => {
    // Before: '#d20000' for both, an opaque hover on a see-through fill.
    expect(darken('rgba(255,0,0,0.5)')).toBe('rgba(210, 0, 0, 0.5)')
    expect(darken('#ff000080')).toBe('rgba(210, 0, 0, 0.502)')
    expect(lighten('rgb(10 20 30 / 25%)')).toMatch(/^rgba\(\d+, \d+, \d+, 0\.25\)$/)
  })

  it('darken leaves a fully transparent colour alone', () => {
    expect(darken('transparent')).toBe('transparent')
    expect(darken('#ff000000')).toBe('#ff000000')
  })

  it('pattern ink stays opaque on a translucent background', () => {
    expect(patternInk('rgba(244, 211, 94, 0.5)')).toBe('#856600')
    expect(patternInk('rgba(255, 255, 255, 0)')).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('ramps stay opaque, exactly as before', () => {
    // A translucent comma rgba() stop has always sampled as its opaque colour;
    // changing that would repaint existing maps, so only hover keeps alpha.
    expect(sampleRamp(['rgba(255,0,0,0.5)', '#0000ff'], 3)).toEqual([
      '#ff0000',
      '#8c53a2',
      '#0000ff',
    ])
    expect(mix('rgba(255,0,0,0.5)', '#0000ff', 0.5)).toBe('#8c53a2')
  })

  it('contrast ignores alpha rather than guessing a backdrop', () => {
    expect(readableOn('rgba(255,0,0,0.5)')).toBe(readableOn('#ff0000'))
  })
})

describe('without a DOM (SSR)', () => {
  it('names, hsl() and var() stay unread and every helper keeps the literal', () => {
    for (const c of ['red', 'hsl(0 100% 50%)', 'var(--x)']) {
      expect(needsBrowser(c)).toBe(true)
      expect(parseColor(c)).toBeNull()
      expect(darken(c)).toBe(c)
    }
    expect(needsBrowser('#fff')).toBe(false)
    expect(needsBrowser('oklch(0.6 0.15 250)')).toBe(false)
  })
})
