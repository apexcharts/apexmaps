// @vitest-environment jsdom
/**
 * Grid layouts: the generator, the registry seam, and the defaults a layout
 * carries about itself.
 *
 * The generator is worth testing closely because every way it can be wrong
 * produces a map that renders. An upside-down country, a lattice of gaps, a
 * ring wound inside out, two states on one cell: all of them draw, and none of
 * them throws. So the assertions here are about geometry and orientation rather
 * than about not crashing.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import ApexMaps from '../src/ApexMaps'
import { layoutToGeoJSON, layoutMeta, type LayoutPack } from '../src/geo/HexLayout'
import { registerLayout, mapMeta, resolveMap, _resetRegistry } from '../src/core/MapRegistry'
import {
  layoutIdFor,
  geoLayouts,
  setGeoSource,
  geoSource,
  DEFAULT_GEO_SOURCE,
  installCatalogue,
  _resetGeoLoads,
} from '../src/core/GeoCatalogue'
import type { GeoInput } from '../src/types'

const GEO_DIR = resolve(process.cwd(), 'geo')
const HEX_FILE = resolve(GEO_DIR, 'us-states-hex.json')
const hasLayout = existsSync(HEX_FILE)

function readPack(file: string): GeoInput {
  return JSON.parse(readFileSync(resolve(GEO_DIR, file), 'utf8')) as GeoInput
}

const SQRT3 = Math.sqrt(3)

/** A minimal two-by-two layout, enough to pin down the lattice. */
const QUAD: LayoutPack = {
  keyField: 'code',
  cells: { NW: [0, 0], NE: [1, 0], SW: [0, 1], SE: [1, 1] },
  names: { NW: 'North west', NE: 'North east', SW: 'South west', SE: 'South east' },
}

/** Signed area under the y-up convention `d3-geo` reads. */
function signedArea(ring: number[][]): number {
  let sum = 0
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
  }
  return sum / 2
}

function centreOf(ring: number[][]): [number, number] {
  const pts = ring.slice(0, -1)
  return [
    pts.reduce((a, p) => a + p[0], 0) / pts.length,
    pts.reduce((a, p) => a + p[1], 0) / pts.length,
  ]
}

afterEach(() => {
  setGeoSource(DEFAULT_GEO_SOURCE)
  _resetGeoLoads()
  vi.unstubAllGlobals()
})

describe('the generator', () => {
  it('makes one six-sided polygon per cell, keyed and named', () => {
    const fc = layoutToGeoJSON(QUAD)
    expect(fc.features).toHaveLength(4)

    for (const feature of fc.features) {
      // Six corners plus the repeated closing point.
      expect(feature.geometry.coordinates[0]).toHaveLength(7)
      expect(feature.geometry.coordinates[0][0]).toEqual(feature.geometry.coordinates[0][6])
    }

    const nw = fc.features[0]
    expect(nw.properties?.code).toBe('NW')
    expect(nw.properties?.name).toBe('North west')
    expect(nw.properties?.col).toBe(0)
    expect(nw.properties?.row).toBe(0)
  })

  it('puts row 0 at the top, not the bottom', () => {
    // The whole country renders upside down if this is wrong, and it still
    // looks like a plausible honeycomb, so nothing else would catch it.
    const fc = layoutToGeoJSON(QUAD)
    const byKey = new Map(
      fc.features.map((f) => [f.properties?.code as string, centreOf(f.geometry.coordinates[0])]),
    )
    expect(byKey.get('NW')![1]).toBeLessThan(byKey.get('SW')![1])
    expect(byKey.get('NE')![1]).toBeLessThan(byKey.get('SE')![1])
  })

  it('puts col 0 on the left', () => {
    const fc = layoutToGeoJSON(QUAD)
    const byKey = new Map(
      fc.features.map((f) => [f.properties?.code as string, centreOf(f.geometry.coordinates[0])]),
    )
    expect(byKey.get('NW')![0]).toBeLessThan(byKey.get('NE')![0])
  })

  it('winds every ring the way d3-geo reads as "the inside is here"', () => {
    // Wound the other way, each cell projects as the whole plane minus the
    // cell. Ingest repairs it, so the only symptom is a warning nobody reads.
    for (const feature of layoutToGeoJSON(QUAD).features) {
      expect(signedArea(feature.geometry.coordinates[0])).toBeLessThan(0)
    }
  })

  it('spaces pointy-top rows 1.5 radii apart, not 2', () => {
    // At a pitch of 2 the hexagons stop tessellating and the map grows a
    // lattice of gaps that reads as missing data.
    const fc = layoutToGeoJSON({ ...QUAD, cells: { A: [0, 0], B: [0, 2] } }, { gap: 0 })
    const [a, b] = fc.features.map((f) => centreOf(f.geometry.coordinates[0]))
    expect(b[1] - a[1]).toBeCloseTo(3, 6) // two rows at 1.5
  })

  it('offsets odd rows by half a cell, and even-r the other rows', () => {
    const odd = layoutToGeoJSON({ ...QUAD, cells: { A: [0, 0], B: [0, 1] } })
    const [a0, b0] = odd.features.map((f) => centreOf(f.geometry.coordinates[0])[0])
    expect(b0 - a0).toBeCloseTo(SQRT3 / 2, 6)

    const even = layoutToGeoJSON({ ...QUAD, offset: 'even-r', cells: { A: [0, 0], B: [0, 1] } })
    const [a1, b1] = even.features.map((f) => centreOf(f.geometry.coordinates[0])[0])
    expect(b1 - a1).toBeCloseTo(-SQRT3 / 2, 6)
  })

  it('offsets flat-top columns vertically instead', () => {
    const fc = layoutToGeoJSON({
      ...QUAD,
      orientation: 'flat',
      cells: { A: [0, 0], B: [1, 0] },
    })
    const [a, b] = fc.features.map((f) => centreOf(f.geometry.coordinates[0]))
    expect(b[0] - a[0]).toBeCloseTo(1.5, 6)
    expect(b[1] - a[1]).toBeCloseTo(SQRT3 / 2, 6)
  })

  it('draws four-cornered cells for a square grid', () => {
    const fc = layoutToGeoJSON({ ...QUAD, grid: 'square' })
    expect(fc.features[0].geometry.coordinates[0]).toHaveLength(5)
    for (const feature of fc.features) {
      expect(signedArea(feature.geometry.coordinates[0])).toBeLessThan(0)
    }
  })

  it('shrinks cells by the gap, leaving centres where they were', () => {
    const tight = layoutToGeoJSON(QUAD, { gap: 0 })
    const loose = layoutToGeoJSON(QUAD, { gap: 0.5 })
    const span = (fc: ReturnType<typeof layoutToGeoJSON>) => {
      const ring = fc.features[0].geometry.coordinates[0]
      const ys = ring.map((p) => p[1])
      return Math.max(...ys) - Math.min(...ys)
    }
    expect(span(loose)).toBeLessThan(span(tight))
    const [tx, ty] = centreOf(tight.features[0].geometry.coordinates[0])
    const [lx, ly] = centreOf(loose.features[0].geometry.coordinates[0])
    expect(lx).toBeCloseTo(tx, 12)
    expect(ly).toBeCloseTo(ty, 12)
  })

  describe('rejects a pack that would render and be wrong', () => {
    it('two regions on one cell', () => {
      expect(() => layoutToGeoJSON({ keyField: 'code', cells: { A: [0, 0], B: [0, 0] } })).toThrow(
        /claimed by both/,
      )
    })

    it('a cell that is not [col, row]', () => {
      expect(() => layoutToGeoJSON({ keyField: 'code', cells: { A: [0] } })).toThrow(
        /must be \[col, row\]/,
      )
      expect(() => layoutToGeoJSON({ keyField: 'code', cells: { A: [0, Number.NaN] } })).toThrow(
        /finite numbers/,
      )
    })

    it('an offset convention that contradicts the orientation', () => {
      // Reading an odd-r table as odd-q shifts every cell and still draws a
      // honeycomb, so this has to be refused rather than reinterpreted.
      expect(() => layoutToGeoJSON({ ...QUAD, orientation: 'pointy', offset: 'odd-q' })).toThrow(
        /pointy-top/,
      )
      expect(() => layoutToGeoJSON({ ...QUAD, orientation: 'flat', offset: 'even-r' })).toThrow(
        /flat-top/,
      )
    })

    it('no keyField, so nothing could join to it', () => {
      expect(() => layoutToGeoJSON({ cells: { A: [0, 0] } } as LayoutPack)).toThrow(/keyField/)
    })

    it('no cells at all', () => {
      expect(() => layoutToGeoJSON({ keyField: 'code', cells: {} })).toThrow(/no cells/)
    })
  })
})

describe('what a layout says about itself', () => {
  it('recommends identity, key labels and no gestures', () => {
    const meta = layoutMeta(QUAD)
    expect(meta.projection).toBe('identity')
    expect(meta.labelField).toBe('code')
    expect(meta.fixed).toBe(true)
  })

  it('reaches the registry through registerLayout', () => {
    registerLayout('demo/quad@hex', QUAD)
    const meta = mapMeta('demo/quad@hex')
    expect(meta?.projection).toBe('identity')
    expect(meta?.labelField).toBe('code')
    expect(meta?.fixed).toBe(true)
    expect(meta?.keyField).toBe('code')
  })

  it('resolves to geometry with no fetch', async () => {
    registerLayout('demo/quad@hex', QUAD)
    const resolved = await resolveMap('demo/quad@hex')
    expect((resolved.data as { features: unknown[] }).features).toHaveLength(4)
  })

  it('refuses an empty id', () => {
    expect(() => registerLayout('', QUAD)).toThrow(/non-empty string/)
  })
})

describe('geo.layout', () => {
  it('maps a boundary pack and an alias to the same layout id', () => {
    expect(layoutIdFor('us/states@10m', 'hex')).toBe('us/states@hex')
    expect(layoutIdFor('us', 'hex')).toBe('us/states@hex')
    expect(layoutIdFor('us/states', 'hex')).toBe('us/states@hex')
  })

  it('has no layout for a pack that has none', () => {
    expect(layoutIdFor('world/countries@110m', 'hex')).toBeUndefined()
    expect(layoutIdFor('jp/admin1@10m', 'hex')).toBeUndefined()
  })

  it('resolves every shipped layout from its country alias', () => {
    // The alias is how anyone will actually reach these, so the mapping from a
    // boundary pack to its layout is asserted for each rather than for the US
    // alone: it is table-driven, and a wrong `of` would only show up here.
    expect(layoutIdFor('au', 'hex')).toBe('au/admin1@hex')
    expect(layoutIdFor('ca', 'hex')).toBe('ca/admin1@hex')
    expect(layoutIdFor('de', 'hex')).toBe('de/admin1@hex')
    expect(layoutIdFor('de/states', 'hex')).toBe('de/admin1@hex')
  })

  it('declares an unplaced list for every layout that is a subset', () => {
    // The coverage warning reads this copy, and `npm run check:layout` fails if
    // it disagrees with the file's own.
    const us = geoLayouts().find((l) => l.id === 'us/states@hex')
    expect(us?.unplaced).toEqual(['AS', 'GU', 'MP', 'PR', 'VI'])
  })
})

describe.skipIf(!hasLayout)('the committed us/states@hex pack', () => {
  beforeEach(() => {
    installCatalogue()
    setGeoSource((file) => Promise.resolve(readPack(file)))
  })

  it('is registered under its id and its aliases', async () => {
    for (const id of ['us/states@hex', 'us/hex', 'us/states/hex']) {
      const resolved = await resolveMap(id)
      expect((resolved.data as { features: unknown[] }).features).toHaveLength(51)
    }
  })

  it('does not answer to the boundary packid it is a layout of', async () => {
    // `us` and `us/states` belong to the real geometry. A layout quietly taking
    // one of those names would redraw every existing map as a honeycomb.
    const resolved = await resolveMap('us')
    expect((resolved.data as { type?: string }).type).toBe('Topology')
  })

  it('generates cells keyed by the same field the boundary pack joins on', async () => {
    const resolved = await resolveMap('us/states@hex')
    const keys = (resolved.data as { features: { properties: { abbr: string } }[] }).features.map(
      (f) => f.properties.abbr,
    )
    expect(keys).toContain('CA')
    expect(keys).toContain('DC')
    expect(keys).not.toContain('PR')
    expect(new Set(keys).size).toBe(51)
  })

  it('carries the layout recommendations before the file has loaded', () => {
    // Meta has to be right at registration time: `_buildViewport` reads the
    // projection, and it runs on geometry that has only just arrived.
    const meta = mapMeta('us/states@hex')
    expect(meta?.projection).toBe('identity')
    expect(meta?.labelField).toBe('abbr')
    expect(meta?.fixed).toBe(true)
    expect((meta?.layout as { of: string }).of).toBe('us/states@10m')
  })

  it('agrees with GeoCatalogue about what it leaves out', () => {
    const pack = JSON.parse(readFileSync(HEX_FILE, 'utf8')) as { unplaced: string[] }
    const row = geoLayouts().find((l) => l.id === 'us/states@hex')
    expect([...pack.unplaced].sort()).toEqual([...(row?.unplaced ?? [])].sort())
  })
})

describe.skipIf(!hasLayout)('every shipped layout', () => {
  beforeEach(() => {
    installCatalogue()
    setGeoSource((file) => Promise.resolve(readPack(file)))
  })

  const SHIPPED = [
    { id: 'au/admin1@hex', cells: 8, key: 'iso_3166_2', has: 'AU-TAS' },
    { id: 'ca/admin1@hex', cells: 13, key: 'iso_3166_2', has: 'CA-NU' },
    { id: 'de/admin1@hex', cells: 16, key: 'iso_3166_2', has: 'DE-BE' },
    { id: 'us/states@hex', cells: 51, key: 'abbr', has: 'DC' },
  ]

  for (const layout of SHIPPED) {
    it(`${layout.id} generates ${layout.cells} keyed cells`, async () => {
      const resolved = await resolveMap(layout.id)
      const features = (resolved.data as { features: { properties: Record<string, string> }[] })
        .features
      expect(features).toHaveLength(layout.cells)
      expect(features.map((f) => f.properties[layout.key])).toContain(layout.has)
      // Six corners and the closing point, for every cell in every layout.
      for (const f of features as unknown as { geometry: { coordinates: number[][][] } }[]) {
        expect(f.geometry.coordinates[0]).toHaveLength(7)
      }
    })
  }

  it('keys every cell to a real feature in the boundary pack it claims', async () => {
    // The join is the whole promise: one dataset, either representation. A cell
    // keyed to something the boundary pack has never heard of silently drops.
    for (const layout of SHIPPED) {
      const row = geoLayouts().find((l) => l.id === layout.id)!
      const boundary = await resolveMap(row.of)
      const geometries = (
        boundary.data as {
          objects: Record<string, { geometries: { properties: Record<string, string> }[] }>
        }
      ).objects
      const real = new Set(
        Object.values(geometries)[0].geometries.map((g) => g.properties?.[layout.key]),
      )
      const cells = await resolveMap(layout.id)
      for (const f of (cells.data as { features: { properties: Record<string, string> }[] })
        .features) {
        expect(
          real.has(f.properties[layout.key]),
          `${layout.id}: ${f.properties[layout.key]}`,
        ).toBe(true)
      }
    }
  })
})

describe.skipIf(!hasLayout)('rendering a layout', () => {
  let host: HTMLDivElement

  beforeEach(() => {
    installCatalogue()
    setGeoSource((file) => Promise.resolve(readPack(file)))
    host = document.createElement('div')
    Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 500, configurable: true })
    document.body.appendChild(host)
  })

  afterEach(() => {
    host.remove()
    _resetRegistry()
    installCatalogue()
  })

  it('draws one mark per cell from a series keyed for the boundary pack', async () => {
    const map = new ApexMaps(host, {
      geo: { map: 'us', layout: 'hex' },
      series: [
        {
          name: 'v',
          joinBy: ['abbr', 'key'],
          data: [
            { key: 'CA', value: 1 },
            { key: 'TX', value: 2 },
            { key: 'NY', value: 3 },
          ],
        },
      ],
    })
    await map.render()
    expect(host.querySelectorAll('path').length).toBeGreaterThanOrEqual(51)
    map.destroy()
  })

  it('turns zoom and pan off, and takes the controls with them', async () => {
    const map = new ApexMaps(host, { geo: { map: 'us', layout: 'hex' }, series: [] })
    await map.render()
    expect(host.querySelector('.apexmaps-zoom')).toBeNull()
    map.destroy()
  })

  it('still lets a caller ask for zoom back', async () => {
    const map = new ApexMaps(host, {
      geo: { map: 'us', layout: 'hex' },
      interaction: { zoom: { enabled: true } },
      series: [],
    })
    await map.render()
    expect(host.querySelector('.apexmaps-zoom')).not.toBeNull()
    map.destroy()
  })

  it('explains itself when no layout exists for the map', async () => {
    const map = new ApexMaps(host, { geo: { map: 'jp', layout: 'hex' }, series: [] })
    await expect(map.render()).rejects.toThrow(/no "hex" layout exists for map "jp"/)
    map.destroy()
  })

  it('warns that the layout covers fewer regions than the boundary pack', async () => {
    const map = new ApexMaps(host, { geo: { map: 'us', layout: 'hex' }, series: [] })
    await map.render()
    expect(map.warnings.join(' ')).toMatch(/places 51 of the 56 regions/)
    expect(map.warnings.join(' ')).toMatch(/AS, GU, MP, PR, VI/)
    map.destroy()
  })

  it('reloads geometry when only the layout changes', async () => {
    // `geo.map` is untouched by this update, so comparing only `map` would
    // change the config and leave the old shapes on screen. This is the path a
    // geography-to-honeycomb toggle takes.
    const map = new ApexMaps(host, { geo: { map: 'us', layout: 'hex' }, series: [] })
    await map.render()
    expect(map.mapId).toBe('us/states@hex')

    await map.updateOptions({ geo: { map: 'us', layout: null } })
    expect(map.mapId).toBe('us')

    await map.updateOptions({ geo: { map: 'us', layout: 'hex' } })
    expect(map.mapId).toBe('us/states@hex')
    map.destroy()
  })

  it('carries a pack-level gap into the geometry', async () => {
    // `gap` belongs to the pack, not to the render call, so it has to survive
    // the trip through the registry. It was unreachable from any public entry
    // point when it lived only on the options argument.
    ApexMaps.registerLayout('demo/tight@hex', { keyField: 'code', cells: { A: [0, 0] }, gap: 0 })
    ApexMaps.registerLayout('demo/loose@hex', { keyField: 'code', cells: { A: [0, 0] }, gap: 0.5 })

    const span = async (id: string) => {
      const resolved = await resolveMap(id)
      const ring = (resolved.data as { features: { geometry: { coordinates: number[][][] } }[] })
        .features[0].geometry.coordinates[0]
      const ys = ring.map((p) => p[1])
      return Math.max(...ys) - Math.min(...ys)
    }
    expect(await span('demo/loose@hex')).toBeLessThan(await span('demo/tight@hex'))
  })

  it('gives the gestures back when drilling out of a layout, and takes them away coming back', async () => {
    // Drilling from a hex cell into real county boundaries changes which
    // gestures exist, and `interaction` says nothing about it. Landing on a
    // county map that cannot be zoomed is the failure this guards.
    const map = new ApexMaps(host, {
      geo: { map: 'us', layout: 'hex' },
      series: [
        {
          type: 'choropleth',
          joinBy: ['abbr', 'key'],
          data: [{ key: 'CA', value: 1 }],
          drilldown: { map: 'us/counties' },
        },
      ],
    })
    await map.render()
    expect(host.querySelector('.apexmaps-zoom')).toBeNull()

    await map.drillTo('CA')
    expect(map.mapId).toBe('us/counties')
    expect(host.querySelector('.apexmaps-zoom')).not.toBeNull()

    await map.drillUp()
    expect(map.mapId).toBe('us/states@hex')
    expect(host.querySelector('.apexmaps-zoom')).toBeNull()
    map.destroy()
  })

  it('gives the gestures back when the layout is swapped for real boundaries', async () => {
    // The effective gestures are not read from `interaction` alone, so a map
    // change has to re-attach: `interaction` is byte-identical across this
    // update and the answer still has to change.
    const map = new ApexMaps(host, { geo: { map: 'us', layout: 'hex' }, series: [] })
    await map.render()
    expect(host.querySelector('.apexmaps-zoom')).toBeNull()

    await map.updateOptions({ geo: { map: 'us', layout: null } })
    expect(host.querySelector('.apexmaps-zoom')).not.toBeNull()

    await map.updateOptions({ geo: { map: 'us', layout: 'hex' } })
    expect(host.querySelector('.apexmaps-zoom')).toBeNull()
    map.destroy()
  })
})

describe('the geo source is left alone', () => {
  it('restores after each test', () => {
    expect(geoSource()).toBe(DEFAULT_GEO_SOURCE)
  })
})
