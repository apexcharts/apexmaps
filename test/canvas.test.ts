// @vitest-environment jsdom
/**
 * The Canvas tier: selection, fallback, and its own performance invariant.
 *
 * jsdom has no canvas implementation, which this file uses in both directions.
 * Unstubbed, it is the honest test of the fallback path: `getContext` fails, the
 * tier declines, and the map renders SVG rather than nothing. Stubbed with a
 * recording 2D context and a counting `Path2D`, it becomes a test bench for the
 * bookkeeping that decides whether the tier is fast, which is what the
 * 2026-07-26 perf decision demanded when it noted that a renderer repainting per
 * frame "needs its own guard".
 *
 * That guard is not a millisecond assertion, for the same reason the SVG one is
 * not: it asserts the property that makes the numbers possible.
 *
 * > A camera frame never projects geometry and never builds a `Path2D`.
 *
 * Real painting, real hit testing and real frame cost are verified in Chromium,
 * since a stub context cannot rasterise and jsdom cannot hit-test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import ApexMaps from '../src/ApexMaps'
import { RendererController } from '../src/renderers/RendererController'
import { CanvasRenderer } from '../src/renderers/CanvasRenderer'
import { DEFAULT_RENDERER_THRESHOLD, geometryMarkCount } from '../src/renderers/Renderer'
import type { ApexMapsOptions } from '../src/types'

/** `count` boxes on a grid, the same fixture shape the SVG perf guard uses. */
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

/** Calls a repaint issues, so the per-frame contract is countable. */
interface Recorder {
  setTransform: number
  clearRect: number
  fill: number
  stroke: number
  pathBuilds: number
  addPath: number
}

let recorder: Recorder
let el: HTMLElement
let map: ApexMaps | null

/**
 * Install a 2D context and a `Path2D` that record rather than rasterise.
 *
 * Everything the renderer touches has to exist, because a missing member throws
 * and would look like a fallback rather than a bug.
 */
function stubCanvas(): void {
  recorder = { setTransform: 0, clearRect: 0, fill: 0, stroke: 0, pathBuilds: 0, addPath: 0 }

  class FakePath2D {
    readonly added: unknown[] = []
    constructor(readonly d?: string) {
      recorder.pathBuilds++
    }
    /** The tier merges a colour bucket's features into one path to paint it. */
    addPath(path: unknown) {
      this.added.push(path)
      recorder.addPath++
    }
  }
  vi.stubGlobal('Path2D', FakePath2D as unknown as typeof Path2D)

  const context = {
    setTransform: () => void recorder.setTransform++,
    clearRect: () => void recorder.clearRect++,
    fillRect: () => {},
    fill: () => void recorder.fill++,
    stroke: () => void recorder.stroke++,
    setLineDash: () => {},
    // Hit testing needs a decision; the exact answer is Chromium's job. Saying
    // "yes" here would fake hits the geometry does not support, so it says no
    // and the jsdom tests assert only what does not depend on it.
    isPointInPath: () => false,
    isPointInStroke: () => false,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    globalAlpha: 1,
  }

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => context as unknown as CanvasRenderingContext2D,
  )
}

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
  vi.restoreAllMocks()
})

async function render(count: number, options: ApexMapsOptions = {}) {
  map = new ApexMaps(el, {
    chart: { width: 800, height: 500, animations: { enabled: false } },
    geo: { map: grid(count) as never, projection: 'equirectangular' },
    legend: { show: false },
    debug: { enabled: false },
    ...options,
  })
  await map.render()
  return map
}

// --- selection, with no canvas involved -------------------------------------

describe('renderer selection', () => {
  it('counts features and path marks, and nothing else', () => {
    // Bubbles and markers stay SVG in both tiers, so they must not promote a map:
    // that would move the cheap half and leave the expensive half behind.
    expect(geometryMarkCount({ featureCount: 3000, pathMarkCount: 200 })).toBe(3200)
    expect(geometryMarkCount({ featureCount: 0, pathMarkCount: 0 })).toBe(0)
  })

  it("stays on svg under the threshold and promotes at it for 'auto'", () => {
    const at = (featureCount: number) =>
      RendererController.desiredKind({ mode: 'auto', featureCount, pathMarkCount: 0 })
    expect(at(DEFAULT_RENDERER_THRESHOLD - 1)).toBe('svg')
    expect(at(DEFAULT_RENDERER_THRESHOLD)).toBe('canvas')
  })

  it('leaves every shipped pack on svg by default', () => {
    // us/counties is the largest pack in the registry at 3,231 features, and SVG
    // measures 3.1 ms p95 there against a 16 ms budget. Promoting it would swap
    // 3,231 elements a caller may be targeting for one canvas, which is a
    // breaking change rather than an optimisation.
    expect(
      RendererController.desiredKind({ mode: 'auto', featureCount: 3231, pathMarkCount: 0 }),
    ).toBe('svg')
  })

  it('honours an explicit threshold', () => {
    expect(
      RendererController.desiredKind({
        mode: 'auto',
        threshold: 100,
        featureCount: 120,
        pathMarkCount: 0,
      }),
    ).toBe('canvas')
  })

  it("'svg' pins svg however large the map is", () => {
    expect(
      RendererController.desiredKind({ mode: 'svg', featureCount: 500_000, pathMarkCount: 0 }),
    ).toBe('svg')
  })

  it("'canvas' asks for canvas at any size", () => {
    expect(
      RendererController.desiredKind({ mode: 'canvas', featureCount: 1, pathMarkCount: 0 }),
    ).toBe('canvas')
  })

  it("'webgl' resolves to the fastest tier that exists, and says so", () => {
    const selection = RendererController.resolve({
      mode: 'webgl',
      featureCount: 10,
      pathMarkCount: 0,
    })
    expect(selection.kind).toBe('canvas')
    expect(selection.warning).toMatch(/'webgl' is not built yet/)
  })

  it('falls back with a warning when an explicitly asked tier is not registered', () => {
    RendererController.unregisterRenderer('canvas')
    try {
      const explicit = RendererController.resolve({
        mode: 'canvas',
        featureCount: 10,
        pathMarkCount: 0,
      })
      expect(explicit.kind).toBe('svg')
      expect(explicit.warning).toMatch(/not bundled/)

      // `'auto'` merely preferred canvas, so nobody has been let down and it
      // stays quiet.
      const auto = RendererController.resolve({
        mode: 'auto',
        featureCount: 999_999,
        pathMarkCount: 0,
      })
      expect(auto.kind).toBe('svg')
      expect(auto.warning).toBeUndefined()
    } finally {
      RendererController.registerRenderer(
        'canvas',
        ({ viewport }) => new CanvasRenderer({ viewport }),
      )
    }
  })

  it("explains itself when 'auto' promotes", () => {
    const selection = RendererController.resolve({
      mode: 'auto',
      threshold: 10,
      featureCount: 50,
      pathMarkCount: 0,
    })
    expect(selection.note).toMatch(/selected canvas: 50 geometry marks/)
  })
})

// --- the fallback path, using jsdom's real lack of a canvas -----------------

describe('fallback when no 2D context exists', () => {
  it('renders SVG and says why, rather than rendering nothing', async () => {
    const instance = await render(30, { chart: { renderer: 'canvas' } })

    expect(instance.rendererKind).toBe('svg')
    expect(instance.canvas).toBeNull()
    expect(el.querySelectorAll('path.apexmaps-feature')).toHaveLength(30)
    expect(instance.warnings.join('\n')).toContain('could not obtain a 2D context')
  })

  it('keeps hover working through the SVG path', async () => {
    const instance = await render(9, { chart: { renderer: 'canvas' } })
    const path = el.querySelector('path.apexmaps-feature')!
    path.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true }))
    expect(instance.hovered).not.toBeNull()
  })
})

// --- the tier itself, with a recording context ------------------------------

describe('canvas tier', () => {
  beforeEach(stubCanvas)

  it('mounts one canvas under the SVG and draws no feature elements', async () => {
    const instance = await render(40, { chart: { renderer: 'canvas' } })

    expect(instance.rendererKind).toBe('canvas')
    const canvases = el.querySelectorAll('canvas.apexmaps-canvas')
    expect(canvases).toHaveLength(1)
    // Under the SVG in paint order, and inert so the SVG above keeps every
    // pointer event.
    expect(canvases[0].parentElement?.firstElementChild).toBe(canvases[0])
    expect((canvases[0] as HTMLCanvasElement).style.pointerEvents).toBe('none')

    // The whole point: no per-feature DOM.
    expect(el.querySelectorAll('path.apexmaps-feature')).toHaveLength(0)
    expect(recorder.fill).toBeGreaterThan(0)
  })

  it('indexes every feature it drew', async () => {
    // With no data series the basemap pseudo-series draws, under its own id, and
    // its features must be indexed too: clicking a country on a basemap-only map
    // still selects it.
    const instance = await render(64, { chart: { renderer: 'canvas' } })
    expect(instance.canvas!.indexSizes()).toEqual([{ seriesId: 'base', features: 64 }])

    const withSeries = await render(64, {
      chart: { renderer: 'canvas' },
      series: [{ type: 'choropleth', name: 'V', data: [{ key: 'F0', value: 1 }] }],
    })
    expect(withSeries.canvas!.indexSizes()).toEqual([{ seriesId: 's0', features: 64 }])
  })

  it('leaves labels, annotations and the a11y tree in the DOM', async () => {
    const instance = await render(25, {
      chart: { renderer: 'canvas' },
      dataLabels: { enabled: true, minFeatureArea: 0 },
      annotations: { points: [{ at: [0, 0], label: 'Origin' }] },
      a11y: { enabled: true, dataTable: false },
    })
    expect(instance.rendererKind).toBe('canvas')
    expect(el.querySelectorAll('text.apexmaps-label').length).toBeGreaterThan(0)
    expect(el.querySelectorAll('text.apexmaps-annotation-text')).toHaveLength(1)
    expect(el.querySelector('svg.apexmaps-svg')?.getAttribute('role')).toBeTruthy()
  })

  it('keeps bubbles in SVG, where clustering already bounds them', async () => {
    await render(20, {
      chart: { renderer: 'canvas' },
      series: [
        {
          type: 'bubble',
          name: 'Cities',
          data: [
            { name: 'A', lon: -20, lat: 0, value: 5 },
            { name: 'B', lon: 20, lat: 0, value: 9 },
          ],
        },
      ],
    })
    expect(el.querySelectorAll('circle.apexmaps-bubble')).toHaveLength(2)
  })

  it('drops back to SVG when the map shrinks below an explicit threshold', async () => {
    const instance = await render(60, { chart: { renderer: 'auto', rendererThreshold: 50 } })
    expect(instance.rendererKind).toBe('canvas')

    await instance.updateOptions({ chart: { rendererThreshold: 1000 } })
    expect(instance.rendererKind).toBe('svg')
    // The canvas must go with it: a stale raster sitting under a live SVG map
    // would double every shape.
    expect(el.querySelectorAll('canvas.apexmaps-canvas')).toHaveLength(0)
    expect(el.querySelectorAll('path.apexmaps-feature')).toHaveLength(60)
  })

  it('does not stack canvases across redraws', async () => {
    const instance = await render(30, { chart: { renderer: 'canvas' } })
    await instance.updateOptions({ geo: { projection: 'orthographic' } })
    await instance.updateOptions({ theme: { mode: 'dark' } })
    expect(el.querySelectorAll('canvas.apexmaps-canvas')).toHaveLength(1)
  })

  it('removes the canvas on destroy', async () => {
    const instance = await render(16, { chart: { renderer: 'canvas' } })
    expect(el.querySelectorAll('canvas.apexmaps-canvas')).toHaveLength(1)
    instance.destroy()
    map = null
    expect(el.querySelectorAll('canvas.apexmaps-canvas')).toHaveLength(0)
  })
})

// --- the tier's performance invariant ---------------------------------------

describe('canvas camera frames', () => {
  beforeEach(stubCanvas)

  it('never builds a Path2D once the layers are drawn', async () => {
    // THE invariant. Rebuilding paths per frame is the regression that makes the
    // canvas tier slower than the SVG it replaced, and it is invisible on a fast
    // machine at low feature counts, which is exactly why it is asserted rather
    // than measured.
    const instance = await render(400, { chart: { renderer: 'canvas' } })
    const built = recorder.pathBuilds
    expect(built).toBeGreaterThanOrEqual(400)

    instance.camera!.panBy(120, -60)
    instance.camera!.zoomAbout(2.5, [400, 250])
    instance.camera!.panBy(-30, 10)

    expect(recorder.pathBuilds).toBe(built)
  })

  it('does one transform and one clear per frame, whatever the feature count', async () => {
    const small = await render(50, { chart: { renderer: 'canvas' } })
    const before = { ...recorder }
    small.camera!.panBy(10, 5)
    const smallFrame = {
      setTransform: recorder.setTransform - before.setTransform,
      clearRect: recorder.clearRect - before.clearRect,
    }
    small.destroy()
    map = null
    el.remove()
    el = document.createElement('div')
    document.body.appendChild(el)

    stubCanvas()
    const large = await render(2000, { chart: { renderer: 'canvas' } })
    const beforeLarge = { ...recorder }
    large.camera!.panBy(10, 5)
    const largeFrame = {
      setTransform: recorder.setTransform - beforeLarge.setTransform,
      clearRect: recorder.clearRect - beforeLarge.clearRect,
    }

    // The per-frame *setup* is O(1). The fills are O(features), which is the
    // trade this tier makes knowingly and the reason it is not the default.
    expect(smallFrame).toEqual(largeFrame)
    expect(largeFrame.clearRect).toBe(1)
  })

  it('rebuilds paths on a projection change, which is the contrast', async () => {
    // Without this, the invariant above would also hold for a tier that draws
    // nothing at all.
    const instance = await render(100, { chart: { renderer: 'canvas' } })
    const built = recorder.pathBuilds
    await instance.updateOptions({ geo: { projection: 'orthographic' } })
    expect(recorder.pathBuilds).toBeGreaterThan(built)
  })

  it('recolours without reprojecting a single feature', async () => {
    // A legend toggle changes fills, so the colour buckets and their merged
    // paths are rebuilt, but the 64 per-feature paths and the spatial index must
    // survive: reprojecting on a recolour is the regression that would make a
    // legend click cost as much as a first render.
    const instance = await render(64, {
      chart: { renderer: 'canvas' },
      series: [
        {
          type: 'choropleth',
          name: 'V',
          data: Array.from({ length: 64 }, (_, i) => ({ key: `F${i}`, value: i })),
        },
      ],
    })
    const built = recorder.pathBuilds
    const painted = recorder.fill
    const buckets = 5 // the default class count

    ;(instance as any)._onLegendToggle(0, 0)

    // Grows by at most one merged path per colour, never by the feature count.
    expect(recorder.pathBuilds).toBeGreaterThan(built)
    expect(recorder.pathBuilds - built).toBeLessThanOrEqual(buckets)
    expect(recorder.fill).toBeGreaterThan(painted)
    expect(instance.canvas!.indexSizes()).toEqual([{ seriesId: 's0', features: 64 }])
  })

  it('paints a bucket per colour, not a call per feature', async () => {
    // The reason the tier is fast rather than merely DOM-free. 2,000 features in
    // five classes must cost about five fills, not two thousand.
    await render(2000, {
      chart: { renderer: 'canvas' },
      series: [
        {
          type: 'choropleth',
          name: 'V',
          data: Array.from({ length: 2000 }, (_, i) => ({ key: `F${i}`, value: i })),
        },
      ],
    })
    const before = recorder.fill
    map!.camera!.panBy(10, 5)
    const perFrame = recorder.fill - before
    expect(perFrame).toBeGreaterThan(0)
    expect(perFrame).toBeLessThanOrEqual(12)
  })

  it('drops muted marks out of the merged path, because alpha cannot overdraw', async () => {
    // Hover and selection paint opaquely and are overdrawn on top of the merged
    // path, which keeps them off the O(features) path. Muting reduces alpha, so
    // the full-opacity copy underneath would show through and it has to be
    // excluded instead.
    const instance = await render(100, {
      chart: { renderer: 'canvas' },
      series: [
        {
          type: 'choropleth',
          name: 'V',
          data: Array.from({ length: 100 }, (_, i) => ({ key: `F${i}`, value: i })),
        },
      ],
    })

    const beforeHover = recorder.addPath
    const mark = (instance as any)._featureMark(
      instance.renderTargets[0],
      instance.geo!.features[3],
    )
    ;(instance as any)._setHover(mark)
    // Hover is an overdraw: nothing remerges.
    expect(recorder.addPath).toBe(beforeHover)

    // A selection mutes the other 99, so the merged paths must be rebuilt.
    instance.setSelection(['F3'])
    expect(recorder.addPath).toBeGreaterThan(beforeHover)
  })

  it('records hover as state rather than touching geometry', async () => {
    const instance = await render(36, { chart: { renderer: 'canvas' } })
    const built = recorder.pathBuilds

    const feature = instance.geo!.features[5]
    const mark = (instance as any)._featureMark(instance.renderTargets[0], feature)
    ;(instance as any)._setHover(mark)

    expect(instance.hovered).not.toBeNull()
    expect(recorder.pathBuilds).toBe(built)
    ;(instance as any)._clearHover()
    expect(instance.hovered).toBeNull()
    expect(recorder.pathBuilds).toBe(built)
  })
})
