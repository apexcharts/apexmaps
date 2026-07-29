// @vitest-environment jsdom
/**
 * The proximity ("voronoi") hit layer.
 *
 * What is under test is an interaction contract, not geometry: a pointer near a
 * small point mark behaves as if it were on it, the nearest mark wins, direct
 * hits keep their precedence, and what the tooltip attributes a position to is
 * what a click at that position acts on. The last one is the honesty property:
 * hover and click disagreeing about what the pointer means is worse than
 * either behaviour alone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ApexMaps from '../src/ApexMaps'

const WORLD = JSON.parse(
  readFileSync(resolve(process.cwd(), 'node_modules/world-atlas/countries-110m.json'), 'utf8'),
)

// Sydney deliberately carries a small value: its bubble ink is ~9px, so a
// pointer 14px from its centre is genuinely off the mark and only the
// proximity layer can attribute it.
const CITIES = [
  { name: 'London', lon: -0.13, lat: 51.5, value: 90 },
  { name: 'Paris', lon: 2.35, lat: 48.85, value: 60 },
  { name: 'Sydney', lon: 151.2, lat: -33.9, value: 5 },
]

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

function bubbleAt(key: string): { circle: SVGCircleElement; x: number; y: number } {
  const circle = [...el.querySelectorAll<SVGCircleElement>('circle.apexmaps-bubble')].find(
    (c) => c.getAttribute('data-key') === key,
  )!
  expect(circle).toBeTruthy()
  return {
    circle,
    x: Number(circle.getAttribute('cx')),
    y: Number(circle.getAttribute('cy')),
  }
}

function svgRoot(): SVGSVGElement {
  return el.querySelector<SVGSVGElement>('svg.apexmaps-svg')!
}

function moveOn(target: Element, x: number, y: number) {
  target.dispatchEvent(
    new window.PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y }),
  )
}

function clickOn(target: Element, x: number, y: number) {
  target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: x, clientY: y }))
}

describe('proximity hover', () => {
  it('hovers a bubble the pointer is near but not on', async () => {
    await render({ series: [{ type: 'bubble', name: 'Cities', data: CITIES }] })
    const hover = vi.fn()
    map.on('markHover', hover)

    const { circle, x, y } = bubbleAt('Sydney')
    moveOn(svgRoot(), x + 14, y)

    expect(hover).toHaveBeenCalledTimes(1)
    expect(hover.mock.calls[0][0].key).toBe('Sydney')
    expect(hover.mock.calls[0][0].value).toBe(5)
    expect(map.hovered?.markKey).toBe('Sydney')
    expect(circle.classList.contains('is-hovered')).toBe(true)
    expect(map.tooltip.visible).toBe(true)
  })

  it('does nothing beyond the radius', async () => {
    await render({ series: [{ type: 'bubble', name: 'Cities', data: CITIES }] })
    const hover = vi.fn()
    map.on('markHover', hover)

    const { x, y } = bubbleAt('Sydney')
    moveOn(svgRoot(), x + 60, y)

    expect(hover).not.toHaveBeenCalled()
    expect(map.hovered).toBeNull()
  })

  it('resolves to the nearest of several candidates', async () => {
    await render({ series: [{ type: 'bubble', name: 'Cities', data: CITIES }] })
    const hover = vi.fn()
    map.on('markHover', hover)

    // London and Paris sit ~10 screen px apart on a 960px world, so both are
    // inside each other's catchment. Standing on Paris must resolve Paris.
    const paris = bubbleAt('Paris')
    moveOn(svgRoot(), paris.x, paris.y)

    expect(hover).toHaveBeenCalledTimes(1)
    expect(hover.mock.calls[0][0].key).toBe('Paris')
  })

  it('re-hovering the same mark does not re-emit', async () => {
    await render({ series: [{ type: 'bubble', name: 'Cities', data: CITIES }] })
    const hover = vi.fn()
    map.on('markHover', hover)

    const { x, y } = bubbleAt('Sydney')
    moveOn(svgRoot(), x + 14, y)
    moveOn(svgRoot(), x + 12, y + 3)

    expect(hover).toHaveBeenCalledTimes(1)
  })

  it('a direct hit on another mark takes over, and leaving it clears', async () => {
    await render({ series: [{ type: 'bubble', name: 'Cities', data: CITIES }] })

    const sydney = bubbleAt('Sydney')
    moveOn(svgRoot(), sydney.x + 14, sydney.y)
    expect(map.hovered?.markKey).toBe('Sydney')

    // Sliding straight from the catchment onto another mark's ink fires no
    // pointerout (the proximity mark was never under the pointer), so the
    // takeover itself must release the old mark's hover styling.
    const london = bubbleAt('London')
    london.circle.dispatchEvent(
      new window.PointerEvent('pointerover', {
        bubbles: true,
        clientX: london.x,
        clientY: london.y,
      }),
    )
    expect(map.hovered?.markKey).toBe('London')
    expect(sydney.circle.classList.contains('is-hovered')).toBe(false)

    london.circle.dispatchEvent(new window.PointerEvent('pointerout', { bubbles: true }))
    expect(map.hovered).toBeNull()
  })

  it('steals hover from the feature underneath and hands it back on leaving', async () => {
    await render({ series: [{ type: 'bubble', name: 'Cities', data: CITIES }] })
    const { x, y } = bubbleAt('Sydney')

    // The reader's pointer enters a country, far from any bubble.
    const feature = el.querySelector<SVGPathElement>('path.apexmaps-feature')!
    feature.dispatchEvent(
      new window.PointerEvent('pointerover', { bubbles: true, clientX: x + 100, clientY: y }),
    )
    const featureKey = map.hovered?.markKey
    expect(featureKey).toBeTruthy()

    // Drifting into the bubble's catchment, still over the same feature
    // element: the bubble wins.
    moveOn(feature, x + 14, y)
    expect(map.hovered?.markKey).toBe('Sydney')

    // Drifting back out: the feature resumes without a new pointerover,
    // because the pointer never left its element.
    const featureHover = vi.fn()
    map.on('featureHover', featureHover)
    moveOn(feature, x + 100, y)
    expect(map.hovered?.markKey).toBe(featureKey)
    expect(featureHover).toHaveBeenCalledTimes(1)
  })

  it('leaving the plot clears a proximity hover', async () => {
    await render({ series: [{ type: 'bubble', name: 'Cities', data: CITIES }] })
    const { x, y } = bubbleAt('Sydney')
    moveOn(svgRoot(), x + 14, y)
    expect(map.hovered?.markKey).toBe('Sydney')

    svgRoot().dispatchEvent(new window.PointerEvent('pointerleave'))
    expect(map.hovered).toBeNull()
    expect(map.tooltip.visible).toBe(false)
  })
})

describe('proximity click', () => {
  it('acts on the nearby mark, not the feature underneath', async () => {
    await render({ series: [{ type: 'bubble', name: 'Cities', data: CITIES }] })
    const featureClick = vi.fn()
    const markClick = vi.fn()
    map.on('featureClick', featureClick)
    map.on('markClick', markClick)

    const { x, y } = bubbleAt('Sydney')
    const feature = el.querySelector<SVGPathElement>('path.apexmaps-feature')!
    clickOn(feature, x + 14, y)

    expect(markClick).toHaveBeenCalledTimes(1)
    expect(markClick.mock.calls[0][0].key).toBe('Sydney')
    expect(featureClick).not.toHaveBeenCalled()
    expect([...map.selection]).toContain('Sydney')
  })

  it('leaves clicks beyond the radius to the feature', async () => {
    await render({ series: [{ type: 'bubble', name: 'Cities', data: CITIES }] })
    const featureClick = vi.fn()
    map.on('featureClick', featureClick)

    const { x, y } = bubbleAt('Sydney')
    const feature = el.querySelector<SVGPathElement>('path.apexmaps-feature')!
    clickOn(feature, x + 60, y)

    expect(featureClick).toHaveBeenCalledTimes(1)
  })
})

describe('proximity and clusters', () => {
  it('resolves to the standing cluster, not its hidden members', async () => {
    await render({
      series: [
        {
          type: 'marker',
          name: 'Offices',
          cluster: {},
          data: [
            { name: 'London', lon: -0.13, lat: 51.5 },
            { name: 'Paris', lon: 2.35, lat: 48.85 },
          ],
        },
      ],
    })

    const clusters = map.series[0].clusters(map.viewport.camera.k)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].count).toBe(2)

    const hover = vi.fn()
    map.on('markHover', hover)
    const [cx, cy] = map.viewport.worldToScreen(clusters[0].world)
    moveOn(svgRoot(), cx + 12, cy)

    expect(hover).toHaveBeenCalledTimes(1)
    expect(hover.mock.calls[0][0].name).toMatch(/Cluster of 2/)
    expect(map.hovered?.markKey).toBe('cluster-0')
  })

  it('a click near a cluster zooms into it rather than selecting', async () => {
    await render({
      series: [
        {
          type: 'marker',
          name: 'Offices',
          cluster: {},
          data: [
            { name: 'London', lon: -0.13, lat: 51.5 },
            { name: 'Paris', lon: 2.35, lat: 48.85 },
          ],
        },
      ],
    })

    const clusterClick = vi.fn()
    const markClick = vi.fn()
    map.on('clusterClick', clusterClick)
    map.on('markClick', markClick)

    const clusters = map.series[0].clusters(map.viewport.camera.k)
    const [cx, cy] = map.viewport.worldToScreen(clusters[0].world)
    clickOn(svgRoot(), cx + 12, cy)

    expect(clusterClick).toHaveBeenCalledTimes(1)
    expect(markClick).not.toHaveBeenCalled()
    expect(map.selection.size).toBe(0)
  })
})

describe('configuration', () => {
  it('can be disabled', async () => {
    await render({
      interaction: { nearest: { enabled: false } },
      series: [{ type: 'bubble', name: 'Cities', data: CITIES }],
    })
    const hover = vi.fn()
    map.on('markHover', hover)

    const { x, y } = bubbleAt('Sydney')
    moveOn(svgRoot(), x + 14, y)

    expect(hover).not.toHaveBeenCalled()
    expect(map.hovered).toBeNull()
  })

  it('honours a custom radius', async () => {
    await render({
      interaction: { nearest: { radius: 80 } },
      series: [{ type: 'bubble', name: 'Cities', data: CITIES }],
    })
    const { x, y } = bubbleAt('Sydney')
    moveOn(svgRoot(), x + 60, y)
    expect(map.hovered?.markKey).toBe('Sydney')
  })

  it('the radius is screen pixels at any zoom', async () => {
    await render({ series: [{ type: 'bubble', name: 'Cities', data: CITIES }] })
    map.camera.jumpTo({ k: 4, x: 0, y: 0 })

    const item = map.series[0].items.find((i: any) => i.key === 'Sydney')
    const [sx, sy] = map.viewport.worldToScreen(item.world)

    // 15 screen px away: inside the 20px catchment.
    moveOn(svgRoot(), sx + 15, sy)
    expect(map.hovered?.markKey).toBe('Sydney')

    // 30 screen px away: outside it. A radius interpreted in world units
    // would be 80 screen px at this zoom and would wrongly catch this.
    moveOn(svgRoot(), sx + 30, sy)
    expect(map.hovered).toBeNull()
  })
})
