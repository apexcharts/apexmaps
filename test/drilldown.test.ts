// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import ApexMaps from '../src/ApexMaps'
import { detectParentField, scopeToParent } from '../src/data/Hierarchy'
import { normalizeGeo } from '../src/geo/GeoData'

/**
 * Two levels shaped like the real packs: states keyed on a USPS abbreviation,
 * counties keyed on FIPS and carrying their parent's abbreviation. Neither level
 * can be joined to the other by key alone, which is the case that makes property
 * detection worth having.
 */
function box(properties, lon, lat, size = 6) {
  return {
    type: 'Feature',
    properties,
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [lon, lat],
          [lon + size, lat],
          [lon + size, lat + size],
          [lon, lat + size],
          [lon, lat],
        ],
      ],
    },
  }
}

const STATES = {
  type: 'FeatureCollection',
  features: [
    box({ abbr: 'CA', fips: '06', name: 'California' }, -30, 0, 12),
    box({ abbr: 'TX', fips: '48', name: 'Texas' }, 10, 0, 12),
  ],
}

const COUNTIES = {
  type: 'FeatureCollection',
  features: [
    box({ fips: '06001', name: 'Alameda', state_abbr: 'CA', state_fips: '06' }, -30, 0, 5),
    box({ fips: '06037', name: 'Los Angeles', state_abbr: 'CA', state_fips: '06' }, -24, 0, 5),
    box({ fips: '06075', name: 'San Francisco', state_abbr: 'CA', state_fips: '06' }, -30, 6, 5),
    box({ fips: '48001', name: 'Anderson', state_abbr: 'TX', state_fips: '48' }, 10, 0, 5),
    box({ fips: '48113', name: 'Dallas', state_abbr: 'TX', state_fips: '48' }, 16, 0, 5),
  ],
}

/** NUTS-shaped: hierarchical codes, no property naming the parent level. */
const NUTS2 = {
  type: 'FeatureCollection',
  features: [
    box({ nuts_id: 'DE11', name: 'Stuttgart', cntr_code: 'DE' }, 8, 48, 2),
    box({ nuts_id: 'DE12', name: 'Karlsruhe', cntr_code: 'DE' }, 8, 50, 2),
    box({ nuts_id: 'DE21', name: 'Oberbayern', cntr_code: 'DE' }, 11, 48, 2),
    box({ nuts_id: 'FR10', name: 'Ile-de-France', cntr_code: 'FR' }, 2, 48, 2),
  ],
}

describe('Hierarchy: parent-child detection', () => {
  const counties = normalizeGeo(COUNTIES, { keyField: 'fips' })
  const nuts2 = normalizeGeo(NUTS2, { keyField: 'nuts_id' })

  it('detects the property that names the parent', () => {
    expect(detectParentField(counties.features, 'CA')).toBe('state_abbr')
    expect(detectParentField(counties.features, '06')).toBe('state_fips')
  })

  it('returns no field when nothing holds the parent key', () => {
    expect(detectParentField(counties.features, 'NY')).toBe(null)
    expect(detectParentField(counties.features, '')).toBe(null)
  })

  it('prefers the field matching the most features over the first one seen', () => {
    // 'Dallas' is one county's name *and* one county's invented region label. The
    // field that describes three counties has to win over the field that describes
    // one, or a coincidence in the data picks the hierarchy.
    const withDecoy = normalizeGeo(
      {
        type: 'FeatureCollection',
        features: COUNTIES.features.map((f, i) => ({
          ...f,
          properties: { ...f.properties, region: i === 0 ? 'CA' : `r${i}` },
        })),
      },
      { keyField: 'fips' },
    )
    expect(detectParentField(withDecoy.features, 'CA')).toBe('state_abbr')
  })

  it('scopes a child level by the detected property', () => {
    const scoped = scopeToParent(counties, 'CA')
    expect(scoped.method).toBe('property')
    expect(scoped.field).toBe('state_abbr')
    expect(scoped.count).toBe(3)
    expect(scoped.geo.features.map((f) => f.key)).toEqual(['06001', '06037', '06075'])
    expect(scoped.note).toContain('state_abbr')
  })

  it('renumbers feature indices to array positions', () => {
    // Everything downstream reads `index` as a position: the DOM key, the anchor
    // map, the join. Keeping the parent level's indices would hit-test the wrong
    // feature, or none.
    const scoped = scopeToParent(counties, 'TX')
    expect(scoped.geo.features.map((f) => f.index)).toEqual([0, 1])
    expect(scoped.geo.features[1].key).toBe('48113')
  })

  it('keeps the collection aligned with the features', () => {
    // The collection is what the projection is fitted to. If it still held all
    // five counties, drilling into California would fit the view to Texas as well.
    const scoped = scopeToParent(counties, 'CA')
    expect(scoped.geo.collection.features).toHaveLength(3)
    expect(scoped.geo.collection.features[0].properties.name).toBe('Alameda')
  })

  it('falls back to a key prefix when no property names the parent', () => {
    const scoped = scopeToParent(nuts2, 'DE1')
    expect(scoped.method).toBe('keyPrefix')
    expect(scoped.geo.features.map((f) => f.key)).toEqual(['DE11', 'DE12'])
  })

  it('takes the property route when both would work', () => {
    // 'DE' matches cntr_code exactly and is also a prefix of every German code.
    // The exact test wins, because a prefix is only ever as good as the code system.
    const scoped = scopeToParent(nuts2, 'DE')
    expect(scoped.method).toBe('property')
    expect(scoped.field).toBe('cntr_code')
    expect(scoped.count).toBe(3)
  })

  it('never matches the parent as its own child by prefix', () => {
    const mixed = normalizeGeo(
      {
        type: 'FeatureCollection',
        features: [box({ nuts_id: 'DE1', name: 'Baden' }, 8, 48, 2), ...NUTS2.features],
      },
      { keyField: 'nuts_id' },
    )
    const scoped = scopeToParent(mixed, 'DE1', { scope: 'keyPrefix' })
    expect(scoped.geo.features.map((f) => f.key)).toEqual(['DE11', 'DE12'])
  })

  it("returns the whole level for scope 'all'", () => {
    const scoped = scopeToParent(counties, 'CA', { scope: 'all' })
    expect(scoped.method).toBe('all')
    expect(scoped.count).toBe(5)
    expect(scoped.geo).toBe(counties)
  })

  it('honours an explicit parentField and reports when it matches nothing', () => {
    expect(scopeToParent(counties, '06', { parentField: 'state_fips' }).count).toBe(3)

    const missed = scopeToParent(counties, 'CA', {
      scope: 'property',
      parentField: 'state_fips',
    })
    expect(missed.method).toBe('none')
    expect(missed.count).toBe(0)
    expect(missed.note).toContain('state_fips')
  })

  it('reports no match rather than an empty map, with a way out', () => {
    const scoped = scopeToParent(counties, 'NY')
    expect(scoped.method).toBe('none')
    expect(scoped.note).toContain('parentField')
    expect(scoped.note).toContain("scope: 'all'")
  })
})

let el
let map

beforeEach(() => {
  el = document.createElement('div')
  document.body.appendChild(el)

  // The camera clock advances 400 ms per frame, so every transition completes in
  // one frame. A frozen clock (the usual jsdom stub) makes an awaited camera move
  // never resolve, which is why the other suites all pass `transition: 'jump'`.
  let now = 0
  vi.stubGlobal('requestAnimationFrame', ((cb: FrameRequestCallback) =>
    setTimeout(() => cb((now += 400)), 0)) as unknown as typeof requestAnimationFrame)
  vi.stubGlobal('cancelAnimationFrame', ((id: number) =>
    clearTimeout(id)) as unknown as typeof cancelAnimationFrame)

  ApexMaps.registerMap('test/states', STATES, { keyField: 'abbr', levelName: 'States' })
  ApexMaps.registerMap('test/counties', COUNTIES, { keyField: 'fips', levelName: 'Counties' })
  ApexMaps.registerMap('test/nuts2', NUTS2, { keyField: 'nuts_id', levelName: 'Basic regions' })
})

afterEach(() => {
  map?.destroy?.()
  map = null
  el.remove()
  vi.unstubAllGlobals()
})

/** Rows for both levels in one array, which is the declarative way to feed a drill. */
const BOTH_LEVELS = [
  { key: 'CA', value: 40 },
  { key: 'TX', value: 30 },
  { key: '06001', value: 1 },
  { key: '06037', value: 10 },
  { key: '06075', value: 8 },
  { key: '48001', value: 2 },
  { key: '48113', value: 26 },
]

async function render(overrides = {}) {
  map = new ApexMaps(el, {
    chart: { width: 400, height: 300 },
    geo: { map: 'test/states', projection: 'equirectangular' },
    debug: { enabled: false },
    series: [
      {
        name: 'Sales',
        joinBy: { data: 'key' },
        data: BOTH_LEVELS,
        drilldown: { map: 'test/counties' },
      },
    ],
    ...overrides,
  })
  await map.render()
  return map
}

const keysOnScreen = () =>
  [...el.querySelectorAll('path.apexmaps-feature')].map((p) => p.getAttribute('data-key'))

function once(instance, event) {
  return new Promise((resolve) => instance.on(event, resolve))
}

/** The screen box a GeoJSON object occupies, as `[x0, y0, x1, y1]`. */
function screenBox(instance, object) {
  const bounds = instance.viewport.measure(object)
  const [ax, ay] = instance.viewport.worldToScreen(bounds[0])
  const [bx, by] = instance.viewport.worldToScreen(bounds[1])
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)]
}

const centre = ([x0, y0, x1, y1]) => [(x0 + x1) / 2, (y0 + y1) / 2]
const size = ([x0, y0, x1, y1]) => [x1 - x0, y1 - y0]

const featureObject = (instance, key) => {
  const feature = instance.geo.features.find((f) => f.key === key)
  return { type: 'Feature', geometry: feature.geometry, properties: {} }
}

/**
 * Observe the state a level change hands over.
 *
 * The camera settle is the last move either direction makes, so whatever `look`
 * reads when it starts is the frame the reader actually sees the swap in. The
 * spy is how a test gets at it: the transition is awaited by the call, so by the
 * time `drillTo` resolves the handoff has already been eased away.
 */
function onSettle(instance, look) {
  const easeTo = instance.camera.easeTo.bind(instance.camera)
  const seen = []
  instance.camera.easeTo = (target) => {
    seen.push(look())
    return easeTo(target)
  }
  return () => seen[seen.length - 1]
}

const featurePaths = () => [...el.querySelectorAll('path.apexmaps-feature')]
/** Marks still waiting for the ripple: the seed is the only thing that writes this. */
const seeded = () => featurePaths().filter((p) => p.getAttribute('stroke-opacity') === '0')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe('drilldown', () => {
  it('replaces the map with the clicked feature’s children', async () => {
    await render()
    expect(keysOnScreen()).toEqual(['CA', 'TX'])

    const entered = await map.drillTo('CA')

    expect(entered).toBe(true)
    expect(map.drillDepth).toBe(1)
    expect(keysOnScreen()).toEqual(['06001', '06037', '06075'])
    expect(map.mapId).toBe('test/counties')
    expect(map.drillPath).toEqual([{ key: 'CA', name: 'California', mapId: 'test/counties' }])
  })

  it('joins the same data array at the child level', async () => {
    // No second series, no data reload: rows for both levels live in one array and
    // each level picks up the ones that match it.
    await render()
    expect(map.series[0].values.get(0)).toBe(40)

    await map.drillTo('CA')
    expect(map.series[0].values.get(1)).toBe(10)
    expect(map.diagnoseJoin().matched).toBe(3)
  })

  it('uses the child pack’s recommended key, not the parent’s', async () => {
    // The states pack recommends `abbr` and the counties pack `fips`. Ingesting the
    // child with the parent's recommendation would key every county on nothing.
    await render()
    expect(map.geo.keyField).toBe('abbr')
    await map.drillTo('CA')
    expect(map.geo.keyField).toBe('fips')
  })

  it('fits the child level and resets the camera', async () => {
    await render()
    await map.drillTo('CA')
    // The child is fitted to its own extent, so a neutral camera shows all of it.
    expect(map.viewport.camera.k).toBe(1)
    const bounds = map.viewport.worldBounds
    expect(bounds[1][0] - bounds[0][0]).toBeGreaterThan(200)
  })

  it('lands the child level on the place the parent feature had on screen', async () => {
    await render()

    // The framing the drilldown itself does, measured up front: this is the box
    // California occupies at the moment the swap happens.
    await map.frameFeature('CA', { padding: 24, transition: 'jump' })
    const parent = screenBox(map, featureObject(map, 'CA'))
    await map.resetView({ transition: 'jump' })

    const handoff = onSettle(map, () =>
      map.mapId === 'test/counties' ? screenBox(map, map.geo.collection) : null,
    )
    await map.drillTo('CA')

    // Same place, same size: the counties arrive where the state was rather than
    // at their own fit, so nothing about the geography jumps across the swap. The
    // child fills the box on its constraining axis and is centred on the other,
    // which is what fitting one box inside another means.
    const child = handoff()
    expect(centre(child)[0]).toBeCloseTo(centre(parent)[0], 1)
    expect(centre(child)[1]).toBeCloseTo(centre(parent)[1], 1)
    expect(size(child)[0]).toBeLessThanOrEqual(size(parent)[0] + 0.5)
    expect(size(child)[1]).toBeLessThanOrEqual(size(parent)[1] + 0.5)
    expect(
      Math.max(size(child)[0] / size(parent)[0], size(child)[1] / size(parent)[1]),
    ).toBeCloseTo(1, 2)

    // And it settles onto its own fit afterwards, so the reader ends where the
    // level means to be read.
    expect(map.viewport.camera.k).toBe(1)
  })

  it('climbs out of wherever the reader had moved to in the child', async () => {
    await render()
    await map.drillTo('CA')

    // Deep inside one county, so the child level is nowhere near its own fit and
    // a fixed padding would have nothing to do with what is on screen.
    map.camera.jumpTo({ zoom: 4 })
    const left = screenBox(map, map.geo.collection)

    const handoff = onSettle(map, () =>
      map.mapId === 'test/states' ? screenBox(map, featureObject(map, 'CA')) : null,
    )
    await map.drillUp()

    // The state starts the climb occupying the box its counties just had.
    const entry = handoff()
    expect(centre(entry)[0]).toBeCloseTo(centre(left)[0], 1)
    expect(centre(entry)[1]).toBeCloseTo(centre(left)[1], 1)
    expect(Math.max(size(entry)[0] / size(left)[0], size(entry)[1] / size(left)[1])).toBeCloseTo(
      1,
      2,
    )
  })

  it('fades the level it leaves out over the one that replaces it', async () => {
    await render()

    const during = onSettle(map, () => ({
      copies: el.querySelectorAll('.apexmaps-ghost').length,
      keys: keysOnScreen(),
    }))
    await map.drillTo('CA')

    // One copy of the outgoing level, over the incoming one, for the length of
    // the settle.
    expect(during().copies).toBe(1)
    // And it answers nothing: a copy that still looked like a feature would have
    // the map reporting both levels to a query, a hit test or an export while it
    // faded.
    expect(during().keys).toEqual(['06001', '06037', '06075'])
    // Gone by the time the call resolves, so the DOM is settled whenever the
    // promise is.
    expect(el.querySelector('.apexmaps-ghost')).toBe(null)
  })

  it('develops the child level out of the colour the parent was', async () => {
    await render()
    const parentFill = el.querySelector('path.apexmaps-feature[data-key="CA"]').getAttribute('fill')

    await map.drillTo('CA')

    // Marks the ripple has not reached yet are still the parent's flat colour with
    // no boundary of their own, which is what makes the level start as a copy of
    // the shape it came from rather than as an already-divided map.
    const waiting = seeded()
    expect(waiting.length).toBeGreaterThan(0)
    for (const path of waiting) expect(path.getAttribute('fill')).toBe(parentFill)

    // And once it has reached all of them, nothing is left holding either the
    // borrowed colour or the attribute that hid its boundary.
    await wait(320)
    expect(seeded()).toEqual([])
    for (const path of featurePaths()) expect(path.hasAttribute('stroke-opacity')).toBe(false)
  })

  it('puts the marks back if the map goes away mid-ripple', async () => {
    await render()
    await map.drillTo('CA')
    const paths = featurePaths()
    expect(seeded().length).toBeGreaterThan(0)

    map.destroy()

    // Detached, but not left holding a colour they borrowed from a level that no
    // longer exists: a reveal cut short still finishes what it started.
    for (const path of paths) expect(path.hasAttribute('stroke-opacity')).toBe(false)
  })

  it('cuts straight to the child level when asked not to animate', async () => {
    await render({
      series: [
        {
          name: 'Sales',
          joinBy: { data: 'key' },
          data: BOTH_LEVELS,
          drilldown: { map: 'test/counties', animate: 'none' },
        },
      ],
    })

    const during = onSettle(map, () => el.querySelectorAll('.apexmaps-ghost').length)
    await map.drillTo('CA')

    // No zoom, no copy, no ripple, no settle: the child is simply there, at its
    // own fit, drawn as it will stay.
    expect(during()).toBe(undefined)
    expect(map.viewport.camera).toEqual({ k: 1, x: 0, y: 0 })
    expect(keysOnScreen()).toEqual(['06001', '06037', '06075'])
    expect(seeded()).toEqual([])
  })

  it('drills on click, and does not also select', async () => {
    await render()
    const clicked = vi.fn()
    map.on('featureClick', clicked)
    const drilled = once(map, 'drilldown')

    el.querySelector('path.apexmaps-feature').dispatchEvent(
      new window.MouseEvent('click', { bubbles: true }),
    )
    const payload = await drilled

    expect(clicked).toHaveBeenCalledOnce()
    expect(payload).toMatchObject({
      key: 'CA',
      name: 'California',
      from: 'test/states',
      to: 'test/counties',
      depth: 1,
      featureCount: 3,
    })
    // The key belongs to a level that no longer exists, so selecting it would
    // leave the map in a state the reader cannot see or clear.
    expect(map.selection.size).toBe(0)
  })

  it('renders a trail whose first crumb goes back to the top', async () => {
    await render()
    expect(el.querySelector('.apexmaps-breadcrumb')).toBe(null)

    await map.drillTo('CA')
    const nav = el.querySelector('.apexmaps-breadcrumb')
    expect(nav.textContent).toContain('States')
    expect(nav.textContent).toContain('California')
    expect(nav.querySelector('.apexmaps-breadcrumb-current').textContent).toBe('California')

    const back = nav.querySelector('button.apexmaps-breadcrumb-item')
    back.click()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(map.drillDepth).toBe(0)
    expect(keysOnScreen()).toEqual(['CA', 'TX'])
    expect(el.querySelector('.apexmaps-breadcrumb')).toBe(null)
  })

  it('names the root crumb from the option when given one', async () => {
    await render({
      series: [
        {
          name: 'Sales',
          joinBy: { data: 'key' },
          data: BOTH_LEVELS,
          drilldown: { map: 'test/counties', breadcrumb: { rootLabel: 'United States' } },
        },
      ],
    })
    await map.drillTo('CA')
    expect(el.querySelector('.apexmaps-breadcrumb').textContent).toContain('United States')
  })

  it('omits the trail when asked to', async () => {
    await render({
      series: [
        {
          name: 'Sales',
          joinBy: { data: 'key' },
          data: BOTH_LEVELS,
          drilldown: { map: 'test/counties', breadcrumb: false },
        },
      ],
    })
    await map.drillTo('CA')
    expect(el.querySelector('.apexmaps-breadcrumb')).toBe(null)
  })

  it('climbs back out on Escape, restoring the level exactly', async () => {
    await render()
    map.camera.jumpTo({ zoom: 2 })
    const zoomed = { ...map.viewport.camera }

    await map.drillTo('CA')
    const left = once(map, 'drillup')
    el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await left

    expect(map.drillDepth).toBe(0)
    expect(keysOnScreen()).toEqual(['CA', 'TX'])
    expect(map.mapId).toBe('test/states')
    // The camera comes back to where the reader left it, not to the default fit.
    expect(map.viewport.camera.k).toBeCloseTo(zoomed.k, 5)
    expect(map.viewport.camera.x).toBeCloseTo(zoomed.x, 5)
  })

  it('leaves Escape alone at the top level', async () => {
    await render()
    const event = new window.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    el.dispatchEvent(event)
    // Nothing to climb, so the a11y meaning of Escape ("leave the map") stands.
    expect(event.defaultPrevented).toBe(false)
  })

  it('returns to the top from any depth', async () => {
    await render({
      series: [
        {
          name: 'Sales',
          joinBy: { data: 'key' },
          data: BOTH_LEVELS,
          // Two levels down: states, then counties, then the NUTS-shaped pack, so
          // the function form gets exercised across levels.
          drilldown: {
            map: (context) => (context.depth === 1 ? 'test/counties' : 'test/nuts2'),
            scope: 'all',
          },
        },
      ],
    })

    expect(await map.drillTo('CA')).toBe(true)
    expect(await map.drillTo('06037')).toBe(true)
    expect(map.drillDepth).toBe(2)

    expect(await map.drillUp(Infinity)).toBe(true)
    expect(map.drillDepth).toBe(0)
    expect(map.mapId).toBe('test/states')
    expect(keysOnScreen()).toEqual(['CA', 'TX'])
  })

  it('declines when the child map is the one already on screen', async () => {
    await render({
      series: [
        {
          name: 'Sales',
          joinBy: { data: 'key' },
          data: BOTH_LEVELS,
          drilldown: { map: 'test/states' },
        },
      ],
    })

    expect(await map.drillTo('CA')).toBe(false)
    expect(map.drillDepth).toBe(0)
    expect(map.warnings.join('\n')).toContain('already on screen')
  })

  it('declines rather than drawing an empty map, and puts the camera back', async () => {
    await render()
    const before = { ...map.viewport.camera }

    // No county belongs to Nevada, because no county says so.
    map.geo.features[0].key = 'NV'
    expect(await map.drillTo('NV')).toBe(false)

    expect(map.drillDepth).toBe(0)
    expect(map.mapId).toBe('test/states')
    expect(map.viewport.camera.k).toBeCloseTo(before.k, 5)
    expect(map.warnings.join('\n')).toContain('was cancelled')
  })

  it('declines a function form that returns nothing', async () => {
    await render({
      series: [
        {
          name: 'Sales',
          joinBy: { data: 'key' },
          data: BOTH_LEVELS,
          drilldown: { map: (context) => (context.key === 'TX' ? 'test/counties' : null) },
        },
      ],
    })
    expect(await map.drillTo('CA')).toBe(false)
    expect(await map.drillTo('TX')).toBe(true)
  })

  it('does nothing for an unknown key or a series with no drilldown', async () => {
    await render()
    expect(await map.drillTo('ZZ')).toBe(false)
    expect(await map.drillUp()).toBe(false)

    await map.updateSeries([{ name: 'Sales', joinBy: { data: 'key' }, data: BOTH_LEVELS }])
    expect(await map.drillTo('CA')).toBe(false)
  })

  it('re-describes itself for assistive technology at the new level', async () => {
    await render({ a11y: { enabled: true, description: 'auto' } })
    const svg = el.querySelector('svg')
    const before = svg.querySelector('desc').textContent

    await map.drillTo('CA')

    const after = svg.querySelector('desc').textContent
    expect(after).not.toBe(before)
    expect(after).toContain('3 areas')
    expect(svg.getAttribute('aria-label')).toContain('3 areas')
    expect(el.querySelector('[role="status"]').textContent).toContain('California')
  })

  it('drills on Enter from keyboard navigation, exactly like a click', async () => {
    // Mouse users click to drill; Escape (the way back out) already worked from
    // the keyboard. A one-way keyboard path is not parity.
    await render({ a11y: { enabled: true } })
    const svg = el.querySelector('svg')
    const drilled = once(map, 'drilldown')

    svg.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    svg.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    await drilled
    expect(map.drillDepth).toBe(1)
    expect(keysOnScreen()).toEqual(['06001', '06037', '06075'])
    // Drilling is not selecting: the parent key must not linger in the selection.
    expect(map.selection.size).toBe(0)
  })

  it('still toggles selection on Enter when the series has no drilldown', async () => {
    await render({
      a11y: { enabled: true },
      series: [{ name: 'Sales', joinBy: { data: 'key' }, data: BOTH_LEVELS }],
    })
    const svg = el.querySelector('svg')

    svg.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    svg.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    expect(map.drillDepth).toBe(0)
    expect([...map.selection]).toEqual(['CA'])
  })

  it('abandons the trail when the caller changes the map', async () => {
    await render()
    await map.drillTo('CA')
    expect(map.drillDepth).toBe(1)

    await map.updateOptions({ geo: { map: 'test/nuts2' } })

    expect(map.drillDepth).toBe(0)
    expect(el.querySelector('.apexmaps-breadcrumb')).toBe(null)
    expect(keysOnScreen()).toEqual(['DE11', 'DE12', 'DE21', 'FR10'])
  })

  it('keeps the child level across a resize', async () => {
    await render({ chart: { width: '100%', height: 300 } })
    await map.drillTo('CA')
    map._relayout()
    expect(keysOnScreen()).toEqual(['06001', '06037', '06075'])
    expect(map.drillDepth).toBe(1)
  })

  it('ignores a second click while a level is loading', async () => {
    await render()
    const first = map.drillTo('CA')
    const second = map.drillTo('TX')
    expect(await Promise.all([first, second])).toEqual([true, false])
    expect(map.drillDepth).toBe(1)
    expect(keysOnScreen()).toEqual(['06001', '06037', '06075'])
  })
})
