/**
 * Packaging checks for the framework wrappers.
 *
 * Every assertion here is for a failure that is invisible in this repository and
 * only appears in a consumer's application:
 *
 * - A missing `'use client'` makes Next.js's App Router treat the component as a
 *   server component, which throws on the first hook. The directive survives two
 *   passes that each want to remove it (rollup ignores module-level directives
 *   when bundling; terser strips redundant ones), so it needs checking rather
 *   than assuming.
 * - A bundled copy of React means two Reacts in the consumer's tree, and hooks
 *   throw across copies. A bundled copy of ApexMaps means two registries, so
 *   `registerMap` populates one and the map reads the other.
 * - A missing `.cjs` or a `.d.ts` that does not resolve makes the package look
 *   installed and broken.
 *
 * Usage: `npm run check:wrappers` (after `npm run build:wrappers`)
 */

import { readFileSync, existsSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const WRAPPERS = join(ROOT, 'wrappers')

/** Bare specifiers that must stay external in every wrapper build. */
const MUST_BE_EXTERNAL = ['react', 'apexmaps']

const rows = []
const failures = []

const packages = existsSync(WRAPPERS)
  ? readdirSync(WRAPPERS).filter((name) => existsSync(join(WRAPPERS, name, 'package.json')))
  : []

if (!packages.length) {
  console.log('\n  No wrappers found under wrappers/.\n')
  process.exit(0)
}

for (const name of packages) {
  const dir = join(WRAPPERS, name)
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const problems = []

  /** Every file the manifest promises a consumer, by the field that promises it. */
  const promised = new Map()
  const promise = (field, relative) => {
    if (typeof relative === 'string') promised.set(relative.replace(/^\.\//, ''), field)
  }
  promise('main', manifest.main)
  promise('module', manifest.module)
  promise('types', manifest.types)
  for (const [subpath, target] of Object.entries(manifest.exports || {})) {
    if (typeof target === 'string') promise(`exports["${subpath}"]`, target)
    else {
      for (const [condition, file] of Object.entries(target || {})) {
        promise(`exports["${subpath}"].${condition}`, file)
      }
    }
  }

  for (const [file, field] of promised) {
    if (!existsSync(join(dir, file))) problems.push(`${field} points at missing ${file}`)
  }

  // The bundles, checked for what they must and must not contain.
  const bundles = [manifest.main, manifest.module]
    .filter((f) => typeof f === 'string')
    .map((f) => f.replace(/^\.\//, ''))
    .filter((f) => existsSync(join(dir, f)))

  for (const file of bundles) {
    const source = readFileSync(join(dir, file), 'utf8')

    if (!/^['"]use client['"]/.test(source.trimStart())) {
      problems.push(`${file} does not start with a 'use client' directive`)
    }

    for (const bare of MUST_BE_EXTERNAL) {
      const imported =
        new RegExp(`from\\s*['"]${bare}(/[^'"]*)?['"]`).test(source) ||
        new RegExp(`require\\(\\s*['"]${bare}(/[^'"]*)?['"]\\s*\\)`).test(source)
      if (!imported) {
        problems.push(`${file} does not import '${bare}': it may have been bundled in`)
      }
    }
  }

  if (!bundles.length) problems.push('no bundle was built (run npm run build:wrappers)')

  // A peer that is also a hard dependency defeats the point of the peer.
  for (const bare of Object.keys(manifest.peerDependencies || {})) {
    if (manifest.dependencies?.[bare]) {
      problems.push(`${bare} is both a peerDependency and a dependency`)
    }
  }

  rows.push({
    name: manifest.name,
    status: problems.length ? 'FAIL' : 'ok',
    detail: problems.length ? problems.join(' | ') : `${bundles.length} bundles, peers external`,
  })
  if (problems.length) failures.push(name)
}

const width = Math.max(...rows.map((r) => r.name.length), 12)
console.log('')
for (const row of rows) {
  console.log(`  ${row.name.padEnd(width)}  ${row.status.padEnd(6)}  ${row.detail}`)
}
console.log(`\n  ${rows.length - failures.length}/${rows.length} wrappers ok\n`)

if (failures.length) process.exit(1)
