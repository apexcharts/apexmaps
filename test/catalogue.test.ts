// @vitest-environment jsdom
/**
 * Geometry catalogue: ids, aliases, loading, provenance, and the packs themselves.
 *
 * The tests that read `geo/` skip when the dataset has not been built, because
 * `npm run data:build` needs network. The build script is the hard gate there: it
 * exits non-zero when the catalogue and the pipeline disagree.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import ApexMaps from '../src/ApexMaps'
import {
  geoPacks,
  geoPack,
  setGeoSource,
  geoSource,
  DEFAULT_GEO_SOURCE,
  _resetGeoLoads,
} from '../src/core/GeoCatalogue'
import { resolveMap, mapMeta, attributionFor, listMaps } from '../src/core/MapRegistry'
import { resolveJoin } from '../src/data/Join'
import { normalizeGeo } from '../src/geo/GeoData'
import type { GeoInput, NormalizedFeature } from '../src/types'

const GEO_DIR = resolve(process.cwd(), 'geo')
const MANIFEST = resolve(GEO_DIR, 'manifest.json')
const hasDataset = existsSync(MANIFEST)

function readPack(file: string): GeoInput {
  return JSON.parse(readFileSync(resolve(GEO_DIR, file), 'utf8')) as GeoInput
}

/** Serve packs off disk, which is also the documented air-gapped setup. */
function serveFromDisk(): void {
  setGeoSource((file) => Promise.resolve(readPack(file)))
}

function features(file: string, keyField?: string): NormalizedFeature[] {
  return normalizeGeo(readPack(file), { keyField }).features
}

afterEach(() => {
  setGeoSource(DEFAULT_GEO_SOURCE)
  _resetGeoLoads()
  vi.unstubAllGlobals()
})

describe('catalogue shape', () => {
  it('registers every pack plus its aliases', () => {
    const ids = listMaps()
    for (const pack of geoPacks()) {
      expect(ids).toContain(pack.id)
      for (const alias of pack.aliases) expect(ids).toContain(alias)
    }
  })

  it('covers the P1 gate: world, US, EU and fifteen countries at admin-1', () => {
    const ids = geoPacks().map((p) => p.id)
    expect(ids).toContain('world/countries@110m')
    expect(ids).toContain('us/states@10m')
    expect(ids).toContain('us/counties@10m')
    expect(ids.filter((id) => id.startsWith('eu/nuts')).length).toBeGreaterThanOrEqual(3)

    const admin1 = ids.filter((id) => id.endsWith('/admin1@10m'))
    expect(admin1.length).toBeGreaterThanOrEqual(15)
    // The US is covered by TIGER instead, which has legal boundaries and counties.
    expect(admin1).not.toContain('us/admin1@10m')
  })

  it('gives every id the canonical namespace/name@detail form', () => {
    for (const pack of geoPacks()) {
      expect(pack.id).toMatch(/^[a-z]{2,6}\/[a-z0-9]+@\d+m$/)
    }
  })

  it('has no duplicate canonical ids', () => {
    const ids = geoPacks().map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('never lets an alias shadow a canonical id', () => {
    const ids = new Set(geoPacks().map((p) => p.id))
    for (const pack of geoPacks()) {
      for (const alias of pack.aliases) expect(ids.has(alias)).toBe(false)
    }
  })

  it('resolves a contested alias the same way everywhere', () => {
    // `world/countries` is declared by both the 110m and 50m packs, which is how
    // "the detail-free form means the lightest one" is expressed. Lookup and
    // registration must agree on which pack wins.
    const contested = new Map<string, string>()
    for (const pack of geoPacks()) {
      for (const alias of pack.aliases) if (!contested.has(alias)) contested.set(alias, pack.id)
    }
    for (const [alias, expected] of contested) {
      expect(geoPack(alias)?.id, alias).toBe(expected)
      expect(mapMeta(alias)?.packId, alias).toBe(expected)
    }
  })

  it('resolves the detail-free alias to the lightest pack, not the heaviest', async () => {
    serveFromDisk()
    expect(mapMeta('world/countries')?.packId).toBe('world/countries@110m')
    expect(mapMeta('world/land')?.packId).toBe('world/land@110m')
  })

  it('aliases each country to its own term for the tier', () => {
    expect(geoPack('jp/prefectures')?.id).toBe('jp/admin1@10m')
    expect(geoPack('de/states')?.id).toBe('de/admin1@10m')
    // Natural Earth admin-1 is departments in France, not regions, and the alias
    // must not claim otherwise.
    expect(geoPack('fr/departments')?.id).toBe('fr/admin1@10m')
    expect(geoPack('fr/regions')).toBeUndefined()
    expect(geoPack('gb/districts')?.id).toBe('gb/admin1@10m')
  })

  it('gives every country pack the two-letter shorthand for its own country', () => {
    // `map: 'jp'` is the prefectures. Getting this wrong hands one country's
    // shorthand to another country's geometry, which renders as a perfectly
    // plausible map of the wrong place.
    const namespaces = new Set(
      geoPacks()
        .map((p) => p.id.slice(0, p.id.indexOf('/')))
        .filter((ns) => ns.length === 2),
    )
    for (const namespace of namespaces) {
      const claimants = geoPacks().filter((p) => p.aliases.includes(namespace))
      expect(claimants.length, `${namespace} claimed ${claimants.length} times`).toBe(1)
      expect(claimants[0].id.startsWith(`${namespace}/`), claimants[0].id).toBe(true)
      expect(geoPack(namespace)?.id).toBe(claimants[0].id)
    }
    expect(geoPack('jp')?.id).toBe('jp/admin1@10m')
    // `map: 'us'` means the states, not a blank national outline.
    expect(geoPack('us')?.id).toBe('us/states@10m')
  })

  it('carries licence and attribution for every pack', () => {
    for (const pack of geoPacks()) {
      expect(pack.license).toBeTruthy()
      expect(pack.source).toBeTruthy()
      expect(pack.vintage).toBeTruthy()
    }
    // Public-domain sources render no attribution; Eurostat requires one.
    expect(attributionFor(['world/countries@110m'])).toBe('')
    expect(attributionFor(['eu/nuts1@20m'])).toContain('EuroGeographics')
    // Deduplicated across a map using several NUTS levels.
    expect(attributionFor(['eu/nuts1@20m', 'eu/nuts2@20m'])).toBe(
      '© EuroGeographics for the administrative boundaries',
    )
  })

  it('states a recommended join key for every pack that can be joined', () => {
    for (const pack of geoPacks()) {
      const joinable = !/land|nation/.test(pack.id)
      if (joinable) expect(pack.keyField, `${pack.id} has no keyField`).toBeTruthy()
    }
  })
})

describe('loading', () => {
  it('fetches nothing until a pack is used', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    // Importing and listing must stay free: the default build makes no mandatory
    // network calls.
    expect(listMaps().length).toBeGreaterThan(20)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('builds the url from the configured base', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ type: 'Topology' }),
    })
    vi.stubGlobal('fetch', fetchSpy)
    setGeoSource('https://example.test/geo')
    await resolveMap('jp/admin1@10m')
    expect(fetchSpy).toHaveBeenCalledWith('https://example.test/geo/jp-admin1-10m.json')
  })

  it('accepts a loader function, for bundlers and air-gapped installs', async () => {
    const loader = vi.fn().mockResolvedValue({ type: 'Topology', objects: {}, arcs: [] })
    setGeoSource(loader)
    expect(geoSource()).toBe(loader)
    await resolveMap('de/states')
    expect(loader).toHaveBeenCalledWith(
      'de-admin1-10m.json',
      expect.objectContaining({ id: 'de/admin1@10m' }),
    )
  })

  it('loads one file once even when asked for by several names', async () => {
    const loader = vi.fn().mockResolvedValue({ type: 'Topology', objects: {}, arcs: [] })
    setGeoSource(loader)
    await Promise.all([
      resolveMap('de/admin1@10m'),
      resolveMap('de/states'),
      resolveMap('de/admin1'),
    ])
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failed load', async () => {
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ type: 'Topology', objects: {}, arcs: [] })
    setGeoSource(loader)
    await expect(resolveMap('kr/admin1@10m')).rejects.toThrow('offline')
    // A transient offline moment must not poison the pack for the page's lifetime.
    await expect(resolveMap('kr/admin1@10m')).resolves.toBeTruthy()
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('explains an http failure and how to fix it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
    setGeoSource('https://example.test/geo/')
    await expect(resolveMap('world/countries@110m')).rejects.toThrow(/404[\s\S]*apexmaps-geo/)
  })

  it('suggests near misses instead of dumping forty ids', async () => {
    await expect(resolveMap('us/county@10m')).rejects.toThrow(/Did you mean "us\/counties@10m"/)
    await expect(resolveMap('world/contries')).rejects.toThrow(/Did you mean/)
  })

  it('still accepts urls and raw geometry', async () => {
    const geometry = { type: 'FeatureCollection', features: [] }
    const resolved = await resolveMap(geometry as GeoInput)
    expect(resolved.data).toBe(geometry)
  })
})

describe.skipIf(!hasDataset)('the built packs', () => {
  const manifest = hasDataset
    ? (JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
        packs: { id: string; file: string }[]
      })
    : { packs: [] }

  beforeEach(() => {
    serveFromDisk()
  })

  it('agrees with the catalogue, id for id and file for file', () => {
    const built = new Map(manifest.packs.map((p) => [p.id, p.file]))
    for (const pack of geoPacks()) {
      expect(built.has(pack.id), `${pack.id} declared but not built`).toBe(true)
      expect(built.get(pack.id)).toBe(pack.file)
    }
    expect(manifest.packs.length).toBe(geoPacks().length)
  })

  it('repairs the ISO codes Natural Earth leaves as -99', () => {
    const world = features('world-countries-110m.json', 'iso_a3')
    const byName = new Map(world.map((f) => [f.name, f]))
    // NE ships France and Norway with ISO_A3 = -99 because it splits their
    // overseas parts out. Anyone joining on iso_a3 loses two countries silently.
    expect(byName.get('France')?.key).toBe('FRA')
    expect(byName.get('Norway')?.key).toBe('NOR')
    expect(world.every((f) => f.key && f.key !== '-99')).toBe(true)
  })

  it('joins world countries on iso_a3 out of the box', () => {
    const world = features('world-countries-110m.json', 'iso_a3')
    const join = resolveJoin({
      features: world,
      data: [
        { code: 'FRA', value: 7.3 },
        { code: 'DEU', value: 5.7 },
        { code: 'USA', value: 3.9 },
      ],
      joinBy: ['iso_a3', 'code'],
    })
    expect(join.unmatchedData).toHaveLength(0)
    expect(join.matched).toBe(3)
  })

  it('colours every feature sharing a key, not just the last one', () => {
    // NE gives Australia, the Indian Ocean Territories and Ashmore and Cartier
    // Islands the same iso_a3. One row must light up all of them: keeping only the
    // last would leave the mainland grey and colour an uninhabited island.
    const world = features('world-countries-50m.json', 'iso_a3')
    const australias = world.filter((f) => f.properties.iso_a3 === 'AUS')
    expect(australias.length).toBeGreaterThan(1)

    const join = resolveJoin({
      features: world,
      data: [{ code: 'AUS', value: 5 }],
      joinBy: ['iso_a3', 'code'],
    })
    expect(join.matched).toBe(australias.length)
    for (const feature of australias) {
      expect(join.byFeatureIndex.get(feature.index)).toEqual({
        code: 'AUS',
        value: 5,
      })
    }
    expect(join.sharedKeys.find((s) => s.key === 'AUS')?.names).toContain('Australia')
    expect(join.report()).toMatch(/shared by several features/)
  })

  it('gives US states the abbreviation people actually have in their data', () => {
    const states = features('us-states-10m.json', 'abbr')
    const california = states.find((f) => f.name === 'California')
    expect(california?.key).toBe('CA')
    expect(california?.properties.fips).toBe('06')
    expect(states.filter((f) => f.key).length).toBe(states.length)
  })

  it('keeps county FIPS codes zero-padded and repairs data that lost them', () => {
    const counties = features('us-counties-10m.json', 'fips')
    expect(counties.length).toBeGreaterThan(3000)
    const join = resolveJoin({
      features: counties,
      // A spreadsheet round-trip turns 04015 into 4015.
      data: [{ fips: 4015, value: 1 }],
      joinBy: ['fips', 'fips'],
    })
    expect(join.matched).toBe(1)
    expect(join.applied.join()).toMatch(/padded "4015" to "04015"/)
  })

  it('keys admin-1 packs on the subdivision code, never the country code', () => {
    // adm0_a3 is present on every feature and sorts earlier in the generic
    // candidate list, so without the pack's own recommendation all 47 Japanese
    // prefectures would share the key "JPN".
    const declared = geoPack('jp/admin1@10m')?.keyField
    expect(declared).toBe('iso_3166_2')

    const prefectures = features('jp-admin1-10m.json', declared)
    expect(prefectures).toHaveLength(47)
    expect(new Set(prefectures.map((f) => f.key)).size).toBe(47)
    expect(prefectures.find((f) => f.name === 'Kagoshima')?.key).toBe('JP-46')
  })

  it('has the right number of first-order units where that is checkable', () => {
    const counts: [string, string, number][] = [
      ['de-admin1-10m.json', 'iso_3166_2', 16],
      ['jp-admin1-10m.json', 'iso_3166_2', 47],
      ['ca-admin1-10m.json', 'iso_3166_2', 13],
      ['br-admin1-10m.json', 'iso_3166_2', 27],
      ['eu-nuts1-20m.json', 'nuts_id', 125],
    ]
    for (const [file, key, expected] of counts) {
      expect(features(file, key).length, file).toBe(expected)
    }
  })

  it('strips the 121 fields Natural Earth ships down to the ones that join', () => {
    const [country] = features('world-countries-110m.json', 'iso_a3')
    const keys = Object.keys(country.properties)
    expect(keys.length).toBeLessThan(12)
    expect(keys).toContain('iso_a3')
    expect(keys).toContain('name')
    // No alternate-language names, no per-country diplomatic variants.
    expect(keys.some((k) => /^name_[a-z]{2}$/.test(k) && k !== 'name_long')).toBe(false)
  })

  it('recommends a projection and a view where the generic default is wrong', () => {
    expect(geoPack('us/states@10m')?.projection).toBe('albersUsa')
    // EPSG:3035, the projection Eurostat publishes NUTS maps in.
    expect(geoPack('eu/nuts1@20m')?.projection).toMatchObject({
      name: 'azimuthalEqualArea',
      rotate: [-10, -52],
    })
    expect(geoPack('eu/nuts1@20m')?.bounds).toEqual([-25, 32, 45, 72])
    expect(geoPack('fr/admin1@10m')?.bounds?.[0]).toBeGreaterThan(-10)
    // The world packs have no business recommending anything.
    expect(geoPack('world/countries@110m')?.projection).toBeUndefined()
    expect(geoPack('world/countries@110m')?.bounds).toBeUndefined()
  })

  it('uses the recommended view, so Europe is not a speck', async () => {
    const distance = async (options: Record<string, unknown>) => {
      const element = document.createElement('div')
      document.body.appendChild(element)
      const map = new ApexMaps(element, {
        chart: { width: 600, height: 400, animations: { enabled: false } },
        geo: { map: 'eu/regions', ...options },
      })
      await map.render()
      const paris = map.viewport.project([2.35, 48.85])
      const berlin = map.viewport.project([13.4, 52.52])
      const projection = map.viewport.projectionName
      map.destroy()
      element.remove()
      return {
        px: Math.hypot(berlin![0] - paris![0], berlin![1] - paris![1]),
        projection,
      }
    }

    const recommended = await distance({})
    // What the pack would look like without the recommendation: NUTS geometry
    // reaches from French Guiana to Réunion, so fitting its extent leaves Europe
    // a few pixels across.
    const rawExtent = await distance({ view: { fit: 'data' }, projection: 'equalEarth' })

    expect(recommended.projection).toBe('azimuthalEqualArea')
    expect(rawExtent.projection).toBe('equalEarth')
    // Paris to Berlin is 880 km. On a 600x400 canvas showing Europe that is a
    // substantial distance; on one showing everything from Guiana to Réunion it is
    // a smudge.
    expect(recommended.px).toBeGreaterThan(60)
    expect(rawExtent.px).toBeLessThan(40)
    expect(recommended.px).toBeGreaterThan(rawExtent.px * 2)
  })

  it('lets an explicit projection or view beat the recommendation', async () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    const map = new ApexMaps(element, {
      chart: { width: 400, height: 300, animations: { enabled: false } },
      geo: { map: 'us', projection: 'mercator' },
    })
    await map.render()
    expect(map.viewport.projectionName).toBe('mercator')
    map.destroy()
    element.remove()
  })

  it('renders a real pack end to end through the public api', async () => {
    const element = document.createElement('div')
    element.style.width = '800px'
    element.style.height = '400px'
    document.body.appendChild(element)

    const map = new ApexMaps(element, {
      chart: { width: 800, height: 400, animations: { enabled: false } },
      geo: { map: 'de/states' },
      series: [
        {
          type: 'choropleth',
          name: 'Population',
          data: [
            { code: 'DE-BY', value: 13.1 },
            { code: 'DE-BE', value: 3.7 },
          ],
          joinBy: ['iso_3166_2', 'code'],
        },
      ],
    })
    await map.render()

    // The pack's own key won, without the caller naming it in geo.keyField.
    expect(map.geo?.keyField).toBe('iso_3166_2')
    expect(map.geo?.features).toHaveLength(16)
    expect(element.querySelectorAll('path.apexmaps-feature').length).toBe(16)
    expect(map.mapMeta?.license).toBe('public domain')
    map.destroy()
    element.remove()
  })
})
