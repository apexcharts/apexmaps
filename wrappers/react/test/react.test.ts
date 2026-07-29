// @vitest-environment jsdom
/**
 * The React component.
 *
 * The interesting surface of a wrapper is not "does it render", it is everything
 * that happens on the second render. React hands the component a brand new
 * options object every time its parent re-renders, so the questions worth pinning
 * are which of those look like changes, which update path each change takes, and
 * what happens when a change arrives before the asynchronous first render has
 * finished. Those are the tests here; there is exactly one that checks a map
 * appears at all.
 *
 * The update path matters as much as the update: routing a series-only change
 * through `updateOptions` produces an identical DOM and silently replaces every
 * tweened transition with a redraw, so several tests assert *which* method ran
 * rather than what it produced.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement, act, StrictMode } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import ApexMaps from 'apexmaps'
import type { ApexMapsOptions } from 'apexmaps'
import ApexMapsReact from '../src/ApexMapsReact'
import type { ApexMapsProps } from '../src/ApexMapsReact'

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

/** A fresh options tree every call, which is what a React parent produces. */
function options(extra: Partial<ApexMapsOptions> = {}): ApexMapsOptions {
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

interface Harness {
  container: HTMLElement
  rerender(props: ApexMapsProps): Promise<void>
  unmount(): Promise<void>
}

async function mount(props: ApexMapsProps, wrap = false): Promise<Harness> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const tree = (p: ApexMapsProps): ReactElement => {
    const node = createElement(ApexMapsReact, p)
    return wrap ? createElement(StrictMode, null, node) : node
  }
  await act(async () => {
    root.render(tree(props))
  })
  return {
    container,
    async rerender(next) {
      await act(async () => {
        root.render(tree(next))
      })
    },
    async unmount() {
      await act(async () => {
        root.unmount()
      })
    },
  }
}

const featureCount = (container: HTMLElement) =>
  container.querySelectorAll('path.apexmaps-feature').length

let live: Harness | null = null

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom has no layout and no frame loop. Matching the core suite's stubs keeps
  // the viewport deterministic and lets the one-per-frame label layout run.
  vi.stubGlobal('requestAnimationFrame', ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame)
  vi.stubGlobal('cancelAnimationFrame', ((id: number) =>
    clearTimeout(id)) as unknown as typeof cancelAnimationFrame)
})

afterEach(async () => {
  await live?.unmount()
  live = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('mounting', () => {
  it('renders a map into its own container', async () => {
    const mapRef = { current: null as ApexMaps | null }
    live = await mount({ options: options(), series: [{ type: 'choropleth', data: DATA }], mapRef })

    expect(featureCount(live.container)).toBe(3)
    expect(mapRef.current?.rendered).toBe(true)
    // React owns the outer element; the core owns the inner one and writes its
    // class and style freely.
    const outer = live.container.firstElementChild as HTMLElement
    expect(mapRef.current?.element).toBe(outer.firstElementChild)
    expect(outer.firstElementChild?.classList.contains('apexmaps')).toBe(true)
  })

  it('passes className and style through, and keeps its own props off the DOM', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    live = await mount({
      options: options(),
      className: 'my-map',
      style: { height: 300 },
      onFeatureClick: () => {},
      onZoom: () => {},
    })

    const outer = live.container.firstElementChild as HTMLElement
    expect(outer.className).toBe('my-map')
    expect(outer.style.height).toBe('300px')
    expect(outer.getAttribute('onFeatureClick')).toBeNull()
    // React warns on unknown DOM attributes, so a leaked prop shows up here even
    // when the attribute assertion above happens to pass.
    expect(spy.mock.calls.flat().join(' ')).not.toMatch(/unknown|invalid|not valid/i)
  })

  it('keeps the core styling when the caller changes className', async () => {
    // React writes `className` by replacing the whole attribute. If the core and
    // the caller shared an element, this rerender would delete the 'apexmaps'
    // class and every rule in the stylesheet would stop matching: a map that
    // renders, then loses all styling later, with nothing thrown.
    live = await mount({ options: options(), className: 'light' })
    const inner = (live.container.firstElementChild as HTMLElement).firstElementChild as HTMLElement
    expect(inner.classList.contains('apexmaps')).toBe(true)

    await live.rerender({ options: options(), className: 'dark' })

    expect((live.container.firstElementChild as HTMLElement).className).toBe('dark')
    expect(inner.classList.contains('apexmaps')).toBe(true)
    expect(featureCount(live.container)).toBe(3)
  })

  it('destroys the instance on unmount', async () => {
    const destroy = vi.spyOn(ApexMaps.prototype, 'destroy')
    const mapRef = { current: null as ApexMaps | null }
    const harness = await mount({ options: options(), mapRef })

    await harness.unmount()

    expect(destroy).toHaveBeenCalledTimes(1)
    expect(mapRef.current).toBeNull()
    expect(harness.container.querySelector('.apexmaps-plot')).toBeNull()
  })

  it('survives StrictMode mount, unmount, mount with one live map', async () => {
    const render = vi.spyOn(ApexMaps.prototype, 'render')
    const destroy = vi.spyOn(ApexMaps.prototype, 'destroy')
    const mapRef = { current: null as ApexMaps | null }
    live = await mount({ options: options(), mapRef }, true)

    // The whole point of StrictMode's double invoke: two instances built, the
    // first torn down, and no half-rendered leftovers from it.
    expect(render).toHaveBeenCalledTimes(2)
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(mapRef.current?.rendered).toBe(true)
    expect(live.container.querySelectorAll('svg.apexmaps-svg')).toHaveLength(1)
    expect(featureCount(live.container)).toBe(3)
  })

  it('does not throw when unmounted before the first render resolves', async () => {
    // No `await` on the mount: the geometry promise is still in flight when the
    // tree goes away, which is the fast-navigation case.
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(ApexMapsReact, { options: options() }))
      root.unmount()
    })

    expect(container.querySelector('.apexmaps-plot')).toBeNull()
    expect(featureCount(container)).toBe(0)
  })
})

describe('change detection', () => {
  /** Spies on both update paths, so tests can assert which one ran. */
  async function watched(props: ApexMapsProps) {
    const mapRef = { current: null as ApexMaps | null }
    const harness = await mount({ ...props, mapRef })
    const map = mapRef.current as ApexMaps
    return {
      harness,
      map,
      updateOptions: vi.spyOn(map, 'updateOptions'),
      updateSeries: vi.spyOn(map, 'updateSeries'),
    }
  }

  it('ignores a re-render with fresh but equal option objects', async () => {
    const w = await watched({ options: options(), series: [{ type: 'choropleth', data: DATA }] })
    live = w.harness

    // Every object here is newly allocated, exactly as a parent render produces.
    await w.harness.rerender({
      options: options(),
      series: [{ type: 'choropleth', data: [...DATA.map((d) => ({ ...d }))] }],
    })

    expect(w.updateOptions).not.toHaveBeenCalled()
    expect(w.updateSeries).not.toHaveBeenCalled()
  })

  it('ignores inline formatter functions, which change identity every render', async () => {
    const w = await watched({
      options: options({ dataLabels: { formatter: (v: unknown) => `${v}!` } } as never),
    })
    live = w.harness

    await w.harness.rerender({
      options: options({ dataLabels: { formatter: (v: unknown) => `${v}!` } } as never),
    })

    expect(w.updateOptions).not.toHaveBeenCalled()
  })

  it('notices a formatter whose source actually changed', async () => {
    const w = await watched({
      options: options({ dataLabels: { formatter: (v: unknown) => `${v}!` } } as never),
    })
    live = w.harness

    await w.harness.rerender({
      options: options({ dataLabels: { formatter: (v: unknown) => `${v}?` } } as never),
    })

    expect(w.updateOptions).toHaveBeenCalledTimes(1)
  })

  it('compares geometry by identity, so the same reference is not a change', async () => {
    const w = await watched({ options: options() })
    live = w.harness

    // `options()` returns a new tree each call but the same THREE_BOXES object.
    await w.harness.rerender({ options: options() })

    expect(w.updateOptions).not.toHaveBeenCalled()
  })

  it('treats a rebuilt-but-equal geometry object as new, by design', async () => {
    const w = await watched({ options: options() })
    live = w.harness

    // Deep-comparing a topology on every parent render would cost more than the
    // redraw it avoids, so a caller who rebuilds geometry inline gets a redraw.
    // Pinned because it is a deliberate trade, not an oversight.
    await w.harness.rerender({
      options: {
        ...options(),
        geo: { map: structuredClone(THREE_BOXES), projection: 'equirectangular' },
      } as never,
    })

    expect(w.updateOptions).toHaveBeenCalledTimes(1)
  })

  it('routes a series-only change to updateSeries, which tweens', async () => {
    const w = await watched({ options: options(), series: [{ type: 'choropleth', data: DATA }] })
    live = w.harness

    await w.harness.rerender({
      options: options(),
      series: [{ type: 'choropleth', data: [{ key: 'AAA', value: 9 }] }],
    })

    expect(w.updateSeries).toHaveBeenCalledTimes(1)
    expect(w.updateOptions).not.toHaveBeenCalled()
  })

  it('routes a change to options.series to updateSeries too', async () => {
    // The same data can live in `options.series` or in the `series` prop, and a
    // caller should not lose tweening by choosing the first.
    const w = await watched({ options: options({ series: [{ type: 'choropleth', data: DATA }] }) })
    live = w.harness

    await w.harness.rerender({
      options: options({ series: [{ type: 'choropleth', data: [{ key: 'AAA', value: 9 }] }] }),
    })

    expect(w.updateSeries).toHaveBeenCalledTimes(1)
    expect(w.updateOptions).not.toHaveBeenCalled()
  })

  it('does not see a change when data moves between the two places it can live', async () => {
    const w = await watched({ options: options({ series: [{ type: 'choropleth', data: DATA }] }) })
    live = w.harness

    await w.harness.rerender({ options: options(), series: [{ type: 'choropleth', data: DATA }] })

    expect(w.updateSeries).not.toHaveBeenCalled()
    expect(w.updateOptions).not.toHaveBeenCalled()
  })

  it('routes a non-series option change to updateOptions', async () => {
    const w = await watched({ options: options() })
    live = w.harness

    await w.harness.rerender({ options: options({ scale: { type: 'quantize', steps: 4 } }) })

    expect(w.updateOptions).toHaveBeenCalledTimes(1)
    expect(w.updateSeries).not.toHaveBeenCalled()
  })

  it('routes width and height changes to updateOptions', async () => {
    const w = await watched({ options: options(), width: 400, height: 300 })
    live = w.harness

    await w.harness.rerender({ options: options(), width: 500, height: 300 })

    expect(w.updateOptions).toHaveBeenCalledTimes(1)
    expect(w.updateOptions.mock.calls[0]?.[0].chart?.width).toBe(500)
  })

  it('constructs at mount without also updating', async () => {
    // The instance is built from the props, and the same props are recorded as the
    // baseline, so the update effect that runs immediately after has nothing to do.
    // Getting those two out of step costs a full redraw one tick into every mount,
    // which is invisible except as a slow first paint. Two renders before the flush
    // is the case most likely to knock them apart.
    const updateOptions = vi.spyOn(ApexMaps.prototype, 'updateOptions')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const mapRef = { current: null as ApexMaps | null }

    await act(async () => {
      root.render(createElement(ApexMapsReact, { options: options(), mapRef }))
      root.render(
        createElement(ApexMapsReact, {
          options: options({ scale: { type: 'quantize', steps: 4 } }),
          mapRef,
        }),
      )
    })

    expect(mapRef.current?.config.scale?.type).toBe('quantize')
    expect(updateOptions).not.toHaveBeenCalled()

    await act(async () => {
      root.unmount()
    })
  })

  it('queues a change that arrives while the first geometry is still loading', async () => {
    // The hazard that makes the wrapper hold the render promise. Nothing throws
    // if an update runs mid-flight: `_draw` returns early while `geo` is still
    // null, so the update paints nothing, and then `render()` resumes and installs
    // the geometry it resolved before the update. The map ends up showing the map
    // it was told to stop showing, silently.
    //
    // A gated loader is the only way to hold that window open long enough to
    // assert on, which is why this test builds its own root instead of using the
    // harness: the mount must not be awaited to completion.
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    ApexMaps.registerMap('gated-first', async () => {
      await gate
      return THREE_BOXES as never
    })
    ApexMaps.registerMap('immediate-second', {
      type: 'FeatureCollection',
      features: [box('XXX', 'Delta', 30)],
    } as never)

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const mapRef = { current: null as ApexMaps | null }
    const props = (map: string): ApexMapsProps => ({
      options: { chart: { width: 400, height: 300 }, geo: { map } } as ApexMapsOptions,
      mapRef,
    })

    // Mounted but deliberately not settled: the loader is still waiting.
    await act(async () => {
      root.render(createElement(ApexMapsReact, props('gated-first')))
    })
    expect(mapRef.current?.rendered).toBe(false)

    await act(async () => {
      root.render(createElement(ApexMapsReact, props('immediate-second')))
    })

    release()
    await act(async () => {
      await gate
    })

    // Without the queue this is ['AAA', 'BBB', 'CCC']: the map that was asked for
    // first and abandoned.
    expect(mapRef.current?.geo?.features.map((f) => f.key)).toEqual(['XXX'])
    expect(featureCount(container)).toBe(1)

    await act(async () => {
      root.unmount()
    })
  })
})

describe('events', () => {
  it('forwards core events to props', async () => {
    const onFeatureClick = vi.fn()
    const onUpdated = vi.fn()
    const mapRef = { current: null as ApexMaps | null }
    live = await mount({ options: options(), mapRef, onFeatureClick, onUpdated })

    const feature = live.container.querySelector('path.apexmaps-feature') as SVGPathElement
    feature.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(onFeatureClick).toHaveBeenCalledTimes(1)
    expect(onFeatureClick.mock.calls[0][0].key).toBe('AAA')

    await mapRef.current?.updateOptions({ scale: { type: 'quantize' } })
    expect(onUpdated).toHaveBeenCalledTimes(1)
  })

  it('uses the latest handler without resubscribing', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const on = vi.spyOn(ApexMaps.prototype, 'on')
    live = await mount({ options: options(), onFeatureClick: first })
    const subscriptions = on.mock.calls.length

    await live.rerender({ options: options(), onFeatureClick: second })

    const feature = live.container.querySelector('path.apexmaps-feature') as SVGPathElement
    feature.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
    // A new closure identity must not cost a resubscribe, because an event fired
    // between the unsubscribe and the resubscribe would simply vanish.
    expect(on.mock.calls.length).toBe(subscriptions)
  })

  it('is safe when no handler is given for an event that fires', async () => {
    live = await mount({ options: options() })
    const feature = live.container.querySelector('path.apexmaps-feature') as SVGPathElement

    expect(() => feature.dispatchEvent(new MouseEvent('click', { bubbles: true }))).not.toThrow()
  })
})

describe('server rendering', () => {
  it('emits the container and builds no map', async () => {
    // Not a DOM-less environment (jsdom is the whole point of this file), so what
    // this pins is the property that makes the component server-safe: everything
    // that touches a document happens in an effect, and effects do not run during
    // renderToString.
    const render = vi.spyOn(ApexMaps.prototype, 'render')

    const html = renderToString(
      createElement(ApexMapsReact, { options: options(), className: 'ssr' }),
    )

    expect(html).toBe('<div class="ssr"><div style="width:100%;height:100%"></div></div>')
    expect(render).not.toHaveBeenCalled()
  })
})

describe('core merge semantics, as seen from React', () => {
  it('does not clear an option that the prop tree stopped providing', async () => {
    // `updateOptions` deep-merges into accumulated options, so a key that
    // disappears from the tree keeps its last value. That is at odds with how a
    // React caller writes `{...(show && { dataLabels })}`, and it is core
    // behaviour rather than wrapper behaviour, so it is pinned here to be a known
    // shape rather than a surprise. The documented workaround is to pass the
    // disabling value (`dataLabels: { enabled: false }`) instead of omitting it.
    const mapRef = { current: null as ApexMaps | null }
    live = await mount({ options: options({ dataLabels: { enabled: true } }), mapRef })
    expect(mapRef.current?.config.dataLabels?.enabled).toBe(true)

    await live.rerender({ options: options({ scale: { type: 'quantize' } }), mapRef })

    expect(mapRef.current?.config.dataLabels?.enabled).toBe(true)
  })
})
