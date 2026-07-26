/**
 * Geometry pipeline source definitions.
 *
 * Every pack in the ApexMaps geo registry is produced from one of the sources
 * below. Three rules govern what may appear here:
 *
 *  1. **Permissive licence only.** Public domain or attribution. GADM is
 *     permanently excluded (non-commercial only).
 *  2. **Provenance travels with the file.** Source, licence, attribution,
 *     vintage and boundary policy are written into the manifest, not into a
 *     README that goes stale.
 *  3. **Join keys are repaired here, once**, rather than in every user's data
 *     wrangling. A pack whose only key is a display name is a pack that will
 *     fail to join.
 *
 * The authoritative list of *ids* is `src/core/GeoCatalogue.ts`, because ids are
 * public API and belong in reviewed source. This file says how to produce them;
 * the build fails if the two disagree.
 */

import { US_STATE_ABBR, US_STATE_NAME } from './us-states.mjs'

const NE_GEOJSON = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/'
const GISCO = 'https://gisco-services.ec.europa.eu/distribution/v2/nuts/geojson/'

/**
 * Provenance profiles, factored out so thirty packs do not repeat the same six
 * strings thirty times.
 */
export const PROFILES = {
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
}

/**
 * Natural Earth's ISO_A3 is `-99` for a handful of countries, including two that
 * surprise everyone: **Norway and France**. Both have ISO codes; NE omits them
 * because it splits their overseas parts into separate features. Anyone joining
 * on `iso_a3` loses France silently, which is the exact failure mode the join
 * diagnostic exists to catch, so the fix belongs upstream in the data.
 *
 * Repair order: ISO_A3, then ISO_A3_EH (the "eh" variant resolves Norway and
 * France), then a user-assigned code where one is in common use, then ADM0_A3.
 */
const ISO_A3_OVERRIDE = {
  Kosovo: 'XKX', // user-assigned, used by the World Bank and IMF
  'N. Cyprus': 'CYN', // no ISO code exists; ADM0_A3 is the de facto key
  Somaliland: 'SOL',
}

/** Case-insensitive property read: NE files are UPPERCASE at admin-0, lowercase at admin-1. */
function prop(props, name) {
  if (name in props) return props[name]
  const upper = name.toUpperCase()
  if (upper in props) return props[upper]
  const lower = name.toLowerCase()
  return lower in props ? props[lower] : undefined
}

function clean(value) {
  if (value === undefined || value === null) return undefined
  if (value === -99 || value === '-99' || value === '') return undefined
  return value
}

function isoA3(props) {
  const name = clean(prop(props, 'name'))
  return (
    clean(prop(props, 'iso_a3')) ??
    clean(prop(props, 'iso_a3_eh')) ??
    ISO_A3_OVERRIDE[name] ??
    clean(prop(props, 'adm0_a3')) ??
    undefined
  )
}

/** Admin-0 countries: the pack most people will use, so it gets every key they might have. */
function countryProps(props) {
  return {
    name: clean(prop(props, 'name')),
    name_long: clean(prop(props, 'name_long')),
    iso_a2: clean(prop(props, 'iso_a2')) ?? clean(prop(props, 'iso_a2_eh')),
    iso_a3: isoA3(props),
    iso_n3: clean(prop(props, 'iso_n3')) ?? clean(prop(props, 'iso_n3_eh')),
    continent: clean(prop(props, 'continent')),
    region_un: clean(prop(props, 'region_un')),
    subregion: clean(prop(props, 'subregion')),
  }
}

/**
 * Admin-1 subdivisions. `iso_3166_2` is the standard subdivision code (`JP-46`,
 * `US-CA`, `DE-BY`) and is what a well-formed dataset uses; `postal` and
 * `code_hasc` cover the datasets that are not well formed.
 */
function admin1Props(props) {
  return {
    name: clean(prop(props, 'name')),
    name_local: clean(prop(props, 'name_local')),
    iso_3166_2: clean(prop(props, 'iso_3166_2')),
    postal: clean(prop(props, 'postal')),
    abbrev: clean(prop(props, 'abbrev')),
    code_hasc: clean(prop(props, 'code_hasc')),
    type_en: clean(prop(props, 'type_en')),
    region: clean(prop(props, 'region')),
    iso_a2: clean(prop(props, 'iso_a2')),
    adm0_a3: clean(prop(props, 'adm0_a3')),
  }
}

function nutsProps(props) {
  return {
    name: clean(props.NAME_LATN) ?? clean(props.NUTS_NAME),
    nuts_id: clean(props.NUTS_ID),
    level: props.LEVL_CODE,
    cntr_code: clean(props.CNTR_CODE),
    iso_a3: clean(props.ISO3_CODE),
  }
}

/**
 * Countries that get an admin-1 pack in registry v1.
 *
 * Chosen as the fifteen largest economies excluding the United States, which is
 * served better by TIGER. `level` records what Natural Earth's admin-1 tier
 * actually *is* for that country, which is not always the first-order division:
 * for the United Kingdom, France, Italy and Spain, NE's admin-1 is the
 * district/department/province tier. Claiming otherwise in the pack name would
 * be a lie that surfaces as a wrong map. Europeans wanting the first-order tier
 * are pointed at the NUTS packs, which model it correctly.
 */
export const ADMIN1_COUNTRIES = [
  { iso2: 'CN', slug: 'cn', level: 'provinces' },
  { iso2: 'IN', slug: 'in', level: 'states' },
  { iso2: 'JP', slug: 'jp', level: 'prefectures' },
  { iso2: 'DE', slug: 'de', level: 'states' },
  { iso2: 'GB', slug: 'gb', level: 'districts' },
  { iso2: 'FR', slug: 'fr', level: 'departments' },
  { iso2: 'IT', slug: 'it', level: 'provinces' },
  { iso2: 'CA', slug: 'ca', level: 'provinces' },
  { iso2: 'BR', slug: 'br', level: 'states' },
  { iso2: 'RU', slug: 'ru', level: 'regions' },
  { iso2: 'MX', slug: 'mx', level: 'states' },
  { iso2: 'AU', slug: 'au', level: 'states' },
  { iso2: 'KR', slug: 'kr', level: 'provinces' },
  { iso2: 'ES', slug: 'es', level: 'provinces' },
  { iso2: 'ID', slug: 'id', level: 'provinces' },
]

/**
 * Downloads. Cached under `.geo-cache/` so re-running the pipeline is free and
 * a flaky network cannot corrupt a release.
 */
export const DOWNLOADS = {
  'ne_110m_admin_0.geojson': `${NE_GEOJSON}ne_110m_admin_0_countries.geojson`,
  'ne_50m_admin_0.geojson': `${NE_GEOJSON}ne_50m_admin_0_countries.geojson`,
  'ne_110m_land.geojson': `${NE_GEOJSON}ne_110m_land.geojson`,
  'ne_50m_land.geojson': `${NE_GEOJSON}ne_50m_land.geojson`,
  'ne_10m_admin_1.geojson': `${NE_GEOJSON}ne_10m_admin_1_states_provinces.geojson`,
  'nuts0.geojson': `${GISCO}NUTS_RG_20M_2021_4326_LEVL_0.geojson`,
  'nuts1.geojson': `${GISCO}NUTS_RG_20M_2021_4326_LEVL_1.geojson`,
  'nuts2.geojson': `${GISCO}NUTS_RG_20M_2021_4326_LEVL_2.geojson`,
  'nuts3.geojson': `${GISCO}NUTS_RG_20M_2021_4326_LEVL_3.geojson`,
}

/**
 * Pack definitions. Each produces one file in `geo/`.
 *
 * `object` is the TopoJSON object name inside the file. It is part of the
 * contract: the loader reads the first object, but a stable name keeps
 * hand-written `topojson.feature()` calls working.
 */
export const PACKS = [
  {
    id: 'world/countries@110m',
    file: 'world-countries-110m.json',
    object: 'countries',
    profile: 'ne',
    detail: 'low',
    from: 'ne_110m_admin_0.geojson',
    props: countryProps,
    idField: 'iso_a3',
    keyField: 'iso_a3',
    levelName: 'Countries',
    quantization: 1e5,
  },
  {
    id: 'world/countries@50m',
    file: 'world-countries-50m.json',
    object: 'countries',
    profile: 'ne',
    detail: 'medium',
    from: 'ne_50m_admin_0.geojson',
    props: countryProps,
    idField: 'iso_a3',
    keyField: 'iso_a3',
    levelName: 'Countries',
    quantization: 2e5,
  },
  {
    id: 'world/land@110m',
    file: 'world-land-110m.json',
    object: 'land',
    profile: 'ne',
    detail: 'low',
    from: 'ne_110m_land.geojson',
    props: () => ({}),
    levelName: 'Landmasses',
    quantization: 1e5,
    note: 'Coastline only, for use as a backdrop. No join keys.',
  },
  {
    id: 'world/land@50m',
    file: 'world-land-50m.json',
    object: 'land',
    profile: 'ne',
    detail: 'medium',
    from: 'ne_50m_land.geojson',
    props: () => ({}),
    levelName: 'Landmasses',
    quantization: 2e5,
    note: 'Coastline only, for use as a backdrop. No join keys.',
  },

  // United States, from TIGER rather than Natural Earth: legal boundaries,
  // complete county coverage, and already quantized TopoJSON.
  {
    id: 'us/states@10m',
    file: 'us-states-10m.json',
    object: 'states',
    profile: 'tiger',
    detail: 'high',
    fromTopo: 'node_modules/us-atlas/states-10m.json',
    topoObject: 'states',
    keyField: 'abbr',
    levelName: 'States',
    decorate: (geometry) => {
      const fips = String(geometry.id)
      geometry.properties = {
        name: geometry.properties?.name,
        abbr: US_STATE_ABBR[fips],
        fips,
      }
    },
  },
  {
    id: 'us/counties@10m',
    file: 'us-counties-10m.json',
    object: 'counties',
    profile: 'tiger',
    detail: 'high',
    fromTopo: 'node_modules/us-atlas/counties-10m.json',
    topoObject: 'counties',
    keyField: 'fips',
    levelName: 'Counties',
    decorate: (geometry) => {
      const fips = String(geometry.id).padStart(5, '0')
      const stateFips = fips.slice(0, 2)
      geometry.properties = {
        name: geometry.properties?.name,
        fips,
        state_fips: stateFips,
        state_abbr: US_STATE_ABBR[stateFips],
        state: US_STATE_NAME[stateFips],
      }
    },
    note: 'County FIPS codes are five digits and keep leading zeros. Numeric data keys are repaired automatically by the join.',
  },
  {
    id: 'us/nation@10m',
    file: 'us-nation-10m.json',
    object: 'nation',
    profile: 'tiger',
    detail: 'high',
    fromTopo: 'node_modules/us-atlas/states-10m.json',
    topoObject: 'nation',
    levelName: 'Nation',
    note: 'Outline only, for use as a backdrop.',
  },

  // Europe. NUTS models the first-order tier correctly for every member state,
  // which Natural Earth's admin-1 does not.
  {
    id: 'eu/nuts0@20m',
    file: 'eu-nuts0-20m.json',
    object: 'nuts0',
    profile: 'nuts',
    detail: 'low',
    from: 'nuts0.geojson',
    props: nutsProps,
    idField: 'nuts_id',
    keyField: 'nuts_id',
    levelName: 'Countries',
    quantization: 1e5,
  },
  {
    id: 'eu/nuts1@20m',
    file: 'eu-nuts1-20m.json',
    object: 'nuts1',
    profile: 'nuts',
    detail: 'low',
    from: 'nuts1.geojson',
    props: nutsProps,
    idField: 'nuts_id',
    keyField: 'nuts_id',
    levelName: 'Major regions',
    quantization: 1e5,
  },
  {
    id: 'eu/nuts2@20m',
    file: 'eu-nuts2-20m.json',
    object: 'nuts2',
    profile: 'nuts',
    detail: 'low',
    from: 'nuts2.geojson',
    props: nutsProps,
    idField: 'nuts_id',
    keyField: 'nuts_id',
    levelName: 'Basic regions',
    quantization: 1e5,
  },
  {
    id: 'eu/nuts3@20m',
    file: 'eu-nuts3-20m.json',
    object: 'nuts3',
    profile: 'nuts',
    detail: 'low',
    from: 'nuts3.geojson',
    props: nutsProps,
    idField: 'nuts_id',
    keyField: 'nuts_id',
    levelName: 'Small regions',
    quantization: 1e5,
  },

  // Admin-1 packs, one per country, sliced out of the single 10m source.
  ...ADMIN1_COUNTRIES.map((country) => ({
    id: `${country.slug}/admin1@10m`,
    file: `${country.slug}-admin1-10m.json`,
    object: 'admin1',
    profile: 'ne',
    detail: 'high',
    from: 'ne_10m_admin_1.geojson',
    filter: (props) =>
      (props.iso_a2 ?? props.ISO_A2) === country.iso2 ||
      (country.iso2 === 'FR' && (props.adm0_a3 ?? props.ADM0_A3) === 'FRA'),
    props: admin1Props,
    idField: 'iso_3166_2',
    keyField: 'iso_3166_2',
    levelName: country.level.charAt(0).toUpperCase() + country.level.slice(1),
    quantization: 1e5,
  })),
]
