// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { geoMercator } from 'd3-geo'
import ApexMaps from '../src/ApexMaps'
import { PREMIUM_FEATURES } from '../src/core/premium'
import type { PremiumFeature } from '../src/core/premium'
import { LicenseManager } from 'apex-commons'

/**
 * Every licensed feature is actually gated, and nothing else is.
 *
 * `PREMIUM_FEATURES` is a list of strings, and a name on it does nothing until a
 * call site passes it to `_requirePremium`. `story` sat on that list from the
 * first release with no call site, so the primary paid differentiator was free
 * and the licence tests passed anyway (they were watching a watermark that
 * arrived from a defect elsewhere). A list is not evidence.
 *
 * So each feature below is driven twice: once with the option that turns it on,
 * which must watermark without a licence, and once without it, which must not.
 * The negative half matters as much: it is what fails if the free tier starts
 * watermarking again.
 *
 * No forged key here, unlike license.test.ts. With no licence at all the verdict
 * is invalid synchronously, so the watermark decision is made during render and
 * there is no asynchronous verification to wait out. That keeps this file about
 * gating and that one about verification.
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

/** The free tier: a choropleth and nothing else. */
const BASE = {
  geo: { map: BOX },
  series: [{ type: 'choropleth', data: [{ key: 'AAA', value: 1 }] }],
}

/**
 * Named ahead of the features themselves, so there is nothing to drive yet. Any
 * other name without an entry in ACTIVATES fails the last test in this file,
 * which is how a feature cannot be declared premium and shipped free.
 */
const UNBUILT: readonly PremiumFeature[] = ['morph', 'presentation', 'timePlayback', 'webgl']

/** The smallest option that puts each feature into use. */
const ACTIVATES: Partial<Record<PremiumFeature, Record<string, unknown>>> = {
  annotations: {
    annotations: { points: [{ at: [4, 4], label: { text: 'here' } }] },
  },
  clustering: {
    series: [
      {
        type: 'marker',
        data: [
          { lon: 1, lat: 1 },
          { lon: 1.1, lat: 1.1 },
        ],
        cluster: {},
      },
    ],
  },
  // Registered in beforeEach. Every built-in name stays free, so this asserts the
  // distinction rather than just "a projection was set".
  customProjection: { geo: { map: BOX, projection: 'testOnly' } },
  drilldown: {
    series: [
      {
        type: 'choropleth',
        data: [{ key: 'AAA', value: 1 }],
        // Never resolves, and never has to: configuring a drilldown is using it,
        // because the reader can drill whether or not a click has happened.
        drilldown: { map: () => null },
      },
    ],
  },
  imageFill: {
    series: [
      {
        type: 'choropleth',
        data: [{ key: 'AAA', value: 1 }],
        fill: { image: { src: 'flag.png' } },
      },
    ],
  },
  linkGroup: { link: { group: 'group-1' } },
  patternFill: {
    series: [
      {
        type: 'choropleth',
        data: [{ key: 'AAA', value: 1 }],
        fill: { pattern: { type: 'dots' } },
      },
    ],
  },
  routes: {
    series: [{ type: 'arc', data: [{ from: [0, 0], to: [8, 8] }] }],
  },
  story: { chart: { context: 'story' } },
}

/**
 * The smallest change that takes each feature back out of use, applied through
 * `updateOptions`. Written by hand rather than derived, because the merge skips
 * `undefined` (so a key cannot be blanked), replaces arrays and deep-merges
 * objects, and each feature turns off differently under those rules.
 */
const TURNS_OFF: Partial<Record<PremiumFeature, Record<string, unknown>>> = {
  annotations: { annotations: { points: [] } },
  clustering: { series: BASE.series },
  customProjection: { geo: { projection: 'mercator' } },
  drilldown: { series: BASE.series },
  imageFill: { series: BASE.series },
  linkGroup: { link: { group: '' } },
  patternFill: { series: BASE.series },
  routes: { series: BASE.series },
  story: { chart: { context: 'dashboard' } },
}

describe('premium gating', () => {
  let el: HTMLElement

  beforeEach(() => {
    el = document.createElement('div')
    Object.defineProperty(el, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true })
    document.body.appendChild(el)
    LicenseManager.setLicense('')
    ApexMaps.registerProjection('testOnly', geoMercator as never)
  })

  afterEach(() => {
    el.remove()
    LicenseManager.setLicense('')
  })

  async function watermarked(options: Record<string, unknown>) {
    const map = new ApexMaps(el, { ...BASE, ...options } as never)
    await map.render()
    const marked = el.querySelector(WATERMARK) !== null
    map.destroy()
    return marked
  }

  it('does not watermark the free tier', async () => {
    expect(await watermarked({})).toBe(false)
  })

  it('does not watermark a built-in projection', async () => {
    expect(await watermarked({ geo: { map: BOX, projection: 'mercator' } })).toBe(false)
  })

  it('does not watermark a cluster that is explicitly off', async () => {
    expect(
      await watermarked({
        series: [{ type: 'marker', data: [{ lon: 1, lat: 1 }], cluster: { enabled: false } }],
      }),
    ).toBe(false)
  })

  for (const [feature, options] of Object.entries(ACTIVATES)) {
    it(`watermarks an unlicensed ${feature}`, async () => {
      expect(await watermarked(options)).toBe(true)
    })
  }

  // The watermark describes the map on screen, not the map's history. Premium
  // usage is recomputed from the config on every options change, so taking the
  // feature back out takes the watermark with it. Both directions are asserted in
  // one test, because the interesting failure is the second half only.
  for (const feature of Object.keys(ACTIVATES) as PremiumFeature[]) {
    it(`clears the watermark when ${feature} is turned off`, async () => {
      const off = TURNS_OFF[feature]
      expect(off, `${feature} has no entry in TURNS_OFF`).toBeDefined()

      const map = new ApexMaps(el, { ...BASE, ...ACTIVATES[feature] } as never)
      await map.render()
      expect(el.querySelector(WATERMARK)).not.toBeNull()

      await map.updateOptions(off as never)
      expect(el.querySelector(WATERMARK)).toBeNull()

      map.destroy()
    })
  }

  it('has a live gate, or a declared reason, for every premium feature', () => {
    const covered = new Set([...Object.keys(ACTIVATES), ...UNBUILT])
    const orphans = PREMIUM_FEATURES.filter((feature) => !covered.has(feature))
    expect(orphans).toEqual([])
  })
})
