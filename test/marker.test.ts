// @vitest-environment jsdom
/**
 * Marker series, shapes and clustering.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import ApexMaps from '../src/ApexMaps'
import { MarkerSeries } from '../src/series/Marker'
import { clusterPoints, clusterLevel, levelScale } from '../src/geo/Cluster'
import { markerPath, MARKER_SHAPES, isPointAnchored } from '../src/renderers/Shapes'
import type { ApexMapsOptions, MarkerDatum } from '../src/types'

const WORLD = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { iso_a3: 'BOX', name: 'Box' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-40, -20],
            [-40, 20],
            [40, 20],
            [40, -20],
            [-40, -20],
          ],
        ],
      },
    },
  ],
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

function markGroups(): SVGGElement[] {
  return [...el.querySelectorAll<SVGGElement>('g.apexmaps-mark')]
}

describe('marker shapes', () => {
  it('generates a path for every shape', () => {
    for (const shape of MARKER_SHAPES) {
      const d = markerPath(shape, 12)
      expect(d.length, shape).toBeGreaterThan(8)
      expect(d.startsWith('M'), shape).toBe(true)
      expect(d, shape).not.toMatch(/NaN|undefined|Infinity/)
    }
  })

  it('scales with size', () => {
    expect(markerPath('square', 20)).not.toBe(markerPath('square', 10))
  })

  it('anchors a pin at its point, and everything else at its centre', () => {
    expect(isPointAnchored('pin')).toBe(true)
    for (const shape of MARKER_SHAPES.filter((s) => s !== 'pin')) {
      expect(isPointAnchored(shape), shape).toBe(false)
    }
    // The pin's path starts at the origin, which is the place it marks.
    expect(markerPath('pin', 14).startsWith('M0,0')).toBe(true)
  })

  it('survives a degenerate size instead of emitting NaN', () => {
    for (const size of [0, -5]) {
      expect(markerPath('star', size)).not.toMatch(/NaN/)
    }
  })
})

describe('clustering', () => {
  const grid = (n: number, spacing: number) =>
    Array.from({ length: n }, (_, i) => ({
      index: i,
      world: [(i % 10) * spacing, Math.floor(i / 10) * spacing] as [number, number],
    }))

  it('merges by distance, not by grid cell', () => {
    // Two points 2 units apart, straddling any cell boundary a naive grid would
    // draw. Distance-based clustering merges them; cell bucketing might not.
    const points = [
      { index: 0, world: [9.9, 0] as [number, number] },
      { index: 1, world: [10.1, 0] as [number, number] },
    ]
    const clusters = clusterPoints(points, { radius: 10, zoom: 1 })
    expect(clusters).toHaveLength(1)
    expect(clusters[0].count).toBe(2)
  })

  it('keeps distant points separate', () => {
    const points = [
      { index: 0, world: [0, 0] as [number, number] },
      { index: 1, world: [500, 0] as [number, number] },
    ]
    const clusters = clusterPoints(points, { radius: 10, zoom: 1 })
    expect(clusters).toHaveLength(2)
    expect(clusters.every((c) => c.count === 1)).toBe(true)
  })

  it('places a cluster at the centre of mass, not on its first member', () => {
    const points = [
      { index: 0, world: [0, 0] as [number, number] },
      { index: 1, world: [10, 0] as [number, number] },
      { index: 2, world: [20, 0] as [number, number] },
    ]
    const [cluster] = clusterPoints(points, { radius: 50, zoom: 1 })
    expect(cluster.count).toBe(3)
    expect(cluster.world[0]).toBeCloseTo(10, 6)
  })

  it('loses nobody: every point lands in exactly one mark', () => {
    const points = grid(200, 7)
    for (const zoom of [0.25, 1, 4, 16]) {
      const clusters = clusterPoints(points, { radius: 60, zoom })
      const seen = clusters.flatMap((c) => c.members)
      expect(new Set(seen).size, `zoom ${zoom}`).toBe(200)
      expect(seen.length, `zoom ${zoom}`).toBe(200)
      expect(
        clusters.reduce((sum, c) => sum + c.count, 0),
        `zoom ${zoom}`,
      ).toBe(200)
    }
  })

  it('dissolves as the camera zooms in', () => {
    const points = grid(100, 8)
    const wide = clusterPoints(points, { radius: 60, zoom: 0.5 })
    const close = clusterPoints(points, { radius: 60, zoom: 40 })
    expect(wide.length).toBeLessThan(close.length)
    expect(close.every((c) => c.count === 1)).toBe(true)
  })

  it('reports bounds that contain every member', () => {
    const points = grid(60, 5)
    for (const cluster of clusterPoints(points, { radius: 80, zoom: 1 })) {
      const [[x0, y0], [x1, y1]] = cluster.bounds
      for (const m of cluster.members) {
        const [x, y] = points[m].world
        expect(x).toBeGreaterThanOrEqual(x0)
        expect(x).toBeLessThanOrEqual(x1)
        expect(y).toBeGreaterThanOrEqual(y0)
        expect(y).toBeLessThanOrEqual(y1)
      }
    }
  })

  it('honours minPoints by emitting singles rather than tiny clusters', () => {
    const points = [
      { index: 0, world: [0, 0] as [number, number] },
      { index: 1, world: [1, 0] as [number, number] },
    ]
    const clusters = clusterPoints(points, { radius: 50, zoom: 1, minPoints: 3 })
    expect(clusters).toHaveLength(2)
    expect(clusters.every((c) => c.count === 1)).toBe(true)
  })

  it('is deterministic', () => {
    const points = grid(120, 6)
    const a = clusterPoints(points, { radius: 45, zoom: 1 })
    const b = clusterPoints(points, { radius: 45, zoom: 1 })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('quantizes zoom into stable levels', () => {
    // The point of levels: a pan cannot change one, and a smooth zoom crosses a
    // handful rather than one per frame.
    expect(clusterLevel(1)).toBe(0)
    expect(clusterLevel(2)).toBe(1)
    expect(clusterLevel(1.05)).toBe(clusterLevel(1.1))
    expect(levelScale(clusterLevel(4))).toBe(4)
  })

  it('handles an empty input', () => {
    expect(clusterPoints([], { radius: 60, zoom: 1 })).toEqual([])
  })
})

describe('marker series', () => {
  const cities: MarkerDatum[] = [
    { name: 'A', lon: -30, lat: 10, category: 'office' },
    { name: 'B', lon: -28, lat: 11, category: 'office' },
    { name: 'C', lon: 30, lat: -10, category: 'depot' },
  ]

  it('draws one mark per datum', async () => {
    await render({ series: [{ type: 'marker', name: 'Sites', data: cities }] })
    expect(markGroups()).toHaveLength(3)
  })

  it('accepts lng as a synonym for lon', async () => {
    await render({
      series: [{ type: 'marker', data: [{ name: 'X', lng: 10, lat: 10 }] }],
    })
    expect(markGroups()).toHaveLength(1)
  })

  it('warns rather than silently dropping a datum with no position', async () => {
    const instance = await render({
      series: [{ type: 'marker', data: [{ name: 'nowhere' }, { name: 'here', lon: 0, lat: 0 }] }],
    })
    expect(markGroups()).toHaveLength(1)
    expect(instance.warnings.join(' ')).toMatch(/no position/)
  })

  it('colours by category and emits a legend for it', async () => {
    const instance = await render({
      legend: { show: true },
      series: [{ type: 'marker', name: 'Sites', data: cities, colorBy: 'category' }],
    })
    const series = instance.series[0] as MarkerSeries
    expect(series.colorScale).toBeTruthy()
    const items = series.legendItems()
    expect(items.map((i) => i.label).sort()).toEqual(['depot', 'office'])
    // Two categories, two colours.
    expect(new Set(items.map((i) => i.color)).size).toBe(2)
  })

  it('has no legend when nothing is being encoded by colour', async () => {
    const instance = await render({ series: [{ type: 'marker', data: cities }] })
    expect((instance.series[0] as MarkerSeries).legendItems()).toEqual([])
  })

  it('lets a datum override shape, colour and size', async () => {
    await render({
      series: [
        {
          type: 'marker',
          shape: 'circle',
          data: [{ name: 'special', lon: 0, lat: 0, shape: 'star', color: '#ff0000', size: 30 }],
        },
      ],
    })
    const shape = el.querySelector('path.apexmaps-mark-shape')
    expect(shape?.getAttribute('fill')).toBe('#ff0000')
    expect(shape?.getAttribute('d')).toBe(markerPath('star', 30))
  })

  it('gives every mark an invisible hit target bigger than its ink', async () => {
    await render({ series: [{ type: 'marker', size: 6, data: cities }] })
    const hit = el.querySelector<SVGCircleElement>('circle.apexmaps-mark-hit')
    // A 6px star has almost no ink; the hit area is what makes it clickable.
    expect(Number(hit?.getAttribute('r'))).toBeGreaterThanOrEqual(6)
  })

  it('advises when markers will overplot', async () => {
    const many = Array.from({ length: 600 }, (_, i) => ({
      name: `p${i}`,
      lon: -30 + (i % 30),
      lat: -10 + Math.floor(i / 30),
    }))
    const instance = await render({ series: [{ type: 'marker', data: many }] })
    const series = instance.series[0] as MarkerSeries
    expect(series.advise().join(' ')).toMatch(/overplot/)
    // ...and not when the caller has already asked for clustering.
    const clustered = new MarkerSeries({
      config: { type: 'marker', data: many, cluster: {} },
      geo: instance.geo!,
      index: 0,
      viewport: instance.viewport,
    })
    expect(clustered.advise().join(' ')).not.toMatch(/overplot/)
  })
})

describe('clustered markers', () => {
  const cluster20 = Array.from({ length: 20 }, (_, i) => ({
    name: `p${i}`,
    lon: -30 + (i % 5) * 0.2,
    lat: 10 + Math.floor(i / 5) * 0.2,
  }))

  it('collapses a dense group into fewer marks', async () => {
    await render({
      series: [{ type: 'marker', data: cluster20, cluster: {} }],
    })
    const groups = markGroups()
    expect(groups.length).toBeLessThan(20)
    expect(el.querySelectorAll('g.apexmaps-cluster').length).toBeGreaterThan(0)
  })

  it('labels a cluster with its member count', async () => {
    await render({ series: [{ type: 'marker', data: cluster20, cluster: {} }] })
    const labels = [...el.querySelectorAll('text.apexmaps-mark-label')].map((t) => t.textContent)
    expect(labels.length).toBeGreaterThan(0)
    const total = labels.reduce((sum, t) => sum + Number(t), 0)
    // Every point is accounted for by exactly one cluster label or single mark.
    const singles = markGroups().length - labels.length
    expect(total + singles).toBe(20)
  })

  it('does not cluster when clustering is off', async () => {
    await render({
      series: [{ type: 'marker', data: cluster20, cluster: { enabled: false } }],
    })
    expect(markGroups()).toHaveLength(20)
    expect(el.querySelectorAll('g.apexmaps-cluster')).toHaveLength(0)
  })

  it('does not recluster on a pan, only when the zoom level changes', async () => {
    const instance = await render({
      series: [{ type: 'marker', data: cluster20, cluster: {} }],
    })
    const redraws = vi.spyOn(instance.renderer!, 'drawMarks')

    // Twenty pans: the camera scale never changes, so no cluster work happens.
    for (let i = 0; i < 20; i++) instance.camera!.panBy(8, 4)
    expect(redraws).not.toHaveBeenCalled()

    // A large zoom crosses several quantized levels, but recomputes a handful of
    // times, not once per camera write.
    for (let i = 0; i < 20; i++) instance.camera!.zoomAbout(1.15, [400, 250])
    expect(redraws.mock.calls.length).toBeGreaterThan(0)
    expect(redraws.mock.calls.length).toBeLessThan(20)
    redraws.mockRestore()
  })

  it('dissolves clusters above the zoom threshold', async () => {
    const instance = await render({
      series: [{ type: 'marker', data: cluster20, cluster: { maxZoom: 4 } }],
    })
    const series = instance.series[0] as MarkerSeries
    expect(series.clusteringEnabled(1)).toBe(true)
    expect(series.clusteringEnabled(8)).toBe(false)
    expect(series.marks(8)).toHaveLength(20)
  })

  it('resolves a click on a cluster to the cluster, not to a data row', async () => {
    const instance = await render({
      series: [{ type: 'marker', data: cluster20, cluster: {} }],
    })
    const events: unknown[] = []
    instance.on('clusterClick', (payload) => events.push(payload))

    const clusterEl = el.querySelector('g.apexmaps-cluster')
    expect(clusterEl).toBeTruthy()
    // Click the label inside the group: hit resolution has to walk up to it.
    const child = clusterEl!.querySelector('text') ?? clusterEl!.querySelector('path')
    child!.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(events).toHaveLength(1)
  })

  it('zooms toward the members when a cluster is clicked', async () => {
    const instance = await render({
      series: [{ type: 'marker', data: cluster20, cluster: {} }],
    })
    const before = instance.viewport.camera.k
    const clusterEl = el.querySelector('g.apexmaps-cluster')
    clusterEl!.querySelector('path')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    // fitBounds animates, so assert the camera was asked to move rather than the
    // final scale.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(instance.viewport.camera.k).toBeGreaterThanOrEqual(before)
  })

  it('does not zoom to infinity when every member shares a position', async () => {
    const stacked = Array.from({ length: 5 }, (_, i) => ({ name: `s${i}`, lon: 5, lat: 5 }))
    const instance = await render({ series: [{ type: 'marker', data: stacked, cluster: {} }] })
    const clusterEl = el.querySelector('g.apexmaps-cluster')
    clusterEl!.querySelector('path')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(Number.isFinite(instance.viewport.camera.k)).toBe(true)
    expect(instance.viewport.camera.k).toBeLessThanOrEqual(64)
  })
})

describe('cluster count legibility', () => {
  /**
   * The count is the only text in the library that sits on a colour the caller
   * chose, so it cannot take the page's ink. A dark `cluster.color` drew a
   * near-black count on a near-black circle, which is unreadable and was visible
   * in the markers demo.
   */
  const clustered = (color: string) => ({
    geo: { map: WORLD, projection: 'equirectangular' },
    series: [
      {
        type: 'marker' as const,
        name: 'Sites',
        // Three points a few degrees apart: one cluster at this radius.
        data: [
          { lon: 0, lat: 0 },
          { lon: 0.4, lat: 0.3 },
          { lon: 0.8, lat: 0.1 },
        ] as MarkerDatum[],
        cluster: { radius: 60, minPoints: 2, color },
      },
    ],
  })

  const countLabel = () => el.querySelector<SVGTextElement>('text.apexmaps-mark-label')

  it('draws a light count on a dark cluster', async () => {
    await render(clustered('#4a5568'))
    const label = countLabel()
    expect(label?.textContent).toBe('3')
    expect(label?.getAttribute('fill')).toBe('#ffffff')
  })

  it('draws a dark count on a light cluster', async () => {
    await render(clustered('#f4d35e'))
    expect(countLabel()?.getAttribute('fill')).toBe('#1a1a1a')
  })
})
