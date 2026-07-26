/**
 * Bundle-size guard.
 *
 * The core bundle carries a 150 kB gzipped budget, excluding geometry, and it is
 * enforced here rather than by intention: this fails the build when a bundle
 * crosses the budget, and prints the numbers either way so a creeping trend is
 * visible in the logs long before the hard limit is.
 *
 * Usage: `npm run check:size` (after `npm run build`)
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const ROOT = resolve(import.meta.dirname, '..')
const BUDGET = 150 * 1024

const BUNDLES = ['apexmaps.min.js', 'apexmaps.esm.js', 'apexmaps.cjs']

let failed = false
console.log('')
for (const file of BUNDLES) {
  const path = join(ROOT, 'dist', file)
  if (!existsSync(path)) {
    console.error(`  ${file}: missing. Run \`npm run build\` first.`)
    failed = true
    continue
  }
  const raw = readFileSync(path)
  const gz = gzipSync(raw, { level: 9 }).length
  const over = gz > BUDGET
  if (over) failed = true
  console.log(
    `  ${file.padEnd(18)} ${(raw.length / 1024).toFixed(1).padStart(7)} kB raw` +
      `  ${(gz / 1024).toFixed(1).padStart(6)} kB gzipped` +
      `  ${over ? 'OVER' : 'ok'} (budget ${(BUDGET / 1024).toFixed(0)} kB)`,
  )
}
console.log('')

if (failed) {
  console.error('  Bundle budget exceeded. Moving the budget requires a recorded decision.\n')
  process.exit(1)
}
