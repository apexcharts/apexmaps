// @vitest-environment jsdom
/**
 * Pixel maps.
 *
 * Two halves. The lattice is held to exact geometry, because the claim a pixel
 * map makes is that a dot belongs to the region its centre is in: a scanline
 * that double-counts a vertex or misses a hole draws a plausible map that is
 * wrong, and nothing on screen says so. So membership is checked against a
 * brute-force point-in-polygon test rather than against counts worked out by
 * hand.
 *
 * The other half is the contract with the rest of the library, which is where
 * a pixel map earns being a choropleth with a different mark rather than a new
 * kind of series: one element per region, the choropleth's colours, the
 * hover, the legend, and a lattice that is sampled once and then only moved.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ApexMaps from '../src/ApexMaps'
import {
  cellsInside,
  dotPath,
  dotTail,
  geoLattice,
  geoRings,
  latticeFor,
  nearestCells,
  planeLattice,
  rowRatio,
  sampleRegions,
} from '../src/geo/PixelGrid'
import type { LatticeSpec, Ring } from '../src/geo/PixelGrid'

const WORLD = JSON.parse(
  readFileSync(resolve(process.cwd(), 'geo/world-countries-110m.json'), 'utf8'),
)

/** A deterministic generator, so a failing polygon can be reproduced. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** Even-odd point in polygon, one point at a time: slow, obvious, and the reference. */
function inside(rings: Ring[], x: number, y: number): boolean {
  let hit = false
  for (const ring of rings) {
    const n = ring.length
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const [xi, yi, xj, yj] = [ring[i], ring[i + 1], ring[j], ring[j + 1]]
      if (yi > y !== yj > y && x < xj + ((y - yj) * (xi - xj)) / (yi - yj)) hit = !hit
    }
  }
  return hit
}

/** Every lattice point in a box, by brute force. */
function bruteForce(rings: Ring[], lattice: LatticeSpec, box: number): string[] {
  const out: string[] = []
  const rows = Math.ceil(box / lattice.rowGap) + 1
  for (let row = -rows; row <= rows; row++) {
    const step = lattice.step(row)
    const origin = lattice.origin(row)
    const cols = Math.ceil(box / step) + 2
    for (let col = -cols; col <= cols; col++) {
      if (inside(rings, origin + col * step, row * lattice.rowGap)) out.push(`${row}:${col}`)
    }
  }
  return out.sort()
}

/** The absolute vertices of one dot, read back out of its path. */
function vertices(d: string): [number, number][] {
  const tokens = d.match(/[MmLlHhVvZzAa]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? []
  const out: [number, number][] = []
  let x = 0
  let y = 0
  let command = ''
  for (let i = 0; i < tokens.length;) {
    if (/[A-Za-z]/.test(tokens[i])) command = tokens[i++]
    const n = () => Number(tokens[i++])
    switch (command) {
      case 'M':
        x = n()
        y = n()
        break
      case 'l':
        x += n()
        y += n()
        break
      case 'h':
        x += n()
        break
      case 'v':
        y += n()
        break
      case 'z':
        continue
    }
    out.push([x, y])
  }
  return out
}

describe('the lattice', () => {
  it('chooses the lattice each shape packs into', () => {
    expect(latticeFor('square')).toBe('square')
    expect(latticeFor('circle')).toBe('staggered')
    expect(latticeFor('hexagon')).toBe('staggered')
    expect(latticeFor('diamond')).toBe('staggered')
    expect(rowRatio('circle', 'staggered')).toBeCloseTo(Math.sqrt(3) / 2)
    expect(rowRatio('hexagon', 'staggered')).toBeCloseTo(Math.sqrt(3) / 2)
    expect(rowRatio('diamond', 'staggered')).toBe(0.5)
    expect(rowRatio('square', 'staggered')).toBe(1)
    expect(rowRatio('circle', 'square')).toBe(1)
  })

  it('agrees with a point-by-point test on random polygons, holes and all', () => {
    // The scanline's whole risk is in the details: the half-open rule at a
    // vertex sitting exactly on a row, a closing edge, a hole. Random polygons
    // with vertices snapped to the lattice put vertices on rows constantly.
    const random = rng(7)
    for (const staggered of [false, true]) {
      const lattice = planeLattice({ spacing: 1, rowRatio: staggered ? 0.5 : 1, staggered })
      for (let trial = 0; trial < 40; trial++) {
        const ring: Ring = []
        const sides = 3 + Math.floor(random() * 9)
        for (let i = 0; i < sides; i++) {
          const angle = (i / sides) * Math.PI * 2
          const radius = 3 + random() * 9
          // Half the vertices land exactly on a row.
          const y = Math.sin(angle) * radius
          ring.push(Math.cos(angle) * radius, trial % 2 ? Math.round(y * 2) / 2 : y)
        }
        const hole: Ring = [-1.3, -1.1, 1.2, -1.1, 1.2, 1.4, -1.3, 1.4]
        const rings = trial % 3 === 0 ? [ring, hole] : [ring]
        const found = cellsInside(rings, lattice)
          .map((c) => `${c.row}:${c.col}`)
          .sort()
        expect(found, `trial ${trial}`).toEqual(bruteForce(rings, lattice, 14))
      }
    }
  })

  it('counts a point once whether or not the ring repeats its first vertex', () => {
    const lattice = planeLattice({ spacing: 1, rowRatio: 1, staggered: false })
    const open: Ring = [0.5, 0.5, 4.5, 0.5, 4.5, 4.5, 0.5, 4.5]
    const closed: Ring = [...open, 0.5, 0.5]
    expect(cellsInside([open], lattice)).toHaveLength(16)
    expect(cellsInside([closed], lattice)).toHaveLength(16)
  })

  it('wraps every geographic row exactly once around the world', () => {
    for (const equalArea of [false, true]) {
      const lattice = geoLattice({
        spacing: 3,
        rowRatio: 1,
        staggered: true,
        equalArea,
        meridian: 20,
      })
      for (let row = lattice.minRow; row <= lattice.maxRow; row++) {
        // A whole number of columns in 360°, or a globe turning under it would
        // show a seam where the row's last column meets its first.
        expect(lattice.period(row) * lattice.step(row)).toBeCloseTo(360, 9)
      }
      // No row at the pole, where a row is a single point.
      expect(lattice.maxRow * lattice.rowGap).toBeLessThan(90)
    }
  })

  it('thins the rows towards the poles when asked to keep the area', () => {
    const lattice = geoLattice({ spacing: 2, rowRatio: 1, staggered: false, equalArea: true })
    const equator = lattice.period(0)
    const sixty = lattice.period(30) // 30 rows of 2° is 60°N
    expect(sixty / equator).toBeCloseTo(0.5, 1)
    const fixed = geoLattice({ spacing: 2, rowRatio: 1, staggered: false, equalArea: false })
    expect(fixed.period(30)).toBe(fixed.period(0))
  })

  it('puts a column on the central meridian in every unshifted row', () => {
    const lattice = geoLattice({
      spacing: 3,
      rowRatio: 1,
      staggered: true,
      equalArea: true,
      meridian: -98,
    })
    for (const row of [0, 2, 10, -14]) expect(lattice.origin(row)).toBe(-98)
    // Odd rows sit half a step over, which is what staggering means.
    expect(lattice.origin(1)).toBeCloseTo(-98 + lattice.step(1) / 2)
  })

  it('offers the nearest lattice points first', () => {
    const lattice = planeLattice({ spacing: 10, rowRatio: 1, staggered: false })
    const near = nearestCells(lattice, 13, 2)
    expect([near[0].x, near[0].y]).toEqual([10, 0])
    const distances = near.map((c) => Math.hypot(c.x - 13, c.y - 2))
    expect([...distances].sort((a, b) => a - b)).toEqual(distances)
    expect(Math.max(...distances)).toBeLessThanOrEqual(15)
  })
})

describe('regions on the lattice', () => {
  const lattice = planeLattice({ spacing: 1, rowRatio: 1, staggered: false })
  const square = (x0: number, y0: number, x1: number, y1: number): Ring => [
    x0,
    y0,
    x1,
    y0,
    x1,
    y1,
    x0,
    y1,
  ]

  it('draws a point inside two overlapping regions once', () => {
    const { cells } = sampleRegions(
      [
        { index: 0, rings: [square(-0.5, -0.5, 3.5, 3.5)] },
        { index: 1, rings: [square(1.5, 1.5, 5.5, 5.5)] },
      ],
      lattice,
    )
    const all = [...cells.values()].flat().map((c) => `${c.row}:${c.col}`)
    expect(new Set(all).size).toBe(all.length)
  })

  it('gives a region too small to catch a point the nearest free one', () => {
    const { cells, dropped } = sampleRegions(
      [{ index: 0, rings: [square(10.2, 10.2, 10.4, 10.4)], anchor: [10.3, 10.3] }],
      lattice,
    )
    expect(dropped).toEqual([])
    expect(cells.get(0)).toEqual([{ row: 10, col: 10, x: 10, y: 10 }])
  })

  it('borrows a point from a neighbour with dots to spare', () => {
    // The small region sits inside the large one's box, so every point round it
    // is taken: it has to borrow.
    const { cells } = sampleRegions(
      [
        { index: 0, rings: [square(-0.5, -0.5, 9.5, 9.5)] },
        { index: 1, rings: [square(4.9, 4.9, 4.95, 4.95)], anchor: [4.92, 4.92] },
      ],
      lattice,
    )
    expect(cells.get(1)).toHaveLength(1)
    expect(cells.get(0)).toHaveLength(99)
  })

  it('reports a region it could not place rather than hiding it', () => {
    // Surrounded by one-dot neighbours on every point within reach, and taking
    // any of their only dots would move the problem rather than solve it.
    const regions = []
    let index = 0
    for (let row = -2; row <= 2; row++) {
      for (let col = -2; col <= 2; col++) {
        regions.push({
          index: index++,
          rings: [square(col - 0.4, row - 0.4, col + 0.4, row + 0.4)],
        })
      }
    }
    regions.push({
      index: 99,
      rings: [square(0.1, 0.1, 0.2, 0.2)],
      anchor: [0.15, 0.15] as [number, number],
    })
    const { cells, dropped } = sampleRegions(regions, lattice)
    expect(dropped).toEqual([99])
    expect(cells.has(99)).toBe(false)
  })

  it('leaves out the smallest region when there are not points enough for all', () => {
    // One free point in a field of one-dot neighbours, and two regions that
    // need it. The smaller is listed first, and still loses.
    const regions = []
    let index = 0
    for (let row = -2; row <= 2; row++) {
      for (let col = -2; col <= 2; col++) {
        if (row === 0 && col === 0) continue
        regions.push({
          index: index++,
          rings: [square(col - 0.4, row - 0.4, col + 0.4, row + 0.4)],
        })
      }
    }
    const smaller = {
      index: 50,
      rings: [square(0.1, 0.1, 0.15, 0.15)],
      anchor: [0.12, 0.12] as [number, number],
    }
    const larger = {
      index: 51,
      rings: [square(-0.3, 0.1, -0.1, 0.3)],
      anchor: [-0.2, 0.2] as [number, number],
    }
    const { cells, dropped } = sampleRegions([...regions, smaller, larger], lattice)
    expect(cells.get(51)).toHaveLength(1)
    expect(dropped).toEqual([50])
  })

  it('unwraps a ring that jumps the antimeridian instead of spanning the world', () => {
    const [ring] = geoRings({
      type: 'Polygon',
      coordinates: [
        [
          [178, -17],
          [-179, -17],
          [-179, -15],
          [178, -15],
          [178, -17],
        ],
      ],
    })
    const lons = ring.filter((_, i) => i % 2 === 0)
    expect(Math.max(...lons) - Math.min(...lons)).toBeLessThan(5)
    // And its points come back folded into range.
    const lattice = geoLattice({ spacing: 1, rowRatio: 1, staggered: false, equalArea: false })
    const cells = cellsInside([ring], lattice)
    expect(cells.length).toBeGreaterThan(0)
    for (const cell of cells) expect(Math.abs(cell.x)).toBeGreaterThan(177)
  })

  it('leaves an edge along the pole alone', () => {
    // Antarctica closes its ring by running along -90° from 180 to -180.
    const [ring] = geoRings({
      type: 'Polygon',
      coordinates: [
        [
          [-180, -90],
          [-180, -70],
          [-90, -70],
          [0, -70],
          [90, -70],
          [180, -70],
          [180, -90],
          [-180, -90],
        ],
      ],
    })
    const lons = ring.filter((_, i) => i % 2 === 0)
    expect(Math.min(...lons)).toBe(-180)
    expect(Math.max(...lons)).toBe(180)
  })
})

describe('dot shapes', () => {
  it('tiles hexagons on the staggered lattice at full width', () => {
    // Pointy-topped, a step wide: the rows √3/2 of a step apart have to bring
    // a hexagon's lower edges exactly onto its neighbours' upper ones.
    const step = 10
    const half = step / 2
    const tail = dotTail('hexagon', half, 6)
    const gap = step * rowRatio('hexagon', 'staggered')
    const a = vertices(dotPath(0, 0, tail, 6))
    const below = vertices(dotPath(step / 2, gap, tail, 6))
    const shared = a.filter(([x, y]) =>
      below.some(([bx, by]) => Math.abs(bx - x) < 1e-6 && Math.abs(by - y) < 1e-6),
    )
    expect(shared).toHaveLength(2)
  })

  it('tiles diamonds on the staggered lattice at full width', () => {
    const step = 10
    const tail = dotTail('diamond', step / 2, 6)
    const gap = step * rowRatio('diamond', 'staggered')
    const a = vertices(dotPath(0, 0, tail, 6))
    const below = vertices(dotPath(step / 2, gap, tail, 6))
    const shared = a.filter(([x, y]) =>
      below.some(([bx, by]) => Math.abs(bx - x) < 1e-6 && Math.abs(by - y) < 1e-6),
    )
    expect(shared).toHaveLength(2)
  })

  it('makes every shape a step wide at full size', () => {
    for (const shape of ['square', 'diamond', 'hexagon'] as const) {
      const xs = vertices(dotPath(0, 0, dotTail(shape, 5, 6), 6)).map(([x]) => x)
      expect(Math.max(...xs) - Math.min(...xs), shape).toBeCloseTo(10)
    }
    expect(dotPath(0, 0, dotTail('circle', 5, 2), 2)).toBe('M-5,0a5,5 0 1,0 10,0a5,5 0 1,0 -10,0z')
  })
})

// --- the series ---------------------------------------------------------------

let el: HTMLElement
let map: ApexMaps | null

beforeEach(() => {
  el = document.createElement('div')
  document.body.appendChild(el)
  vi.stubGlobal('requestAnimationFrame', ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame)
  vi.stubGlobal('cancelAnimationFrame', ((id: number) =>
    clearTimeout(id)) as unknown as typeof cancelAnimationFrame)
})

afterEach(() => {
  map?.destroy()
  map = null
  el.remove()
  vi.unstubAllGlobals()
})

const DATA = [
  { iso_a3: 'USA', value: 10 },
  { iso_a3: 'BRA', value: 20 },
  { iso_a3: 'IND', value: 30 },
  { iso_a3: 'AUS', value: 40 },
  { iso_a3: 'RUS', value: 50 },
  { iso_a3: 'NGA', value: 60 },
]

async function draw(series: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const { geo, ...rest } = options
  map = new ApexMaps(el, {
    chart: { width: 900, height: 460 },
    geo: { map: WORLD, ...((geo as object) ?? {}) },
    series: [{ type: 'pixel', joinBy: 'iso_a3', data: DATA, ...series }],
    ...rest,
  } as never)
  await map.render()
  return map
}

const pixels = () => [...el.querySelectorAll<SVGPathElement>('path.apexmaps-pixels')]
const pixel = (key: string) =>
  el.querySelector<SVGPathElement>(`path.apexmaps-pixels[data-key="${key}"]`)
const dots = (path: Element | null) => (path?.getAttribute('d')?.match(/M/g) ?? []).length
const totalDots = () => pixels().reduce((n, p) => n + dots(p), 0)

describe('a pixel series', () => {
  it('draws each region as one path, over an outline that answers for its gaps', async () => {
    await draw()
    const paths = pixels()
    expect(paths.length).toBe(WORLD.objects.countries.geometries.length)
    for (const path of paths) expect(path.classList.contains('apexmaps-feature')).toBe(true)

    const hits = [...el.querySelectorAll('path.apexmaps-feature-hit')]
    expect(hits).toHaveLength(paths.length)
    // Every outline is under every dot in the series, so a dot overhanging its
    // border onto a neighbour's outline still answers as its own region.
    const group = paths[0].parentElement!
    const order = [...group.children]
    const lastHit = Math.max(...hits.map((h) => order.indexOf(h)))
    const firstDot = Math.min(...paths.map((p) => order.indexOf(p)))
    expect(lastHit).toBeLessThan(firstDot)
    for (const hit of hits) expect(hit.getAttribute('fill')).toBe('transparent')
  })

  it('leaves no country out at the default spacing', async () => {
    await draw({ data: [] })
    const keys = WORLD.objects.countries.geometries.map(
      (g: { properties: { iso_a3: string } }) => g.properties.iso_a3,
    )
    // The ones a 3° lattice steps over entirely, which have to be given a dot.
    for (const key of ['LUX', 'PSE', 'GMB', 'TTO', 'BRN']) {
      expect(keys, key).toContain(key)
      expect(dots(pixel(key)), key).toBeGreaterThan(0)
    }
    expect(pixels()).toHaveLength(keys.length)
  })

  it('paints each region the colour a choropleth of the same data would', async () => {
    await draw()
    const pixelFills = new Map(pixels().map((p) => [p.dataset.key, p.getAttribute('fill')]))
    map!.destroy()

    map = new ApexMaps(el, {
      chart: { width: 900, height: 460 },
      geo: { map: WORLD },
      series: [{ type: 'choropleth', joinBy: 'iso_a3', data: DATA }],
    } as never)
    await map.render()
    const choropleth = [...el.querySelectorAll<SVGPathElement>('path.apexmaps-feature')]
    expect(choropleth.length).toBeGreaterThan(0)
    for (const path of choropleth) {
      expect(pixelFills.get(path.dataset.key), path.dataset.key).toBe(path.getAttribute('fill'))
    }
  })

  it('draws no outline round the dots by default', async () => {
    await draw()
    expect(pixel('BRA')!.getAttribute('stroke-width')).toBe('0')
  })

  it('shows the mark in the legend', async () => {
    await draw({ shape: 'diamond' })
    const swatches = [...el.querySelectorAll('.apexmaps-legend-swatch.is-dots')]
    expect(swatches.length).toBeGreaterThan(0)
    // Four of the map's own dots, in the class colour.
    expect(dots(swatches[0].querySelector('path'))).toBe(4)
  })

  it('clamps a size past the step to the step, and reads pixels as pixels', async () => {
    await draw({ size: '100%' })
    const full = pixel('BRA')!.getAttribute('d')
    map!.destroy()
    await draw({ size: '160%' })
    expect(pixel('BRA')!.getAttribute('d')).toBe(full)
    map!.destroy()
    await draw({ size: 6 })
    expect(pixel('BRA')!.getAttribute('d')).toMatch(/a3,3 0 1,0 6,0/)
  })

  it('reports options that cannot apply', async () => {
    await draw({ equalArea: false, spacing: -2 })
    const warnings = map!.warnings.join('\n')
    expect(warnings).toMatch(/equalArea only applies on a globe/)
    expect(warnings).toMatch(/spacing -2 is not a positive number/)
  })

  it('keeps its elements and its lattice across a data update', async () => {
    await draw()
    const before = pixel('BRA')!
    const d = before.getAttribute('d')
    map!.updateSeries([
      { type: 'pixel', joinBy: 'iso_a3', data: DATA.map((r) => ({ ...r, value: 100 - r.value })) },
    ] as never)
    const after = pixel('BRA')!
    // The same element, so the fill tweens rather than the region blinking out
    // and back, and the same dots, because the sample is shared.
    expect(after).toBe(before)
    expect(after.getAttribute('d')).toBe(d)
  })

  it('holds the hover while the pointer crosses from a dot to a gap and back', async () => {
    await draw()
    const featureHover = vi.fn()
    map!.on('featureHover', featureHover)
    const dot = pixel('BRA')!
    const gap = el.querySelector('path.apexmaps-feature-hit[data-key="BRA"]')!

    gap.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true }))
    const darkened = dot.getAttribute('fill')
    gap.dispatchEvent(new window.PointerEvent('pointerout', { bubbles: true, relatedTarget: dot }))
    dot.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true, relatedTarget: gap }))
    dot.dispatchEvent(new window.PointerEvent('pointerout', { bubbles: true, relatedTarget: gap }))
    gap.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true, relatedTarget: dot }))

    expect(featureHover).toHaveBeenCalledTimes(1)
    // Darkened once, not once per crossing.
    expect(dot.getAttribute('fill')).toBe(darkened)
    expect(dot.classList.contains('is-hovered')).toBe(true)

    gap.dispatchEvent(new window.PointerEvent('pointerout', { bubbles: true, relatedTarget: el }))
    expect(dot.classList.contains('is-hovered')).toBe(false)
  })

  it('selects a region from a click on its dots', async () => {
    await draw()
    pixel('IND')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    expect([...map!.selection]).toContain('IND')
    expect(pixel('IND')!.classList.contains('is-selected')).toBe(true)
  })

  it('is left out of a layout morph, which has no outline to walk', async () => {
    await draw()
    const renderer = (map as never as { renderer: { featureMarks(): Map<string, Element> } })
      .renderer
    expect(renderer.featureMarks().size).toBe(0)
  })
})

describe('the geo grid', () => {
  it('magnifies with the camera instead of resampling', async () => {
    await draw({ grid: 'geo' })
    const d = pixel('BRA')!.getAttribute('d')
    map!.camera!.set({ k: 6, x: -1500, y: -900 })
    expect(pixel('BRA')!.getAttribute('d')).toBe(d)
  })

  it('lays an even lattice on a flat map, whatever the projection does to the parallels', async () => {
    // Mercator stretches the high latitudes; a lattice laid in degrees would
    // put the rows further and further apart going north. Laid on the map as
    // drawn, the rows of Russia are exactly as far apart as Brazil's.
    await draw({ grid: 'geo', shape: 'square', spacing: 3 }, { geo: { projection: 'mercator' } })
    // The y of every dot's first vertex, which for a square is its top edge.
    const tops = (key: string) =>
      [
        ...pixel(key)!
          .getAttribute('d')!
          .matchAll(/M[-\d.]+,([-\d.]+)/g),
      ].map((m) => Number(m[1]))
    const brazil = [...new Set(tops('BRA'))].sort((a, b) => a - b)
    const step = brazil[1] - brazil[0]
    expect(step).toBeGreaterThan(1)
    // Russia's rows sit on the same lattice as Brazil's, a whole number of
    // Brazil's steps away, sixty degrees further north on a projection that has
    // stretched every degree up there to twice its length.
    for (const y of tops('RUS')) {
      const steps = (y - brazil[0]) / step
      expect(Math.abs(steps - Math.round(steps)), `row at ${y}`).toBeLessThan(0.01)
    }
  })

  it('turns with a globe, culls the far side, and never resamples', async () => {
    await draw(
      { grid: 'screen', shape: 'hexagon' },
      { geo: { projection: 'orthographic', view: { fit: 'world' } } },
    )
    expect(map!.warnings.join('\n')).toMatch(/grid: 'screen' is not available on a globe/)

    const facing = new Set(pixels().map((p) => p.dataset.key))
    expect(facing.size).toBeGreaterThan(20)
    expect(facing.size).toBeLessThan(WORLD.objects.countries.geometries.length)

    map!.rotateTo([180, 0, 0])
    await new Promise((r) => setTimeout(r, 10))
    const turned = new Set(pixels().map((p) => p.dataset.key))
    // The other hemisphere: what faced the reader now mostly does not.
    const both = [...facing].filter((k) => turned.has(k))
    expect(both.length).toBeLessThan(facing.size / 2)

    map!.rotateTo([0, 0, 0])
    await new Promise((r) => setTimeout(r, 10))
    expect(new Set(pixels().map((p) => p.dataset.key))).toEqual(facing)
  })

  it('shrinks the dots towards the horizon of a globe', async () => {
    await draw({ shape: 'circle' }, { geo: { projection: 'orthographic', view: { fit: 'world' } } })
    const radii = pixels().flatMap((p) =>
      [...p.getAttribute('d')!.matchAll(/a([\d.]+),/g)].map((m) => Number(m[1])),
    )
    expect(Math.min(...radii)).toBeLessThan(Math.max(...radii) / 3)
  })
})

describe('the screen grid', () => {
  it('refines as the reader zooms, and holds still for a pan', async () => {
    await draw({ grid: 'screen', spacing: 8 })
    const opening = totalDots()

    // A pan inside the sampled area: nothing resamples.
    const d = pixel('BRA')!.getAttribute('d')
    map!.camera!.set({ k: 1, x: 40, y: 10 })
    expect(pixel('BRA')!.getAttribute('d')).toBe(d)

    // Across two levels: the lattice is a quarter the world spacing.
    map!.camera!.set({ k: 4, x: -1200, y: -700 })
    const brazil = pixel('BRA')
    expect(brazil?.getAttribute('d')).not.toBe(d)
    expect(totalDots()).toBeGreaterThan(opening)
  })

  it('keeps the dots the same size on screen at every level', async () => {
    await draw({ grid: 'screen', spacing: 10, size: '50%' })
    const radius = () =>
      Number(
        pixel('BRA')!
          .getAttribute('d')!
          .match(/a([\d.]+),/)![1],
      )
    const opening = radius()
    map!.camera!.set({ k: 4, x: -1200, y: -700 })
    expect(radius() * 4).toBeCloseTo(opening, 1)
  })
})
