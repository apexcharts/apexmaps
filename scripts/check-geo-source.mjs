/**
 * Verify that the default geometry source actually serves geometry.
 *
 * This is the check whose absence let the library ship a default that 404s. The
 * README's headline example names a pack and calls `render()`, with no
 * `setGeoSource()` anywhere, so `DEFAULT_GEO_SOURCE` is a load-bearing promise to
 * every user. Nothing inside this repository exercises it: the demos and the tests
 * all point at the committed `geo/` directory, so all 18 pages and 323 tests pass
 * while a fresh install cannot draw a map.
 *
 * Run it after publishing the dataset, and on a schedule if you want to know when
 * the CDN stops serving.
 *
 * Usage: `npm run check:geo-source`
 *        `npm run check:geo-source -- --retries 12`   (waits out CDN propagation)
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

const args = process.argv.slice(2)
const retries = Number(args[args.indexOf('--retries') + 1]) || 0
const waitMs = 15000

const source = readFileSync(join(ROOT, 'src', 'core', 'GeoCatalogue.ts'), 'utf8')
const version = /GEO_DATASET_VERSION = '([^']+)'/.exec(source)?.[1]
const template = /DEFAULT_GEO_SOURCE = `([^`]+)`/.exec(source)?.[1]

if (!version || !template) {
  console.error('  could not read GEO_DATASET_VERSION / DEFAULT_GEO_SOURCE from GeoCatalogue.ts')
  process.exit(1)
}

const base = template.replace('${GEO_DATASET_VERSION}', version)

// The pack the README's first example uses. If any single file has to resolve,
// it is this one.
const DEFAULT_PACK = 'world-countries-110m.json'
const url = `${base}${DEFAULT_PACK}`

console.log(`\n  dataset version  ${version}`)
console.log(`  default source   ${base}`)
console.log(`  probing          ${DEFAULT_PACK}\n`)

async function probe() {
  const response = await fetch(url)
  if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` }

  const body = await response.json()
  if (body?.type !== 'Topology') {
    return { ok: false, detail: `served 200 but is not TopoJSON (type "${body?.type}")` }
  }
  const objects = Object.keys(body.objects ?? {})
  if (!objects.length) return { ok: false, detail: 'served TopoJSON with no objects' }
  return { ok: true, detail: `TopoJSON, objects: ${objects.join(', ')}` }
}

let result
for (let attempt = 0; attempt <= retries; attempt++) {
  try {
    result = await probe()
  } catch (error) {
    result = { ok: false, detail: error.message }
  }
  if (result.ok) break
  if (attempt < retries) {
    console.log(`  attempt ${attempt + 1}: ${result.detail}, retrying in ${waitMs / 1000}s`)
    await new Promise((r) => setTimeout(r, waitMs))
  }
}

if (result.ok) {
  console.log(`  OK: ${result.detail}\n`)
  process.exit(0)
}

console.error(`  FAILED: ${result.detail}`)
console.error(`  ${url}\n`)
console.error('  Every user who names a pack without calling setGeoSource() hits this.')
console.error('  If the dataset has not been published yet, publish geo/ as apexmaps-geo.\n')
process.exit(1)
