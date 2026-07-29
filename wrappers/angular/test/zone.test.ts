// @vitest-environment jsdom
/**
 * The zone contract, in a zone.js application.
 *
 * Its own file because `import 'zone.js'` patches global timers, promises and
 * `addEventListener` for the whole process, which must not leak into the
 * zoneless suite. Vitest isolates test files, so the patching stays here.
 *
 * Both assertions are about failures that are invisible in a demo and
 * expensive in an application:
 *
 * - A map constructed *inside* the zone attaches its pointer listeners through
 *   the patched `addEventListener`, so every pointermove over every feature
 *   runs change detection across the whole app. Nothing is wrong, everything
 *   is slow, and the profiler blames Angular.
 * - An output emitted *outside* the zone is invisible to zone-based change
 *   detection, so a `(featureClick)` handler that sets component state updates
 *   nothing on screen until some unrelated event flushes it. It looks like the
 *   wrapper drops events, intermittently.
 */
import 'zone.js'
import '@angular/compiler'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ApplicationRef, NgZone, provideZoneChangeDetection } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing'
import type { ApexMapsOptions } from 'apexmaps'
import { ApexMapsComponent } from 'ngx-apexmaps'

try {
  TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting())
} catch {
  // Already initialised in this worker.
}

const THREE_BOXES = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { iso_a3: 'AAA', name: 'Alpha' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-30, 0],
            [-22, 0],
            [-22, 8],
            [-30, 8],
            [-30, 0],
          ],
        ],
      },
    },
  ],
}

const OPTIONS = {
  chart: { width: 400, height: 300 },
  geo: { map: THREE_BOXES, projection: 'equirectangular' },
} as ApexMapsOptions

beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [provideZoneChangeDetection()],
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

async function mount() {
  const fixture = TestBed.createComponent(ApexMapsComponent)
  fixture.componentRef.setInput('options', OPTIONS)
  fixture.detectChanges()
  for (let i = 0; i < 6; i++) {
    await fixture.whenStable()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return fixture
}

/**
 * Records the zone every `addEventListener` call is made from. Patched-vs-not is
 * decided at registration time, so this is the deterministic observable: a
 * listener registered while `Zone.current` is the Angular zone is wrapped and
 * will run change detection on every event for the rest of its life.
 */
function recordListenerZones() {
  const zones: string[] = []
  const original = EventTarget.prototype.addEventListener
  const spy = vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (
    this: EventTarget,
    ...args
  ) {
    const zone = (globalThis as { Zone?: { current?: { name?: string } } }).Zone
    zones.push(zone?.current?.name ?? '?')
    return original.apply(this, args as Parameters<typeof original>)
  })
  return { zones, done: () => spy.mockRestore() }
}

describe('the zone contract', () => {
  it('attaches every map listener outside the zone at mount', async () => {
    // afterNextRender guarantees this today, but the guarantee is Angular's, not
    // ours: this pins it so a refactor that moves construction into an effect or
    // a lifecycle hook (both run inside the zone) fails here instead of shipping
    // a map whose every pointermove runs change detection.
    const recorder = recordListenerZones()
    const fixture = await mount()
    recorder.done()

    expect(recorder.zones.length).toBeGreaterThan(0)
    expect(recorder.zones.filter((name) => name === 'angular')).toEqual([])
    fixture.destroy()
  })

  it('re-attaches interaction listeners outside the zone on updates', async () => {
    // An interaction-options change makes `updateOptions` tear down and
    // re-attach the pointer listeners, and a re-attach from inside the zone
    // patches them: from that update onward every pointermove over the map runs
    // change detection. Angular currently guarantees this cannot happen (effect
    // callbacks run outside the zone, and the component wraps the calls anyway),
    // which is exactly why the test pins the *invariant* rather than the
    // component's wrapper: mutating the wrapper away is unobservable today, and
    // what this must catch is a refactor onto a path with no such guarantee
    // (a lifecycle hook, a subscription, a public method called from a zoned
    // handler) or a framework that stops providing it.
    const fixture = await mount()
    const zone = TestBed.inject(NgZone)

    // The component's update effect is a root effect (created with an explicit
    // injector), so it flushes in ApplicationRef.tick, not in a view's
    // detectChanges. In a zoned application tick runs inside the zone, so the
    // test drives it from there rather than from TestBed's root-zone helpers,
    // which would exercise a flush path no real application has.
    const appRef = TestBed.inject(ApplicationRef)
    const recorder = recordListenerZones()
    zone.run(() => {
      fixture.componentRef.setInput('options', {
        ...OPTIONS,
        interaction: { nearest: { radius: 30 } },
      })
      // Both calls, and both matter: setInput's write lands during the view's
      // refresh (detectChanges), and the root effect flushes in tick. A TestBed
      // fixture is not attached to ApplicationRef, so tick alone never applies
      // the input and detectChanges alone never runs the effect in-zone.
      fixture.detectChanges()
      appRef.tick()
    })
    for (let i = 0; i < 6; i++) {
      await fixture.whenStable()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    recorder.done()

    // The re-attach must have happened (the pointer listeners re-registered),
    // and none of it from inside the zone.
    expect(
      (fixture.componentInstance.map()?.config.interaction?.nearest as { radius?: number })?.radius,
    ).toBe(30)
    expect(recorder.zones.length).toBeGreaterThan(0)
    expect(recorder.zones.filter((name) => name === 'angular')).toEqual([])
    fixture.destroy()
  })

  it('emits outputs back inside the zone, so a handler that sets state is seen', async () => {
    const fixture = await mount()

    // The event reaching this handler originated from a listener the core
    // attached outside the zone. Without the re-entry in the component, this
    // asserts false and a state-setting handler would repaint nothing.
    let inZone: boolean | null = null
    fixture.componentInstance.featureClick.subscribe(() => {
      inZone = NgZone.isInAngularZone()
    })

    const feature = (fixture.nativeElement as HTMLElement).querySelector(
      'path.apexmaps-feature',
    ) as SVGPathElement
    feature.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(inZone).toBe(true)
    fixture.destroy()
  })
})
