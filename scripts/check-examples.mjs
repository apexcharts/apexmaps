/**
 * Smoke check for the demos.
 *
 * Loads every page in `examples/` in headless Chromium and fails if one of them
 * errors, never becomes ready, or draws nothing. That last case is the one worth
 * automating: a demo that throws is obvious, while a demo that renders an empty
 * plot because a pack id changed or a join key moved looks fine in a diff and is
 * only caught by someone opening it.
 *
 * It also fails when a demo page is not linked from `examples/index.html`, so a new
 * feature cannot ship a demo that nobody can find.
 *
 * Playwright is not a dependency of this repository, because a 300 MB browser
 * download has no place in a clone that only wants to run the unit tests. It is
 * resolved from wherever it already exists, and the check reports itself as skipped
 * rather than passing when nothing is found.
 *
 * Usage: `npm run check:examples`
 */

import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const EXAMPLES = join(ROOT, 'examples')
const PORT = Number(process.env.PORT || 8099)

/** Pages that are tools rather than demos: interactive, and nothing to assert. */
const MANUAL = new Set(['bench.html'])

function loadPlaywright() {
  const candidates = [
    join(ROOT, 'package.json'),
    process.env.APEXMAPS_PLAYWRIGHT && join(process.env.APEXMAPS_PLAYWRIGHT, 'package.json'),
    // Sibling Apex repositories, which is where it usually already lives.
    join(ROOT, '..', 'apex-grid', 'package.json'),
    join(ROOT, '..', 'apexcharts-js', 'package.json'),
  ].filter(Boolean)

  for (const from of candidates) {
    if (!existsSync(from)) continue
    try {
      return createRequire(from)('playwright')
    } catch {
      // Not installed there; try the next.
    }
  }
  return null
}

const playwright = loadPlaywright()
if (!playwright) {
  console.log('\n  SKIPPED: playwright was not found.\n')
  console.log(
    '  Install it here:            npm i -D playwright && npx playwright install chromium',
  )
  console.log(
    '  Or point at an existing copy: APEXMAPS_PLAYWRIGHT=../apex-grid npm run check:examples\n',
  )
  process.exit(0)
}

if (!existsSync(join(ROOT, 'dist', 'apexmaps.min.js'))) {
  console.error('\n  dist/apexmaps.min.js is missing. Run `npm run build` first.\n')
  process.exit(1)
}

const pages = readdirSync(EXAMPLES)
  .filter((f) => f.endsWith('.html') && f !== 'index.html' && !f.startsWith('_'))
  .sort()

const indexHtml = readFileSync(join(EXAMPLES, 'index.html'), 'utf8')
const unlinked = pages.filter((f) => !indexHtml.includes(`href="${f}"`))

const server = spawn('node', [join('scripts', 'serve.mjs'), String(PORT)], {
  cwd: ROOT,
  stdio: 'ignore',
})
await new Promise((r) => setTimeout(r, 600))

const browser = await playwright.chromium.launch()
const failures = []
const rows = []

for (const file of pages) {
  if (MANUAL.has(file)) {
    rows.push({ file, status: 'manual', detail: 'interactive tool, not asserted' })
    continue
  }

  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const problems = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))

  try {
    await page.goto(`http://127.0.0.1:${PORT}/examples/${file}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(() => window.__demo && window.__demo.ready === true, null, {
      timeout: 20000,
    })

    const result = await page.evaluate(() => {
      /**
       * Whether a canvas holds any ink.
       *
       * The canvas tier draws no elements, so counting them would report every
       * canvas map as blank. Sampling pixels is the equivalent check, and it is
       * actually the stronger one: a canvas that exists, is sized, and is
       * entirely transparent is exactly the "looks healthy and is blank" failure
       * this script was written to catch.
       */
      const canvasHasInk = (canvas) => {
        if (!canvas || !canvas.width || !canvas.height) return 0
        const ctx = canvas.getContext('2d')
        if (!ctx) return 0
        const { width, height } = canvas
        const data = ctx.getImageData(0, 0, width, height).data
        let opaque = 0
        for (let y = 0; y < height; y += 11) {
          for (let x = 0; x < width; x += 11) {
            if (data[(y * width + x) * 4 + 3] > 8) opaque++
          }
        }
        return opaque
      }

      return {
        error: window.__demo.error,
        maps: window.__demo.maps.map(({ name, map }) => {
          const elements = map.element.querySelectorAll(
            'path.apexmaps-feature, circle.apexmaps-bubble, g.apexmaps-mark, path.apexmaps-arc, path.apexmaps-line',
          ).length
          const canvas = map.element.querySelector('canvas.apexmaps-canvas')
          const ink = canvas ? canvasHasInk(canvas) : 0
          return {
            name,
            rendered: !!map.rendered,
            renderer: map.rendererKind || 'svg',
            features: map.geo ? map.geo.features.length : 0,
            elements,
            ink,
            // What "drew something" means for whichever tier is active.
            marks: canvas ? ink : elements,
            warnings: map.warnings.slice(0, 3),
          }
        }),
      }
    })

    if (result.error) problems.push(`demo reported: ${result.error.split('\n')[0]}`)
    if (!result.maps.length) problems.push('no map registered with Demo.watch()')
    for (const map of result.maps) {
      if (!map.rendered) problems.push(`${map.name}: never finished rendering`)
      // The failure this check exists for: a demo that looks healthy and is blank.
      else if (map.marks === 0) {
        problems.push(
          map.renderer === 'canvas'
            ? `${map.name}: canvas tier drew no ink`
            : `${map.name}: rendered 0 marks`,
        )
      }
    }

    const summary = result.maps
      .map((m) =>
        m.renderer === 'canvas'
          ? `${m.name} canvas ${m.ink} ink/${m.features}`
          : `${m.name} ${m.marks}/${m.features}`,
      )
      .join(', ')
    rows.push({
      file,
      status: problems.length ? 'FAIL' : 'ok',
      detail: problems.length ? problems.join(' | ') : summary,
    })
    if (problems.length) failures.push({ file, problems })

    const warned = result.maps.flatMap((m) => m.warnings.map((w) => `${m.name}: ${w}`))
    if (warned.length) rows.push({ file: '', status: 'note', detail: warned.join(' | ') })
  } catch (error) {
    rows.push({ file, status: 'FAIL', detail: `${error.message.split('\n')[0]}` })
    failures.push({ file, problems: [error.message, ...problems] })
  } finally {
    await page.close()
  }
}

await browser.close()
server.kill()

const width = Math.max(...rows.map((r) => r.file.length), 12)
console.log('')
for (const row of rows) {
  console.log(`  ${row.file.padEnd(width)}  ${row.status.padEnd(6)}  ${row.detail}`)
}

if (unlinked.length) {
  console.log('')
  for (const file of unlinked) {
    console.log(`  ${file} is not linked from examples/index.html`)
  }
}

console.log(
  `\n  ${pages.length - failures.length}/${pages.length} pages ok` +
    ` (marks drawn / features loaded)\n`,
)

if (failures.length || unlinked.length) process.exit(1)
