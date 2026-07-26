// @vitest-environment jsdom
/**
 * Every declared option either works or says so.
 *
 * These pins come out of the 2026-07-26 audit, which found option keys that
 * could be set and did nothing (worse than absent: SCOPE.md section 0), plus
 * three lifecycle defects: interaction options frozen at first render, inline
 * geometry re-ingested on every options change because merging cloned it, and
 * mark stores surviving destroy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import ApexMaps from '../src/ApexMaps'

function box(key, name, lon, lat) {
  return {
    type: 'Feature',
    properties: { iso_a3: key, name },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [lon, lat],
          [lon + 8, lat],
          [lon + 8, lat + 8],
          [lon, lat + 8],
          [lon, lat],
        ],
      ],
    },
  }
}

const THREE_BOXES = {
  type: 'FeatureCollection',
  features: [box('AAA', 'Alpha', -30, 0), box('BBB', 'Beta', -10, 0), box('CCC', 'Gamma', 10, 0)],
}

let el
let map

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

async function render(options = {}) {
  map = new ApexMaps(el, {
    chart: { width: 400, height: 300 },
    geo: { map: THREE_BOXES, projection: 'equirectangular' },
    debug: { enabled: false },
    series: [
      {
        name: 'Metric',
        joinBy: ['iso_a3', 'key'],
        data: [
          { key: 'AAA', value: 1 },
          { key: 'BBB', value: 2 },
          { key: 'CCC', value: 3 },
        ],
      },
    ],
    ...options,
  })
  await map.render()
  return map
}

describe('inline geometry across option updates', () => {
  it('is not re-ingested when unrelated options change', async () => {
    // Merging used to clone object-form geo.map on every rebuild, so the
    // identity check in updateOptions saw a changed map on every call and
    // re-ingested the geometry (and abandoned any drill trail) for a legend
    // tweak.
    await render()
    const geoBefore = map.geo
    await map.updateOptions({ legend: { show: false } })
    expect(map.geo).toBe(geoBefore)
  })

  it('is re-ingested when the caller actually passes new geometry', async () => {
    await render()
    const geoBefore = map.geo
    const twoBoxes = {
      type: 'FeatureCollection',
      features: [box('DDD', 'Delta', -30, 0), box('EEE', 'Epsilon', -10, 0)],
    }
    await map.updateOptions({ geo: { map: twoBoxes } })
    expect(map.geo).not.toBe(geoBefore)
    expect(map.geo.features).toHaveLength(2)
  })
})

describe('interaction options after render', () => {
  it('rebuilds the gesture handling when interaction options change', async () => {
    await render()
    const before = map.zoomPan
    await map.updateOptions({ interaction: { selection: { modifier: 'alt' } } })
    expect(map.zoomPan).not.toBe(before)
    expect(map.zoomPan.options.selection.modifier).toBe('alt')
  })

  it('keeps the gesture handling when interaction options did not change', async () => {
    // Recreating drops a gesture mid-flight, so it must only happen when the
    // interaction tree actually changed.
    await render()
    const before = map.zoomPan
    await map.updateOptions({ legend: { show: false } })
    expect(map.zoomPan).toBe(before)
  })
})

describe('states.hover stroke', () => {
  it('applies the hover outline and restores the series stroke after', async () => {
    await render({ states: { hover: { stroke: '#ff0000', strokeWidth: 3 } } })
    const path = el.querySelector('path.apexmaps-feature')

    path.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true }))
    expect(path.getAttribute('stroke')).toBe('#ff0000')
    expect(path.getAttribute('stroke-width')).toBe('3')

    path.dispatchEvent(new window.PointerEvent('pointerout', { bubbles: true }))
    expect(path.getAttribute('stroke')).toBe('#ffffff')
    expect(path.getAttribute('stroke-width')).toBe('0.5')
  })

  it('restores the selection outline, not the series default, on a selected mark', async () => {
    await render({ states: { hover: { stroke: '#ff0000' } } })
    map.setSelection(['AAA'])
    const path = el.querySelector('path.apexmaps-feature[data-key="AAA"]')

    path.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true }))
    path.dispatchEvent(new window.PointerEvent('pointerout', { bubbles: true }))
    expect(path.getAttribute('stroke')).toBe('#111111')
  })
})

describe('legend.align and legend.showNull', () => {
  it('centres the legend by default, as the declared default says', async () => {
    await render()
    expect(el.querySelector('.apexmaps-legend--align-center')).not.toBeNull()
  })

  it('honours an explicit align', async () => {
    await render({ legend: { align: 'right' } })
    expect(el.querySelector('.apexmaps-legend--align-right')).not.toBeNull()
  })

  it('drops the no-data swatch when showNull is false', async () => {
    const partial = {
      series: [
        {
          name: 'Metric',
          joinBy: ['iso_a3', 'key'],
          data: [
            { key: 'AAA', value: 1 },
            { key: 'BBB', value: 2 },
          ],
        },
      ],
    }
    await render(partial)
    expect(el.querySelector('.apexmaps-legend-item.is-null')).not.toBeNull()
    map.destroy()

    el = document.createElement('div')
    document.body.appendChild(el)
    await render({ ...partial, legend: { showNull: false } })
    expect(el.querySelector('.apexmaps-legend-item.is-null')).toBeNull()
  })
})

describe('a11y.dataTable on symbol series', () => {
  it('renders a table from the series rows on a bubble map', async () => {
    // dataTable: true that only worked on choropleths would be an accessibility
    // option that silently fails on every other map type.
    await render({
      series: [
        {
          type: 'bubble',
          name: 'Population',
          data: [
            { name: 'A', lon: -26, lat: 4, value: 5 },
            { name: 'B', lon: -6, lat: 4, value: 9 },
          ],
        },
      ],
      a11y: { enabled: true, dataTable: true },
    })
    const table = el.querySelector('table.apexmaps-data-table')
    expect(table).not.toBeNull()
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(table.textContent).toContain('Population')
  })
})

describe('unimplemented options say so', () => {
  it('warns for each declared option that has no effect yet', async () => {
    await render({
      chart: { renderer: 'canvas', animations: { speed: 'fast' }, context: 'story' },
      geo: { map: THREE_BOXES, projection: 'equirectangular', boundaries: 'neutral-dashed' },
      annotations: { points: [{ at: [0, 0] }] },
    })
    const all = map.warnings.join('\n')
    expect(all).toContain("chart.renderer 'canvas'")
    expect(all).toContain('annotations are not implemented')
    expect(all).toContain('chart.animations')
    expect(all).toContain("chart.context 'story'")
    expect(all).toContain('geo.boundaries')
  })

  it('stays quiet when only implemented options are set', async () => {
    await render()
    expect(map.warnings.join('\n')).not.toContain('not implemented')
  })
})

describe('renderer teardown', () => {
  it('clears the mark stores on destroy', async () => {
    await render({
      series: [
        {
          type: 'marker',
          name: 'Sites',
          data: [
            { name: 'A', lon: -26, lat: 4 },
            { name: 'B', lon: -6, lat: 4 },
          ],
        },
      ],
    })
    const renderer = map.renderer as unknown as {
      marksByKey: Map<string, unknown>
      markWorld: Map<string, unknown>
    }
    expect(renderer.marksByKey.size).toBeGreaterThan(0)
    map.destroy()
    map = null
    expect(renderer.marksByKey.size).toBe(0)
    expect(renderer.markWorld.size).toBe(0)
  })
})
