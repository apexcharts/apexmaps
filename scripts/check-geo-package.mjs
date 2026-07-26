/**
 * Pre-publish gate for the `apexmaps-geo` dataset.
 *
 * The library and the dataset are separate packages that have to agree, and every
 * way they can disagree fails at runtime in a user's browser rather than here:
 *
 * - A pack id the library declares with no file behind it is an HTTP 404 the
 *   moment someone names that map.
 * - A file nothing declares is dead weight nobody can reach.
 * - A major version that does not match `GEO_DATASET_VERSION` is the worst case,
 *   because the library requests `apexmaps-geo@<major>` and jsDelivr resolves it
 *   to the newest release in that range. Publishing 2.0.0 while the library still
 *   asks for `@1` means the release is simply never served, silently.
 *
 * `scripts/build-geo.mjs` cross-checks ids too, but only when it runs, and it
 * needs network plus a 39 MB download. This runs against the committed files, so
 * it can gate a publish.
 *
 * Usage: `npm run check:geo`
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const GEO_DIR = join(ROOT, 'geo')

const problems = []
const note = (message) => problems.push(message)

/* ---------------------------------------------------------------- the library */

const catalogueSource = readFileSync(join(ROOT, 'src', 'core', 'GeoCatalogue.ts'), 'utf8')

const versionMatch = /GEO_DATASET_VERSION = '([^']+)'/.exec(catalogueSource)
if (!versionMatch) {
  console.error('  could not find GEO_DATASET_VERSION in src/core/GeoCatalogue.ts')
  process.exit(1)
}
const datasetMajor = versionMatch[1]

// Pack rows are declared as `{ id: '...', file: '...' }` literals. Reading them
// out of the reviewed source is deliberate: that file is the authority on ids.
const declared = new Map()
for (const m of catalogueSource.matchAll(/id:\s*'([^']+)',\s*\n\s*file:\s*'([^']+)'/g)) {
  declared.set(m[1], m[2])
}
if (!declared.size) note('parsed zero pack declarations out of src/core/GeoCatalogue.ts')

/* ---------------------------------------------------------------- the package */

const pkgPath = join(GEO_DIR, 'package.json')
if (!existsSync(pkgPath)) {
  console.error('  geo/package.json is missing')
  process.exit(1)
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

if (pkg.name !== 'apexmaps-geo')
  note(`geo/package.json name is "${pkg.name}", expected apexmaps-geo`)

const pkgMajor = String(pkg.version).split('.')[0]
if (pkgMajor !== datasetMajor) {
  note(
    `version mismatch: geo/package.json is ${pkg.version} (major ${pkgMajor}) but the library ` +
      `requests apexmaps-geo@${datasetMajor}. A publish now would never be served. ` +
      'Either bump GEO_DATASET_VERSION in src/core/GeoCatalogue.ts or correct the package version.',
  )
}

for (const required of ['README.md', 'LICENSE']) {
  if (!existsSync(join(GEO_DIR, required))) note(`geo/${required} is missing`)
}

/* ------------------------------------------------------------------- the files */

const onDisk = new Set(readdirSync(GEO_DIR).filter((f) => f.endsWith('.json')))
onDisk.delete('package.json')

if (!onDisk.has('manifest.json')) {
  note('geo/manifest.json is missing; run `npm run data:build`')
} else {
  onDisk.delete('manifest.json')
  const manifest = JSON.parse(readFileSync(join(GEO_DIR, 'manifest.json'), 'utf8'))
  const inManifest = new Set((manifest.packs ?? []).map((p) => p.id))
  for (const id of declared.keys()) {
    if (!inManifest.has(id))
      note(`"${id}" is declared in the library but absent from manifest.json`)
  }
  for (const id of inManifest) {
    if (!declared.has(id)) note(`"${id}" is in manifest.json but not declared in the library`)
  }
}

for (const [id, file] of declared) {
  if (!onDisk.has(file)) note(`"${id}" needs ${file}, which is not in geo/`)
}

const expectedFiles = new Set(declared.values())
for (const file of onDisk) {
  if (!expectedFiles.has(file)) note(`geo/${file} is not referenced by any declared pack`)
}

// A pack that parses but holds no geometry is the failure the demo smoke check
// exists for at the library level; catching it here keeps it out of a release.
for (const [id, file] of declared) {
  const path = join(GEO_DIR, file)
  if (!existsSync(path)) continue
  let topology
  try {
    topology = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    note(`geo/${file} is not valid JSON: ${error.message}`)
    continue
  }
  if (topology.type !== 'Topology') note(`geo/${file} is not TopoJSON (type "${topology.type}")`)
  const objects = Object.keys(topology.objects ?? {})
  if (!objects.length)
    note(`geo/${file} declares no TopoJSON objects, so "${id}" would draw nothing`)
}

/* ---------------------------------------------------------------------- report */

const kb = (n) => `${Math.round(n / 1024)} kB`
let total = 0
for (const file of expectedFiles) {
  const path = join(GEO_DIR, file)
  if (existsSync(path)) total += readFileSync(path).length
}

console.log('')
console.log(`  package     apexmaps-geo@${pkg.version}`)
console.log(`  library     requests apexmaps-geo@${datasetMajor}`)
console.log(
  `  packs       ${declared.size} declared, ${expectedFiles.size} files, ${kb(total)} total`,
)
console.log('')

if (problems.length) {
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(`\n  ${problems.length} problem(s). Not safe to publish.\n`)
  process.exit(1)
}

console.log('  dataset and library agree.\n')
