// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import ApexMaps from '../src/ApexMaps'

/**
 * Three adjacent lat/lon boxes, correctly wound. Small enough to reason about,
 * real enough to exercise projection, join, scale, legend and a11y together.
 */
const THREE_BOXES = {
  type: 'FeatureCollection',
  features: [box('AAA', 'Alpha', -30, 0), box('BBB', 'Beta', -10, 0), box('CCC', 'Gamma', 10, 0)],
}

/**
 */
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

let el
let map

beforeEach(() => {
  el = document.createElement('div')
  document.body.appendChild(el)
  // jsdom has no layout, so explicit pixel sizes keep the viewport deterministic.
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

/**
 */
async function render(options = {}) {
  map = new ApexMaps(el, {
    chart: { width: 400, height: 300, type: 'choropleth' },
    geo: { map: THREE_BOXES, projection: 'equirectangular' },
    debug: { enabled: false },
    series: [
      {
        name: 'Score',
        joinBy: ['iso_a3', 'code'],
        data: [
          { code: 'AAA', value: 10 },
          { code: 'BBB', value: 50 },
          { code: 'CCC', value: 90 },
        ],
      },
    ],
    ...options,
  })
  await map.render()
  return map
}

describe('ApexMaps render', () => {
  it('renders one SVG path per feature with distinct fills', async () => {
    await render()
    const paths = el.querySelectorAll('path.apexmaps-feature')
    expect(paths).toHaveLength(3)

    const fills = [...paths].map((p) => p.getAttribute('fill'))
    expect(new Set(fills).size).toBe(3)
    for (const fill of fills) expect(fill).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('carries join keys and indices on the DOM for hit-testing', async () => {
    await render()
    const keys = [...el.querySelectorAll('path.apexmaps-feature')].map((p) =>
      p.getAttribute('data-key'),
    )
    expect(keys).toEqual(['AAA', 'BBB', 'CCC'])
  })

  it('keeps borders visually constant under zoom', async () => {
    await render()
    const path = el.querySelector('path.apexmaps-feature')
    expect(path?.getAttribute('vector-effect')).toBe('non-scaling-stroke')
  })

  it('renders a legend with one entry per class', async () => {
    await render()
    const items = el.querySelectorAll('.apexmaps-legend-item')
    // 3 values across 5 quantile classes, so some classes are empty but present.
    expect(items.length).toBeGreaterThanOrEqual(3)
    expect(el.querySelector('.apexmaps-legend-title')?.textContent).toBe('Score')
  })

  it('mutes a class when its legend entry is clicked', async () => {
    await render()
    const before = [...el.querySelectorAll('path.apexmaps-feature')].map((p) =>
      p.getAttribute('fill'),
    )
    const item = el.querySelector('.apexmaps-legend-item' as HTMLElement)
    item.click()
    const after = [...el.querySelectorAll('path.apexmaps-feature')].map((p) =>
      p.getAttribute('fill'),
    )
    expect(after).not.toEqual(before)
  })

  it('applies the camera as a single group transform', async () => {
    await render()
    const world = el.querySelector('g.apexmaps-world')
    expect(world?.getAttribute('transform')).toMatch(/translate\([-\d.]+,[-\d.]+\) scale\([\d.]+\)/)
  })

  it('exposes an accessible name, description and live region', async () => {
    await render()
    const svg = el.querySelector('svg')
    expect(svg?.getAttribute('role')).toBe('application')
    expect(svg?.getAttribute('aria-label')).toContain('Choropleth map of 3 areas')
    const description = svg?.querySelector('desc')?.textContent ?? ''
    expect(description).toContain('Score')
    expect(description).toContain('Gamma')
    // Each clause is a sentence, so each one starts with a capital: this text is
    // read aloud, and "map of 3 areas. showing Score. values range from" is what
    // machine output sounds like.
    for (const sentence of description.split('. ')) {
      if (sentence.trim()) expect(sentence.trim()[0]).toBe(sentence.trim()[0].toUpperCase())
    }
    // And the class summary names a span, not four numbers joined by three "to"s.
    expect(description).toMatch(/\d+ classes spanning .+ to .+, the lowest being/)
    expect(el.querySelector('[aria-live="polite"]')).toBeTruthy()
  })

  it('announces the focused feature on arrow-key navigation', async () => {
    await render()
    const svg = el.querySelector('svg' as SVGSVGElement)
    svg.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    const live = el.querySelector('[aria-live="polite"]')
    expect(live?.textContent).toMatch(/(Alpha|Beta|Gamma), Score \d+/)
  })

  it('renders an optional hidden data table', async () => {
    await render({
      a11y: { enabled: true, dataTable: true, description: 'auto' },
    })
    const table = el.querySelector('table.apexmaps-data-table')
    expect(table).toBeTruthy()
    expect(table?.querySelectorAll('tbody tr')).toHaveLength(3)
  })

  it('shows a tooltip on hover and hides it on out', async () => {
    await render()
    const path = el.querySelector('path.apexmaps-feature' as Element)
    path.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true }))
    const tooltip = el.querySelector('.apexmaps-tooltip' as HTMLElement)
    expect(tooltip.style.display).toBe('block')
    expect(tooltip.textContent).toContain('Alpha')

    path.dispatchEvent(new window.PointerEvent('pointerout', { bubbles: true }))
    expect(tooltip.style.display).toBe('none')
  })

  it('emits featureClick and tracks selection', async () => {
    const onClick = vi.fn()
    await render()
    map.on('featureClick', onClick)

    const path = el.querySelectorAll('path.apexmaps-feature')[1]
    path.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))

    expect(onClick).toHaveBeenCalledOnce()
    expect(onClick.mock.calls[0][0]).toMatchObject({
      key: 'BBB',
      name: 'Beta',
      value: 50,
    })
    expect(map.selection.has('BBB')).toBe(true)
    expect(path.classList.contains('is-selected')).toBe(true)
  })

  it('renders unmatched features as no-data, not as the lowest class', async () => {
    await render({
      series: [
        {
          name: 'Sparse',
          joinBy: ['iso_a3', 'code'],
          data: [{ code: 'AAA', value: 10 }],
        },
      ],
    })

    const paths = [...el.querySelectorAll('path.apexmaps-feature')]
    const nullColor = map.series[0].scale.nullColor
    expect(paths[0].getAttribute('fill')).not.toBe(nullColor)
    expect(paths[1].getAttribute('fill')).toBe(nullColor)
    expect(paths[2].getAttribute('fill')).toBe(nullColor)
  })

  it('reports join failures through diagnoseJoin', async () => {
    await render({
      series: [
        {
          name: 'Broken',
          joinBy: ['iso_a3', 'code'],
          data: [{ code: 'Alpha', value: 1 }],
        },
      ],
    })

    const join = map.diagnoseJoin()
    expect(join.matched).toBe(0)
    expect(join.unmatchedData[0].suggestions[0].featureKey).toBe('AAA')
    expect(join.report()).toContain('did you mean')
  })

  it('applies normalizeBy and says so in the legend title', async () => {
    await render({
      series: [
        {
          name: 'Cases',
          joinBy: ['iso_a3', 'code'],
          normalizeBy: 'population',
          data: [
            { code: 'AAA', value: 100, population: 10 },
            { code: 'BBB', value: 100, population: 100 },
            { code: 'CCC', value: 100, population: 1000 },
          ],
        },
      ],
    })

    expect(map.series[0].valueFor(map.geo.features[0])).toBe(10)
    expect(el.querySelector('.apexmaps-legend-title')?.textContent).toBe('Cases (per population)')
  })

  it('advises against mapping raw counts', async () => {
    await render({
      series: [
        {
          name: 'Population',
          joinBy: ['iso_a3', 'code'],
          data: [
            { code: 'AAA', value: 5000 },
            { code: 'BBB', value: 90000 },
            { code: 'CCC', value: 1200000 },
          ],
        },
      ],
    })

    expect(map.series[0].advise().join(' ')).toContain('raw counts')
  })

  it('renders labels only where they fit', async () => {
    await render({ dataLabels: { enabled: true, minFeatureArea: 0 } })
    const labels = el.querySelectorAll('text.apexmaps-label')
    expect(labels.length).toBeGreaterThan(0)
    expect([...labels].map((l) => l.textContent)).toContain('Alpha')
    expect(labels[0].getAttribute('paint-order')).toBe('stroke')
  })

  it('drops labels for features below the area threshold', async () => {
    await render({ dataLabels: { enabled: true, minFeatureArea: 1e9 } })
    expect(el.querySelectorAll('text.apexmaps-label')).toHaveLength(0)
  })

  it('updates fills in place on updateSeries without rebuilding paths', async () => {
    await render()
    const pathsBefore = [...el.querySelectorAll('path.apexmaps-feature')]
    const fillsBefore = pathsBefore.map((p) => p.getAttribute('fill'))

    map.updateSeries([
      {
        name: 'Score',
        joinBy: ['iso_a3', 'code'],
        data: [
          { code: 'AAA', value: 90 },
          { code: 'BBB', value: 50 },
          { code: 'CCC', value: 10 },
        ],
      },
    ])

    const pathsAfter = [...el.querySelectorAll('path.apexmaps-feature')]
    // Same DOM nodes, new fills: that is what makes the update tween instead of
    // flashing.
    expect(pathsAfter[0]).toBe(pathsBefore[0])
    expect(pathsAfter[0].getAttribute('fill')).not.toBe(fillsBefore[0])
  })

  it('switches projection through updateOptions', async () => {
    await render()
    const before = el.querySelector('path.apexmaps-feature')?.getAttribute('d')
    await map.updateOptions({ geo: { projection: 'equalEarth' } })
    const after = el.querySelector('path.apexmaps-feature')?.getAttribute('d')
    expect(after).not.toBe(before)
    expect(map.viewport.projectionName).toBe('equalEarth')
  })

  it('draws the graticule and sphere only when asked', async () => {
    await render()
    expect(el.querySelector('.apexmaps-graticule')).toBeNull()

    await map.updateOptions({
      geo: { graticule: { show: true }, sphere: { show: true } },
    })
    expect(el.querySelector('.apexmaps-graticule')).toBeTruthy()
    expect(el.querySelector('.apexmaps-sphere')).toBeTruthy()
  })

  it('serialises the effective spec, dropping functions', async () => {
    await render({ tooltip: { formatter: () => 'x' } })
    const spec = map.toSpec()
    expect(spec.geo.projection).toBe('equirectangular')
    expect(spec.series[0].name).toBe('Score')
    expect(spec.tooltip.formatter).toBeUndefined()
    expect(() => JSON.stringify(spec)).not.toThrow()
  })

  it('carries no watermark when only free-tier features are used', async () => {
    await render()
    // The pricing decision in SCOPE.md: the watermark is the premium-feature trial
    // state, never a tax on basic maps.
    expect(el.querySelector('[data-apex-watermark], .apex-watermark')).toBeNull()
    expect(el.textContent).not.toMatch(/unlicensed|watermark/i)
  })

  it('cleans up the DOM and listeners on destroy', async () => {
    await render()
    expect(el.querySelector('svg')).toBeTruthy()
    map.destroy()
    expect(el.querySelector('svg')).toBeNull()
    expect(el.querySelector('.apexmaps-tooltip')).toBeNull()
    expect(el.classList.contains('apexmaps')).toBe(false)
    map = null
  })

  it('throws a helpful error for an unknown registered map', async () => {
    const bad = new ApexMaps(el, { geo: { map: 'nope/does-not-exist' } })
    await expect(bad.render()).rejects.toThrow(/unknown map/)
  })

  it('supports registering geometry by id', async () => {
    ApexMaps.registerMap('test/boxes@2026', THREE_BOXES, {
      source: 'synthetic',
      license: 'public domain',
      vintage: '2026',
    })
    expect(ApexMaps.listMaps()).toContain('test/boxes@2026')

    await render({
      geo: { map: 'test/boxes@2026', projection: 'equirectangular' },
    })
    expect(el.querySelectorAll('path.apexmaps-feature')).toHaveLength(3)
    expect(map.mapMeta.vintage).toBe('2026')
  })

  it('exposes the palette registry, so a picker does not hard-code the list', () => {
    // The counterpart of listMaps() and listProjections(). Without it, any palette
    // UI (or docs table, or demo gallery) has to keep its own copy of the list.
    const names = ApexMaps.listPalettes()
    expect(names).toContain('blues')
    expect(names).toContain('okabeIto')
    expect(names.length).toBeGreaterThanOrEqual(17)

    const blues = ApexMaps.palette('blues')
    expect(blues.kind).toBe('sequential')
    expect(blues.stops[0]).toMatch(/^#/)
    expect(ApexMaps.palette('no-such-palette')).toBeUndefined()

    ApexMaps.registerPalette('test/ramp', { kind: 'sequential', stops: ['#000', '#fff'] })
    expect(ApexMaps.listPalettes()).toContain('test/ramp')
  })

  it('renders an attribution string automatically when the licence requires it', async () => {
    ApexMaps.registerMap('test/attributed@2026', THREE_BOXES, {
      attribution: '© Test Data Consortium',
    })
    await render({
      geo: { map: 'test/attributed@2026', projection: 'equirectangular' },
    })
    expect(el.querySelector('.apexmaps-attribution')?.textContent).toBe('© Test Data Consortium')
  })
})

describe('geo.view.fit as a bounding box', () => {
  /** Pixel distance between two lon/lat points under the fitted projection. */
  function span(instance, a, b) {
    const p = instance.viewport.project(a)
    const q = instance.viewport.project(b)
    return Math.hypot(q[0] - p[0], q[1] - p[1])
  }

  it('fits the box, not the whole sphere minus the box', async () => {
    // The ring handed to d3-geo has to wind clockwise. Wound the other way, d3
    // reads the box as a hole in the world, fits the world, and the requested
    // region ends up a few pixels across: a silent, plausible-looking wrong map.
    const tight = await render({ geo: { map: THREE_BOXES, view: { fit: [-30, 0, 18, 8] } } })
    const tightSpan = span(tight, [-30, 0], [18, 8])
    tight.destroy()

    const world = await render({ geo: { map: THREE_BOXES, view: { fit: 'world' } } })
    const worldSpan = span(world, [-30, 0], [18, 8])

    expect(tightSpan).toBeGreaterThan(worldSpan * 2)
    // 48 degrees of longitude across a 400 px canvas: most of the width.
    expect(tightSpan).toBeGreaterThan(300)
  })

  it('centres the requested box', async () => {
    const instance = await render({ geo: { map: THREE_BOXES, view: { fit: [-10, -10, 10, 10] } } })
    const centre = instance.viewport.project([0, 0])
    expect(centre[0]).toBeCloseTo(200, 0)
    expect(centre[1]).toBeCloseTo(150, 0)
  })
})

describe('camera', () => {
  it('frames a feature by key', async () => {
    await render()
    const before = { ...map.viewport.camera }
    await map.frameFeature('CCC', { transition: 'jump', padding: 10 })
    expect(map.viewport.camera.k).toBeGreaterThan(before.k)
  })

  it('resets to the initial fit', async () => {
    await render()
    await map.frameFeature('CCC', { transition: 'jump' })
    await map.resetView({ transition: 'jump' })
    expect(map.viewport.camera.k).toBeCloseTo(1, 1)
  })

  it('zooms about a fixed screen point', async () => {
    await render()
    const anchor = [100, 150] as [number, number]
    const worldBefore = map.viewport.screenToWorld(anchor)
    map.camera.zoomAbout(2, anchor)
    const worldAfter = map.viewport.screenToWorld(anchor)
    expect(worldAfter[0]).toBeCloseTo(worldBefore[0], 6)
    expect(worldAfter[1]).toBeCloseTo(worldBefore[1], 6)
  })

  it('clamps zoom to the configured range', async () => {
    await render({ interaction: { zoom: { min: 1, max: 4 } } })
    map.camera.set({ k: 100 })
    expect(map.viewport.camera.k).toBe(4)
    map.camera.set({ k: 0.01 })
    expect(map.viewport.camera.k).toBe(1)
  })
})
