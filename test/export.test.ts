// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import ApexMaps from '../src/ApexMaps'
import { download } from '../src/export/Exporter'

/**
 * Static export.
 *
 * jsdom computes almost no styles for SVG and cannot rasterize, so these tests
 * pin what is deterministic everywhere: the exported document is standalone
 * (namespaces, size, background), it carries the attribute-driven styling that
 * IS visible to jsdom, the download plumbing fires with the right names, and
 * the PNG path fails loudly rather than hanging where no canvas exists. The
 * styled end-to-end appearance is covered by the export demo page, which
 * `npm run check:examples` loads in real Chromium.
 */

const BOX = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { iso_a3: 'AAA', name: 'Alpha' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [8, 0],
            [8, 8],
            [0, 8],
            [0, 0],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { iso_a3: 'BBB', name: 'Beta' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [10, 0],
            [18, 0],
            [18, 8],
            [10, 8],
            [10, 0],
          ],
        ],
      },
    },
  ],
}

async function renderedMap(el: HTMLElement) {
  const map = new ApexMaps(el, {
    // Explicit numbers: jsdom does no layout, so a fluid chart would fall back
    // to internal defaults and the size assertions would pin the fallback.
    chart: { width: 800, height: 400 },
    geo: { map: BOX as never },
    series: [
      {
        type: 'choropleth',
        data: [
          { key: 'AAA', value: 1 },
          { key: 'BBB', value: 9 },
        ],
      },
    ],
  } as never)
  await map.render()
  return map
}

describe('export', () => {
  let el: HTMLElement

  beforeEach(() => {
    el = document.createElement('div')
    Object.defineProperty(el, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true })
    document.body.appendChild(el)
  })

  afterEach(() => {
    el.remove()
    // A failed assertion must not leak a spy into the next test: vi.spyOn on an
    // already-spied method returns the old spy, calls array and all.
    vi.restoreAllMocks()
  })

  it('getSvgString produces a standalone SVG document', async () => {
    const map = await renderedMap(el)
    const markup = map.getSvgString()

    expect(markup.startsWith('<?xml version="1.0"')).toBe(true)
    expect(markup).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(markup).toContain('xmlns:xlink')
    // The choropleth's scale colours land as fill attributes, which must
    // survive serialization: they are most of what a map export is.
    expect(markup).toMatch(/fill="(#|rgb)/)
    // The live chart's focus affordance means nothing in a file.
    expect(markup).not.toContain('tabindex')

    map.destroy()
  })

  it('the export mirrors the live width and height', async () => {
    const map = await renderedMap(el)
    const markup = map.getSvgString()

    expect(markup).toMatch(/width="800"/)
    expect(markup).toMatch(/height="400"/)

    map.destroy()
  })

  it('a background paints a full-bleed rect first, so everything draws over it', async () => {
    const map = await renderedMap(el)
    const markup = map.getSvgString({ background: '#123456' })

    const rectAt = markup.indexOf('<rect width="100%" height="100%" fill="#123456"')
    const worldAt = markup.indexOf('apexmaps-world')
    expect(rectAt).toBeGreaterThan(-1)
    expect(rectAt).toBeLessThan(worldAt)

    // And absent by default: an SVG export stays transparent like the live chart.
    expect(map.getSvgString()).not.toContain('width="100%"')

    map.destroy()
  })

  it('exporting does not disturb the live chart', async () => {
    const map = await renderedMap(el)
    const before = el.querySelector('svg')!.outerHTML
    map.getSvgString({ background: '#fff' })
    expect(el.querySelector('svg')!.outerHTML).toBe(before)
    map.destroy()
  })

  it('exportSVG downloads under the map-derived filename', async () => {
    const map = await renderedMap(el)
    // The anchor is what click() was invoked on, so the spy's instance list is
    // the cleanest way to capture it.
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    map.exportSVG()

    expect(click).toHaveBeenCalledTimes(1)
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement
    // Inline geometry has no map id, so the neutral default applies.
    expect(anchor.download).toBe('apexmaps.svg')
    // Object URL where the environment has one, data URI where it does not.
    expect(anchor.href).toMatch(/^(blob:|data:image\/svg\+xml)/)

    map.destroy()
  })

  it('exportSVG honours an explicit filename', async () => {
    const map = await renderedMap(el)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    map.exportSVG({ filename: 'quarterly-sales' })

    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement
    expect(anchor.download).toBe('quarterly-sales.svg')

    map.destroy()
  })

  it('exportPNG rejects loudly where no canvas exists, instead of hanging', async () => {
    const map = await renderedMap(el)
    await expect(map.exportPNG()).rejects.toThrow(/canvas 2d context/)
    map.destroy()
  })

  it('export before render fails with instructions, not undefined behaviour', () => {
    const map = new ApexMaps(el, { geo: { map: BOX as never }, series: [] } as never)
    expect(() => map.getSvgString()).toThrow(/render\(\) must complete first/)
  })

  it('export after destroy fails the same way', async () => {
    const map = await renderedMap(el)
    map.destroy()
    expect(() => map.getSvgString()).toThrow(/render\(\) must complete first/)
  })

  it('download() refuses a blob when the environment cannot address one', () => {
    // A blob with no way to reference it must throw, not silently download
    // nothing. Shadowed rather than deleted: deleting jsdom's implementation
    // exposes Node's own up the chain, which rejects jsdom's Blob as being
    // from the wrong realm and turns the test into a test of that.
    const original = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    Object.defineProperty(URL, 'createObjectURL', { value: undefined, configurable: true })
    try {
      expect(() => download(new Blob(['x']), 'x.svg')).toThrow(/cannot create a download URL/)
    } finally {
      if (original) Object.defineProperty(URL, 'createObjectURL', original)
    }
  })
})
