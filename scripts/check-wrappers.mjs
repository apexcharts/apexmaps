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
 * - A dist that exists on disk but never reaches the tarball looks like a good
 *   release right up to `npm install`. What ships is decided by `files` plus
 *   npm's ignore rules, not by the manifest, and the two can disagree silently:
 *   npm-packlist skips nested directories that carry their own package.json,
 *   which ng-packagr's dist does, so the Angular package once packed its
 *   sources and tests while excluding the only directory a consumer can use.
 *
 * Usage: `npm run check:wrappers` (after `npm run build:wrappers`), or with a
 * wrapper's directory name to check that one alone, which is what each
 * wrapper's `prepublishOnly` runs.
 */

import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const WRAPPERS = join(ROOT, 'wrappers')

/**
 * Specifiers that must stay external, keyed by nothing: whichever of these is a
 * declared peer of the wrapper must appear as an import in its bundle.
 */
const MUST_BE_EXTERNAL = ['react', 'vue', '@angular/core', 'apexmaps']

/**
 * Change detection lives at `apexmaps/wrappers`, a subpath of the peer. Every
 * wrapper must import it rather than inline a frozen copy, because an inlined
 * copy stops tracking the core semantics it encodes: the rules ship with the
 * core precisely so that a semantics change and the diffing that reflects it
 * arrive in the same package version.
 */

const rows = []
const failures = []

const only = process.argv[2]

const packages = existsSync(WRAPPERS)
  ? readdirSync(WRAPPERS).filter((name) => {
      if (only && name !== only) return false
      const manifest = join(WRAPPERS, name, 'package.json')
      if (!existsSync(manifest)) return false
      // The shared internals workspace is private and has no bundle of its own.
      // Every assertion below would pass it vacuously, which is worse than silence.
      return !JSON.parse(readFileSync(manifest, 'utf8')).private
    })
  : []

if (!packages.length) {
  if (only) {
    console.error(`\n  No publishable wrapper named '${only}' under wrappers/.\n`)
    process.exit(1)
  }
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

  const peers = Object.keys(manifest.peerDependencies || {})
  const imports = (source, bare) =>
    new RegExp(`from\\s*['"]${bare}(/[^'"]*)?['"]`).test(source) ||
    new RegExp(`require\\(\\s*['"]${bare}(/[^'"]*)?['"]\\s*\\)`).test(source)

  for (const file of bundles) {
    const source = readFileSync(join(dir, file), 'utf8')

    // Only React wrappers. `'use client'` is a React Server Components marker;
    // Vue decides client-only rendering at the call site (`<ClientOnly>`), so
    // requiring it of a Vue bundle would be cargo cult.
    if (peers.includes('react') && !/^['"]use client['"]/.test(source.trimStart())) {
      problems.push(`${file} does not start with a 'use client' directive`)
    }

    for (const bare of MUST_BE_EXTERNAL) {
      if (!peers.includes(bare)) continue
      if (!imports(source, bare)) {
        problems.push(`${file} does not import peer '${bare}': it may have been bundled in`)
      }
    }

    if (peers.includes('apexmaps') && !imports(source, 'apexmaps/wrappers')) {
      problems.push(
        `${file} does not import 'apexmaps/wrappers': the change detection was inlined or dropped`,
      )
    }
  }

  if (!bundles.length) problems.push('no bundle was built (run npm run build:wrappers)')

  // A peer that is also a hard dependency defeats the point of the peer.
  for (const bare of Object.keys(manifest.peerDependencies || {})) {
    if (manifest.dependencies?.[bare]) {
      problems.push(`${bare} is both a peerDependency and a dependency`)
    }
  }

  // The tarball, not the working tree, is the release. Everything above ran
  // against files on disk, and the missing-dist failure passed all of it.
  // `--ignore-scripts` keeps the dry run from triggering build lifecycles.
  let packed = null
  try {
    const out = execSync('npm pack --dry-run --json --ignore-scripts', {
      cwd: dir,
      encoding: 'utf8',
      // stderr is captured rather than discarded: when this call fails, its
      // message is the only thing that explains why, and swallowing it once cost
      // a release. The npm 12 shape change below arrived in CI as
      // "the tarball contents are unknown" and nothing else.
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const parsed = JSON.parse(out)
    // npm 11 and earlier return an array of results; npm 12 returns an object
    // keyed by package name. CI installs `npm@latest` (trusted publishing needs
    // 11.5.1+), so the version here is whatever npm shipped this week, and both
    // shapes have to work.
    const result = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
    if (!result?.files) throw new Error(`unrecognised npm pack --json shape: ${out.slice(0, 200)}`)
    packed = new Set(result.files.map((entry) => entry.path))
  } catch (error) {
    const detail = (error.stderr || error.message || '').toString().trim().split('\n')[0]
    problems.push(`npm pack --dry-run failed, so the tarball contents are unknown: ${detail}`)
  }

  if (packed) {
    for (const [file, field] of promised) {
      if (!packed.has(file)) problems.push(`tarball is missing ${file} (promised by ${field})`)
    }

    // "SEE LICENSE IN LICENSE" is a promise like any exports target: the file
    // it names has to travel with every copy of the package.
    const licenseFile = /^SEE LICENSE IN (.+)$/.exec(manifest.license || '')?.[1]
    if (licenseFile && !packed.has(licenseFile)) {
      problems.push(`tarball is missing ${licenseFile}, which the license field points at`)
    }
    if (!packed.has('README.md')) problems.push('tarball is missing README.md')

    // And nothing else. Shipping sources, tests or configs does not break a
    // consumer, but it is exactly how the missing dist stayed invisible, so
    // the contents are pinned to what a consumer resolves.
    const expected = new Set(['package.json', 'README.md', 'LICENSE', licenseFile].filter(Boolean))
    for (const path of packed) {
      if (!path.startsWith('dist/') && !expected.has(path)) {
        problems.push(`tarball ships ${path}, which no consumer resolves`)
      }
    }
  }

  rows.push({
    name: manifest.name,
    status: problems.length ? 'FAIL' : 'ok',
    detail: problems.length
      ? problems.join(' | ')
      : `${bundles.length} bundles, peers external, ${packed.size} files in tarball`,
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
