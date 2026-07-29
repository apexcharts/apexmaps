// @vitest-environment jsdom
/**
 * Every declared option either works or says so.
 *
 * These pins come out of the 2026-07-26 audit, which found option keys that
 * could be set and did nothing (worse than absent), plus
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

describe('chart.width and chart.height after render', () => {
  /**
   * Found while building the React wrapper, whose natural way to express a size
   * is a prop that becomes `updateOptions({ chart: { height } })`.
   *
   * A size only takes effect once it is measured: the viewport, the plot box, the
   * renderer surfaces and every projected coordinate come from that measurement.
   * `render()` measured, and the ResizeObserver measured, but the observer is only
   * attached when a size is a *string* (fluid), so an explicit numeric height
   * changed the config and nothing else, with nothing thrown and no warning. The
   * fourth instance of the same shape: implemented, declared, and never read.
   */
  it('resizes the viewport and the plot when a numeric size changes', async () => {
    await render()
    expect(map.viewport.height).toBe(300)

    await map.updateOptions({ chart: { height: 520, width: 640 } })

    expect(map.viewport.height).toBe(520)
    expect(map.viewport.width).toBe(640)
    expect(map.plot.style.height).toBe('520px')
    expect(map.plot.style.width).toBe('640px')
  })

  it('reprojects, so geometry fills the new box rather than the old one', async () => {
    await render()
    const pathOf = () =>
      (map.renderer.pathFor('s0', 'AAA') || map.renderer.pathFor('base', 'AAA'))?.getAttribute('d')
    const before = pathOf()
    expect(before).toBeTruthy()

    await map.updateOptions({ chart: { height: 900 } })

    // The element is reused, which is the point of the mark store, so the geometry
    // is the thing to compare. Without the reprojection this is byte-identical and
    // the map is simply drawn small inside a tall box.
    expect(pathOf()).not.toBe(before)
  })

  it('emits resized, the same as a container-driven resize', async () => {
    await render()
    const seen = []
    map.on('resized', (payload) => seen.push(payload))

    await map.updateOptions({ chart: { height: 480 } })

    expect(seen).toEqual([{ width: 400, height: 480 }])
  })

  it('does not relayout when the size did not change', async () => {
    await render()
    const spy = vi.spyOn(map.viewport, 'resize')

    await map.updateOptions({ legend: { position: 'top' } })

    expect(spy).not.toHaveBeenCalled()
  })
})

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

  it('is not re-ingested when the caller passes the same geometry again', async () => {
    // The other half of the same bug, found by the Vue wrapper on 2026-07-29.
    // `buildConfig` was taught to pass object geometry through by reference, but
    // `updateOptions` merges into the accumulated options first, and *that* merge
    // still deep-cloned it. So the guard only held for callers who omitted `geo`
    // from every update, which no declarative wrapper can do: a framework binding
    // hands over the whole tree every time.
    //
    // The cost was not just the clone of a possibly multi-megabyte topology. The
    // clone made the next call's identity check see a different map, which
    // re-resolved it, re-ingested it, and abandoned the drilldown trail, for a
    // legend tweak.
    await render()
    const geoBefore = map.geo
    await map.updateOptions({ geo: { map: THREE_BOXES }, legend: { show: false } })

    expect(map.config.geo.map).toBe(THREE_BOXES)
    expect(map.geo).toBe(geoBefore)

    // Twice, because the first call is what plants the clone that the second one
    // then compares against.
    await map.updateOptions({ geo: { map: THREE_BOXES }, legend: { show: true } })
    expect(map.config.geo.map).toBe(THREE_BOXES)
    expect(map.geo).toBe(geoBefore)
  })

  it('keeps the drilldown trail when an update repeats the geometry', async () => {
    // The user-visible half: a reader two levels deep, and a parent component
    // re-rendering with the same options, used to land them back at the top.
    await render()
    map.userOptions.geo.map = THREE_BOXES
    const geoBefore = map.geo

    await map.updateOptions({ geo: { map: THREE_BOXES }, legend: { position: 'top' } })

    expect(map.drillDepth).toBe(0)
    expect(map.geo).toBe(geoBefore)
    expect(map.config.legend.position).toBe('top')
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
    expect(all).toContain('geo.boundaries')
    // Implemented since: value transitions read chart.animations, a story
    // context turns the entrance fade on, annotations draw, and chart.renderer
    // selects a real tier. Warning for any of them again would be a regression
    // in the other direction.
    expect(all).not.toContain('chart.animations')
    expect(all).not.toContain("chart.context 'story'")
    expect(all).not.toContain('annotations are not implemented')
    expect(all).not.toContain('is not implemented yet; this version always renders SVG')
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
