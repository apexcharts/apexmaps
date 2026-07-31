// @vitest-environment jsdom
/**
 * Performance guards.
 *
 * These do not measure milliseconds. A wall-clock assertion in CI is a flake
 * generator: it fails on a loaded runner and passes on a fast one, so it gets
 * marked skip and then the budget is unenforced. Real frame times are measured in
 * a real browser by `examples/bench.html`, where paint and rasterisation actually
 * happen.
 *
 * What is asserted here is the *invariant that makes those numbers possible*:
 * panning and zooming apply one transform to one group and never touch feature
 * geometry. That is deterministic, machine-independent, and it is exactly what a
 * well-meaning refactor would break, which is the failure this file exists to
 * catch. Reprojecting 3,000 features per frame would still pass a generous
 * millisecond budget on a fast laptop and would ruin the product on a real one.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import ApexMaps from '../src/ApexMaps'
import type { ApexMapsOptions } from '../src/types'

/** `count` boxes on a grid, enough features that O(n) per frame would be visible. */
function grid(count: number) {
  const features = []
  const side = Math.ceil(Math.sqrt(count))
  const step = 160 / side
  for (let i = 0; i < count; i++) {
    const lon = -80 + (i % side) * step
    const lat = -40 + Math.floor(i / side) * step
    features.push({
      type: 'Feature',
      properties: { iso_a3: `F${i}`, name: `Feature ${i}` },
      geometry: {
        type: 'Polygon',
        // Clockwise, which is the winding d3-geo treats as "inside is here".
        coordinates: [
          [
            [lon, lat],
            [lon, lat + step * 0.8],
            [lon + step * 0.8, lat + step * 0.8],
            [lon + step * 0.8, lat],
            [lon, lat],
          ],
        ],
      },
    })
  }
  return { type: 'FeatureCollection', features }
}

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
  vi.unstubAllGlobals()
})

async function render(count: number, options: ApexMapsOptions = {}) {
  map = new ApexMaps(el, {
    // Every assertion below is about the renderer's camera invariant: one
    // transform on one group, and no geometry rewrite per frame.
    chart: { width: 800, height: 500, animations: { enabled: false } },
    geo: { map: grid(count), projection: 'equirectangular' },
    legend: { show: false },
    ...options,
  })
  await map.render()
  return map
}

function paths(): SVGPathElement[] {
  return [...el.querySelectorAll<SVGPathElement>('path.apexmaps-feature')]
}

function geometrySnapshot(): string[] {
  return paths().map((p) => p.getAttribute('d') ?? '')
}

/** Attribute writes on SVG elements, so "what does a frame actually touch" is countable. */
function countAttributeWrites(run: () => void): {
  total: number
  byAttribute: Record<string, number>
} {
  const byAttribute: Record<string, number> = {}
  let total = 0
  const original = Element.prototype.setAttribute
  Element.prototype.setAttribute = function patched(name: string, value: string) {
    total++
    byAttribute[name] = (byAttribute[name] ?? 0) + 1
    return original.call(this, name, value)
  }
  try {
    run()
  } finally {
    Element.prototype.setAttribute = original
  }
  return { total, byAttribute }
}

describe('panning and zooming', () => {
  it('never regenerates feature geometry', async () => {
    const instance = await render(400)
    expect(paths()).toHaveLength(400)

    const before = geometrySnapshot()
    instance.camera!.panBy(120, -60)
    instance.camera!.zoomAbout(2.5, [400, 250])
    instance.camera!.panBy(-30, 10)

    expect(geometrySnapshot()).toEqual(before)
  })

  it('moves the world by transforming one group', async () => {
    const instance = await render(400)
    const world = el.querySelector('.apexmaps-world')
    expect(world).toBeTruthy()

    const before = world!.getAttribute('transform')
    instance.camera!.panBy(50, 25)
    expect(world!.getAttribute('transform')).not.toBe(before)
  })

  it('costs the same number of dom writes at 50 features as at 2,000', async () => {
    // The property under test: a camera frame is O(1) in the feature count. If this
    // ever becomes O(n), the p95 frame budget is gone at exactly the feature counts
    // the product promises to handle.
    const small = await render(50)
    const smallWrites = countAttributeWrites(() => small.camera!.panBy(10, 5))
    small.destroy()

    const large = await render(2000)
    expect(paths()).toHaveLength(2000)
    const largeWrites = countAttributeWrites(() => large.camera!.panBy(10, 5))

    expect(smallWrites.total).toBe(largeWrites.total)
    expect(largeWrites.byAttribute.transform).toBe(1)
    expect(largeWrites.byAttribute.d ?? 0).toBe(0)
  })

  it('does regenerate geometry on a projection change, which is the contrast', async () => {
    // Without this, the tests above would also pass on a map that draws nothing.
    const instance = await render(200)
    const before = geometrySnapshot()
    await instance.updateOptions({ geo: { projection: 'orthographic' } })
    expect(geometrySnapshot()).not.toEqual(before)
    expect(geometrySnapshot().filter(Boolean).length).toBeGreaterThan(0)
  })
})

describe('screen-space marks', () => {
  it('reposition per frame, and only they do', async () => {
    // Bubbles hold their pixel radius because the radius encodes a value, so they
    // are the one thing that must be rewritten per frame. The cost is O(bubbles),
    // not O(features), and that is the trade being made.
    const instance = await render(300, {
      series: [
        {
          type: 'bubble',
          name: 'Cities',
          data: Array.from({ length: 12 }, (_, i) => ({
            name: `City ${i}`,
            lon: -60 + i * 10,
            lat: 10,
            value: (i + 1) * 1000,
          })),
        },
      ],
    })

    const writes = countAttributeWrites(() => instance.camera!.panBy(20, 10))
    expect(writes.byAttribute.transform).toBe(1)
    expect(writes.byAttribute.cx).toBe(12)
    expect(writes.byAttribute.cy).toBe(12)
    expect(writes.byAttribute.d ?? 0).toBe(0)
  })
})

describe('label layout', () => {
  it('culls by projected area before doing per-label work', async () => {
    // 900 features on an 800x500 canvas: every label cannot fit, and the ones that
    // are dropped must be dropped cheaply rather than measured and then discarded.
    const instance = await render(900, { dataLabels: { enabled: true } })
    const placed = el.querySelectorAll('.apexmaps-label').length
    expect(placed).toBeGreaterThan(0)
    expect(placed).toBeLessThan(900)

    // Zooming in makes features bigger, so more labels earn their place.
    const zoomed = instance.camera!
    zoomed.zoomAbout(6, [400, 250])
    instance.labels!.layout()
    expect(el.querySelectorAll('.apexmaps-label').length).not.toBe(placed)
  })
})
