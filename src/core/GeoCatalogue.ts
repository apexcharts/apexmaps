/**
 * The built-in geometry catalogue.
 *
 * This file is the **authoritative list of pack ids**, because ids are public
 * API: once `map: 'us/counties@10m'` appears in someone's dashboard it cannot be
 * renamed. The pipeline in `scripts/build-geo.mjs` must produce exactly these
 * ids, and both the build and the test suite fail if the two disagree.
 *
 * Three decisions are encoded here.
 *
 * **1. Nothing is fetched until a pack is used.** Registration installs loader
 * closures, not geometry, so importing ApexMaps costs no network and no bytes
 * beyond this table. The default bundle still makes zero mandatory requests.
 *
 * **2. Ids name the source's level, and aliases name the country's own term.**
 * Natural Earth's "admin-1" tier is not the first-order division everywhere: for
 * the United Kingdom it is 232 districts, for France 101 departments, for Italy
 * and Spain the provinces. Calling `fr/admin1@10m` "regions" would be a lie that
 * shows up as a wrong map, so the alias is `fr/departments`, and Europeans who
 * want the first-order tier are pointed at the NUTS packs, which model it
 * correctly. `levelName` says what a pack actually contains.
 *
 * **3. Provenance is in the bundle, not in a manifest fetch.** Licence and
 * attribution have to be available the moment geometry renders, and an
 * attribution that depends on a second request is an attribution that will
 * sometimes be missing.
 *
 * @module core/GeoCatalogue
 */

import type { GeoInput } from '../types'
import { registerMap, type MapMeta } from './MapRegistry'
import { layoutToGeoJSON, type LayoutPack } from '../geo/HexLayout'

/**
 * Geometry is versioned independently of the library: a patch release must not
 * change which boundaries you get, and a boundary correction must not require a
 * library upgrade.
 */
export const GEO_DATASET_VERSION = '1'

/**
 * Default location for pack files.
 *
 * The dataset is distributed separately from the library (npm for offline and
 * air-gapped installs, CDN for zero-install use) because 6.7 MB of geometry has
 * no business in a charting dependency. Override with
 * `setGeoSource()` for a self-hosted copy, an air-gapped path, or a bundler
 * import.
 */
export const DEFAULT_GEO_SOURCE = `https://cdn.jsdelivr.net/npm/apexmaps-geo@${GEO_DATASET_VERSION}/`

export type GeoFetcher = (file: string, pack: GeoPack) => Promise<GeoInput>

export interface GeoPack {
  /** Canonical id, always `namespace/name@detail`. */
  id: string
  file: string
  /** What one feature in this pack is. */
  levelName: string
  /** Recommended `joinBy` geometry field. */
  keyField?: string
  detail: 'low' | 'medium' | 'high'
  /** Friendly synonyms, plus the auto-generated detail-free form. */
  aliases: string[]
  source: string
  license: string
  attribution: string
  vintage: string
  boundaries: string
  /** Projection the pack is meant to be drawn in, when the default is wrong for it. */
  projection?: unknown
  /** Recommended view, `[west, south, east, north]`. */
  bounds?: [number, number, number, number]
  note?: string
}

/** Provenance profiles, so twenty-six packs do not repeat the same six strings. */
const PROFILES = {
  ne: {
    source: 'Natural Earth 5.1.1',
    license: 'public domain',
    attribution: '',
    vintage: '2022',
    boundaries: 'Natural Earth de facto boundaries; disputed areas follow the NE default view',
  },
  tiger: {
    source: 'US Census Bureau TIGER/Line via us-atlas 3.0',
    license: 'public domain',
    attribution: '',
    vintage: '2023',
    boundaries: 'US Census legal boundaries',
  },
  nuts: {
    source: 'Eurostat GISCO NUTS 2021 (1:20 million)',
    license: 'CC BY 4.0, EuroGeographics terms apply',
    attribution: '© EuroGeographics for the administrative boundaries',
    vintage: '2021',
    boundaries: 'Eurostat NUTS 2021 classification',
  },
} as const

const DETAIL_BY_SCALE: Record<string, GeoPack['detail']> = {
  '110m': 'low',
  '50m': 'medium',
  '20m': 'low',
  '10m': 'high',
}

interface PackRow {
  id: string
  file: string
  level: string
  key?: string
  /** Friendly synonyms. The first one declared for a name wins. */
  alias?: string | string[]
  /**
   * Projection this pack is meant to be drawn in, when the global default is
   * actively wrong for it. Overridden by an explicit `geo.projection`.
   */
  projection?: unknown
  /**
   * Recommended view as `[west, south, east, north]`, for packs whose full extent
   * is not the map anyone wants: NUTS reaches from French Guiana to Réunion, and
   * fitting all of it leaves Europe a speck. An editorial choice, so it is
   * declared here and overridden by an explicit `geo.view.fit`.
   */
  bounds?: [number, number, number, number]
  note?: string
}

/**
 * EPSG:3035 (ETRS89-LAEA), the projection Eurostat publishes its own maps in:
 * Lambert azimuthal equal-area centred on 10E 52N. Equal-area matters because a
 * NUTS choropleth encodes value as area fill.
 */
const EUROPE_PROJECTION = { name: 'azimuthalEqualArea', rotate: [-10, -52] }

/** Europe without the overseas regions. Cyprus and the Canaries stay in. */
const EUROPE_BOUNDS: [number, number, number, number] = [-25, 32, 45, 72]

const WORLD: PackRow[] = [
  {
    id: 'world/countries@110m',
    file: 'world-countries-110m.json',
    level: 'Countries',
    key: 'iso_a3',
    alias: 'world',
  },
  {
    id: 'world/countries@50m',
    file: 'world-countries-50m.json',
    level: 'Countries',
    key: 'iso_a3',
  },
  {
    id: 'world/land@110m',
    file: 'world-land-110m.json',
    level: 'Landmasses',
    note: 'Coastline only, for use as a backdrop. No join keys.',
  },
  {
    id: 'world/land@50m',
    file: 'world-land-50m.json',
    level: 'Landmasses',
    note: 'Coastline only, for use as a backdrop. No join keys.',
  },
]

const US: PackRow[] = [
  {
    id: 'us/states@10m',
    file: 'us-states-10m.json',
    level: 'States',
    key: 'abbr',
    alias: ['us/states', 'us'],
    projection: 'albersUsa',
    note: 'albersUsa insets Alaska and Hawaii. Without it the Aleutians cross the antimeridian and the map spans the whole world.',
  },
  {
    id: 'us/counties@10m',
    file: 'us-counties-10m.json',
    level: 'Counties',
    key: 'fips',
    alias: 'us/counties',
    projection: 'albersUsa',
    note: 'County FIPS codes are five digits and keep their leading zero. A numeric data key is repaired automatically and the repair is reported.',
  },
  {
    id: 'us/nation@10m',
    file: 'us-nation-10m.json',
    level: 'Nation',
    projection: 'albersUsa',
    note: 'Outline only, for use as a backdrop.',
  },
]

const EU: PackRow[] = [
  {
    id: 'eu/nuts0@20m',
    file: 'eu-nuts0-20m.json',
    level: 'Countries',
    key: 'nuts_id',
    alias: 'eu',
    projection: EUROPE_PROJECTION,
    bounds: EUROPE_BOUNDS,
  },
  {
    id: 'eu/nuts1@20m',
    file: 'eu-nuts1-20m.json',
    level: 'Major regions',
    key: 'nuts_id',
    alias: 'eu/regions',
    projection: EUROPE_PROJECTION,
    bounds: EUROPE_BOUNDS,
  },
  {
    id: 'eu/nuts2@20m',
    file: 'eu-nuts2-20m.json',
    level: 'Basic regions',
    key: 'nuts_id',
    projection: EUROPE_PROJECTION,
    bounds: EUROPE_BOUNDS,
  },
  {
    id: 'eu/nuts3@20m',
    file: 'eu-nuts3-20m.json',
    level: 'Small regions',
    key: 'nuts_id',
    projection: EUROPE_PROJECTION,
    bounds: EUROPE_BOUNDS,
  },
]

/**
 * Admin-1 packs. `level` and `alias` are the country's own term for the tier
 * Natural Earth actually provides, which is why France is departments and the
 * United Kingdom is districts.
 */
const ADMIN1: PackRow[] = [
  {
    id: 'cn/admin1@10m',
    file: 'cn-admin1-10m.json',
    level: 'Provinces',
    key: 'iso_3166_2',
    alias: ['cn/provinces', 'cn'],
  },
  {
    id: 'in/admin1@10m',
    file: 'in-admin1-10m.json',
    level: 'States',
    key: 'iso_3166_2',
    alias: ['in/states', 'in'],
  },
  {
    id: 'jp/admin1@10m',
    file: 'jp-admin1-10m.json',
    level: 'Prefectures',
    key: 'iso_3166_2',
    alias: ['jp/prefectures', 'jp'],
  },
  {
    id: 'de/admin1@10m',
    file: 'de-admin1-10m.json',
    level: 'States',
    key: 'iso_3166_2',
    alias: ['de/states', 'de'],
  },
  {
    id: 'gb/admin1@10m',
    file: 'gb-admin1-10m.json',
    level: 'Districts and unitary authorities',
    key: 'iso_3166_2',
    alias: ['gb/districts', 'gb'],
    note: 'Natural Earth admin-1 for the UK is the district tier, not the four countries or the twelve regions. For those, use eu/nuts1@20m.',
  },
  {
    id: 'fr/admin1@10m',
    file: 'fr-admin1-10m.json',
    level: 'Departments',
    key: 'iso_3166_2',
    alias: ['fr/departments', 'fr'],
    // Metropolitan France. The pack still contains Guadeloupe, Martinique, French
    // Guiana, Réunion and Mayotte, and fitting all of them spans 118 degrees of
    // longitude. Pass geo.view.fit to see them.
    bounds: [-5.5, 41, 10, 51.5],
    note: 'Departments, not regions. For the 13 metropolitan regions use eu/nuts1@20m. The default view is metropolitan France; the overseas departments are in the data.',
  },
  {
    id: 'it/admin1@10m',
    file: 'it-admin1-10m.json',
    level: 'Provinces',
    key: 'iso_3166_2',
    alias: ['it/provinces', 'it'],
    note: 'Provinces, not the 20 regions. For those use eu/nuts2@20m.',
  },
  {
    id: 'ca/admin1@10m',
    file: 'ca-admin1-10m.json',
    level: 'Provinces and territories',
    key: 'iso_3166_2',
    alias: ['ca/provinces', 'ca'],
    projection: { name: 'conicConformal', rotate: [95, 0], parallels: [49, 77] },
  },
  {
    id: 'br/admin1@10m',
    file: 'br-admin1-10m.json',
    level: 'States',
    key: 'iso_3166_2',
    alias: ['br/states', 'br'],
  },
  {
    id: 'ru/admin1@10m',
    file: 'ru-admin1-10m.json',
    level: 'Federal subjects',
    key: 'iso_3166_2',
    alias: ['ru/regions', 'ru'],
    // Chukotka crosses the antimeridian, so any projection centred on 0 degrees
    // tears the country in half and the fitted extent becomes the whole world.
    projection: { name: 'conicEqualArea', rotate: [-100, 0], parallels: [50, 70] },
  },
  {
    id: 'mx/admin1@10m',
    file: 'mx-admin1-10m.json',
    level: 'States',
    key: 'iso_3166_2',
    alias: ['mx/states', 'mx'],
  },
  {
    id: 'au/admin1@10m',
    file: 'au-admin1-10m.json',
    level: 'States and territories',
    key: 'iso_3166_2',
    alias: ['au/states', 'au'],
    // Excludes the Heard and McDonald Islands, which are 4,000 km south west of
    // Perth and otherwise add nine degrees of empty ocean.
    bounds: [112, -44.5, 154.5, -9],
  },
  {
    id: 'kr/admin1@10m',
    file: 'kr-admin1-10m.json',
    level: 'Provinces',
    key: 'iso_3166_2',
    alias: ['kr/provinces', 'kr'],
  },
  {
    id: 'es/admin1@10m',
    file: 'es-admin1-10m.json',
    level: 'Provinces',
    key: 'iso_3166_2',
    alias: ['es/provinces', 'es'],
    note: 'Provinces, not the 17 autonomous communities. For those use eu/nuts2@20m.',
  },
  {
    id: 'id/admin1@10m',
    file: 'id-admin1-10m.json',
    level: 'Provinces',
    key: 'iso_3166_2',
    alias: ['id/provinces', 'id'],
  },
]

function expand(rows: PackRow[], profile: keyof typeof PROFILES): GeoPack[] {
  return rows.map((row) => {
    const scale = row.id.slice(row.id.indexOf('@') + 1)
    const bare = row.id.slice(0, row.id.indexOf('@'))
    // The detail-free form always resolves, and resolves to the pack declared
    // first, which is the lightest one. `world/countries` should not silently
    // download 800 kB.
    const aliases = [bare]
    for (const alias of row.alias ? (Array.isArray(row.alias) ? row.alias : [row.alias]) : []) {
      if (alias !== bare) aliases.push(alias)
    }
    return {
      id: row.id,
      file: row.file,
      levelName: row.level,
      keyField: row.key,
      detail: DETAIL_BY_SCALE[scale] ?? 'medium',
      aliases,
      ...PROFILES[profile],
      ...(row.projection ? { projection: row.projection } : {}),
      ...(row.bounds ? { bounds: row.bounds } : {}),
      ...(row.note ? { note: row.note } : {}),
    }
  })
}

const PACKS: GeoPack[] = [
  ...expand(WORLD, 'ne'),
  ...expand(US, 'tiger'),
  ...expand(EU, 'nuts'),
  ...expand(ADMIN1, 'ne'),
]

/* -------------------------------------------------------------- grid layouts */

/**
 * Hex tile layouts: one equal cell per region, at a hand-authored position.
 *
 * Deliberately a separate table from `PACKS`, not another `expand()` profile.
 * A layout has no scale, no simplification level and no source geometry, so
 * `detail` and the `@10m` id grammar do not apply to it; and `expand()` derives
 * a detail-free alias from the part before the `@`, which for `us/states@hex`
 * would be `us/states` and would fight the real boundary pack for that name.
 *
 * The `@hex` suffix reuses the id grammar's variant slot on purpose: `@10m` and
 * `@hex` are both "which representation of this region set", and a reader who
 * has seen one can guess the other.
 *
 * These files are hand-authored and verified against the boundary pack they
 * claim to represent (`npm run check:layout`), so they are not produced by
 * `npm run data:build` and that script must leave their manifest rows alone.
 */
interface LayoutRow {
  id: string
  file: string
  /** Canonical id of the boundary pack whose keys these cells use. */
  of: string
  level: string
  key: string
  alias?: string | string[]
  /**
   * Keys in the boundary pack this layout leaves out.
   *
   * Declared here as well as in the file because the coverage warning has to be
   * available before the file resolves, and because "which regions does this
   * deliberately omit" is exactly the kind of decision that belongs in reviewed
   * source rather than only in data. `npm run check:layout` fails if the two
   * disagree.
   */
  unplaced?: string[]
  note?: string
}

const LAYOUTS: LayoutRow[] = [
  {
    id: 'us/states@hex',
    file: 'us-states-hex.json',
    of: 'us/states@10m',
    level: 'States',
    key: 'abbr',
    alias: ['us/hex', 'us/states/hex'],
    unplaced: ['AS', 'GU', 'MP', 'PR', 'VI'],
    note: '50 states plus DC. The five inhabited territories in us/states@10m are unplaced: no published one-hex-per-unit layout includes them.',
  },
]

/** Every layout, for documentation and the id-agreement checks. */
export function geoLayouts(): LayoutRow[] {
  return LAYOUTS.slice()
}

/**
 * The layout id for a boundary pack, or undefined if it has none.
 *
 * Accepts an alias, so `geo: { map: 'us', layout: 'hex' }` resolves the same way
 * `geo: { map: 'us/states@10m', layout: 'hex' }` does.
 */
export function layoutIdFor(mapIdOrAlias: string, layout: string): string | undefined {
  if (layout !== 'hex') return undefined
  const pack = geoPack(mapIdOrAlias)
  const canonical = pack?.id ?? mapIdOrAlias
  const row = LAYOUTS.find(
    (l) => l.of === canonical || l.id === mapIdOrAlias || l.alias?.includes(mapIdOrAlias),
  )
  return row?.id
}

/** Every pack, for documentation, tests and `listMaps()` output. */
export function geoPacks(): GeoPack[] {
  return PACKS.slice()
}

export function geoPack(idOrAlias: string): GeoPack | undefined {
  return PACKS.find((p) => p.id === idOrAlias || p.aliases.includes(idOrAlias))
}

/* ------------------------------------------------------------------ fetching */

let currentSource: string | GeoFetcher = DEFAULT_GEO_SOURCE

/**
 * Point the catalogue at a copy of the geometry dataset.
 *
 * Accepts a base URL, or a function, which is how a bundler user pulls packs
 * out of the npm dataset with no network at all:
 *
 * ```js
 * ApexMaps.setGeoSource((file) => import(`apexmaps-geo/${file}`).then((m) => m.default))
 * ```
 */
export function setGeoSource(next: string | GeoFetcher): void {
  if (typeof next !== 'string' && typeof next !== 'function') {
    throw new TypeError('ApexMaps.setGeoSource expects a base URL or a loader function')
  }
  currentSource = next
  // Point the registry back at the loaders and drop what the old source returned.
  // The registry memoizes a resolved pack in place, so without this a source
  // change would be silently ignored for every pack already on screen, which is
  // the one thing this function exists to do.
  byFile.clear()
  if (installed) register()
}

export function geoSource(): string | GeoFetcher {
  return currentSource
}

/**
 * One in-flight request per *file*, not per id.
 *
 * `world/countries@110m` and its two aliases are three registry entries backed by
 * one file, and a dashboard asking for all three must not fetch it three times.
 */
const byFile = new Map<string, Promise<GeoInput>>()

/**
 * One dataset file, through whatever source is configured.
 *
 * Shared by boundary packs and layouts because the fetch, the two failure
 * messages and the self-hosting escape hatch are identical for both; only what
 * happens to the parsed JSON afterwards differs.
 */
async function fetchFile(file: string, id: string, pack?: GeoPack): Promise<unknown> {
  if (typeof currentSource === 'function') return currentSource(file, pack as GeoPack)

  const base = currentSource.endsWith('/') ? currentSource : `${currentSource}/`
  const url = `${base}${file}`
  if (typeof fetch !== 'function') {
    throw new Error(
      `ApexMaps: cannot load "${id}" because fetch is unavailable here. ` +
        'Pass geometry directly, or give ApexMaps.setGeoSource() a loader function.',
    )
  }
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(
      `ApexMaps: could not load map "${id}" from ${url} (HTTP ${response.status}). ` +
        'The geometry dataset ships separately from the library: install it with ' +
        '`npm i apexmaps-geo` and call ApexMaps.setGeoSource(), self-host the files, ' +
        'or pass geometry to geo.map directly.',
    )
  }
  return response.json()
}

/** Dedupe by file, then hand the parsed JSON to `finish`. */
function loadOnce(file: string, run: () => Promise<GeoInput>): Promise<GeoInput> {
  const existing = byFile.get(file)
  if (existing) return existing

  const promise = run().catch((error) => {
    // A failed load must not be cached, or a transient offline moment poisons the
    // pack for the life of the page.
    byFile.delete(file)
    throw error
  })

  byFile.set(file, promise)
  return promise
}

function load(pack: GeoPack): Promise<GeoInput> {
  return loadOnce(pack.file, async () => (await fetchFile(pack.file, pack.id, pack)) as GeoInput)
}

/**
 * A layout file is a table of grid positions, so it becomes geometry here rather
 * than in ingest. What reaches the registry is an ordinary FeatureCollection,
 * which is the reason a layout needs no special case anywhere downstream.
 */
function loadLayout(row: LayoutRow): Promise<GeoInput> {
  return loadOnce(row.file, async () => {
    const pack = (await fetchFile(row.file, row.id)) as LayoutPack
    return layoutToGeoJSON({ ...pack, id: row.id, keyField: pack.keyField ?? row.key }) as GeoInput
  })
}

/* -------------------------------------------------------------- registration */

function metaFor(pack: GeoPack): MapMeta {
  return {
    source: pack.source,
    license: pack.license,
    attribution: pack.attribution,
    vintage: pack.vintage,
    detail: pack.detail,
    boundaries: pack.boundaries,
    projection: pack.projection,
    bounds: pack.bounds,
    keyField: pack.keyField,
    levelName: pack.levelName,
    packId: pack.id,
    file: pack.file,
    ...(pack.note ? { note: pack.note } : {}),
  }
}

let installed = false

/**
 * Register every pack and alias.
 *
 * Called from the ApexMaps module rather than by a bare side-effect import,
 * because the package declares `sideEffects: false` and a bundler is entitled to
 * drop an import whose result is unused.
 */
export function installCatalogue(): void {
  if (installed) return
  installed = true
  register()
}

function register(): void {
  const canonical = new Set(PACKS.map((p) => p.id))
  const claimed = new Set<string>()

  for (const pack of PACKS) {
    const meta = metaFor(pack)
    registerMap(pack.id, () => load(pack), meta)

    for (const alias of pack.aliases) {
      // First declaration wins, which is why the lightest pack is listed first:
      // `world/countries` must not silently pull the 800 kB file.
      if (canonical.has(alias) || claimed.has(alias)) continue
      claimed.add(alias)
      registerMap(alias, () => load(pack), { ...meta, aliasOf: pack.id })
    }
  }

  // Layouts register after the boundary packs so that a layout alias can never
  // take a name a real pack already answers to.
  for (const row of LAYOUTS) {
    const ids = [row.id, ...(row.alias ? (Array.isArray(row.alias) ? row.alias : [row.alias]) : [])]
    for (const id of ids) {
      if (id !== row.id && (canonical.has(id) || claimed.has(id))) continue
      claimed.add(id)
      // The recommendations are stated here, not read out of the file, because
      // meta has to be right before the fetch resolves: `_buildViewport` reads
      // the projection, and being a grid rather than a place is a property of
      // the declaration, not of its contents.
      registerMap(id, () => loadLayout(row), {
        levelName: row.level,
        keyField: row.key,
        projection: 'identity',
        labelField: row.key,
        fixed: true,
        layout: { grid: 'hex', of: row.of, unplaced: row.unplaced },
        packId: row.id,
        file: row.file,
        ...(id === row.id ? {} : { aliasOf: row.id }),
        ...(row.note ? { note: row.note } : {}),
      })
    }
  }
}

/** Test helper: forget cached loads and restore the loader closures. */
export function _resetGeoLoads(): void {
  byFile.clear()
  if (installed) register()
}
