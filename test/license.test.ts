// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import ApexMaps from '../src/ApexMaps'
import { LicenseManager } from 'apex-commons'

/**
 * Licence enforcement, driven the way a caller drives it rather than by poking
 * the verifier.
 *
 * apex-commons 0.2.0 verifies signatures, and verification is asynchronous
 * (`crypto.subtle` has no sync API) while the watermark decision is made
 * synchronously during render. So a forged key is accepted provisionally and
 * corrected a microtask later, by `Watermark` reconciling every container it has
 * been asked about. These tests pin both halves of that: the correction lands,
 * and it stops landing once a map is destroyed.
 */

const WATERMARK = '[data-apexcharts-watermark]'

const BOX = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { iso_a3: 'AAA', name: 'Alpha' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [8, 0],
            [8, 8],
            [0, 8],
            [0, 0],
          ],
        ],
      },
    },
  ],
}

const envelope = (payload: Record<string, unknown>) => 'APEX-' + btoa(JSON.stringify(payload))

/** Structurally perfect, signature is nonsense: what payload tampering produces. */
const forgedKey = () =>
  envelope({
    issueDate: '2026-07-01',
    expiryDate: '2099-12-31',
    plan: 'enterprise',
    sig: btoa(String.fromCharCode(...new Uint8Array(64).fill(7))),
  })

/** A key issued before signing existed. Must keep working until the cutoff. */
const unsignedKey = () =>
  envelope({ issueDate: '2025-01-01', expiryDate: '2099-12-31', plan: 'premium' })

/**
 * Let importKey/verify settle, then the onChange listener that reconciles.
 *
 * WebCrypto verification resolves on a thread pool, not the microtask queue,
 * so a fixed microtask count can lose the race on a loaded machine (observed
 * once with a browser build running alongside). With a predicate, this polls
 * until the expected state lands; without one (negative assertions, where
 * arrival cannot be awaited), it waits out a real-time deadline instead.
 */
async function settle(done?: () => boolean) {
  const deadline = Date.now() + (done ? 500 : 150)
  do {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 5))
    if (done?.()) return
  } while (Date.now() < deadline)
}

function makeHost() {
  const host = document.createElement('div')
  Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true })
  Object.defineProperty(host, 'clientHeight', { value: 400, configurable: true })
  document.body.appendChild(host)
  return host
}

/**
 * A premium map. `chart.context: 'story'` is gated by `_checkPremium`, which is
 * what makes the licence decision observable at all: with no premium feature in
 * use the watermark is never added, and these tests would pass while checking
 * nothing. That is not hypothetical, it is how they passed before: `story` was
 * listed in `PREMIUM_FEATURES` but nothing called `_requirePremium` with it, so
 * the watermark these tests saw was arriving from the free-tier defect below
 * rather than from the gate.
 */
function makeMap(el: HTMLElement) {
  return new ApexMaps(el, {
    geo: { map: BOX as never },
    series: [{ type: 'choropleth', data: [{ key: 'AAA', value: 1 }] }],
    chart: { context: 'story' },
  } as never)
}

/** The same map with nothing premium in it: the free tier. */
function makeFreeMap(el: HTMLElement) {
  return new ApexMaps(el, {
    geo: { map: BOX as never },
    series: [{ type: 'choropleth', data: [{ key: 'AAA', value: 1 }] }],
  } as never)
}

describe('licence enforcement', () => {
  let el: HTMLElement

  beforeEach(() => {
    el = makeHost()
    LicenseManager.setLicense('')
  })

  afterEach(() => {
    el.remove()
    LicenseManager.setLicense('')
  })

  it('watermarks a forged key once verification fails', async () => {
    ApexMaps.setLicense(forgedKey())
    const map = makeMap(el)
    await map.render()

    await settle(() => el.querySelector(WATERMARK) !== null)
    expect(el.querySelector(WATERMARK)).not.toBeNull()

    map.destroy()
  })

  it('leaves a free-tier map alone when a forged key is rejected', async () => {
    // The free tier carries no watermark, which has to survive the correction
    // meant for premium maps. `Watermark.remove()` TRACKS the container, and
    // reconciliation inside apex-commons is licence-driven (paint everything
    // tracked while the licence is invalid) rather than usage-driven, so a plain
    // map was painted the moment a forged key's verdict landed. The fix untracks
    // a container with no premium feature in use.
    ApexMaps.setLicense(forgedKey())
    const map = makeFreeMap(el)
    await map.render()

    await settle()
    expect(el.querySelector(WATERMARK)).toBeNull()

    map.destroy()
  })

  it('marks the premium map and not the plain one beside it', async () => {
    // The same defect at page scale, and the shape a customer actually hits: one
    // story map and one ordinary choropleth, sharing a global licence verdict.
    const other = makeHost()
    ApexMaps.setLicense(forgedKey())
    const premium = makeMap(el)
    const free = makeFreeMap(other)
    await premium.render()
    await free.render()

    await settle(() => el.querySelector(WATERMARK) !== null)
    expect(el.querySelector(WATERMARK)).not.toBeNull()
    expect(other.querySelector(WATERMARK)).toBeNull()

    premium.destroy()
    free.destroy()
    other.remove()
  })

  it('leaves an unsigned legacy key alone', async () => {
    ApexMaps.setLicense(unsignedKey())
    const map = makeMap(el)
    await map.render()

    await settle()
    expect(el.querySelector(WATERMARK)).toBeNull()

    map.destroy()
  })

  it('does not watermark a destroyed map when the licence verdict changes', async () => {
    // Watermark.remove() TRACKS the container, so destroy() alone leaves the
    // element registered for reconciliation. A later verdict would then paint a
    // watermark into a container that no longer holds a map: visible nonsense in
    // an app that tears one down and keeps the div.
    const map = makeMap(el)
    await map.render()
    map.destroy()

    ApexMaps.setLicense(forgedKey())
    await settle()

    expect(el.querySelector(WATERMARK)).toBeNull()
  })

  it('does not watermark when a render resolves after destroy', async () => {
    // render() is async: geometry may be a URL or a lazy pack. A caller that
    // renders and tears down without awaiting (a fast unmount, React StrictMode)
    // leaves the tail of that render executing against a destroyed map, and it
    // used to re-register the container for watermarking.
    const map = makeMap(el)
    const pending = map.render()
    map.destroy()
    await pending

    ApexMaps.setLicense(forgedKey())
    await settle()

    expect(el.querySelector(WATERMARK)).toBeNull()
  })
})
