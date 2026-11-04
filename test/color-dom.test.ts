// @vitest-environment jsdom
/**
 * CSS colours only a browser can read (names, `hsl()`, `var()`), resolved inside
 * the map's element.
 *
 * Before this, each of them parsed to null: a named or hsl ramp collapsed to its
 * first stop, hover left the fill alone, and cluster counts and pattern ink read
 * the colour as black and went white on yellow. jsdom computes names and `hsl()`
 * into `rgb()` like a browser does, but not `var()`, so the `var()` scoping is
 * checked here through a stubbed `getComputedStyle` and in Chromium by hand.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import ApexMaps from '../src/ApexMaps'
import {
  darken,
  mix,
  parseColor,
  readableOn,
  sampleRamp,
  withColorScope,
  clearColorCache,
} from '../src/scales/Color'
import { createScale } from '../src/scales/Scale'
import { patternInk } from '../src/renderers/Paint'
import type { ApexMapsOptions, MarkerDatum } from '../src/types'

const box = (iso: string, x: number) => ({
  type: 'Feature',
  properties: { iso_a3: iso, name: iso },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [x, -20],
        [x, 20],
        [x + 20, 20],
        [x + 20, -20],
        [x, -20],
      ],
    ],
  },
})

const WORLD = {
  type: 'FeatureCollection',
  features: [box('AAA', -80), box('BBB', -50), box('CCC', -20), box('DDD', 10), box('EEE', 40)],
}

const DATA = [
  { code: 'AAA', value: 10 },
  { code: 'BBB', value: 30 },
  { code: 'CCC', value: 50 },
  { code: 'DDD', value: 70 },
  { code: 'EEE', value: 90 },
]

let el: HTMLElement
let map: ApexMaps | null

beforeEach(() => {
  el = document.createElement('div')
  document.body.appendChild(el)
  vi.stubGlobal('requestAnimationFrame', ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame)
  vi.stubGlobal('cancelAnimationFrame', ((id: number) =>
    clearTimeout(id)) as unknown as typeof cancelAnimationFrame)
})

afterEach(() => {
  map?.destroy?.()
  map = null
  el.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function render(options: ApexMapsOptions = {}) {
  map = new ApexMaps(el, {
    chart: { width: 800, height: 500, animations: { enabled: false } },
    geo: { map: WORLD, projection: 'equirectangular' },
    legend: { show: false },
    ...options,
  })
  await map.render()
  return map
}

const fills = () =>
  [...el.querySelectorAll('path.apexmaps-feature')].map((p) => p.getAttribute('fill'))

describe('names and hsl() resolve through the browser', () => {
  it('reads them as the colours they are', () => {
    expect(parseColor('red')).toEqual([255, 0, 0])
    expect(parseColor('hsl(200 80% 40%)')).toEqual([20, 129, 184])
    expect(mix('red', 'blue', 0.5)).toBe(mix('#ff0000', '#0000ff', 0.5))
    expect(darken('red')).toBe(darken('#ff0000'))
  })

  it('picks dark ink on light named colours', () => {
    // Before: luminance 0, so white ink on yellow (about 1.07:1).
    expect(readableOn('yellow')).toBe('#1a1a1a')
    expect(readableOn('hsl(60 100% 90%)')).toBe('#1a1a1a')
    expect(readableOn('navy')).toBe('#ffffff')
    expect(patternInk('lightyellow')).toBe(patternInk('#ffffe0'))
    expect(patternInk('lightyellow')).not.toBe('#ffffff')
  })

  it('a named ramp interpolates, keeping the anchors as written', () => {
    // Before: ['white', 'white', 'white', 'white', 'navy'].
    expect(sampleRamp(['white', 'navy'], 5)).toEqual([
      'white',
      '#b4c4e3',
      '#6e8ac4',
      '#2c50a3',
      'navy',
    ])
  })

  it('a continuous named scale shades every value', () => {
    // Before: 'white' for 10, 50 and 90.
    const s = createScale([10, 50, 90], { type: 'linear', palette: ['white', 'navy'] })
    expect(new Set([10, 50, 90].map((v) => s.color(v))).size).toBe(3)
  })
})

describe('var() resolves inside the map element', () => {
  // jsdom leaves var() unresolved, so stand in for the cascade: `--brand` is only
  // defined inside `el`, the way a token set on the map's container is.
  function stubVar() {
    const real = window.getComputedStyle.bind(window)
    return vi.spyOn(window, 'getComputedStyle').mockImplementation((node, pseudo) => {
      const style = real(node, pseudo)
      if ((node as HTMLElement).style?.color === 'var(--brand)') {
        const color = el.contains(node) ? 'rgb(255, 0, 0)' : style.color
        return { ...style, color } as CSSStyleDeclaration
      }
      return style
    })
  }

  it('in scope it reads the token, out of scope it does not', () => {
    stubVar()
    clearColorCache(el)
    expect(withColorScope(el, () => darken('var(--brand)'))).toBe(darken('#ff0000'))
    expect(darken('var(--brand)')).toBe('var(--brand)')
  })

  it('a var() palette on a map interpolates, and anchors stay live', async () => {
    stubVar()
    await render({
      series: [
        {
          data: DATA,
          joinBy: ['iso_a3', 'code'],
          scale: { type: 'quantile', classes: 3, palette: ['white', 'var(--brand)'] },
        },
      ],
    })
    const f = fills()
    expect(f).toContain('white')
    expect(f).toContain('var(--brand)')
    expect(f.some((c) => /^#[0-9a-f]{6}$/.test(c ?? ''))).toBe(true)
    expect(map!.warnings.filter((w) => w.includes('could not be resolved'))).toEqual([])
  })

  it('warns once about a var() that does not resolve', async () => {
    await render({
      series: [
        {
          data: DATA,
          joinBy: ['iso_a3', 'code'],
          scale: { type: 'linear', palette: ['var(--missing)', 'navy'] },
        },
      ],
    })
    expect(map!.warnings.filter((w) => w.includes('could not be resolved'))).toEqual([
      'colour "var(--missing)" could not be resolved; ramps, hover and label contrast use it as written',
    ])
  })
})

describe('on a rendered map', () => {
  it('a two-stop named linear palette no longer paints every region white', async () => {
    await render({
      series: [
        {
          data: DATA,
          joinBy: ['iso_a3', 'code'],
          scale: { type: 'linear', palette: ['white', 'navy'] },
        },
      ],
    })
    expect(new Set(fills()).size).toBe(5)
    expect(map!.warnings).toEqual([])
  })

  it('hover darkens a named fill', async () => {
    await render({
      series: [
        {
          data: DATA,
          joinBy: ['iso_a3', 'code'],
          scale: { type: 'quantile', classes: 2, palette: ['red', 'blue'] },
        },
      ],
    })
    const path = el.querySelector('path.apexmaps-feature[data-key="AAA"]')!
    expect(path.getAttribute('fill')).toBe('red')
    path.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true }))
    // Before: still 'red', no feedback.
    expect(path.getAttribute('fill')).toBe(darken('#ff0000', 0.08))
  })

  it('hover keeps a translucent fill translucent', async () => {
    // An ordinal palette is used as written, so the fill really is translucent.
    await render({
      series: [
        {
          data: DATA.map((d, i) => ({ ...d, value: i % 2 })),
          joinBy: ['iso_a3', 'code'],
          scale: { type: 'ordinal', palette: ['rgba(255, 0, 0, 0.5)', 'rgba(0, 0, 255, 0.5)'] },
        },
      ],
    })
    const path = el.querySelector('path.apexmaps-feature[data-key="AAA"]')!
    expect(path.getAttribute('fill')).toBe('rgba(255, 0, 0, 0.5)')
    path.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true }))
    // Before: '#e10000', an opaque hover on a see-through fill.
    expect(path.getAttribute('fill')).toBe('rgba(225, 0, 0, 0.5)')
  })

  it('a named light cluster colour gets a dark count', async () => {
    await render({
      series: [
        {
          type: 'marker',
          name: 'Points',
          data: [
            { lon: 0, lat: 0 },
            { lon: 0.4, lat: 0.3 },
            { lon: 0.8, lat: 0.1 },
          ] as MarkerDatum[],
          cluster: { radius: 60, minPoints: 2, color: 'yellow' },
        },
      ],
    })
    const label = el.querySelector('text.apexmaps-mark-label')
    expect(label?.textContent).toBe('3')
    // Before: '#ffffff', white on yellow.
    expect(label?.getAttribute('fill')).toBe('#1a1a1a')
  })
})

describe('colours resolve in the map element after the build', () => {
  // `--pale` is set on the map's container only, like the brand tokens a page puts
  // on a wrapper. jsdom has no cascade for it, so the stub stands in.
  function stubPale() {
    const real = window.getComputedStyle.bind(window)
    return vi.spyOn(window, 'getComputedStyle').mockImplementation((node, pseudo) => {
      const style = real(node, pseudo)
      if ((node as HTMLElement).style?.color === 'var(--pale)') {
        const color = el.contains(node) ? 'rgb(255, 255, 224)' : style.color
        return { ...style, color } as CSSStyleDeclaration
      }
      return style
    })
  }

  // The ink of the dots tile a feature is painted with.
  const inkOf = (key: string) => {
    const fill = el.querySelector(`path.apexmaps-feature[data-key="${key}"]`)!.getAttribute('fill')
    const id = fill?.match(/url\(#([^)]+)\)/)?.[1]
    return id ? el.querySelector(`pattern[id="${id}"] circle`)?.getAttribute('fill') : null
  }

  it('pattern ink on a var() class survives a redraw and a legend toggle', async () => {
    stubPale()
    await render({
      legend: { show: true },
      series: [
        {
          data: DATA,
          joinBy: ['iso_a3', 'code'],
          scale: { type: 'quantile', classes: 2, palette: ['var(--pale)', '#8b0000'] },
          fill: { pattern: { type: 'dots' } },
        },
      ],
    })
    const dark = withColorScope(el, () => patternInk('var(--pale)'))
    expect(dark).not.toBe('#ffffff')
    expect(inkOf('AAA')).toBe(dark)
    const swatch = el.querySelector('.apexmaps-legend-swatch.is-patterned circle')
    expect(swatch?.getAttribute('fill')).toBe(dark)

    // Both repaint outside the draw: before, the ink went white here while the
    // legend swatch kept the dark ink.
    ;(map as unknown as { _drawGeometry(): void })._drawGeometry()
    expect(inkOf('AAA')).toBe(dark)
    ;(map as unknown as { _onLegendToggle(c: number, s: number): void })._onLegendToggle(1, 0)
    expect(inkOf('AAA')).toBe(dark)
  })

  it('a hexbin palette reports a var() it cannot resolve, as a choropleth does', async () => {
    await render({
      series: [
        {
          type: 'hexbin',
          data: [
            { lon: 0, lat: 0, value: 1 },
            { lon: 30, lat: 10, value: 5 },
            { lon: -30, lat: -10, value: 9 },
          ],
          scale: { palette: ['white', 'var(--nope)'] },
        },
      ] as never,
    })
    expect(map!.warnings.filter((w) => w.includes('could not be resolved'))).toEqual([
      'colour "var(--nope)" could not be resolved; ramps, hover and label contrast use it as written',
    ])
  })

  it('a hexbin with a hex palette reports nothing', async () => {
    await render({
      series: [
        {
          type: 'hexbin',
          data: [{ lon: 0, lat: 0, value: 1 }],
          scale: { palette: ['#ffffff', '#08519c'] },
        },
      ] as never,
    })
    expect(map!.warnings.filter((w) => w.includes('could not be resolved'))).toEqual([])
  })
})

describe('paints that are not colours are not reported', () => {
  const points = [
    { lon: 0, lat: 0 },
    { lon: 0.4, lat: 0.3 },
    { lon: 0.8, lat: 0.1 },
  ] as MarkerDatum[]

  it.each(['none', 'url(#grad)'])(
    'a %s marker with no clustering has no warnings',
    async (color) => {
      await render({ series: [{ type: 'marker', name: 'Points', data: points, color }] })
      expect(map!.warnings).toEqual([])
    },
  )

  it('a hollow cluster colour has no warnings', async () => {
    await render({
      series: [
        {
          type: 'marker',
          name: 'Points',
          data: points,
          cluster: { radius: 60, minPoints: 2, color: 'none' },
        },
      ],
    })
    expect(map!.warnings).toEqual([])
  })
})

describe('a map rendered before its element is attached', () => {
  // A detached element computes no style: Chromium answers '' for every colour in
  // it, which the old probe read as "unresolved". jsdom computes regardless, so
  // the stub answers the way the browser does.
  function stubDetached() {
    const real = window.getComputedStyle.bind(window)
    return vi.spyOn(window, 'getComputedStyle').mockImplementation((node, pseudo) => {
      const style = real(node, pseudo)
      return (node as Node).isConnected ? style : ({ ...style, color: '' } as CSSStyleDeclaration)
    })
  }

  it('reads named colours against the document, without warnings', async () => {
    stubDetached()
    el.remove()
    await render({
      series: [
        {
          data: DATA,
          joinBy: ['iso_a3', 'code'],
          scale: { type: 'linear', palette: ['white', 'navy'] },
        },
      ],
    })
    // Before: 2 fills and a warning each for 'white' and 'navy'.
    expect(new Set(fills()).size).toBe(5)
    expect(map!.warnings).toEqual([])
  })

  it('leaves a var() as written, unreported, until a build after attach', async () => {
    stubDetached()
    el.remove()
    await render({
      series: [
        {
          data: DATA,
          joinBy: ['iso_a3', 'code'],
          scale: { type: 'quantile', classes: 2, palette: ['var(--later)', 'navy'] },
        },
      ],
    })
    expect(fills()).toContain('var(--later)')
    expect(map!.warnings).toEqual([])
  })
})
