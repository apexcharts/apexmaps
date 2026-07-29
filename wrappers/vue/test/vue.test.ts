// @vitest-environment jsdom
/**
 * The Vue 3 component.
 *
 * Most of what matters here is the same as in the React wrapper (which update path
 * a change takes, what happens to a change that lands before the first render
 * resolves), and those are pinned again rather than assumed, because the two
 * wrappers reach the core through different machinery.
 *
 * What is genuinely different is the change model, and it is the first thing tested.
 * A React caller replaces `options`; a Vue caller mutates reactive state in place,
 * so the last-applied options and the current props are the same object and a
 * wrapper that kept a reference would compare an object against itself, conclude
 * nothing changed, and never update. Hence the snapshot, and hence the two tests
 * that mutate rather than replace.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { reactive, nextTick, markRaw, isReactive } from 'vue'
import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import ApexMaps from 'apexmaps'
import type { ApexMapsOptions } from 'apexmaps'
import ApexMapsVue from '../src/ApexMapsVue'

/** Three adjacent lat/lon boxes, correctly wound, matching the core suite. */
const THREE_BOXES = {
  type: 'FeatureCollection',
  features: [box('AAA', 'Alpha', -30), box('BBB', 'Beta', -10), box('CCC', 'Gamma', 10)],
}

function box(key: string, name: string, lon: number) {
  return {
    type: 'Feature',
    properties: { iso_a3: key, name },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [lon, 0],
          [lon + 8, 0],
          [lon + 8, 8],
          [lon, 8],
          [lon, 0],
        ],
      ],
    },
  }
}

function options(extra: Record<string, unknown> = {}): ApexMapsOptions {
  return {
    chart: { width: 400, height: 300 },
    geo: { map: THREE_BOXES, projection: 'equirectangular' },
    ...extra,
  } as ApexMapsOptions
}

const DATA = [
  { key: 'AAA', value: 1 },
  { key: 'BBB', value: 2 },
  { key: 'CCC', value: 3 },
]

/** A settled mount: the geometry promise and the post-flush watchers are done. */
async function mountMap(props: Record<string, unknown>) {
  const wrapper = mount(ApexMapsVue, { props: props as never, attachTo: document.body })
  await flush()
  return wrapper
}

async function flush() {
  // Generous on purpose. An update that lands mid-load queues behind the render
  // promise and then calls `updateOptions`, which awaits its own geometry
  // resolution, so a single tick settles neither. Mutation testing confirms this
  // still fails when the queue is removed rather than papering over it.
  for (let i = 0; i < 6; i++) {
    await nextTick()
    await Promise.resolve()
  }
}

const mapOf = (wrapper: VueWrapper) => (wrapper.vm as unknown as { map: ApexMaps | null }).map

const featureCount = (wrapper: VueWrapper) =>
  wrapper.element.querySelectorAll('path.apexmaps-feature').length

let live: VueWrapper | null = null

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame)
  vi.stubGlobal('cancelAnimationFrame', ((id: number) =>
    clearTimeout(id)) as unknown as typeof cancelAnimationFrame)
})

afterEach(() => {
  live?.unmount()
  live = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the Vue change model', () => {
  it('sees an option mutated in place on reactive state', async () => {
    // The case a reference comparison cannot see: nothing was replaced, so the
    // object the wrapper would be holding is the object that just changed.
    const state = reactive(options({ legend: { position: 'bottom' } }) as Record<string, unknown>)
    live = await mountMap({ options: state })
    const map = mapOf(live) as ApexMaps
    const updateOptions = vi.spyOn(map, 'updateOptions')

    ;(state.legend as Record<string, unknown>).position = 'top'
    await flush()

    expect(updateOptions).toHaveBeenCalledTimes(1)
    expect(map.config.legend?.position).toBe('top')
  })

  it('sees series data pushed onto a reactive array', async () => {
    const series = reactive([{ type: 'choropleth', data: [...DATA] }])
    live = await mountMap({ options: options(), series })
    const map = mapOf(live) as ApexMaps
    const updateSeries = vi.spyOn(map, 'updateSeries')

    ;(series[0] as { data: unknown[] }).data.push({ key: 'DDD', value: 4 })
    await flush()

    expect(updateSeries).toHaveBeenCalledTimes(1)
  })

  it('never hands the core a reactive object', async () => {
    // `reactive()` proxies lazily, on access, so a reactive topology given to the
    // core becomes a proxy per feature, per geometry and per coordinate array as
    // the ingest walks it: tens of thousands of proxies for a county map, and a
    // trap on every read after that. Nothing throws and nothing looks wrong, which
    // is why it needs a test rather than a comment.
    const state = reactive(options() as Record<string, unknown>)
    live = await mountMap({ options: state })
    const map = mapOf(live) as ApexMaps

    expect(isReactive(state.geo)).toBe(true)
    expect(map.config.geo?.map).toBe(THREE_BOXES)
    expect(isReactive(map.config.geo?.map)).toBe(false)
    expect(isReactive(map.geo?.features[0]?.properties)).toBe(false)
  })

  it('holds the instance without making it reactive', async () => {
    // `ref()` converts an object it holds into a reactive proxy, so the exposed
    // instance would be a proxied ApexMaps: every method running with `this` bound
    // to the proxy, and every element it hands out being a proxy rather than the
    // node. The core keeps element-keyed bookkeeping and compares `event.target`
    // against stored elements, and a proxy is not `===` the node it wraps, so this
    // is a silent lookup failure rather than a slowdown.
    live = await mountMap({ options: options() })
    const map = mapOf(live) as ApexMaps

    expect(isReactive(map)).toBe(false)
    expect(map.element).toBe(live.element.firstElementChild)
    expect(isReactive(map.element)).toBe(false)
  })

  it('still compares geometry by identity once it has been unwrapped', async () => {
    // The trap in unwrapping: comparing an unwrapped snapshot against live props
    // compares a raw topology with its own proxy, so the geometry reads as new and
    // the map reprojects on every tick. Both sides have to be snapshots.
    const state = reactive(options() as Record<string, unknown>)
    live = await mountMap({ options: state })
    const map = mapOf(live) as ApexMaps
    const updateOptions = vi.spyOn(map, 'updateOptions')

    ;(state.chart as Record<string, unknown>).background = '#eee'
    await flush()
    ;(state.chart as Record<string, unknown>).background = '#ddd'
    await flush()

    // Two real changes, two updates. A raw-against-proxy comparison would also
    // pass this count while reprojecting needlessly, so the geometry identity is
    // asserted directly.
    expect(updateOptions).toHaveBeenCalledTimes(2)
    expect(map.config.geo?.map).toBe(THREE_BOXES)
  })

  it('works when the caller marks the geometry raw, as the README suggests', async () => {
    const state = reactive({
      chart: { width: 400, height: 300 },
      geo: { map: markRaw(THREE_BOXES), projection: 'equirectangular' },
    } as Record<string, unknown>)
    live = await mountMap({ options: state })

    expect(featureCount(live)).toBe(3)
    expect(mapOf(live)?.rendered).toBe(true)
  })
})

describe('mounting', () => {
  it('renders a map into an element the core owns', async () => {
    live = await mountMap({ options: options(), series: [{ type: 'choropleth', data: DATA }] })

    expect(featureCount(live)).toBe(3)
    expect(mapOf(live)?.rendered).toBe(true)
    const inner = live.element.firstElementChild as HTMLElement
    expect(mapOf(live)?.element).toBe(inner)
    expect(inner.classList.contains('apexmaps')).toBe(true)
  })

  it('puts fallthrough attributes on the outer element only', async () => {
    live = await mountMap({ options: options(), class: 'my-map', id: 'here' })

    const outer = live.element as HTMLElement
    expect(outer.className).toBe('my-map')
    expect(outer.id).toBe('here')
    expect((outer.firstElementChild as HTMLElement).classList.contains('apexmaps')).toBe(true)
  })

  it('keeps the core styling when the caller changes class', async () => {
    // Vue patches `class` by assigning the whole attribute, exactly as React does,
    // so a shared element would lose 'apexmaps' here and every rule in the
    // stylesheet would stop matching.
    live = await mountMap({ options: options(), class: 'light' })
    const inner = live.element.firstElementChild as HTMLElement

    await live.setProps({ class: 'dark' } as never)
    await flush()

    expect((live.element as HTMLElement).className).toBe('dark')
    expect(inner.classList.contains('apexmaps')).toBe(true)
    expect(featureCount(live)).toBe(3)
  })

  it('destroys the instance on unmount', async () => {
    const destroy = vi.spyOn(ApexMaps.prototype, 'destroy')
    const wrapper = await mountMap({ options: options() })
    const element = wrapper.element as HTMLElement

    wrapper.unmount()

    expect(destroy).toHaveBeenCalledTimes(1)
    expect(element.querySelector('.apexmaps-plot')).toBeNull()
  })

  it('does not throw when unmounted before the first render resolves', async () => {
    const wrapper = mount(ApexMapsVue, {
      props: { options: options() } as never,
      attachTo: document.body,
    })
    await nextTick()
    expect(() => wrapper.unmount()).not.toThrow()
    await flush()

    expect(document.body.querySelectorAll('path.apexmaps-feature')).toHaveLength(0)
  })
})

describe('update routing', () => {
  async function watched(props: Record<string, unknown>) {
    const wrapper = await mountMap(props)
    const map = mapOf(wrapper) as ApexMaps
    return {
      wrapper,
      map,
      updateOptions: vi.spyOn(map, 'updateOptions'),
      updateSeries: vi.spyOn(map, 'updateSeries'),
    }
  }

  it('ignores a replaced options object that is equal', async () => {
    const w = await watched({ options: options(), series: [{ type: 'choropleth', data: DATA }] })
    live = w.wrapper

    await w.wrapper.setProps({
      options: options(),
      series: [{ type: 'choropleth', data: DATA.map((d) => ({ ...d })) }],
    } as never)
    await flush()

    expect(w.updateOptions).not.toHaveBeenCalled()
    expect(w.updateSeries).not.toHaveBeenCalled()
  })

  it('ignores an inline formatter whose identity changed', async () => {
    const w = await watched({
      options: options({ dataLabels: { formatter: (v: unknown) => `${v}!` } }),
    })
    live = w.wrapper

    await w.wrapper.setProps({
      options: options({ dataLabels: { formatter: (v: unknown) => `${v}!` } }),
    } as never)
    await flush()

    expect(w.updateOptions).not.toHaveBeenCalled()
  })

  it('notices a formatter whose source actually changed', async () => {
    // The snapshot keeps functions by reference for exactly this. Cloning one into
    // a wrapper would give every formatter the same source, so `equal` would report
    // two different formatters as identical and a real edit would never apply.
    const w = await watched({
      options: options({ dataLabels: { formatter: (v: unknown) => `${v}!` } }),
    })
    live = w.wrapper

    await w.wrapper.setProps({
      options: options({ dataLabels: { formatter: (v: unknown) => `${v}?` } }),
    } as never)
    await flush()

    expect(w.updateOptions).toHaveBeenCalledTimes(1)
  })

  it('routes a series-only change to updateSeries, which tweens', async () => {
    const w = await watched({ options: options(), series: [{ type: 'choropleth', data: DATA }] })
    live = w.wrapper

    await w.wrapper.setProps({
      options: options(),
      series: [{ type: 'choropleth', data: [{ key: 'AAA', value: 9 }] }],
    } as never)
    await flush()

    expect(w.updateSeries).toHaveBeenCalledTimes(1)
    expect(w.updateOptions).not.toHaveBeenCalled()
  })

  it('routes a change to options.series to updateSeries too', async () => {
    const w = await watched({ options: options({ series: [{ type: 'choropleth', data: DATA }] }) })
    live = w.wrapper

    await w.wrapper.setProps({
      options: options({ series: [{ type: 'choropleth', data: [{ key: 'AAA', value: 9 }] }] }),
    } as never)
    await flush()

    expect(w.updateSeries).toHaveBeenCalledTimes(1)
    expect(w.updateOptions).not.toHaveBeenCalled()
  })

  it('routes a non-series option change to updateOptions', async () => {
    const w = await watched({ options: options() })
    live = w.wrapper

    await w.wrapper.setProps({ options: options({ legend: { position: 'top' } }) } as never)
    await flush()

    expect(w.updateOptions).toHaveBeenCalledTimes(1)
    expect(w.updateSeries).not.toHaveBeenCalled()
  })

  it('routes height changes to updateOptions and resizes', async () => {
    const w = await watched({ options: options(), height: 300 })
    live = w.wrapper

    await w.wrapper.setProps({ height: 520 } as never)
    await flush()

    expect(w.updateOptions).toHaveBeenCalledTimes(1)
    expect(w.map.viewport.height).toBe(520)
  })

  it('treats new geometry by reference, and equal geometry as new', async () => {
    const w = await watched({ options: options() })
    live = w.wrapper

    await w.wrapper.setProps({ options: options() } as never)
    await flush()
    expect(w.updateOptions).not.toHaveBeenCalled()

    await w.wrapper.setProps({
      options: { ...options(), geo: { map: structuredClone(THREE_BOXES) } },
    } as never)
    await flush()
    expect(w.updateOptions).toHaveBeenCalledTimes(1)
  })

  it('queues a change that arrives while the first geometry is still loading', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    ApexMaps.registerMap('vue-gated', async () => {
      await gate
      return THREE_BOXES as never
    })
    ApexMaps.registerMap('vue-second', {
      type: 'FeatureCollection',
      features: [box('XXX', 'Delta', 30)],
    } as never)

    const wrapper = mount(ApexMapsVue, {
      props: {
        options: { chart: { width: 400, height: 300 }, geo: { map: 'vue-gated' } },
      } as never,
      attachTo: document.body,
    })
    await nextTick()
    expect(mapOf(wrapper)?.rendered).toBe(false)

    await wrapper.setProps({
      options: { chart: { width: 400, height: 300 }, geo: { map: 'vue-second' } },
    } as never)
    await nextTick()

    release()
    await flush()

    // Without the queue this is ['AAA', 'BBB', 'CCC']: the abandoned first map.
    expect(mapOf(wrapper)?.geo?.features.map((f) => f.key)).toEqual(['XXX'])
    wrapper.unmount()
  })
})

describe('events', () => {
  it('emits core events under their own names', async () => {
    live = await mountMap({ options: options() })

    const feature = live.element.querySelector('path.apexmaps-feature') as SVGPathElement
    feature.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    const emitted = live.emitted('featureClick')
    expect(emitted).toHaveLength(1)
    expect((emitted?.[0]?.[0] as { key: string }).key).toBe('AAA')
  })

  it('emits rendered once, after the map is drawn', async () => {
    live = await mountMap({ options: options() })

    expect(live.emitted('rendered')).toHaveLength(1)
    expect(featureCount(live)).toBe(3)
  })
})
