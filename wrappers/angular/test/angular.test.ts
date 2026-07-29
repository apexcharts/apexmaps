// @vitest-environment jsdom
/**
 * The Angular component, under zoneless change detection.
 *
 * Zoneless is the primary test target because it is where Angular is going and
 * because it removes zone.js from the failure surface: what remains is the
 * component's own behaviour, which is the same contract the React and Vue suites
 * pin (which update path a change takes, what happens to a change that lands
 * before the first render resolves, who owns which element). The zone half of
 * the contract has its own file, `zone.test.ts`, because zone.js patches global
 * timers and promises at import and must not leak into these tests.
 *
 * JIT throughout: `@angular/compiler` is imported for its side effect, and the
 * partial-Ivy output of the real build is exercised by the Chromium probe
 * instead, where the linker's JIT fallback compiles it.
 */
import '@angular/compiler'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Component, provideZonelessChangeDetection, signal, ViewChild } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import type { ComponentFixture } from '@angular/core/testing'
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing'
import ApexMaps from 'apexmaps'
import type { ApexMapsOptions, FeatureEventPayload, Series } from 'apexmaps'
import { ApexMapsComponent } from 'ngx-apexmaps'

try {
  TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting())
} catch {
  // Already initialised by a sibling suite in the same worker.
}

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

/**
 * A host component, because that is how a consumer reaches the wrapper: through
 * the `apx-map` selector and template bindings, which a bare
 * `TestBed.createComponent(ApexMapsComponent)` never exercises. The query is the
 * decorator kind and the fields are plain signals, because the host is compiled
 * by pure JIT where initializer APIs (input, output, viewChild) do not register;
 * the wrapper itself gets them through the linked partial-Ivy build under test.
 */
@Component({
  standalone: true,
  imports: [ApexMapsComponent],
  template: `<apx-map
    [options]="options()"
    [series]="series()"
    [width]="width()"
    [height]="height()"
    (featureClick)="clicks.push($event)"
    (rendered)="renders.push($event)"
  />`,
})
class HostComponent {
  readonly options = signal<ApexMapsOptions>({} as ApexMapsOptions)
  readonly series = signal<readonly Series[] | undefined>(undefined)
  readonly width = signal<number | string | undefined>(undefined)
  readonly height = signal<number | string | undefined>(undefined)
  readonly clicks: FeatureEventPayload[] = []
  readonly renders: unknown[] = []
  @ViewChild(ApexMapsComponent) child!: ApexMapsComponent
}

type Fixture = ComponentFixture<HostComponent>

/**
 * Settle the fixture: effects, `afterNextRender`, the geometry promise, and the
 * rAF-shimmed label layout. Generous on purpose; the queue test below proves the
 * generosity is not hiding a missing queue.
 */
async function settle(fixture: Fixture) {
  for (let i = 0; i < 6; i++) {
    await fixture.whenStable()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

interface HostInputs {
  options: ApexMapsOptions
  series?: readonly Series[]
  width?: number | string
  height?: number | string
}

function setInputs(fixture: Fixture, inputs: Partial<HostInputs>) {
  const host = fixture.componentInstance
  if ('options' in inputs) host.options.set(inputs.options as ApexMapsOptions)
  if ('series' in inputs) host.series.set(inputs.series)
  if ('width' in inputs) host.width.set(inputs.width)
  if ('height' in inputs) host.height.set(inputs.height)
}

async function mountMap(inputs: HostInputs): Promise<Fixture> {
  const fixture = TestBed.createComponent(HostComponent)
  setInputs(fixture, inputs)
  fixture.detectChanges()
  await settle(fixture)
  return fixture
}

const mapOf = (fixture: Fixture) => fixture.componentInstance.child?.map() ?? null

const featureCount = (fixture: Fixture) =>
  (fixture.nativeElement as HTMLElement).querySelectorAll('path.apexmaps-feature').length

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  })
  vi.stubGlobal('requestAnimationFrame', ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame)
  vi.stubGlobal('cancelAnimationFrame', ((id: number) =>
    clearTimeout(id)) as unknown as typeof cancelAnimationFrame)
})

afterEach(() => {
  TestBed.resetTestingModule()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('mounting', () => {
  it('renders a map into the inner element the core owns', async () => {
    const fixture = await mountMap({
      options: options(),
      series: [{ type: 'choropleth', data: DATA }],
    })

    expect(featureCount(fixture)).toBe(3)
    const map = mapOf(fixture)
    expect(map?.rendered).toBe(true)
    // The <apx-map> element belongs to the caller: their class and style
    // bindings land there. The inner div belongs to the core, which writes its
    // own class there and never on the host.
    const host = (fixture.nativeElement as HTMLElement).querySelector('apx-map') as HTMLElement
    const inner = host.firstElementChild as HTMLElement
    // `element` is protected API, read through a cast because the ownership
    // boundary is exactly what this test pins.
    expect((map as unknown as { element: Element })?.element).toBe(inner)
    expect(inner.classList.contains('apexmaps')).toBe(true)
    expect(host.classList.contains('apexmaps')).toBe(false)
  })

  it('destroys the instance when the component is destroyed', async () => {
    const destroy = vi.spyOn(ApexMaps.prototype, 'destroy')
    const fixture = await mountMap({ options: options() })
    const child = fixture.componentInstance.child
    const host = fixture.nativeElement as HTMLElement

    fixture.destroy()

    expect(destroy).toHaveBeenCalledTimes(1)
    expect(child.map()).toBeNull()
    expect(host.querySelector('.apexmaps-plot')).toBeNull()
  })

  it('does not throw when destroyed before the first render resolves', async () => {
    const fixture = TestBed.createComponent(HostComponent)
    setInputs(fixture, { options: options() })
    fixture.detectChanges()
    // One stable pass so afterNextRender has fired, but the geometry promise has
    // deliberately not been given time to resolve.
    await fixture.whenStable()

    expect(() => fixture.destroy()).not.toThrow()
    await settle(fixture)
    expect(document.body.querySelectorAll('path.apexmaps-feature')).toHaveLength(0)
  })
})

describe('update routing', () => {
  async function watched(inputs: HostInputs) {
    const fixture = await mountMap(inputs)
    const map = mapOf(fixture) as ApexMaps
    return {
      fixture,
      map,
      updateOptions: vi.spyOn(map, 'updateOptions'),
      updateSeries: vi.spyOn(map, 'updateSeries'),
      async set(next: Partial<HostInputs>) {
        setInputs(fixture, next)
        fixture.detectChanges()
        await settle(fixture)
      },
    }
  }

  it('ignores a replaced options object that is equal', async () => {
    // `[options]="build()"` re-evaluates on every change detection cycle and
    // hands over a brand new object each time, so this is the resting state of a
    // template-driven binding, not an edge case.
    const w = await watched({ options: options(), series: [{ type: 'choropleth', data: DATA }] })

    await w.set({
      options: options(),
      series: [{ type: 'choropleth', data: DATA.map((d) => ({ ...d })) }],
    })

    expect(w.updateOptions).not.toHaveBeenCalled()
    expect(w.updateSeries).not.toHaveBeenCalled()
  })

  it('ignores an inline formatter whose identity changed', async () => {
    const w = await watched({
      options: options({ dataLabels: { formatter: (v: unknown) => `${v}!` } }),
    })

    await w.set({ options: options({ dataLabels: { formatter: (v: unknown) => `${v}!` } }) })

    expect(w.updateOptions).not.toHaveBeenCalled()
  })

  it('notices a formatter whose source actually changed', async () => {
    const w = await watched({
      options: options({ dataLabels: { formatter: (v: unknown) => `${v}!` } }),
    })

    await w.set({ options: options({ dataLabels: { formatter: (v: unknown) => `${v}?` } }) })

    expect(w.updateOptions).toHaveBeenCalledTimes(1)
  })

  it('routes a series-only change to updateSeries, which tweens', async () => {
    const w = await watched({ options: options(), series: [{ type: 'choropleth', data: DATA }] })

    await w.set({ series: [{ type: 'choropleth', data: [{ key: 'AAA', value: 9 }] }] })

    expect(w.updateSeries).toHaveBeenCalledTimes(1)
    expect(w.updateOptions).not.toHaveBeenCalled()
  })

  it('routes a change to options.series to updateSeries too', async () => {
    const w = await watched({ options: options({ series: [{ type: 'choropleth', data: DATA }] }) })

    await w.set({
      options: options({ series: [{ type: 'choropleth', data: [{ key: 'AAA', value: 9 }] }] }),
    })

    expect(w.updateSeries).toHaveBeenCalledTimes(1)
    expect(w.updateOptions).not.toHaveBeenCalled()
  })

  it('routes a non-series option change to updateOptions', async () => {
    const w = await watched({ options: options() })

    await w.set({ options: options({ legend: { position: 'top' } }) })

    expect(w.updateOptions).toHaveBeenCalledTimes(1)
    expect(w.updateSeries).not.toHaveBeenCalled()
    expect(w.map.config.legend?.position).toBe('top')
  })

  it('routes height changes to updateOptions and resizes', async () => {
    const w = await watched({ options: options(), height: 300 })

    await w.set({ height: 520 })

    expect(w.updateOptions).toHaveBeenCalledTimes(1)
    expect(w.map.viewport.height).toBe(520)
  })

  it('treats new geometry by reference, and equal geometry as new', async () => {
    const w = await watched({ options: options() })

    await w.set({ options: options() })
    expect(w.updateOptions).not.toHaveBeenCalled()

    await w.set({
      options: { ...options(), geo: { map: structuredClone(THREE_BOXES) } } as ApexMapsOptions,
    })
    expect(w.updateOptions).toHaveBeenCalledTimes(1)
  })

  it('catches an in-place mutation when any later input change arrives', async () => {
    // Signals do not fire on a same-reference mutation, so the mutation itself is
    // invisible until something else changes. What the snapshot buys is that the
    // NEXT change, whatever it is, sees it: here the later change is series-only,
    // and it must escalate to updateOptions so the mutated option is applied
    // rather than silently dropped by the updateSeries fast path. With a stored
    // reference instead of a snapshot, the comparison agrees with itself and the
    // mutation never reaches the map.
    const opts = options()
    const w = await watched({ options: opts, series: [{ type: 'choropleth', data: DATA }] })

    ;(opts as Record<string, never>).legend = { position: 'top' } as never
    await w.set({ series: [{ type: 'choropleth', data: [{ key: 'AAA', value: 9 }] }] })

    expect(w.updateOptions).toHaveBeenCalledTimes(1)
    expect(w.map.config.legend?.position).toBe('top')
    expect(w.map.config.series?.[0]?.data).toEqual([{ key: 'AAA', value: 9 }])
  })

  it('queues a change that arrives while the first geometry is still loading', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    ApexMaps.registerMap('ng-gated', async () => {
      await gate
      return THREE_BOXES as never
    })
    ApexMaps.registerMap('ng-second', {
      type: 'FeatureCollection',
      features: [box('XXX', 'Delta', 30)],
    } as never)

    const fixture = TestBed.createComponent(HostComponent)
    setInputs(fixture, {
      options: { chart: { width: 400, height: 300 }, geo: { map: 'ng-gated' } } as ApexMapsOptions,
    })
    fixture.detectChanges()
    await fixture.whenStable()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mapOf(fixture)?.rendered).toBe(false)

    setInputs(fixture, {
      options: { chart: { width: 400, height: 300 }, geo: { map: 'ng-second' } } as ApexMapsOptions,
    })
    fixture.detectChanges()
    await fixture.whenStable()

    release()
    await settle(fixture)

    // Without the queue this is ['AAA', 'BBB', 'CCC']: the abandoned first map.
    expect(mapOf(fixture)?.geo?.features.map((f) => f.key)).toEqual(['XXX'])
    fixture.destroy()
  })
})

describe('outputs', () => {
  it('emits core events under their template names', async () => {
    const fixture = await mountMap({ options: options() })

    const feature = (fixture.nativeElement as HTMLElement).querySelector(
      'path.apexmaps-feature',
    ) as SVGPathElement
    feature.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(fixture.componentInstance.clicks.map((c) => c.key)).toEqual(['AAA'])
  })

  it('emits rendered once the map is drawn', async () => {
    const fixture = await mountMap({ options: options() })

    expect(fixture.componentInstance.renders).toHaveLength(1)
    expect(featureCount(fixture)).toBe(3)
  })
})
