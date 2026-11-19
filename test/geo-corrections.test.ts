/**
 * Corrections the geometry pipeline makes to upstream data, pinned twice: once
 * against the committed pack, so a rebuild that loses a fix fails here, and once
 * against the correction step itself, so it refuses a source it no longer fits.
 *
 * The points below are on land, checked against the islands they name. They are
 * deliberately written out rather than read from scripts/geo/corrections.mjs, so
 * that emptying the correction list cannot make this file agree with itself.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { feature } from 'topojson-client'
import type { Topology, GeometryCollection } from 'topojson-specification'
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson'

import { ADMIN1_CORRECTIONS, applyCorrections } from '../scripts/geo/corrections.mjs'

const GEO_DIR = resolve(process.cwd(), 'geo')

type Shape = Feature<Polygon | MultiPolygon, Record<string, unknown>>

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(GEO_DIR, file), 'utf8')) as T
}

const topology = readJson<Topology>('jp-admin1-10m.json')
const prefectures = feature(topology, topology.objects.admin1 as GeometryCollection)
  .features as Shape[]

function prefecture(code: string): Shape {
  const found = prefectures.find((f) => f.properties.iso_3166_2 === code)
  if (!found) throw new Error(`${code} is not in jp-admin1-10m.json`)
  return found
}

function polygonsOf(shape: Shape): Position[][][] {
  return shape.geometry.type === 'Polygon'
    ? [shape.geometry.coordinates]
    : shape.geometry.coordinates
}

/** Even-odd ray cast, independent of the one in the pipeline. */
function inRing([x, y]: Position, ring: Position[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function contains(shape: Shape, point: Position): boolean {
  return polygonsOf(shape).some(
    (polygon) => inRing(point, polygon[0]) && !polygon.slice(1).some((hole) => inRing(point, hole)),
  )
}

/** The prefecture whose geometry holds the point, or undefined at sea. */
function prefectureAt(point: Position): string | undefined {
  return prefectures.find((f) => contains(f, point))?.properties.iso_3166_2 as string | undefined
}

function bounds(shape: Shape): [number, number, number, number] {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const polygon of polygonsOf(shape)) {
    for (const [x, y] of polygon[0]) {
      w = Math.min(w, x)
      s = Math.min(s, y)
      e = Math.max(e, x)
      n = Math.max(n, y)
    }
  }
  return [w, s, e, n]
}

describe('jp/admin1@10m prefecture membership', () => {
  it('puts the Amami Islands in Kagoshima, not Okinawa', () => {
    const amami: [string, Position][] = [
      ['Amami Oshima', [129.32, 28.3]],
      ['Kakeromajima', [129.25, 28.13]],
      ['Kikaijima', [129.97, 28.32]],
      ['Tokunoshima', [128.96, 27.8]],
      ['Okinoerabujima', [128.6, 27.38]],
      ['Yoronjima', [128.42, 27.04]],
    ]
    for (const [name, point] of amami) expect(prefectureAt(point), name).toBe('JP-46')
  })

  it('puts Nagashima and Shishijima in Kagoshima, not Kumamoto', () => {
    expect(prefectureAt([130.15, 32.17]), 'Nagashima').toBe('JP-46')
    expect(prefectureAt([130.24, 32.28]), 'Shishijima').toBe('JP-46')
  })

  it("keeps Okinawa's own islands in Okinawa, and nothing else", () => {
    const okinawa: [string, Position][] = [
      ['Okinawa Island', [127.8, 26.35]],
      ['Iejima', [127.78, 26.72]],
      ['Iheyajima', [127.96, 27.05]],
      ['Iotorishima', [128.237, 27.86]],
      ['Kumejima', [126.77, 26.34]],
      ['Miyakojima', [125.33, 24.78]],
      ['Ishigakijima', [124.18, 24.43]],
      ['Iriomotejima', [123.8, 24.33]],
      ['Minamidaitojima', [131.246, 25.849]],
    ]
    for (const [name, point] of okinawa) expect(prefectureAt(point), name).toBe('JP-47')

    // Iotorishima, at 27.87 N, is the prefecture's northernmost island. Before
    // the correction Amami Oshima carried Okinawa's bounds to 28.5 N.
    const [, south, , north] = bounds(prefecture('JP-47'))
    expect(north).toBeGreaterThan(27.8)
    expect(north).toBeLessThan(27.95)
    expect(south).toBeLessThan(24.3)

    // Kagoshima now reaches south to Yoronjima, around 27.0 N.
    const [, kagoshimaSouth] = bounds(prefecture('JP-46'))
    expect(kagoshimaSouth).toBeLessThan(27.05)
    expect(kagoshimaSouth).toBeGreaterThan(26.95)
  })

  it('keeps the region set the hex layout morphs against', () => {
    const hex = readJson<{ cells: Record<string, unknown> }>('jp-admin1-hex.json')
    const keys = prefectures.map((f) => f.properties.iso_3166_2 as string).sort()
    expect(keys).toHaveLength(47)
    expect(Object.keys(hex.cells).sort()).toEqual(keys)
  })

  it('records the corrections in the manifest', () => {
    const manifest = readJson<{ packs: { id: string; corrections?: string[] }[] }>('manifest.json')
    const row = manifest.packs.find((p) => p.id === 'jp/admin1@10m')
    expect(row?.corrections).toEqual(ADMIN1_CORRECTIONS.JP.map((c) => c.summary))
  })
})

describe('applyCorrections', () => {
  const square = (x: number, y: number): Position[][] => [
    [
      [x, y],
      [x + 1, y],
      [x + 1, y + 1],
      [x, y + 1],
      [x, y],
    ],
  ]
  const make = (code: string, polygons: Position[][][]) => ({
    type: 'Feature',
    properties: { code },
    geometry: { type: 'MultiPolygon', coordinates: polygons },
  })
  const keyOf = (props: Record<string, unknown>) => props.code
  const move = (point: Position) => [
    { from: 'B', to: 'A', summary: 'moved', islands: [{ name: 'island', point }] },
  ]

  it('moves the named polygon, appends it, and leaves the input untouched', () => {
    const input = [make('A', [square(0, 0)]), make('B', [square(10, 0), square(20, 0)])]
    const snapshot = JSON.stringify(input)
    const { features, applied } = applyCorrections(input, move([20.5, 0.5]), keyOf)

    expect(applied).toEqual(['moved'])
    expect(features[0].geometry.coordinates).toEqual([square(0, 0), square(20, 0)])
    expect(features[1].geometry).toEqual({ type: 'Polygon', coordinates: square(10, 0) })
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('stops the build when upstream has already fixed the island', () => {
    const input = [make('A', [square(0, 0), square(20, 0)]), make('B', [square(10, 0)])]
    expect(() => applyCorrections(input, move([20.5, 0.5]), keyOf)).toThrow(/already in A upstream/)
  })

  it('stops the build when the island is in neither feature', () => {
    const input = [make('A', [square(0, 0)]), make('B', [square(10, 0)])]
    expect(() => applyCorrections(input, move([50, 50]), keyOf)).toThrow(/re-audit/)
  })

  it('passes features through when a pack has no corrections', () => {
    const input = [make('A', [square(0, 0)])]
    expect(applyCorrections(input, undefined, keyOf).features).toBe(input)
  })
})
