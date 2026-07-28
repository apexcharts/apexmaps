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

const envelope = (payload: Record<string, unknown>) =>
  'APEX-' + btoa(JSON.stringify(payload))

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

/** Let importKey/verify settle, then the onChange listener that reconciles. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

function makeMap(el: HTMLElement) {
  // `story` is a premium feature, so the licence decision has an effect at all.
  // Without one the watermark is never added and these tests would pass while
  // checking nothing.
  return new ApexMaps(el, {
    geo: { map: BOX as never },
    series: [{ type: 'choropleth', data: [{ key: 'AAA', value: 1 }] }],
    chart: { context: 'story' },
  } as never)
}

describe('licence enforcement', () => {
  let el: HTMLElement

  beforeEach(() => {
    el = document.createElement('div')
    Object.defineProperty(el, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true })
    document.body.appendChild(el)
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

    await settle()
    expect(el.querySelector(WATERMARK)).not.toBeNull()

    map.destroy()
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
