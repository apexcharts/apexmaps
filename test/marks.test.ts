// @vitest-environment jsdom
/**
 * Bubble and arc series.
 *
 * The assertions that matter here are the ones about honesty and correctness:
 * square-root area scaling, paint order, great-circle paths, and antimeridian
 * handling. Those are the four things that separate a credible connection map from
 * a decorative one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ApexMaps from '../src/ApexMaps'
import { SizeScale } from '../src/scales/SizeScale'
import { greatCircle, angularDistance, bezierArc, segmentsFor } from '../src/geo/Geodesic'

const WORLD = JSON.parse(
  readFileSync(resolve(process.cwd(), 'node_modules/world-atlas/countries-110m.json'), 'utf8'),
)

const TOKYO: [number, number] = [139.7, 35.7]
const NEW_YORK: [number, number] = [-74.0, 40.7]
const LOS_ANGELES: [number, number] = [-118.2, 34.1]
const LONDON: [number, number] = [-0.13, 51.5]
const SYDNEY: [number, number] = [151.2, -33.9]

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

describe('SizeScale', () => {
  it('scales area, not radius, by default', () => {
    const scale = new SizeScale([0, 100], { range: [0, 20] })
    const r100 = scale.radius(100)!
    const r25 = scale.radius(25)!
    // Four times the value must be twice the radius, which is four times the area.
    // Linear radius scaling would make it four times the radius, i.e. sixteen
    // times the ink for four times the quantity.
    expect(r100 / r25).toBeCloseTo(2, 5)
  })

  it('scales radius linearly when explicitly asked', () => {
    const scale = new SizeScale([0, 100], { range: [0, 20], scale: 'linear' })
    expect(scale.radius(50)! / scale.radius(100)!).toBeCloseTo(0.5, 5)
  })

  it('anchors the domain at zero so the smallest place is not implied to be empty', () => {
    const scale = new SizeScale([50, 100])
    expect(scale.domain[0]).toBe(0)
  })

  it('returns null rather than a minimum radius for missing values', () => {
    const scale = new SizeScale([1, 2, 3])
    expect(scale.radius(null)).toBeNull()
    expect(scale.radius(undefined)).toBeNull()
    expect(scale.radius('abc')).toBeNull()
  })

  it('produces round, decreasing reference values for the legend', () => {
    const entries = new SizeScale([0, 8_432_000]).legendEntries()
    expect(entries.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].value).toBeLessThan(entries[i - 1].value)
      expect(entries[i].radius).toBeLessThan(entries[i - 1].radius)
    }
    // Round numbers: a legend of 8,432,000 / 4,216,000 is unreadable.
    expect(entries[0].value % 100000).toBe(0)
  })

  it('warns when a log scale is given a domain touching zero', () => {
    expect(new SizeScale([0, 100], { scale: 'log' }).warnings.join(' ')).toContain(
      'positive domain',
    )
  })
})

describe('Geodesic', () => {
  it('measures angular distance', () => {
    // Tokyo to New York is roughly 100 degrees of arc.
    expect(angularDistance(TOKYO, NEW_YORK)).toBeGreaterThan(90)
    expect(angularDistance(TOKYO, NEW_YORK)).toBeLessThan(110)
    expect(angularDistance(TOKYO, TOKYO)).toBeCloseTo(0, 9)
  })

  it('arcs poleward rather than following the parallel', () => {
    const points = greatCircle(TOKYO, NEW_YORK)
    const maxLat = Math.max(...points.map((p) => p[1]))
    // Both cities sit near 36-41N, but the great circle between them climbs into
    // the high Arctic. A straight line on a map would stay near 38N and be wrong.
    expect(maxLat).toBeGreaterThan(60)
  })

  it('includes both endpoints exactly', () => {
    const points = greatCircle(LONDON, SYDNEY)
    expect(points[0]).toEqual(LONDON)
    expect(points[points.length - 1]).toEqual(SYDNEY)
  })

  it('samples longer arcs more densely', () => {
    expect(segmentsFor(120)).toBeGreaterThan(segmentsFor(5))
    expect(segmentsFor(0)).toBeGreaterThan(0)
  })

  it('handles coincident endpoints without producing NaN', () => {
    const points = greatCircle(TOKYO, TOKYO)
    expect(points).toHaveLength(2)
    for (const p of points) expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true)
  })

  it('bulges a bezier to one side and degenerates safely', () => {
    const curved = bezierArc([0, 0], [100, 0], 0.4)
    expect(curved).toContain('Q')
    expect(bezierArc([0, 0], [100, 0], 0)).toBe('M0,0L100,0')
    expect(bezierArc([5, 5], [5, 5], 0.5)).toBe('M5,5L5,5')
  })
})

describe('bubble series', () => {
  const CITIES = [
    { name: 'Tokyo', lon: 139.7, lat: 35.7, value: 37_400_000 },
    { name: 'Delhi', lon: 77.2, lat: 28.6, value: 28_500_000 },
    { name: 'Lagos', lon: 3.4, lat: 6.5, value: 13_900_000 },
    { name: 'Lima', lon: -77.0, lat: -12.0, value: 10_400_000 },
  ]

  it('renders one circle per datum in the symbol layer', async () => {
    await render({
      series: [{ type: 'bubble', name: 'Population', data: CITIES }],
    })
    const circles = el.querySelectorAll('circle.apexmaps-bubble')
    expect(circles).toHaveLength(4)
    for (const c of circles) {
      expect(Number(c.getAttribute('r'))).toBeGreaterThan(0)
      expect(Number(c.getAttribute('cx'))).not.toBeNaN()
    }
  })

  it('still draws the basemap underneath, because bubbles in the void are not a map', async () => {
    await render({
      series: [{ type: 'bubble', name: 'Population', data: CITIES }],
    })
    expect(el.querySelectorAll('path.apexmaps-feature').length).toBe(177)
  })

  it('paints largest first so small bubbles stay clickable', async () => {
    await render({
      series: [{ type: 'bubble', name: 'Population', data: CITIES }],
    })
    const radii = [...el.querySelectorAll('circle.apexmaps-bubble')].map((c) =>
      Number(c.getAttribute('r')),
    )
    for (let i = 1; i < radii.length; i++) expect(radii[i]).toBeLessThanOrEqual(radii[i - 1])
  })

  it('keeps its radius constant when the camera zooms', async () => {
    await render({
      series: [{ type: 'bubble', name: 'Population', data: CITIES }],
    })
    const before = el.querySelector('circle.apexmaps-bubble')!.getAttribute('r')
    map.camera.set({ k: 6 })
    const after = el.querySelector('circle.apexmaps-bubble')!.getAttribute('r')
    // Radius encodes a value, so it must not change with zoom, but position must.
    expect(after).toBe(before)
  })

  it('repositions symbols on a camera change', async () => {
    await render({
      series: [{ type: 'bubble', name: 'Population', data: CITIES }],
    })
    const cx = () => el.querySelector('circle.apexmaps-bubble')!.getAttribute('cx')
    const before = cx()
    map.camera.panBy(60, 0)
    expect(cx()).not.toBe(before)
  })

  it('places bubbles at feature centroids when the data has no coordinates', async () => {
    await render({
      series: [
        {
          type: 'bubble',
          name: 'Score',
          joinBy: 'name',
          data: [
            { name: 'Brazil', value: 100 },
            { name: 'Japan', value: 60 },
          ],
        },
      ],
    })
    expect(el.querySelectorAll('circle.apexmaps-bubble')).toHaveLength(2)
    expect(map.series[0].join.matched).toBe(2)
  })

  it('reports data it cannot place', async () => {
    await render({
      series: [
        {
          type: 'bubble',
          name: 'Score',
          joinBy: 'name',
          data: [{ name: 'Atlantis', value: 5 }],
        },
      ],
    })
    expect(map.warnings.join(' ')).toContain('no position')
    expect(el.querySelectorAll('circle.apexmaps-bubble')).toHaveLength(0)
  })

  it('emits markClick and includes the datum', async () => {
    const onClick = vi.fn()
    await render({
      series: [{ type: 'bubble', name: 'Population', data: CITIES }],
    })
    map.on('markClick', onClick)

    el.querySelector('circle.apexmaps-bubble')!.dispatchEvent(
      new window.MouseEvent('click', { bubbles: true }),
    )
    expect(onClick).toHaveBeenCalledOnce()
    expect(onClick.mock.calls[0][0].name).toBe('Tokyo')
    expect(onClick.mock.calls[0][0].value).toBe(37_400_000)
  })

  it('shows a tooltip on hover', async () => {
    await render({
      series: [{ type: 'bubble', name: 'Population', data: CITIES }],
    })
    el.querySelector('circle.apexmaps-bubble')!.dispatchEvent(
      new window.PointerEvent('pointerover', { bubbles: true }),
    )
    const tooltip = el.querySelector('.apexmaps-tooltip') as HTMLElement
    expect(tooltip.style.display).toBe('block')
    expect(tooltip.textContent).toContain('Tokyo')
  })

  it('renders a nested-circle size legend', async () => {
    await render({
      series: [{ type: 'bubble', name: 'Population', data: CITIES }],
    })
    const legend = el.querySelector('svg.apexmaps-legend-sizes')
    expect(legend).toBeTruthy()
    expect(legend!.querySelectorAll('circle').length).toBeGreaterThanOrEqual(2)
    expect(legend!.getAttribute('aria-label')).toContain('Circle sizes')
  })

  it('supports colouring by a second variable', async () => {
    await render({
      series: [
        {
          type: 'bubble',
          name: 'Population',
          data: CITIES.map((c, i) => ({ ...c, growth: i * 10 })),
          colorField: 'growth',
          colorScale: { type: 'quantile', classes: 4, palette: 'reds' },
        },
      ],
    })
    const fills = new Set(
      [...el.querySelectorAll('circle.apexmaps-bubble')].map((c) => c.getAttribute('fill')),
    )
    expect(fills.size).toBeGreaterThan(1)
  })

  it('advises when the value range makes small bubbles invisible', async () => {
    await render({
      series: [
        {
          type: 'bubble',
          name: 'Skewed',
          data: [
            { name: 'a', lon: 0, lat: 0, value: 1 },
            { name: 'b', lon: 10, lat: 10, value: 5_000_000 },
          ],
        },
      ],
    })
    expect(map.series[0].advise().join(' ')).toMatch(/span .*x/)
  })

  it('advises against negative values, which radius cannot encode', async () => {
    await render({
      series: [
        {
          type: 'bubble',
          name: 'Net',
          data: [
            { name: 'a', lon: 0, lat: 0, value: -5 },
            { name: 'b', lon: 10, lat: 10, value: 5 },
          ],
        },
      ],
    })
    expect(map.series[0].advise().join(' ')).toContain('negatives')
  })
})

describe('arc series', () => {
  const ROUTES = [
    { name: 'NRT-JFK', from: TOKYO, to: NEW_YORK, value: 900 },
    { name: 'LHR-SYD', from: LONDON, to: SYDNEY, value: 400 },
    { name: 'NRT-LAX', from: TOKYO, to: LOS_ANGELES, value: 650 },
  ]

  it('renders one path per route', async () => {
    await render({ series: [{ type: 'arc', name: 'Routes', data: ROUTES }] })
    const arcs = el.querySelectorAll('path.apexmaps-arc')
    expect(arcs).toHaveLength(3)
    for (const a of arcs) {
      const d = a.getAttribute('d')!
      expect(d.length).toBeGreaterThan(20)
      expect(d).not.toContain('NaN')
    }
  })

  it('draws a great circle rather than a straight line by default', async () => {
    await render({
      series: [{ type: 'arc', name: 'Routes', data: [ROUTES[0]] }],
    })
    const geodesic = el.querySelector('path.apexmaps-arc')!.getAttribute('d')!

    await map.updateOptions({
      series: [{ type: 'arc', name: 'Routes', geodesic: false, data: [ROUTES[0]] }],
    })
    const straight = el.querySelector('path.apexmaps-arc')!.getAttribute('d')!

    // A straight chord is one move and one line; a sampled great circle is a long
    // polyline that bends far north of it.
    expect(straight.length).toBeLessThan(geodesic.length)
    expect(geodesic.split('L').length).toBeGreaterThan(10)
  })

  it('splits an antimeridian crossing instead of streaking across the map', async () => {
    await render({
      series: [{ type: 'arc', name: 'Routes', data: [ROUTES[2]] }],
    })
    const d = el.querySelector('path.apexmaps-arc')!.getAttribute('d')!
    // d3-geo cuts the arc at the map edge, so the path contains two subpaths.
    expect((d.match(/M/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('scales width by value', async () => {
    await render({ series: [{ type: 'arc', name: 'Routes', data: ROUTES }] })
    const widths = [...el.querySelectorAll('path.apexmaps-arc')].map((a) =>
      Number(a.getAttribute('stroke-width')),
    )
    expect(Math.max(...widths)).toBeGreaterThan(Math.min(...widths))
  })

  it('adds an invisible wider hit path so thin arcs are hoverable', async () => {
    await render({ series: [{ type: 'arc', name: 'Routes', data: ROUTES }] })
    const hits = el.querySelectorAll('path.apexmaps-arc-hit')
    expect(hits.length).toBe(3)
    for (const h of hits) {
      expect(Number(h.getAttribute('stroke-width'))).toBeGreaterThan(6)
      expect(h.getAttribute('stroke')).toBe('transparent')
    }
  })

  it('removes the hit path together with its arc', async () => {
    // A pruned arc whose hit companion survives is an invisible 8px-wide element
    // that still answers hover, and its stale item index resolves to a different
    // arc's data. The ghost is worse than the leak.
    await render({ series: [{ type: 'arc', name: 'Routes', data: ROUTES }] })
    expect(el.querySelectorAll('path.apexmaps-arc-hit')).toHaveLength(3)

    map.updateSeries([{ type: 'arc', name: 'Routes', data: [ROUTES[0]] }])

    expect(el.querySelectorAll('path.apexmaps-arc')).toHaveLength(1)
    expect(el.querySelectorAll('path.apexmaps-arc-hit')).toHaveLength(1)
  })

  it('resolves endpoints given as geometry keys', async () => {
    await render({
      series: [
        {
          type: 'arc',
          name: 'Trade',
          joinBy: 'name',
          data: [{ from: 'Brazil', to: 'Japan', value: 10 }],
        },
      ],
    })
    expect(el.querySelectorAll('path.apexmaps-arc')).toHaveLength(1)
    expect(map.series[0].items[0].fromLabel).toBe('Brazil')
  })

  it('reports endpoints it cannot resolve', async () => {
    await render({
      series: [
        {
          type: 'arc',
          name: 'Trade',
          data: [{ from: 'Nowhere', to: 'Japan', value: 1 }],
        },
      ],
    })
    expect(map.warnings.join(' ')).toContain('could not be resolved')
  })

  it('draws deduplicated endpoint dots when asked', async () => {
    await render({
      series: [
        {
          type: 'arc',
          name: 'Routes',
          data: ROUTES,
          endpoints: { show: true },
        },
      ],
    })
    // Five distinct airports across three routes that share Tokyo.
    expect(el.querySelectorAll('circle.apexmaps-bubble')).toHaveLength(5)
  })

  it('warns that curvature is decorative rather than geographic', async () => {
    await render({
      series: [{ type: 'arc', name: 'Routes', curvature: 0.4, data: ROUTES }],
    })
    expect(map.warnings.join(' ')).toContain('decorative')
  })

  it('emits markClick with the route datum', async () => {
    const onClick = vi.fn()
    await render({ series: [{ type: 'arc', name: 'Routes', data: ROUTES }] })
    map.on('markClick', onClick)

    el.querySelector('path.apexmaps-arc')!.dispatchEvent(
      new window.MouseEvent('click', { bubbles: true }),
    )
    expect(onClick).toHaveBeenCalledOnce()
    expect(onClick.mock.calls[0][0].seriesName).toBe('Routes')
  })

  it('rebuilds arc geometry on a projection change', async () => {
    await render({ series: [{ type: 'arc', name: 'Routes', data: ROUTES }] })
    const before = el.querySelector('path.apexmaps-arc')!.getAttribute('d')
    await map.updateOptions({ geo: { projection: 'orthographic' } })
    const after = el.querySelector('path.apexmaps-arc')!.getAttribute('d')
    expect(after).not.toBe(before)
  })

  it('advises when an arc count will read as a hairball', async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      from: [(i % 180) - 90, 10] as [number, number],
      to: [((i * 7) % 180) - 90, -10] as [number, number],
      value: i,
    }))
    await render({ series: [{ type: 'arc', name: 'Flows', data: many }] })
    expect(map.series[0].advise().join(' ')).toContain('hairball')
  })
})

describe('combined series', () => {
  it('renders a choropleth, bubbles and arcs together in the right layers', async () => {
    await render({
      series: [
        {
          type: 'choropleth',
          name: 'Score',
          joinBy: 'name',
          data: [
            { name: 'Brazil', value: 10 },
            { name: 'Japan', value: 20 },
          ],
        },
        {
          type: 'bubble',
          name: 'Cities',
          data: [{ name: 'Tokyo', lon: 139.7, lat: 35.7, value: 37 }],
        },
        {
          type: 'arc',
          name: 'Routes',
          data: [{ from: TOKYO, to: NEW_YORK, value: 5 }],
        },
      ],
    })

    expect(el.querySelectorAll('path.apexmaps-feature')).toHaveLength(177)
    expect(el.querySelectorAll('circle.apexmaps-bubble')).toHaveLength(1)
    expect(el.querySelectorAll('path.apexmaps-arc')).toHaveLength(1)

    // Arcs share the world group with features so they scale; bubbles do not.
    expect(el.querySelector('g.apexmaps-layer-marks path.apexmaps-arc')).toBeTruthy()
    expect(el.querySelector('g.apexmaps-layer-symbols circle.apexmaps-bubble')).toBeTruthy()

    // No basemap pseudo-series when a real feature series exists.
    expect(el.querySelectorAll('g.apexmaps-series').length).toBe(2)
  })

  it('gives each series its own legend section', async () => {
    await render({
      series: [
        {
          type: 'choropleth',
          name: 'Score',
          joinBy: 'name',
          data: [{ name: 'Brazil', value: 10 }],
        },
        {
          type: 'bubble',
          name: 'Cities',
          data: [{ name: 'Tokyo', lon: 139.7, lat: 35.7, value: 37 }],
        },
      ],
    })
    const sections = el.querySelectorAll('.apexmaps-legend-section')
    expect(sections.length).toBe(2)
    expect(el.textContent).toContain('Score')
    expect(el.textContent).toContain('Cities')
  })

  it('removes marks when a series is dropped', async () => {
    await render({
      series: [
        {
          type: 'bubble',
          name: 'Cities',
          data: [{ name: 'Tokyo', lon: 139.7, lat: 35.7, value: 37 }],
        },
        {
          type: 'arc',
          name: 'Routes',
          data: [{ from: TOKYO, to: NEW_YORK, value: 5 }],
        },
      ],
    })
    expect(el.querySelectorAll('circle.apexmaps-bubble')).toHaveLength(1)

    await map.updateOptions({
      series: [
        {
          type: 'arc',
          name: 'Routes',
          data: [{ from: TOKYO, to: NEW_YORK, value: 5 }],
        },
      ],
    })
    expect(el.querySelectorAll('circle.apexmaps-bubble')).toHaveLength(0)
    expect(el.querySelectorAll('path.apexmaps-arc')).toHaveLength(1)
  })

  it('serialises a multi-series spec', async () => {
    await render({
      series: [
        {
          type: 'bubble',
          name: 'Cities',
          data: [{ name: 'Tokyo', lon: 139.7, lat: 35.7, value: 37 }],
        },
        {
          type: 'arc',
          name: 'Routes',
          data: [{ from: TOKYO, to: NEW_YORK, value: 5 }],
        },
      ],
    })
    const spec = map.toSpec()
    expect(spec.series).toHaveLength(2)
    expect(spec.series[0].type).toBe('bubble')
    expect(spec.series[1].type).toBe('arc')
    expect(() => JSON.stringify(spec)).not.toThrow()
  })
})
