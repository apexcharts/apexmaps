/**
 * Pixel lattices: which points of a regular grid fall inside which region.
 *
 * The third lattice in this directory, and the one with the opposite job to
 * `geo/Hexbin`. A hexbin lattice ignores the boundaries and reports what landed
 * in each cell; this one *is* the boundaries, sampled. Every lattice point that
 * falls inside a region becomes one of that region's dots, and the region is
 * drawn as nothing else, so the map's outlines are never drawn at all and are
 * read off where one colour of dot gives way to the next.
 *
 * Three decisions shape the result.
 *
 * **A dot belongs to a region by its centre, and is never cut.** A lattice
 * repeated across the plane and clipped to each outline (which is what a pattern
 * fill is) leaves half-dots along every coast and border, and those slivers are
 * exactly what makes a dot texture look like a texture rather than a map. Here a
 * point is in or out, and a dot that overhangs its border is drawn whole.
 *
 * **Membership is a scanline, not a point-in-polygon test per point.** Each row
 * of the lattice is crossed once against a region's edges, the crossings are
 * sorted, and every column between an entering and a leaving crossing is in.
 * That is one pass over the edges per row rather than one per point, and it
 * never visits a lattice point outside the region's bounding box. Even-odd over
 * every ring at once gives holes for free: Lesotho is a hole in South Africa,
 * and its points come out of South Africa's count without a winding rule.
 *
 * **No region disappears for being small.** A region that the lattice steps
 * over entirely (an island, a city state, most of the Caribbean at world scale)
 * still gets one dot, at the lattice point nearest its centre. If a larger
 * neighbour already owns that point it gives it up, as long as it has others to
 * spare; a region whose data vanished from the map because the grid was coarse
 * would be a choropleth that silently dropped rows.
 *
 * @module geo/PixelGrid
 */

import type { LonLat, PixelShape, WorldBounds } from '../types'

export type PixelLattice = 'square' | 'staggered'

/** A closed ring as flat `[x0, y0, x1, y1, ...]`. The closing point is optional. */
export type Ring = number[]

/** One lattice point, inside some region. */
export interface PixelCell {
  row: number
  /** Column within the row, wrapped into `[0, period)` on a lattice that wraps. */
  col: number
  x: number
  y: number
}

/**
 * A lattice of rows. Row `j` sits at `y = j * rowGap`, and its columns at
 * `origin(j) + i * step(j)`.
 *
 * Rows rather than a single grid because the geographic lattice thins its rows
 * towards the poles, so the column spacing is a property of the row.
 */
export interface LatticeSpec {
  rowGap: number
  /** Rows outside this range do not exist (the geographic lattice stops short of the poles). */
  minRow: number
  maxRow: number
  step(row: number): number
  origin(row: number): number
  /** Columns per row on a lattice that wraps around the globe; 0 on one that does not. */
  period(row: number): number
}

const SQRT3_2 = Math.sqrt(3) / 2
const RADIANS = Math.PI / 180

/** The lattice a shape packs into when the caller has not chosen one. */
export function latticeFor(shape: PixelShape): PixelLattice {
  return shape === 'square' ? 'square' : 'staggered'
}

/**
 * Row spacing as a fraction of the column spacing, chosen so the shape tiles.
 *
 * Staggered circles and hexagons sit at the corners of equilateral triangles,
 * which puts the rows √3/2 of a step apart and makes a pointy-topped hexagon of
 * full width meet all six of its neighbours. Staggered diamonds interlock at
 * half a step, which is a square grid turned through 45°. A staggered square is
 * a brick wall, with its rows a full step apart.
 */
export function rowRatio(shape: PixelShape, lattice: PixelLattice): number {
  if (lattice === 'square' || shape === 'square') return 1
  if (shape === 'diamond') return 0.5
  return SQRT3_2
}

/**
 * The lattice on the globe, in degrees: rows along the parallels, anchored on the
 * equator, with every row wrapping exactly once around the world.
 *
 * Each row's column spacing is rounded so a whole number of columns fits in 360°,
 * which is what lets a globe turn under it without a seam at the antimeridian.
 * With `equalArea` the row is also thinned in proportion to the length of its
 * parallel, so a dot stands for the same area of ground at 60° as at the equator.
 *
 * Every row puts a column on `meridian`, the middle of the map. Rows thinned by
 * different amounts have slightly different steps, so their columns drift apart
 * in proportion to how far they are from wherever the rows were lined up. Lined
 * up at the antimeridian, the drift is largest in the middle of a world map, and
 * the columns comb out into diagonal streaks right where the reader is looking;
 * lined up at the centre, the columns run straight down the middle and the drift
 * is pushed out to the edges, where the projection is bending everything anyway.
 */
export function geoLattice({
  spacing,
  rowRatio: ratio,
  staggered,
  equalArea,
  meridian = 0,
}: {
  spacing: number
  rowRatio: number
  staggered: boolean
  equalArea: boolean
  meridian?: number
}): LatticeSpec {
  const rowGap = spacing * ratio
  // Strictly inside the poles: a row at 90° is a single point drawn as a
  // whole ring of dots on any projection that draws the pole as a line.
  const maxRow = Math.max(0, Math.ceil(90 / rowGap) - 1)
  const rows = new Map<number, [step: number, origin: number, period: number]>()

  const row = (j: number) => {
    let found = rows.get(j)
    if (!found) {
      const width = equalArea ? 360 * Math.cos(j * rowGap * RADIANS) : 360
      const period = Math.max(1, Math.round(width / spacing))
      const step = 360 / period
      const origin = meridian + (staggered && j & 1 ? step / 2 : 0)
      found = [step, origin, period]
      rows.set(j, found)
    }
    return found
  }

  return {
    rowGap,
    minRow: -maxRow,
    maxRow,
    step: (j) => row(j)[0],
    origin: (j) => row(j)[1],
    period: (j) => row(j)[2],
  }
}

/**
 * The lattice on the plane, in world units, anchored at the world origin so the
 * same level always produces the same points however often it is rebuilt.
 */
export function planeLattice({
  spacing,
  rowRatio: ratio,
  staggered,
}: {
  spacing: number
  rowRatio: number
  staggered: boolean
}): LatticeSpec {
  return {
    rowGap: spacing * ratio,
    minRow: Number.NEGATIVE_INFINITY,
    maxRow: Number.POSITIVE_INFINITY,
    step: () => spacing,
    origin: (j) => (staggered && j & 1 ? spacing / 2 : 0),
    period: () => 0,
  }
}

/**
 * The lattice points round a position, nearest first, out to a step and a half.
 *
 * Several rather than one because the nearest point is often taken: a small
 * region sits between neighbours, and one of them may own the point closest to
 * its centre with nothing to spare, while the next point along is open water or
 * belongs to a neighbour with dots to give.
 */
export function nearestCells(lattice: LatticeSpec, x: number, y: number): PixelCell[] {
  const centre = Math.round(y / lattice.rowGap)
  const found: { cell: PixelCell; distance: number }[] = []
  for (let row = centre - 1; row <= centre + 1; row++) {
    if (row < lattice.minRow || row > lattice.maxRow) continue
    const step = lattice.step(row)
    const origin = lattice.origin(row)
    const near = Math.round((x - origin) / step)
    const reach = 1.5 * Math.max(step, lattice.rowGap)
    for (let col = near - 1; col <= near + 1; col++) {
      // Measured before wrapping, so a point just across the antimeridian is as
      // near as it looks rather than a whole world away.
      const distance = Math.hypot(origin + col * step - x, row * lattice.rowGap - y)
      if (distance <= reach) found.push({ cell: cellAt(lattice, row, col, step, origin), distance })
    }
  }
  return found.sort((a, b) => a.distance - b.distance).map((f) => f.cell)
}

function cellAt(
  lattice: LatticeSpec,
  row: number,
  col: number,
  step: number,
  origin: number,
): PixelCell {
  const period = lattice.period(row)
  if (!period) return { row, col, x: origin + col * step, y: row * lattice.rowGap }
  // Adding zero, because a column of -0 compares unequal to its own key.
  const wrapped = (((col % period) + period) % period) + 0
  return { row, col: wrapped, x: wrapLongitude(origin + wrapped * step), y: row * lattice.rowGap }
}

/**
 * Every lattice point inside a region, by even-odd over all of its rings.
 *
 * @param clip Only visit points inside this box. The screen lattice uses it to
 *   sample what is near the viewport rather than the whole world at the zoom the
 *   reader happens to be at, which at 64x would be tens of millions of points.
 */
export function cellsInside(
  rings: readonly Ring[],
  lattice: LatticeSpec,
  clip?: WorldBounds | null,
): PixelCell[] {
  const out: PixelCell[] = []
  let y0 = Number.POSITIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i += 2) {
      if (ring[i] < y0) y0 = ring[i]
      if (ring[i] > y1) y1 = ring[i]
    }
  }
  if (clip) {
    y0 = Math.max(y0, clip[0][1])
    y1 = Math.min(y1, clip[1][1])
  }
  if (!(y1 >= y0)) return out

  const first = Math.max(lattice.minRow, Math.ceil(y0 / lattice.rowGap))
  const last = Math.min(lattice.maxRow, Math.floor(y1 / lattice.rowGap))
  const crossings: number[] = []

  for (let row = first; row <= last; row++) {
    const y = row * lattice.rowGap
    crossings.length = 0

    for (const ring of rings) {
      const n = ring.length
      if (n < 6) continue
      // Start from the last vertex so the closing edge is included whether or
      // not the ring repeats its first point.
      let px = ring[n - 2]
      let py = ring[n - 1]
      for (let i = 0; i < n; i += 2) {
        const qx = ring[i]
        const qy = ring[i + 1]
        // Half-open on y, so a row passing exactly through a vertex counts the
        // two edges meeting there once between them rather than twice or not
        // at all.
        if (qy > y !== py > y) crossings.push(px + ((y - py) * (qx - px)) / (qy - py))
        px = qx
        py = qy
      }
    }
    if (crossings.length < 2) continue
    crossings.sort((a, b) => a - b)

    const step = lattice.step(row)
    const origin = lattice.origin(row)
    for (let c = 0; c + 1 < crossings.length; c += 2) {
      let a = crossings[c]
      let b = crossings[c + 1]
      if (clip) {
        a = Math.max(a, clip[0][0])
        b = Math.min(b, clip[1][0])
      }
      for (let col = Math.ceil((a - origin) / step); origin + col * step <= b; col++) {
        out.push(cellAt(lattice, row, col, step, origin))
      }
    }
  }
  return out
}

/** One region to sample: its rings in the lattice's plane, and where its centre is. */
export interface RegionInput {
  index: number
  rings: Ring[]
  /** Where a region too small to catch a lattice point gets its one dot. */
  anchor?: [number, number] | null
}

export interface Sampled {
  /** Lattice points per region index, in row order. */
  cells: Map<number, PixelCell[]>
  /** Regions that caught no point and could not be given one. */
  dropped: number[]
}

/**
 * Assign lattice points to regions.
 *
 * A point inside two regions (overlapping geometry, which real boundary data
 * does have along disputed borders) goes to whichever came first, so every
 * point is drawn once.
 */
export function sampleRegions(
  regions: readonly RegionInput[],
  lattice: LatticeSpec,
  clip?: WorldBounds | null,
): Sampled {
  const cells = new Map<number, PixelCell[]>()
  const owner = new Map<string, number>()
  const dropped: number[] = []
  const empty: RegionInput[] = []

  for (const region of regions) {
    const kept: PixelCell[] = []
    for (const cell of cellsInside(region.rings, lattice, clip)) {
      const key = `${cell.row}:${cell.col}`
      if (owner.has(key)) continue
      owner.set(key, region.index)
      kept.push(cell)
    }
    if (kept.length) cells.set(region.index, kept)
    else empty.push(region)
  }

  // Second pass, so a small region never takes a point from a neighbour that
  // had not been sampled yet and would then have been left with none itself.
  // Largest first: where there are more small regions than spare points (the
  // Balkans on a coarse world lattice), the ones left out should be the
  // smallest, not whichever happened to come last in the data.
  empty.sort((a, b) => ringsArea(b.rings) - ringsArea(a.rings))
  for (const region of empty) {
    const anchor = region.anchor
    const near = anchor ? nearestCells(lattice, anchor[0], anchor[1]) : []
    // Outside the sampled box is not dropped, it is simply not on screen yet.
    const candidates = clip ? near.filter((c) => insideBox(c, clip)) : near
    if (clip && near.length && !candidates.length) continue

    // A free point first, so a small region costs nobody a dot it did not have
    // to. Failing that, the nearest point whose owner can spare it: a neighbour
    // with one dot is as small as this region is, and taking its only dot would
    // move the problem rather than solve it.
    const cell =
      candidates.find((c) => !owner.has(`${c.row}:${c.col}`)) ??
      candidates.find((c) => (cells.get(owner.get(`${c.row}:${c.col}`)!)?.length ?? 0) > 1)
    if (!cell) {
      dropped.push(region.index)
      continue
    }

    const key = `${cell.row}:${cell.col}`
    const holder = owner.get(key)
    if (holder !== undefined) {
      const theirs = cells.get(holder)!
      theirs.splice(
        theirs.findIndex((c) => c.row === cell.row && c.col === cell.col),
        1,
      )
    }
    owner.set(key, region.index)
    cells.set(region.index, [cell])
  }

  return { cells, dropped }
}

/** Planar area of a set of rings, holes counted as area: only ever compared. */
function ringsArea(rings: readonly Ring[]): number {
  let total = 0
  for (const ring of rings) {
    let twice = 0
    const n = ring.length
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      twice += ring[j] * ring[i + 1] - ring[i] * ring[j + 1]
    }
    total += Math.abs(twice) / 2
  }
  return total
}

function insideBox(cell: PixelCell, [[x0, y0], [x1, y1]]: WorldBounds): boolean {
  return cell.x >= x0 && cell.x <= x1 && cell.y >= y0 && cell.y <= y1
}

/**
 * A GeoJSON geometry's rings in longitude and latitude, ready to scan.
 *
 * Planar in degrees, which is exact for the scan as long as no edge jumps the
 * antimeridian: geometry cut there (every pack this library ships, and Natural
 * Earth generally) needs nothing more. A ring that does jump it, which is how
 * Fiji or Chukotka arrive from sources that do not cut, is unwrapped into one
 * continuous run of longitudes past ±180, and the lattice's wrap folds the points
 * it finds back into range. Edges lying along a pole (Antarctica closes its ring
 * by running along -90° from 180 to -180) are not jumps and are left alone.
 */
export function geoRings(geometry: unknown): Ring[] {
  const g = geometry as { type?: string; coordinates?: unknown; geometries?: unknown[] } | null
  if (!g?.type) return []
  if (g.type === 'GeometryCollection') return (g.geometries ?? []).flatMap(geoRings)

  const polygons =
    g.type === 'Polygon'
      ? [g.coordinates as number[][][]]
      : g.type === 'MultiPolygon'
        ? (g.coordinates as number[][][][])
        : []

  const out: Ring[] = []
  for (const polygon of polygons) {
    for (const ring of polygon ?? []) {
      if (!Array.isArray(ring) || ring.length < 3) continue
      const flat: number[] = []
      let offset = 0
      let previous: number | null = null
      for (const point of ring) {
        const lat = point[1]
        let lon = point[0]
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
        if (previous !== null && Math.abs(lat) < 90) {
          const jump = lon + offset - previous
          if (jump > 180) offset -= 360
          else if (jump < -180) offset += 360
        }
        lon += offset
        previous = lon
        flat.push(lon, lat)
      }
      if (flat.length >= 6) out.push(flat)
    }
  }
  return out
}

/**
 * A geometry's rings after projection, in world units: exactly the outline the
 * renderer draws, clipped and resampled by the projection's own stream.
 *
 * Read off the stream rather than parsed out of an SVG path string, because the
 * stream is where the clipping happens: a region cut by the antimeridian or by a
 * globe's horizon arrives here as the pieces that are actually drawn.
 */
export function projectedRings(
  projection: { stream: (sink: unknown) => unknown },
  geometry: unknown,
  geoStream: (object: never, stream: never) => void,
): Ring[] {
  const rings: Ring[] = []
  let current: Ring | null = null
  let inPolygon = false
  const sink = {
    point(x: number, y: number) {
      if (current && Number.isFinite(x) && Number.isFinite(y)) current.push(x, y)
    },
    lineStart() {
      current = inPolygon ? [] : null
    },
    lineEnd() {
      if (current && current.length >= 6) rings.push(current)
      current = null
    },
    polygonStart() {
      inPolygon = true
    },
    polygonEnd() {
      inPolygon = false
    },
    sphere() {},
  }
  geoStream(geometry as never, projection.stream(sink) as never)
  return rings
}

/** Longitude folded into (-180, 180]. */
export function wrapLongitude(lon: number): number {
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180
  return wrapped === -180 ? 180 : wrapped
}

/**
 * A readable default spacing in degrees: about `columns` dots across the
 * longitude span, rounded to a step a reader would have chosen by hand.
 */
export function niceDegrees(span: number, columns = 120): number {
  const raw = Math.max(1e-6, span) / columns
  const steps = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 10]
  let best = steps[0]
  for (const step of steps) {
    if (Math.abs(Math.log(step / raw)) < Math.abs(Math.log(best / raw))) best = step
  }
  return best
}

/**
 * The longitude span of a set of regions, in degrees, taking the shorter way
 * round: a map of the Pacific spans the antimeridian and should measure as the
 * ocean it shows rather than as the rest of the world.
 */
export function lonSpan(bounds: [LonLat, LonLat]): number {
  const [[west], [east]] = bounds
  if (!Number.isFinite(west) || !Number.isFinite(east)) return 360
  const span = east >= west ? east - west : east + 360 - west
  return span <= 0 ? 360 : span
}

/**
 * Path data for one dot, centred on `(x, y)`, as an absolute move followed by
 * relative drawing commands.
 *
 * Every dot in a region goes into the same `d`, so the region is still one
 * element on the page: one hover target, one focus stop, one fill to tween. The
 * shape is described relative to its own first vertex so the tail of the string
 * is identical for every dot of the same size, and `dotTail` builds it once.
 */
export function dotPath(x: number, y: number, tail: DotTail, precision: number): string {
  return `M${round(x + tail.dx, precision)},${round(y + tail.dy, precision)}${tail.d}`
}

export interface DotTail {
  /** Offset from the centre to the first vertex. */
  dx: number
  dy: number
  d: string
}

/** The part of a dot's path that does not depend on where it is. */
export function dotTail(shape: PixelShape, half: number, precision: number): DotTail {
  const h = round(half, precision)
  const s = round(half * 2, precision)
  switch (shape) {
    case 'square':
      return { dx: -half, dy: -half, d: `h${s}v${s}h${-s}z` }
    case 'diamond':
      return { dx: 0, dy: -half, d: `l${h},${h}l${-h},${h}l${-h},${-h}z` }
    case 'hexagon': {
      // Pointy-topped, `half` from the centre to a flat side, which is the
      // orientation and the size that tile on a staggered lattice at 100%.
      const r = half / SQRT3_2
      const rh = round(r / 2, precision)
      const rf = round(r, precision)
      return {
        dx: 0,
        dy: -r,
        d: `l${h},${rh}v${rf}l${-h},${rh}l${-h},${-rh}v${-rf}z`,
      }
    }
    case 'circle':
    default:
      return { dx: -half, dy: 0, d: `a${h},${h} 0 1,0 ${s},0a${h},${h} 0 1,0 ${-s},0z` }
  }
}

function round(value: number, precision: number): number {
  const f = 10 ** precision
  // Adding zero, so -0 never reaches a path string as "-0".
  return Math.round(value * f) / f + 0
}
