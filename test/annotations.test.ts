// @vitest-environment jsdom
/**
 * Annotations: the editorial layer.
 *
 * The assertions that matter are the ones about the contracts a naive
 * implementation gets wrong quietly: annotations win collisions against
 * generated labels, they never swallow the pointer from the data they explain,
 * their anchors follow the geography through camera and projection changes, an
 * unresolvable anchor says so rather than vanishing, and they leave with the
 * map in the export.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ApexMaps from '../src/ApexMaps'

const WORLD = JSON.parse(
  readFileSync(resolve(process.cwd(), 'node_modules/world-atlas/countries-110m.json'), 'utf8'),
)

const TOKYO: [number, number] = [139.7, 35.7]
const LONDON: [number, number] = [-0.13, 51.5]

/**
 * world-atlas keys features by UN M49 code, not ISO alpha-3, so the key is
 * looked up by name rather than hard-coded: a test that asserts on '392' reads
 * as a magic number and breaks silently if the fixture's key field ever moves.
 */
function keyOf(name: string): string {
  const feature = map.geo.features.find((f: any) => f.name === name)
  expect(feature, `fixture has no feature named ${name}`).toBeTruthy()
  return feature.key
}

let el: HTMLElement
let map: any

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

async function render(options: Record<string, unknown>) {
  map = new ApexMaps(el, {
    chart: { width: 960, height: 500 },
    geo: { map: WORLD, projection: 'equalEarth' },
    debug: { enabled: false },
    ...options,
  } as any)
  await map.render()
  return map
}

const chips = () => [...el.querySelectorAll('rect.apexmaps-annotation-chip')]
const texts = () => [...el.querySelectorAll('text.apexmaps-annotation-text')]
const groups = () => [...el.querySelectorAll('g.apexmaps-annotation')]
const areas = () => [...el.querySelectorAll('path.apexmaps-annotation-area')]
const markers = () => [...el.querySelectorAll('path.apexmaps-annotation-marker')]

describe('point annotations', () => {
  it('draws a chip and a marker at a coordinate', async () => {
    await render({
      annotations: {
        points: [{ at: TOKYO, label: 'Tokyo', marker: { shape: 'pin', size: 12 } }],
      },
    })

    expect(groups()).toHaveLength(1)
    expect(texts()[0].textContent).toBe('Tokyo')
    expect(chips()).toHaveLength(1)
    expect(markers()).toHaveLength(1)
    expect(markers()[0].getAttribute('transform')).toMatch(/^translate\(/)
  })

  it('accepts a bare string as the label', async () => {
    await render({ annotations: { points: [{ at: TOKYO, label: 'Shorthand' }] } })
    expect(texts()[0].textContent).toBe('Shorthand')
  })

  it('positions the chip where the anchor projects to', async () => {
    await render({ annotations: { points: [{ at: TOKYO, label: 'Tokyo' }] } })
    const expected = map.viewport.lonLatToScreen(TOKYO)
    const chip = chips()[0]
    const cx = Number(chip.getAttribute('x')) + Number(chip.getAttribute('width')) / 2
    expect(cx).toBeCloseTo(expected[0], 0)
    // Default position is above the anchor, so the chip's centre sits higher.
    const cy = Number(chip.getAttribute('y')) + Number(chip.getAttribute('height')) / 2
    expect(cy).toBeLessThan(expected[1])
  })

  it('honours position, offsets, and the connector', async () => {
    await render({
      annotations: {
        points: [
          {
            at: TOKYO,
            label: { text: 'Right', position: 'right', offsetY: -20 },
            connector: true,
          },
        ],
      },
    })
    const anchor = map.viewport.lonLatToScreen(TOKYO)
    const chip = chips()[0]
    const cx = Number(chip.getAttribute('x')) + Number(chip.getAttribute('width')) / 2
    expect(cx).toBeGreaterThan(anchor[0])

    const line = el.querySelector('line.apexmaps-annotation-connector')!
    expect(Number(line.getAttribute('x1'))).toBeCloseTo(anchor[0], 0)
    expect(Number(line.getAttribute('x2'))).toBeCloseTo(cx, 0)
  })

  it("draws haloed text with no chip for background 'none'", async () => {
    await render({
      annotations: { points: [{ at: TOKYO, label: { text: 'Bare', background: 'none' } }] },
    })
    expect(chips()).toHaveLength(0)
    expect(texts()[0].getAttribute('paint-order')).toBe('stroke')
  })

  it('splits a multi-line label into tspans', async () => {
    await render({ annotations: { points: [{ at: TOKYO, label: 'Two\nlines' }] } })
    const spans = texts()[0].querySelectorAll('tspan')
    expect(spans).toHaveLength(2)
    expect(spans[1].getAttribute('dy')).toBeTruthy()
  })

  it('warns for a malformed coordinate rather than drawing nothing quietly', async () => {
    await render({ annotations: { points: [{ at: 'nope' as never, label: 'Bad' }] } })
    expect(map.warnings.join('\n')).toContain('annotations.points[0] has no usable "at"')
    expect(groups()).toHaveLength(0)
  })
})

describe('feature annotations', () => {
  it('anchors at the same point the label engine uses', async () => {
    // Rendered bare first so the key can be resolved from the fixture, then
    // re-rendered with the annotation attached to it.
    await render({})
    const key = keyOf('Japan')
    map.destroy()
    el.remove()
    el = document.createElement('div')
    document.body.appendChild(el)

    await render({ annotations: { features: [{ key, label: 'Japan' }] } })
    const feature = map.geo.features.find((f: any) => f.key === key)
    const expected = map.viewport.worldToScreen(map.anchors.get(feature.index).world)

    const chip = chips()[0]
    const cx = Number(chip.getAttribute('x')) + Number(chip.getAttribute('width')) / 2
    expect(cx).toBeCloseTo(expected[0], 0)
  })

  it('traces the feature outline when asked', async () => {
    await render({})
    const key = keyOf('Japan')
    map.destroy()
    el.remove()
    el = document.createElement('div')
    document.body.appendChild(el)

    await render({ annotations: { features: [{ key, label: 'Japan', outline: true }] } })
    const outline = areas()[0]
    expect(outline.getAttribute('d')).toBeTruthy()
    expect(outline.getAttribute('fill')).toBe('none')
    expect(outline.getAttribute('vector-effect')).toBe('non-scaling-stroke')
  })

  it('reports a key that matches no feature', async () => {
    await render({ annotations: { features: [{ key: 'ZZZ', label: 'Nowhere' }] } })
    expect(map.warnings.join('\n')).toContain('key "ZZZ" matches no feature')
    expect(groups()).toHaveLength(0)
  })
})

describe('area annotations', () => {
  it('projects a lon/lat box into world space', async () => {
    await render({
      annotations: {
        areas: [{ bounds: [100, -10, 150, 20], label: 'Region', fillOpacity: 0.2 }],
      },
    })
    const area = areas()[0]
    expect(area.getAttribute('d')).toBeTruthy()
    expect(area.getAttribute('fill-opacity')).toBe('0.2')
    // Anchored on the region's centroid, so the label rides with it.
    expect(texts()[0].textContent).toBe('Region')
  })

  it('lives above the fills and below the symbols', async () => {
    await render({
      annotations: { areas: [{ bounds: [100, -10, 150, 20] }] },
      series: [
        { type: 'bubble', name: 'Cities', data: [{ name: 'T', lon: 139.7, lat: 35.7, value: 5 }] },
      ],
    })
    const layers = [...el.querySelectorAll('svg.apexmaps-svg g[class^="apexmaps-layer"]')].map(
      (g) => g.getAttribute('class'),
    )
    expect(layers.indexOf('apexmaps-layer-regions')).toBeGreaterThan(
      layers.indexOf('apexmaps-layer-marks'),
    )
    expect(layers.indexOf('apexmaps-layer-regions')).toBeLessThan(
      layers.indexOf('apexmaps-layer-symbols'),
    )
  })

  it('accepts a raw GeoJSON geometry', async () => {
    await render({
      annotations: {
        areas: [
          {
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [0, 0],
                  [0, 10],
                  [10, 10],
                  [10, 0],
                  [0, 0],
                ],
              ],
            },
          },
        ],
      },
    })
    expect(areas()[0].getAttribute('d')).toBeTruthy()
  })

  it('warns when neither bounds nor geometry is supplied', async () => {
    await render({ annotations: { areas: [{ label: 'Empty' }] } })
    expect(map.warnings.join('\n')).toContain('needs "bounds"')
  })

  it('winds the box so d3 fills the region, not the rest of the sphere', async () => {
    // The winding trap: counterclockwise in lon/lat means "sphere minus box" to
    // d3-geo, which fills the whole map. A correct box is a small fraction of
    // the plot area.
    await render({ annotations: { areas: [{ bounds: [100, -10, 150, 20] }] } })
    const d = areas()[0].getAttribute('d')!
    const xs = [...d.matchAll(/-?\d+\.?\d*/g)].map(Number).filter((_, i) => i % 2 === 0)
    const span = Math.max(...xs) - Math.min(...xs)
    expect(span).toBeLessThan(map.viewport.width * 0.5)
  })
})

describe('annotations versus generated labels', () => {
  it('a colliding data label yields to the annotation', async () => {
    const without = await render({ dataLabels: { enabled: true, minFeatureArea: 0 } })
    const placedWithout = without.labels.placedCount
    expect(placedWithout).toBeGreaterThan(0)

    map.destroy()
    el.remove()
    el = document.createElement('div')
    document.body.appendChild(el)

    // A wide chip parked on the densest label cluster in the fixture. The
    // annotation must survive intact and the generated labels under it give way.
    await render({
      dataLabels: { enabled: true, minFeatureArea: 0 },
      annotations: {
        points: [{ at: [10, 50], label: 'A deliberately wide editorial note about Europe' }],
      },
    })
    expect(texts()[0].textContent).toBe('A deliberately wide editorial note about Europe')
    expect(map.labels.placedCount).toBeLessThan(placedWithout)
  })

  it('does not count reserved boxes as placed labels', async () => {
    await render({
      dataLabels: { enabled: false },
      annotations: { points: [{ at: TOKYO, label: 'Tokyo' }] },
    })
    expect(map.labels.placedCount).toBe(0)
  })
})

describe('annotations and the pointer', () => {
  it('are inert, so the data underneath keeps its events', async () => {
    await render({ annotations: { points: [{ at: TOKYO, label: 'Tokyo', marker: {} }] } })
    for (const el2 of [...groups(), ...areas(), ...markers()]) {
      const group = el2.closest('g.apexmaps-annotations, g.apexmaps-annotation-regions')
      expect(group?.getAttribute('pointer-events')).toBe('none')
    }
  })
})

describe('annotations and the camera', () => {
  it('reposition on a camera change without reprojecting', async () => {
    await render({ annotations: { points: [{ at: LONDON, label: 'London' }] } })
    const before = Number(chips()[0].getAttribute('x'))

    map.camera.jumpTo({ k: 1, x: -60, y: -30 })
    await new Promise((r) => setTimeout(r, 20))

    const after = Number(chips()[0].getAttribute('x'))
    expect(after).toBeCloseTo(before - 60, 0)
    // Text keeps its size: editorial type that grew with the camera would stop
    // being type.
    expect(texts()[0].getAttribute('font-size')).toBe('11')
  })

  it('are culled once the anchor is well off the plot', async () => {
    await render({ annotations: { points: [{ at: LONDON, label: 'London' }] } })
    expect(chips()).toHaveLength(1)

    map.camera.jumpTo({ k: 1, x: -3000, y: 0 })
    await new Promise((r) => setTimeout(r, 20))
    expect(chips()).toHaveLength(0)
  })

  it('follow a projection change', async () => {
    await render({ annotations: { points: [{ at: LONDON, label: 'London' }] } })
    const before = Number(chips()[0].getAttribute('x'))

    await map.updateOptions({ geo: { projection: 'orthographic' } })
    const after = Number(chips()[0].getAttribute('x'))
    expect(Number.isFinite(after)).toBe(true)
    expect(after).not.toBeCloseTo(before, 1)
  })

  it('survive an updateOptions that changes the annotations themselves', async () => {
    await render({ annotations: { points: [{ at: TOKYO, label: 'First' }] } })
    expect(texts()[0].textContent).toBe('First')

    await map.updateOptions({ annotations: { points: [{ at: TOKYO, label: 'Second' }] } })
    // Rebuilt, not accumulated: one chip, with the new text.
    expect(texts()).toHaveLength(1)
    expect(texts()[0].textContent).toBe('Second')
  })
})

describe('component options follow updateOptions', () => {
  /*
   * Found while building the annotations demo, which toggles data labels at
   * runtime: every component took its options at construction, and construction
   * only reruns for a map or projection change. `dataLabels`, `legend.position`,
   * `legend.align` and `tooltip.offset` set after render were therefore read
   * from a first-render snapshot and did nothing at all.
   */
  it('enables data labels set after render', async () => {
    await render({ dataLabels: { enabled: false } })
    expect(el.querySelectorAll('text.apexmaps-label')).toHaveLength(0)

    await map.updateOptions({ dataLabels: { enabled: true, minFeatureArea: 0 } })
    expect(map.labels.options.enabled).toBe(true)
    expect(el.querySelectorAll('text.apexmaps-label').length).toBeGreaterThan(0)
  })

  it('moves the legend when position changes after render', async () => {
    await render({})
    const rows = map.geo.features.slice(0, 8).map((f: any, i: number) => ({
      key: f.key,
      value: i + 1,
    }))
    map.destroy()
    el.remove()
    el = document.createElement('div')
    document.body.appendChild(el)

    await render({
      legend: { position: 'bottom' },
      series: [{ type: 'choropleth', name: 'V', data: rows }],
    })
    const legend = () => el.querySelector('.apexmaps-legend')!.getAttribute('class')!
    expect(legend()).toContain('apexmaps-legend--bottom')

    await map.updateOptions({ legend: { position: 'top', align: 'right' } })
    expect(legend()).toContain('apexmaps-legend--top')
    expect(legend()).toContain('apexmaps-legend--align-right')
    expect(legend()).not.toContain('apexmaps-legend--bottom')
  })

  it('carries a new tooltip offset through to the component', async () => {
    await render({ annotations: { points: [{ at: TOKYO, label: 'Tokyo' }] } })
    await map.updateOptions({ tooltip: { offset: [40, 40] } })
    expect(map.tooltip.options.offset).toEqual([40, 40])
  })
})

describe('annotations and export', () => {
  it('are inside the exported SVG', async () => {
    await render({ annotations: { points: [{ at: TOKYO, label: 'Exported' }] } })
    const markup = map.getSvgString()
    expect(markup).toContain('apexmaps-annotation')
    expect(markup).toContain('Exported')
  })
})

describe('annotations teardown', () => {
  it('leave no groups behind on destroy', async () => {
    await render({
      annotations: {
        points: [{ at: TOKYO, label: 'Tokyo' }],
        areas: [{ bounds: [100, -10, 150, 20] }],
      },
    })
    expect(groups().length + areas().length).toBeGreaterThan(0)

    map.destroy()
    map = null
    expect(el.querySelectorAll('g.apexmaps-annotations')).toHaveLength(0)
    expect(el.querySelectorAll('g.apexmaps-annotation-regions')).toHaveLength(0)
  })
})
