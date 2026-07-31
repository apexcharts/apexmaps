// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import ApexMaps from '../src/ApexMaps'

/**
 * Pattern and image fills.
 *
 * The interesting assertions are not "a `<pattern>` appeared". They are the three
 * things a paint breaks that a flat fill cannot:
 *
 * 1. The fill is a *reference*, so everything that used to read a colour out of
 *    the `fill` attribute (hover, a drilldown seed) reads a URL instead.
 * 2. The def is a *shared document resource*, so it has to be deduplicated, and
 *    pruned when the data stops asking for it, or a long-lived map leaks `<defs>`.
 * 3. A pattern resolves in the referencing element's user space, which is under
 *    the camera, so texture that is not rescaled grows with the zoom.
 */

const GRID = {
  type: 'FeatureCollection',
  features: [0, 1, 2, 3].map((i) => ({
    type: 'Feature',
    properties: { iso_a3: `A${i}`, name: `Area ${i}` },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [i * 10, 0],
          [i * 10 + 8, 0],
          [i * 10 + 8, 8],
          [i * 10, 8],
          [i * 10, 0],
        ],
      ],
    },
  })),
}

/** One tile per class, for the qualitative case. */
const TILES = ['dots', 'diagonal', 'grid', 'crosshatch', 'lines'] as const

const DATA = [
  { key: 'A0', value: 1 },
  { key: 'A1', value: 2 },
  { key: 'A2', value: 3 },
  { key: 'A3', value: 4 },
]

describe('pattern and image fills', () => {
  let el: HTMLElement

  beforeEach(() => {
    el = document.createElement('div')
    Object.defineProperty(el, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true })
    document.body.appendChild(el)
  })

  afterEach(() => {
    el.remove()
  })

  async function draw(options: Record<string, unknown>) {
    const map = new ApexMaps(el, options as never)
    await map.render()
    return map
  }

  function features() {
    return Array.from(el.querySelectorAll<SVGPathElement>('.apexmaps-feature'))
  }

  /** The map's paints. Legend swatches carry their own tiles; see the last test. */
  function patterns() {
    return Array.from(el.querySelectorAll('.apexmaps-svg > defs > pattern'))
  }

  const withFill = (fill: unknown, scale?: unknown) => ({
    geo: { map: GRID },
    series: [{ type: 'choropleth', data: DATA, fill, ...(scale ? { scale } : {}) }],
  })

  it('leaves an unpatterned map on flat fills', async () => {
    const map = await draw({ geo: { map: GRID }, series: [{ type: 'choropleth', data: DATA }] })
    expect(patterns()).toHaveLength(0)
    expect(features()[0].getAttribute('fill')).toMatch(/^(#|rgb)/)
    map.destroy()
  })

  it('fills features by reference and keeps the flat colour alongside', async () => {
    const map = await draw(withFill({ pattern: { type: 'dots' } }))
    const path = features()[0]
    expect(path.getAttribute('fill')).toMatch(/^url\(#apexmaps-paint-/)
    // The colour the scale chose is still on the element, because hover, the
    // legend and a drilldown seed all need a colour rather than a reference.
    expect(path.getAttribute('data-fill')).toMatch(/^(#|rgb)/)
    expect(path.getAttribute('data-paint')).toBe(path.getAttribute('fill'))
    map.destroy()
  })

  it('shares one def per distinct pattern', async () => {
    // Four features, four classes, one pattern type: four tiles, because the tile
    // background is the class colour.
    const map = await draw(
      withFill({ pattern: { type: 'dots' } }, { type: 'quantile', classes: 4 }),
    )
    expect(patterns()).toHaveLength(4)

    // Same four features with the tile background pinned: one tile, shared.
    map.updateSeries([
      {
        type: 'choropleth',
        data: DATA,
        fill: { pattern: { type: 'dots', background: '#123456' } },
      },
    ] as never)
    expect(patterns()).toHaveLength(1)
    map.destroy()
  })

  it('drops defs the map has stopped referencing', async () => {
    const map = await draw(
      withFill({ pattern: { type: 'dots' } }, { type: 'quantile', classes: 4 }),
    )
    expect(patterns().length).toBeGreaterThan(0)

    map.updateSeries([{ type: 'choropleth', data: DATA }] as never)
    expect(patterns()).toHaveLength(0)
    expect(features()[0].getAttribute('fill')).toMatch(/^(#|rgb)/)
    expect(features()[0].getAttribute('data-paint')).toBeNull()
    map.destroy()
  })

  it('never textures a feature with no data', async () => {
    const map = await draw(withFill({ pattern: { type: 'dots' } }) as never)
    // A3 has data; drop it and the feature has to go back to flat no-data.
    map.updateSeries([
      { type: 'choropleth', data: DATA.slice(0, 3), fill: { pattern: { type: 'dots' } } },
    ] as never)
    const last = features()[3]
    expect(last.getAttribute('fill')).not.toMatch(/^url\(/)
    map.destroy()
  })

  it('takes a pattern per feature', async () => {
    const map = await draw(
      withFill({
        pattern: ({ classIndex }: { classIndex: number }) =>
          classIndex % 2 ? { type: 'lines' } : { type: 'dots' },
      }),
    )
    const types = patterns().map((p) => (p.querySelector('circle') ? 'dots' : 'lines'))
    expect(new Set(types)).toEqual(new Set(['dots', 'lines']))
    map.destroy()
  })

  /*
   * The ink weights are the difference between a patterned map that looks drawn and
   * one that looks clogged, and they are the kind of number a later refactor rounds
   * "harmlessly". Pinned as coverage rather than as literals, so the assertion says
   * what the design decision was: the fill is still the colour, and the tile is a
   * mark on it.
   */
  it('keeps ink to about a tenth of the tile by default', async () => {
    const map = await draw(withFill({ pattern: { type: 'dots' } }))
    const tile = patterns()[0]
    const size = Number(tile.getAttribute('width'))
    expect(size).toBe(10)

    const r = Number(tile.querySelector('circle')!.getAttribute('r'))
    const coverage = (Math.PI * r * r) / (size * size)
    expect(coverage).toBeGreaterThan(0.04)
    expect(coverage).toBeLessThan(0.12)
    map.destroy()
  })

  it('keeps bars to a fifth of their spacing by default', async () => {
    const map = await draw(withFill({ pattern: { type: 'lines' } }))
    const tile = patterns()[0]
    const size = Number(tile.getAttribute('width'))
    const bar = Number(tile.querySelector('rect:last-of-type')!.getAttribute('height'))
    expect(bar / size).toBeCloseTo(0.2, 5)
    map.destroy()
  })

  it('shows the tile at swatch scale, not map scale', async () => {
    // A 10px tile in a 14px swatch is one dot and a crop, and the reader cannot tell
    // dots from squares, which is the one thing the swatch is for.
    const map = await draw(withFill({ pattern: { type: 'dots', size: 20 } }))
    const box = el.querySelector('.apexmaps-legend-swatch.is-patterned svg')!
    const tile = box.querySelector('pattern')!
    const scale = Number(tile.getAttribute('patternTransform')!.match(/scale\(([\d.]+)\)/)![1])
    // Two repeats across the swatch, whatever the authored tile size was.
    expect(20 * scale).toBeCloseTo(Number(box.getAttribute('width')) / 2, 5)
    map.destroy()
  })

  it('holds the tile at its screen size as the camera zooms', async () => {
    const map = await draw(withFill({ pattern: { type: 'dots', size: 8 } }))
    const tile = patterns()[0]
    expect(tile.getAttribute('patternTransform')).toBe('scale(1)')

    map.camera!.set({ k: 4 })
    // A tile a quarter the size in world space is the same size on screen, which
    // is what keeps texture reading as texture rather than as geometry.
    expect(tile.getAttribute('patternTransform')).toBe('scale(0.25)')
    map.destroy()
  })

  it('keeps the author rotation across a camera change', async () => {
    const map = await draw(withFill({ pattern: { type: 'lines', angle: 45 } }))
    expect(patterns()[0].getAttribute('patternTransform')).toBe('rotate(45) scale(1)')
    map.camera!.set({ k: 2 })
    expect(patterns()[0].getAttribute('patternTransform')).toBe('rotate(45) scale(0.5)')
    map.destroy()
  })

  it('pins an image fill to the feature box and does not rescale it', async () => {
    const map = await draw(
      withFill({ image: { src: (context: { key: string }) => `${context.key}.png` } }),
    )
    expect(patterns()).toHaveLength(4)

    const tile = patterns()[0]
    // World space, so the picture stays over the ground it describes: this one is
    // positioned and sized, unlike a texture tile.
    expect(tile.getAttribute('patternUnits')).toBe('userSpaceOnUse')
    expect(Number(tile.getAttribute('width'))).toBeGreaterThan(0)
    expect(tile.getAttribute('patternTransform')).toBeNull()

    const image = tile.querySelector('image')!
    expect(image.getAttribute('href')).toBe('A0.png')
    expect(image.getAttribute('preserveAspectRatio')).toBe('xMidYMid slice')

    map.camera!.set({ k: 4 })
    expect(tile.getAttribute('patternTransform')).toBeNull()
    map.destroy()
  })

  it('leaves a feature flat when its image resolver declines', async () => {
    const map = await draw(
      withFill({
        image: { src: ({ key }: { key: string }) => (key === 'A0' ? null : `${key}.png`) },
      }),
    )
    expect(features()[0].getAttribute('fill')).toMatch(/^(#|rgb)/)
    expect(features()[1].getAttribute('fill')).toMatch(/^url\(/)
    map.destroy()
  })

  /*
   * Cover is computed from the source's real aspect ratio once it is known, because
   * `preserveAspectRatio="slice"` is a request the referencing element does not win
   * against an SVG source: the file's own aspect handling takes precedence per spec,
   * and an SVG flag asked to cover comes out letterboxed with the fill colour around
   * it. jsdom loads nothing, so what is pinned here is the fallback and the geometry
   * of the computation itself.
   */
  it('falls back to the slice attribute while a source is unmeasured', async () => {
    const map = await draw(withFill({ image: { src: 'unmeasurable.png' } }))
    const image = el.querySelector('defs image')!
    expect(image.getAttribute('preserveAspectRatio')).toBe('xMidYMid slice')
    // No computed geometry yet, so the image still fills the tile exactly.
    const tile = patterns()[0]
    expect(image.getAttribute('width')).toBe(tile.getAttribute('width'))
    map.destroy()
  })

  it('computes the cover crop from the source aspect ratio', async () => {
    // jsdom never loads an image, so the probe is stood in for. A wide source in a
    // tall-ish box has to be scaled to the box height and centred horizontally, with
    // the overflow left to the pattern tile and the feature outline to crop.
    const real = window.Image
    class Probe {
      naturalWidth = 200
      naturalHeight = 100
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        this.onload?.()
      }
    }
    ;(window as unknown as { Image: unknown }).Image = Probe
    ;(globalThis as unknown as { Image: unknown }).Image = Probe

    try {
      const map = await draw(withFill({ image: { src: 'wide.png' } }))
      const tile = patterns()[0]
      const image = tile.querySelector('image')!
      const boxW = Number(tile.getAttribute('width'))
      const boxH = Number(tile.getAttribute('height'))

      const w = Number(image.getAttribute('width'))
      const h = Number(image.getAttribute('height'))
      // Aspect preserved, and big enough to cover in both directions.
      expect(w / h).toBeCloseTo(2, 2)
      expect(w).toBeGreaterThanOrEqual(boxW - 0.01)
      expect(h).toBeGreaterThanOrEqual(boxH - 0.01)
      // Centred, so the crop takes equal bites off both sides.
      expect(Number(image.getAttribute('x'))).toBeCloseTo((boxW - w) / 2, 2)
      expect(Number(image.getAttribute('y'))).toBeCloseTo((boxH - h) / 2, 2)
      // Nothing left to negotiate once the box is the source's own ratio.
      expect(image.getAttribute('preserveAspectRatio')).toBe('none')
      map.destroy()
    } finally {
      ;(window as unknown as { Image: unknown }).Image = real
      ;(globalThis as unknown as { Image: unknown }).Image = real
    }
  })

  it('honours the fit', async () => {
    for (const [fit, expected] of [
      ['cover', 'xMidYMid slice'],
      ['contain', 'xMidYMid meet'],
      ['fill', 'none'],
    ] as const) {
      const map = await draw(withFill({ image: { src: 'x.png', fit } }))
      expect(el.querySelector('defs image')!.getAttribute('preserveAspectRatio')).toBe(expected)
      map.destroy()
    }
  })

  it('puts the class tile on the legend swatch', async () => {
    const map = await draw(
      withFill(
        { pattern: ({ classIndex }: { classIndex: number }) => ({ type: TILES[classIndex] }) },
        { type: 'quantile', classes: 4 },
      ),
    )
    const swatches = Array.from(
      el.querySelectorAll<HTMLElement>('.apexmaps-legend-swatch.is-patterned'),
    )
    expect(swatches).toHaveLength(4)
    // Each swatch draws the tile its class is painted with, off the same builder
    // the map uses, rather than a flat colour that says the texture means nothing.
    expect(swatches[0].querySelector('circle')).not.toBeNull() // dots
    expect(swatches[1].querySelector('path')).not.toBeNull() // diagonal
    map.destroy()
  })

  it('leaves the no-data swatch flat', async () => {
    const map = await draw({
      geo: { map: GRID },
      series: [{ type: 'choropleth', data: DATA.slice(0, 3), fill: { pattern: { type: 'dots' } } }],
    })
    const nullSwatch = el.querySelector('.apexmaps-legend-item.is-null .apexmaps-legend-swatch')!
    expect(nullSwatch.classList.contains('is-patterned')).toBe(false)
    map.destroy()
  })

  it('dims a textured feature on hover instead of darkening a URL', async () => {
    const map = await draw(withFill({ pattern: { type: 'dots' } }))
    const path = features()[0]
    const before = path.getAttribute('fill')

    path.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true }))
    expect(path.getAttribute('fill')).toBe(before)
    expect(path.style.filter).toMatch(/^brightness\(/)

    path.dispatchEvent(new window.PointerEvent('pointerout', { bubbles: true }))
    expect(path.style.filter).toBe('')
    expect(path.getAttribute('fill')).toBe(before)
    map.destroy()
  })

  it('carries the paints into an SVG export', async () => {
    const map = await draw(withFill({ pattern: { type: 'crosshatch' } }))
    const markup = map.getSvgString()

    // The def and the reference to it have to travel together: a `url(#id)` fill
    // in a file whose `<defs>` was left behind is an unpainted map.
    const id = features()[0].getAttribute('data-paint')!.slice(5, -1)
    expect(markup).toContain(`id="${id}"`)
    expect(markup).toContain(`url(#${id})`)
    map.destroy()
  })

  it('namespaces def ids per map', async () => {
    const other = document.createElement('div')
    Object.defineProperty(other, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(other, 'clientHeight', { value: 400, configurable: true })
    document.body.appendChild(other)

    const a = await draw(withFill({ pattern: { type: 'dots' } }))
    const b = new ApexMaps(other, withFill({ pattern: { type: 'dots' } }) as never)
    await b.render()

    const idOf = (root: HTMLElement) => root.querySelector('defs pattern')!.getAttribute('id')
    expect(idOf(el)).not.toBe(idOf(other))

    a.destroy()
    b.destroy()
    other.remove()
  })
})
