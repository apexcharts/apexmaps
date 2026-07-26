/**
 * Geometry pipeline.
 *
 * Produces the ApexMaps geo registry: one quantized, property-stripped TopoJSON
 * file per pack in `geo/`, plus a `manifest.json` carrying provenance for every
 * one of them.
 *
 * Design notes worth keeping:
 *
 *  - **Everything routes through GeoJSON features, then one topology builder.**
 *    Extracting a single object out of an existing TopoJSON without rebuilding
 *    would keep the arcs belonging to its siblings, so `us/counties` would ship
 *    the states and nation outlines too. Rebuilding costs a few seconds and gives
 *    an honest file size.
 *  - **Property whitelisting is the largest single size win.** Natural Earth
 *    admin-0 carries 169 fields per feature, most of them alternate-language
 *    names and per-country diplomatic variants. Eight are useful for joining.
 *  - **Sources are cached under `.geo-cache/`.** Re-running is free, and a flaky
 *    download cannot half-produce a release.
 *
 * Usage:
 *   npm run data:build                 # everything
 *   npm run data:build -- --only=us    # ids containing "us"
 *   npm run data:build -- --refresh    # ignore the download cache
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { topology } from 'topojson-server'
import { feature as topoFeature } from 'topojson-client'

import { PACKS, PROFILES, DOWNLOADS } from './geo/sources.mjs'

const ROOT = process.cwd()
const CACHE_DIR = resolve(ROOT, '.geo-cache')
const OUT_DIR = resolve(ROOT, 'geo')
const CATALOGUE = resolve(ROOT, 'src/core/GeoCatalogue.ts')

const args = process.argv.slice(2)
const only = args.find((a) => a.startsWith('--only='))?.slice(7)
const refresh = args.includes('--refresh')

const selected = only ? PACKS.filter((p) => p.id.includes(only) || p.file.includes(only)) : PACKS
if (!selected.length) {
  console.error(`no packs match --only=${only}`)
  process.exit(1)
}

mkdirSync(CACHE_DIR, { recursive: true })
mkdirSync(OUT_DIR, { recursive: true })

/* ------------------------------------------------------------------ download */

function mb(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)} MB`
    : `${(bytes / 1024).toFixed(0)} kB`
}

async function download(name, url) {
  const target = join(CACHE_DIR, name)
  if (existsSync(target) && !refresh) return target

  process.stdout.write(`  fetching ${name} ... `)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  const body = Buffer.from(await response.arrayBuffer())
  writeFileSync(target, body)
  console.log(mb(body.length))
  return target
}

/** Sources are parsed once and shared: fifteen admin-1 packs come from one 39 MB file. */
const parsed = new Map()

function readSource(name) {
  if (parsed.has(name)) return parsed.get(name)
  const json = JSON.parse(readFileSync(join(CACHE_DIR, name), 'utf8'))
  parsed.set(name, json)
  return json
}

function readTopoSource(path) {
  if (parsed.has(path)) return parsed.get(path)
  const full = resolve(ROOT, path)
  if (!existsSync(full)) throw new Error(`${path} not found. Run npm install first.`)
  const json = JSON.parse(readFileSync(full, 'utf8'))
  parsed.set(path, json)
  return json
}

/* --------------------------------------------------------------------- build */

/** Bring a pack's source to a plain GeoJSON feature array, whatever its input format. */
function featuresFor(pack) {
  if (pack.fromTopo) {
    const topo = readTopoSource(pack.fromTopo)
    const object = topo.objects[pack.topoObject]
    if (!object) throw new Error(`${pack.id}: object "${pack.topoObject}" not in ${pack.fromTopo}`)

    // Decorate in place before converting, so added properties survive.
    const geometries = object.type === 'GeometryCollection' ? object.geometries : [object]
    if (pack.decorate) geometries.forEach((geometry) => pack.decorate(geometry))

    const collection = topoFeature(topo, object)
    return collection.type === 'FeatureCollection' ? collection.features : [collection]
  }

  const source = readSource(pack.from)
  return source.type === 'FeatureCollection' ? source.features : [source]
}

/**
 * Whitelist properties, assign a stable id, and drop features the pack does not
 * claim. Returns the cleaned features plus anything that needs reporting.
 */
function transform(pack, features) {
  const kept = []
  const ids = new Set()
  let filtered = 0
  let missingKey = 0
  let duplicateId = 0

  for (const feature of features) {
    const props = feature.properties ?? {}
    if (pack.filter && !pack.filter(props)) {
      filtered++
      continue
    }

    const next = pack.props ? pack.props(props) : { ...props }
    for (const key of Object.keys(next)) {
      if (next[key] === undefined) delete next[key]
    }

    const out = { type: 'Feature', properties: next, geometry: feature.geometry }

    if (pack.idField) {
      const id = next[pack.idField]
      if (id === undefined || id === null || id === '') {
        // Counted below via keyField when they coincide.
      } else if (ids.has(id)) {
        duplicateId++
      } else {
        ids.add(id)
        out.id = id
      }
    } else if (feature.id !== undefined) {
      out.id = feature.id
    }

    if (pack.keyField && next[pack.keyField] === undefined) missingKey++

    kept.push(out)
  }

  return { features: kept, filtered, missingKey, duplicateId }
}

function buildPack(pack, features) {
  return topology(
    { [pack.object]: { type: 'FeatureCollection', features } },
    pack.quantization ?? 1e5,
  )
}

/* ---------------------------------------------------------------------- main */

const needed = new Set(selected.map((p) => p.from).filter(Boolean))
if (needed.size) {
  console.log(`sources (cache: ${CACHE_DIR.replace(ROOT, '.')})`)
  for (const name of needed) {
    if (!DOWNLOADS[name]) throw new Error(`no download url declared for ${name}`)
    await download(name, DOWNLOADS[name])
  }
  console.log()
}

const manifest = []
const warnings = []
let totalBytes = 0

console.log('packs')
for (const pack of selected) {
  const result = transform(pack, featuresFor(pack))

  if (!result.features.length) {
    warnings.push(`${pack.id}: produced 0 features (filter matched nothing)`)
    continue
  }

  const json = `${JSON.stringify(buildPack(pack, result.features))}\n`
  writeFileSync(join(OUT_DIR, pack.file), json)
  const bytes = statSync(join(OUT_DIR, pack.file)).size
  totalBytes += bytes

  manifest.push({
    id: pack.id,
    file: pack.file,
    object: pack.object,
    features: result.features.length,
    bytes,
    detail: pack.detail,
    keyField: pack.keyField,
    levelName: pack.levelName,
    ...PROFILES[pack.profile],
    ...(pack.note ? { note: pack.note } : {}),
  })

  const flags = []
  if (result.missingKey) flags.push(`${result.missingKey} without ${pack.keyField}`)
  if (result.duplicateId) flags.push(`${result.duplicateId} duplicate id`)
  console.log(
    `  ${pack.id.padEnd(24)} ${String(result.features.length).padStart(5)} features  ${mb(bytes).padStart(9)}` +
      (flags.length ? `   (${flags.join(', ')})` : ''),
  )
  if (result.missingKey) {
    warnings.push(
      `${pack.id}: ${result.missingKey} feature(s) lack the recommended key "${pack.keyField}"`,
    )
  }
}

manifest.sort((a, b) => a.id.localeCompare(b.id))
writeFileSync(
  join(OUT_DIR, 'manifest.json'),
  `${JSON.stringify({ generated: 'npm run data:build', packs: manifest }, null, 2)}\n`,
)

console.log(`\n${manifest.length} pack(s), ${mb(totalBytes)} total, manifest.json written to ./geo`)

/* ------------------------------------------------------- catalogue agreement */

/**
 * `src/core/GeoCatalogue.ts` is the authoritative id list, because ids are public
 * API and belong in reviewed source. The pipeline must produce exactly those ids:
 * a catalogue entry with no file is a runtime 404, and a file with no catalogue
 * entry is invisible.
 */
if (!only && existsSync(CATALOGUE)) {
  const text = readFileSync(CATALOGUE, 'utf8')
  const declared = new Set(
    [...text.matchAll(/'([a-z]{2,6}\/[a-z0-9]+@[0-9]+m)'/g)].map((m) => m[1]),
  )
  const built = new Set(manifest.map((p) => p.id))

  const missing = [...declared].filter((id) => !built.has(id))
  const extra = [...built].filter((id) => !declared.has(id))
  if (missing.length)
    warnings.push(`catalogue declares ids the pipeline did not build: ${missing.join(', ')}`)
  if (extra.length)
    warnings.push(`pipeline built ids the catalogue does not declare: ${extra.join(', ')}`)
}

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`)
  for (const warning of warnings) console.log(`  ! ${warning}`)
  process.exitCode = 1
}
