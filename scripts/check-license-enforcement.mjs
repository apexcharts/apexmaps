/**
 * Licence enforcement, driven through the BUILT bundle.
 *
 * `test/license.test.ts` and `test/premium.test.ts` cover the same ground against
 * source, because `vitest.config.ts` aliases the bare `apexmaps` specifier to
 * `src/`. Nothing else in this repository ever loads `dist/`, and dist is what
 * customers run, so between the two there is a gap that nothing watches:
 *
 * - `apex-commons` is INLINED into the bundle (there is no `apex-commons` import
 *   left in `dist/apexmaps.esm.js`). The enforcement code that ships is therefore
 *   a copy that went through rollup, babel and terser, not the package the tests
 *   import. A terser setting that touches a static class field, or a change to the
 *   build, breaks the shipped copy while every test stays green.
 * - The watermark decision is synchronous during render, while signature
 *   verification is asynchronous (`crypto.subtle` has no sync API), so a
 *   structurally valid key is accepted provisionally and corrected a microtask
 *   later. Anything that breaks the correction leaves a library that verifies
 *   signatures and enforces nothing.
 *
 * That second failure is why this file exists at all: apexcharts-js 6.6.0 shipped
 * exactly it, green unit suite throughout, because the suite tested the verifier's
 * mechanism rather than the sequence a customer produces. This drives the
 * sequence: set a key, render, wait for the verdict, look at the DOM.
 *
 * The negative cases carry as much weight as the positive ones. A watermark on the
 * free tier is not a smaller bug than a missing one on a forged key, it is the
 * same bug pointed at paying-nothing customers, and it shipped in 0.1.0.
 *
 * Usage:
 *   node scripts/check-license-enforcement.mjs              # dist/apexmaps.esm.js
 *   node scripts/check-license-enforcement.mjs <bundle>
 *
 * Set APEX_TEST_LICENSE_KEY to additionally assert that a real production-signed
 * key is accepted. Skipped when unset, because signing one needs the private key.
 *
 * Run after `npm run build`. CI runs it on every push and the publish workflow
 * runs it before anything reaches npm.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'

const ROOT = resolve(import.meta.dirname, '..')
const WATERMARK = '[data-apexcharts-watermark]'
const bundlePath = resolve(ROOT, process.argv[2] ?? 'dist/apexmaps.esm.js')

if (!existsSync(bundlePath)) {
  console.error(`\n  ${bundlePath} is missing. Run \`npm run build\` first.\n`)
  process.exit(1)
}

// --- a DOM, before the bundle is imported ------------------------------------
// The bundle injects its stylesheet at import time, guarded on `document`, so the
// globals have to exist first. That is also why the import below is dynamic.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  // Serves rAF, which the animation paths use.
  pretendToBeVisual: true,
  // A real origin: a domain-locked key is checked against the hostname.
  url: 'https://apexmaps.test/',
})

globalThis.window = dom.window
globalThis.document = dom.window.document
// Node defines its own `navigator` as a getter-only property, so plain assignment
// throws. jsdom's carries the userAgent the DOM paths read.
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
})
for (const key of [
  'CustomEvent',
  'DOMParser',
  'Element',
  'Event',
  'HTMLElement',
  'Image',
  'MouseEvent',
  'Node',
  'PointerEvent',
  'SVGElement',
  'XMLSerializer',
  'cancelAnimationFrame',
  'requestAnimationFrame',
]) {
  const value = dom.window[key]
  if (value === undefined || globalThis[key] !== undefined) continue
  globalThis[key] =
    typeof value === 'function' && !/^[A-Z]/.test(key) ? value.bind(dom.window) : value
}
// Not `globalThis.getComputedStyle = dom.window.getComputedStyle`: it throws
// unless `this` is the window, and `Watermark.paint` calls it on every container.
globalThis.getComputedStyle = (...args) => dom.window.getComputedStyle(...args)

// jsdom implements neither, and both are on the render path: the reduced-motion
// query decides animation, and a string `chart.height` starts an observer.
dom.window.matchMedia = () => ({
  matches: false,
  media: '',
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
})
globalThis.matchMedia = dom.window.matchMedia
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub
dom.window.ResizeObserver = ResizeObserverStub

const { default: ApexMaps } = await import(pathToFileURL(bundlePath).href)

// --- keys ---------------------------------------------------------------------

const envelope = (payload) => 'APEX-' + Buffer.from(JSON.stringify(payload)).toString('base64')

/** Structurally perfect, signature is nonsense: what payload tampering produces. */
const FORGED = envelope({
  issueDate: '2026-07-01',
  expiryDate: '2099-12-31',
  plan: 'enterprise',
  sig: Buffer.alloc(64, 7).toString('base64'),
})

/** Issued before signing existed. MUST keep working until the legacy cutoff. */
const UNSIGNED = envelope({ issueDate: '2025-01-01', expiryDate: '2099-12-31', plan: 'premium' })

/** Ran out. Caught synchronously by structure, so no verdict ever flips. */
const EXPIRED = envelope({ issueDate: '2025-01-01', expiryDate: '2025-02-01', plan: 'premium' })

// --- maps ---------------------------------------------------------------------

const BOX = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { iso_a3: 'AAA', name: 'Alpha' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [8, 0],
            [8, 8],
            [0, 8],
            [0, 0],
          ],
        ],
      },
    },
  ],
}

const BASE = {
  geo: { map: BOX },
  series: [{ type: 'choropleth', data: [{ key: 'AAA', value: 1 }] }],
}

/** A licensed feature, so the licence verdict is observable at all. */
const PREMIUM = { ...BASE, chart: { context: 'story' } }

// --- cases --------------------------------------------------------------------

const CASES = [
  { name: 'free tier, no key', key: '', options: BASE, watermark: false },
  // The 0.1.0 defect: free containers stayed registered for licence
  // reconciliation, so the correction meant for premium maps painted them.
  { name: 'free tier, forged key', key: FORGED, options: BASE, watermark: false },
  { name: 'premium, no key', key: '', options: PREMIUM, watermark: true },
  // THE case this file exists for: the verdict arrives after the decision.
  { name: 'premium, forged key', key: FORGED, options: PREMIUM, watermark: true },
  { name: 'premium, unsigned legacy key', key: UNSIGNED, options: PREMIUM, watermark: false },
  { name: 'premium, expired key', key: EXPIRED, options: PREMIUM, watermark: true },
  // Premium usage is recomputed from the config, so removing the feature removes
  // the mark. Asserted here too, because it is the half a bundling change would
  // silently invert.
  {
    name: 'premium turned off again',
    key: FORGED,
    options: PREMIUM,
    then: { chart: { context: 'dashboard' } },
    watermark: false,
  },
]

if (process.env.APEX_TEST_LICENSE_KEY) {
  CASES.push({
    name: 'premium, real signed key',
    key: process.env.APEX_TEST_LICENSE_KEY,
    options: PREMIUM,
    watermark: false,
  })
} else {
  CASES.push({ name: 'premium, real signed key', skip: 'APEX_TEST_LICENSE_KEY unset' })
}

/**
 * Let importKey/verify settle, then the listener that reconciles.
 *
 * WebCrypto resolves on a thread pool rather than the microtask queue, so a fixed
 * number of microtasks can lose the race on a loaded machine. With a predicate
 * this polls until the expected state arrives; without one (an absence, which
 * cannot be awaited) it waits out a deadline instead.
 */
async function settle(done) {
  const deadline = Date.now() + (done ? 1000 : 250)
  do {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 5))
    if (done?.()) return
  } while (Date.now() < deadline)
}

/**
 * Captured rather than printed. Most cases here are supposed to produce a
 * complaint (`setLicense('')` between cases is an invalid key by definition), so
 * relaying all of it would bury the table in expected noise. They are worth
 * keeping for a failing case, where the library's own account of the key is the
 * first thing to read, so they are replayed only then.
 */
function captureConsole() {
  const lines = []
  const original = { warn: console.warn, error: console.error }
  console.warn = (...args) => lines.push(args.join(' '))
  console.error = (...args) => lines.push(args.join(' '))
  return {
    lines,
    restore() {
      console.warn = original.warn
      console.error = original.error
    },
  }
}

async function run(testCase) {
  const el = dom.window.document.createElement('div')
  Object.defineProperty(el, 'clientWidth', { value: 800, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true })
  dom.window.document.body.appendChild(el)

  ApexMaps.setLicense('')
  ApexMaps.setLicense(testCase.key)

  const map = new ApexMaps(el, testCase.options)
  await map.render()
  if (testCase.then) await map.updateOptions(testCase.then)

  // Wait for arrival when a watermark is expected; wait out the deadline when it
  // is not, because nothing signals that something never happened.
  await settle(testCase.watermark ? () => el.querySelector(WATERMARK) !== null : undefined)
  const marked = el.querySelector(WATERMARK) !== null

  map.destroy()
  el.remove()
  ApexMaps.setLicense('')
  return marked
}

async function runQuietly(testCase) {
  const captured = captureConsole()
  try {
    return { marked: await run(testCase), logs: captured.lines }
  } finally {
    captured.restore()
  }
}

// --- report -------------------------------------------------------------------

let failed = false
const rows = []

for (const testCase of CASES) {
  if (testCase.skip) {
    rows.push({ name: testCase.name, status: 'skip', detail: testCase.skip })
    continue
  }
  const { marked, logs } = await runQuietly(testCase)
  const ok = marked === testCase.watermark
  if (!ok) failed = true
  rows.push({
    name: testCase.name,
    status: ok ? 'ok' : 'FAIL',
    detail: ok
      ? `watermark ${marked ? 'present' : 'absent'}, as expected`
      : `expected watermark ${testCase.watermark ? 'present' : 'absent'}, got ${marked ? 'present' : 'absent'}`,
    logs: ok ? [] : logs,
  })
}

const width = Math.max(...rows.map((r) => r.name.length))
console.log(`\n  ${bundlePath.replace(ROOT + '/', '')}\n`)
for (const row of rows) {
  console.log(`  ${row.name.padEnd(width)}  ${row.status.padEnd(5)}  ${row.detail}`)
  for (const line of row.logs ?? []) console.log(`  ${' '.repeat(width)}         ${line}`)
}
console.log('')

if (failed) {
  console.error('  The shipped bundle does not enforce the licence as configured.\n')
  process.exit(1)
}
