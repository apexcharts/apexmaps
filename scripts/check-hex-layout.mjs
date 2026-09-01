/**
 * Verification gate for the hand-authored grid layouts in `geo/`.
 *
 * A hex layout is wrong in ways a diff cannot show. Two integers change, the
 * file still parses, every check passes, and a state is quietly in the wrong
 * place. Reviewing it means looking at a picture, which does not happen on a
 * one-line change. So the layout is scored against the boundary pack it claims
 * to represent, and the score is the review.
 *
 * **What is measured, and what deliberately is not.** Absolute position error
 * is the obvious metric and the wrong one: a tilegram exists precisely to give
 * Rhode Island as much room as Texas, so every mid-continent cell "should" look
 * displaced and the metric flags the feature as the bug. What actually reads as
 * wrong is a pair in the wrong *order*, and a border that comes apart. So:
 *
 * 1. **Coverage.** Every key in the boundary pack is either placed or listed as
 *    deliberately unplaced. This is the one that catches a genuine omission,
 *    which otherwise shows up as a number that never appears on the map.
 * 2. **Order.** For regions within 2 degrees of latitude, left-to-right on the
 *    grid matches west-to-east on the ground; likewise top-to-bottom. Swaps on
 *    a sub-2-degree centroid difference are reported separately, because nobody
 *    can see that one centroid is half a degree west of another and treating it
 *    as an error would bury the real ones.
 * 3. **Adjacency.** Regions that share a border in the topology keep their cells
 *    touching, or at worst one cell apart. This is the metric that decides
 *    whether the country still reads as itself.
 *
 * Usage: `npm run check:layout`
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { feature: topoFeature, neighbors } = require('topojson-client')
const { geoCentroid, geoArea } = require('d3-geo')

const ROOT = resolve(import.meta.dirname, '..')
const GEO_DIR = join(ROOT, 'geo')
const CATALOGUE = join(ROOT, 'src', 'core', 'GeoCatalogue.ts')

const problems = []
const warnings = []
const note = (m) => problems.push(m)
const warn = (m) => warnings.push(m)

/* --------------------------------------------------------------- the layouts */

const manifest = JSON.parse(readFileSync(join(GEO_DIR, 'manifest.json'), 'utf8'))
const fileFor = new Map((manifest.packs ?? []).map((p) => [p.id, p.file]))

const layouts = readdirSync(GEO_DIR)
  .filter((f) => f.endsWith('.json') && f !== 'manifest.json' && f !== 'package.json')
  .map((file) => ({ file, json: JSON.parse(readFileSync(join(GEO_DIR, file), 'utf8')) }))
  .filter(({ json }) => json.kind === 'layout')

if (!layouts.length) {
  console.log('\n  no grid layouts in geo/, nothing to check\n')
  process.exit(0)
}

/**
 * `unplaced` is declared twice on purpose: in the file, and in
 * `GeoCatalogue.ts` where the coverage warning can reach it before the file
 * loads. Two copies of a decision drift, so they are compared here.
 */
const catalogueSource = existsSync(CATALOGUE) ? readFileSync(CATALOGUE, 'utf8') : ''

function declaredUnplaced(id) {
  const row = catalogueSource.slice(catalogueSource.indexOf(`id: '${id}'`))
  if (!row) return null
  const end = row.indexOf('},')
  const block = end === -1 ? row : row.slice(0, end)
  const match = /unplaced:\s*\[([^\]]*)\]/.exec(block)
  if (!match) return null
  return match[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean)
}

/* ---------------------------------------------------------------- geometry */

/**
 * Each separately drawable piece of a geometry, as its own Polygon.
 *
 * A MultiPolygon is one geometry covering several landmasses, so it has to come
 * apart before any of them can be measured on its own.
 */
function mainlands(geometry) {
  if (!geometry) return []
  if (geometry.type === 'Polygon') return [geometry]
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.map((coordinates) => ({ type: 'Polygon', coordinates }))
  }
  return []
}

/** Pointy-top odd-r cell centre, unit radius. */
function centre([col, row], pack) {
  const flat = pack.orientation === 'flat'
  const s = Math.sqrt(3)
  if (flat) return [col * 1.5, row * s + (Math.abs(col % 2) === 1 ? s / 2 : 0)]
  return [col * s + (Math.abs(row % 2) === 1 ? s / 2 : 0), row * 1.5]
}

/** Grid distance between two offset cells, via cube coordinates. */
function hexDistance(a, b) {
  const cube = ([col, row]) => {
    const x = col - (row - (row & 1)) / 2
    return [x, -x - row, row]
  }
  const [ax, ay, az] = cube(a)
  const [bx, by, bz] = cube(b)
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz))
}

function spearman(a, b) {
  const rank = (xs) => {
    const order = xs.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0])
    const out = new Array(xs.length)
    order.forEach(([, i], k) => (out[i] = k))
    return out
  }
  const ra = rank(a)
  const rb = rank(b)
  let d2 = 0
  for (let i = 0; i < a.length; i++) d2 += (ra[i] - rb[i]) ** 2
  return 1 - (6 * d2) / (a.length * (a.length ** 2 - 1))
}

function renderGrid(cells) {
  const entries = Object.entries(cells)
  const maxRow = Math.max(...entries.map(([, [, r]]) => r))
  const maxCol = Math.max(...entries.map(([, [c]]) => c))
  const at = new Map(entries.map(([k, [c, r]]) => [`${c},${r}`, k]))
  const lines = []
  for (let r = 0; r <= maxRow; r++) {
    let line = r % 2 === 1 ? '  ' : ''
    for (let c = 0; c <= maxCol; c++) line += ` ${at.get(`${c},${r}`) ?? '··'} `
    lines.push(`    ${line}`)
  }
  return lines.join('\n')
}

/* ----------------------------------------------------------------- checking */

const LAT_BAND = 2.0
const LON_BAND = 3.0
const MARGIN = 2.0
/** Cells this far apart no longer read as a shared border. */
const TORN = 3

/**
 * A layout is a set of compromises, and the good ones are deliberate. The
 * prose in `compromises` records why; `accept` records *what*, as pairs, so a
 * decision already taken does not fail this check forever while a new mistake
 * hides behind the noise. An accepted pair that no longer trips anything is
 * itself reported: a stale exemption is a claim about the layout that is no
 * longer true, and it would silence a real regression if one reappeared there.
 */
const pairKey = (a, b) => [a, b].sort().join('/')

for (const { file, json: pack } of layouts) {
  const id = pack.id ?? file
  const cells = Object.fromEntries(
    Object.entries(pack.cells ?? {}).map(([k, v]) => [k, [Number(v[0]), Number(v[1])]]),
  )
  const keys = Object.keys(cells)

  console.log(
    `\n  ${id}  (${keys.length} cells, ${pack.grid ?? 'hex'}/${pack.orientation ?? 'pointy'}/${pack.offset ?? 'odd-r'})`,
  )

  // --- the boundary pack it claims to represent
  const ofFile = fileFor.get(pack.of)
  if (!ofFile) {
    note(`${id}: claims to represent "${pack.of}", which is not in manifest.json`)
    continue
  }
  const topology = JSON.parse(readFileSync(join(GEO_DIR, ofFile), 'utf8'))
  const objectName = Object.keys(topology.objects)[0]
  const geometries = topology.objects[objectName].geometries
  const fc = topoFeature(topology, topology.objects[objectName])

  // Where a region *is*, for a reader: the centroid of its largest landmass,
  // not of everything filed under its key. A key sprawls in two different ways
  // and both would score a correct layout as misplaced:
  //
  //   - As several features. Natural Earth files New South Wales and Lord Howe
  //     Island separately under `AU-NSW`, and the island is 12 degrees out into
  //     the Tasman.
  //   - As one MultiPolygon. Eurostat files metropolitan France and the five
  //     overseas departments as a single `FR`, which puts France in the Bay of
  //     Biscay, 9 degrees west of Paris and south of the Loire. Natural Earth
  //     does the same to Tokyo, whose Ogasawara islands reach 1000 km south and
  //     invert Tokyo against Kanagawa.
  //
  // So both collapse to one rule, applied across features and across the rings
  // inside them: the main landmass is the region.
  const truth = new Map()
  for (const f of fc.features) {
    const value = f.properties?.[pack.keyField]
    if (value == null) continue
    const key = String(value)
    for (const part of mainlands(f.geometry)) {
      const [lon, lat] = geoCentroid(part)
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
      const area = Math.abs(geoArea(part))
      const held = truth.get(key)
      if (held && held.area >= area) continue
      truth.set(key, { lon, lat, area, name: f.properties.name })
    }
  }

  // --- 1. coverage
  const unplaced = new Set(pack.unplaced ?? [])
  for (const key of keys) {
    if (!truth.has(key)) note(`${id}: places "${key}", which is not a key in ${pack.of}`)
  }
  const missing = [...truth.keys()].filter((k) => !(k in cells) && !unplaced.has(k))
  if (missing.length) {
    note(
      `${id}: ${missing.length} region(s) in ${pack.of} are neither placed nor listed as ` +
        `unplaced: ${missing.join(', ')}. Add cells, or add them to "unplaced" to say it is deliberate.`,
    )
  }
  for (const key of unplaced) {
    if (!truth.has(key)) warn(`${id}: lists "${key}" as unplaced, but ${pack.of} has no such key`)
    if (key in cells) note(`${id}: "${key}" is both placed and listed as unplaced`)
  }

  const accept = {
    order: new Set((pack.accept?.order ?? []).map((p) => pairKey(...p.split('/')))),
    borders: new Set((pack.accept?.borders ?? []).map((p) => pairKey(...p.split('/')))),
  }
  const fired = { order: new Set(), borders: new Set() }

  const declared = declaredUnplaced(id)
  if (declared) {
    const a = [...unplaced].sort().join(',')
    const b = [...declared].sort().join(',')
    if (a !== b) {
      note(
        `${id}: the unplaced list disagrees with GeoCatalogue.ts. ` +
          `File: [${a}]. Catalogue: [${b}]. The coverage warning reads the catalogue copy.`,
      )
    }
  }

  // --- 2. order
  // Parked cells would wreck a geographic score: Alaska and Hawaii are drawn in
  // a corner by convention, nowhere near where they are.
  const parked = new Set(pack.parked ?? ['AK', 'HI'])
  const scored = keys.filter((k) => truth.has(k) && !parked.has(k))
  const xs = scored.map((k) => centre(cells[k], pack)[0])
  const ys = scored.map((k) => centre(cells[k], pack)[1])
  const lons = scored.map((k) => truth.get(k).lon)
  const lats = scored.map((k) => -truth.get(k).lat)

  // Drawing two regions *level* is the third way to get the order wrong, and
  // the quietest: a comparison that skipped ties would pass Rio Grande do Sul
  // sitting beside Santa Catarina rather than below it, because two cells in
  // one row are neither before nor after each other. So ties count, and only
  // for pairs the band already says are comparable: a tilegram flattens most
  // of the map on purpose, and only a pair that is close on one axis and far
  // apart on the other has an order a reader can miss.
  const swaps = { x: [], y: [] }
  for (let i = 0; i < scored.length; i++) {
    for (let j = i + 1; j < scored.length; j++) {
      const ta = truth.get(scored[i])
      const tb = truth.get(scored[j])
      const pair = pairKey(scored[i], scored[j])
      if (Math.abs(ta.lat - tb.lat) <= LAT_BAND) {
        const grid = Math.sign(xs[i] - xs[j])
        if (grid !== Math.sign(ta.lon - tb.lon)) {
          swaps.x.push({ pair, gap: Math.abs(ta.lon - tb.lon), level: grid === 0 })
        }
      }
      if (Math.abs(ta.lon - tb.lon) <= LON_BAND) {
        const grid = Math.sign(ys[i] - ys[j])
        if (grid !== Math.sign(tb.lat - ta.lat)) {
          swaps.y.push({ pair, gap: Math.abs(ta.lat - tb.lat), level: grid === 0 })
        }
      }
    }
  }

  for (const [axis, list] of Object.entries(swaps)) {
    const real = list.filter((s) => s.gap >= MARGIN).sort((a, b) => b.gap - a.gap)
    const marginal = list.filter((s) => s.gap < MARGIN)
    const label = axis === 'x' ? 'left-right' : 'top-bottom'
    const flat = axis === 'x' ? 'the same column' : 'the same row'
    let accepted = 0
    for (const s of real) {
      const message = s.level
        ? `${id}: ${s.pair} are drawn in ${flat} but are ${s.gap.toFixed(1)}° apart ${axis === 'x' ? 'east-west' : 'north-south'}`
        : `${id}: ${label} order is wrong for ${s.pair} (${s.gap.toFixed(1)}° apart)`
      if (accept.order.has(s.pair)) {
        fired.order.add(s.pair)
        accepted++
        warn(`${message} — accepted`)
      } else {
        note(message)
      }
    }
    // Marginal pairs are named, but only the widest few. Japan's prefectures are
    // small enough that a hundred pairs sit inside a band and under the margin,
    // and a hundred names is not a review, it is a wall.
    const worst = marginal.sort((a, b) => b.gap - a.gap)
    const named = worst.slice(0, 6).map((s) => s.pair)
    console.log(
      `    ${label.padEnd(10)} ${real.length - accepted} error(s)` +
        (accepted ? `, ${accepted} accepted` : '') +
        (marginal.length
          ? `, ${marginal.length} marginal, widest: ${named.join(', ')}` +
            (worst.length > named.length ? ` and ${worst.length - named.length} more` : '')
          : ''),
    )
  }
  console.log(
    `    rank corr  west-east ${spearman(xs, lons).toFixed(3)}, north-south ${spearman(ys, lats).toFixed(3)}`,
  )

  // --- 3. adjacency
  const borders = new Set()
  neighbors(geometries).forEach((list, i) => {
    const a = geometries[i].properties?.[pack.keyField]
    for (const j of list) {
      const b = geometries[j].properties?.[pack.keyField]
      // A state split into several geometries neighbours itself; not a border.
      if (a && b && a !== b) borders.add([String(a), String(b)].sort().join('|'))
    }
  })

  let touching = 0
  let near = 0
  const torn = []
  for (const border of borders) {
    const [a, b] = border.split('|')
    if (!(a in cells) || !(b in cells)) continue
    const d = hexDistance(cells[a], cells[b])
    if (d === 1) touching++
    else if (d === 2) near++
    else torn.push({ pair: `${a}/${b}`, d })
  }
  const total = touching + near + torn.length
  const pct = (n) => `${Math.round((n / total) * 100)}%`
  console.log(
    `    borders    ${total} real, ${touching} touching (${pct(touching)}), ` +
      `${near} one apart (${pct(near)}), ${torn.length} further`,
  )
  for (const t of torn.sort((p, q) => q.d - p.d)) {
    const message = `${id}: ${t.pair} share a border but their cells are ${t.d} apart`
    if (accept.borders.has(t.pair)) {
      fired.borders.add(t.pair)
      warn(`${message} — accepted`)
    } else if (t.d > TORN) {
      note(message)
    } else {
      warn(message)
    }
  }

  for (const kind of ['order', 'borders']) {
    for (const pair of accept[kind]) {
      if (!fired[kind].has(pair)) {
        note(
          `${id}: accept.${kind} lists "${pair}", which no longer trips anything. ` +
            'Remove it, or it will hide a regression there.',
        )
      }
    }
  }

  if (process.argv.includes('--print')) console.log(`\n${renderGrid(cells)}`)
}

/* ------------------------------------------------------------------- report */

console.log('')
for (const w of warnings) console.log(`  note     ${w}`)
if (problems.length) {
  for (const p of problems) console.error(`  problem  ${p}`)
  console.error(`\n  ${problems.length} problem(s).\n`)
  process.exit(1)
}
console.log(`  ${layouts.length} layout(s) verified against their boundary packs.\n`)
