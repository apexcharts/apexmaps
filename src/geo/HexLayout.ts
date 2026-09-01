/**
 * Grid layouts: one equal cell per region, at a hand-authored position.
 *
 * A hex tile map (honeycomb, tilegram) is a cartogram, not geography. Every
 * region becomes one identical hexagon, so the smallest unit is as legible as
 * the largest and land area stops deciding how loud a value looks. That is the
 * whole point: on a choropleth of the United States, Rhode Island is invisible
 * and Montana shouts, and neither fact is in the data.
 *
 * Three decisions, each of which shows up on screen if you get it wrong.
 *
 * **1. A layout is a table, not baked polygons.** `{ "AL": [6, 5] }` is two
 * integers; the hexagon it becomes is fourteen floats. Keeping the table as the
 * distributed form makes the US layout 2.4 kB against 111 kB of real boundary,
 * and that ratio is the reason the layout has to resolve on its own: a
 * honeycomb that first downloads boundaries it never draws is slower than the
 * choropleth it replaced. It also keeps orientation, offset and spacing legible
 * and arguable in the file, instead of frozen into coordinates nobody can read.
 *
 * **2. The offset convention is declared, never assumed.** Reading an `odd-r`
 * table as `even-r` shifts half the rows by half a cell, and the result still
 * looks like a plausible honeycomb, so nothing catches it. Only two
 * combinations are coherent: pointy-top hexagons offset by row, flat-top
 * hexagons offset by column. A pack asking for anything else is rejected rather
 * than quietly reinterpreted.
 *
 * **3. Vertical pitch is 1.5 radii, not 2.** Pointy-top hexagons are 2 radii
 * tall but tessellate by overlapping a quarter of that height, so rows sit 1.5
 * apart. Using the full height leaves a lattice of gaps that reads as missing
 * data. Flat-top hexagons have the same relationship on the horizontal axis.
 *
 * The generated coordinates are a flat plane, not longitude and latitude, so a
 * layout is drawn with the `identity` projection. Nothing else in the engine
 * knows or cares: the features carry the same join key the boundary pack
 * carries, so joins, scales, legend, tooltip, labels, selection and
 * accessibility are the machinery that already exists.
 *
 * @module geo/HexLayout
 */

import type { Feature, FeatureCollection, Polygon } from 'geojson'

export type LayoutGrid = 'hex' | 'square'
export type LayoutOrientation = 'pointy' | 'flat'
export type LayoutOffset = 'odd-r' | 'even-r' | 'odd-q' | 'even-q'

/** `[col, row]`, with row 0 north and col 0 west. */
export type LayoutCell = readonly [number, number]

export interface LayoutPack {
  id?: string
  kind?: 'layout'
  /** Canonical id of the boundary pack whose keys these cells use. */
  of?: string
  /** Default `'hex'`. */
  grid?: LayoutGrid
  /** Default `'pointy'`. */
  orientation?: LayoutOrientation
  /** Default `'odd-r'` for pointy, `'odd-q'` for flat. */
  offset?: LayoutOffset
  /** Geometry field the cells are keyed by. Must match the boundary pack's. */
  keyField: string
  /** Where {@link LayoutPack.names} is written. Default `'name'`. */
  nameField?: string
  levelName?: string
  cells: Record<string, LayoutCell | number[]>
  /**
   * Space between cells, as a fraction of the cell. Default 0.06, which reads
   * as a tiled surface. Zero makes the cells share edges, which looks like one
   * shape rather than a set of units.
   *
   * A property of the layout rather than a render option, and deliberately so:
   * the generated geometry is cached per file, so a gap chosen at render time
   * would either be ignored by the second map on the page or force a second
   * copy of the geometry. Density is the pack author's decision, it travels
   * with the table, and it stays serialisable.
   */
  gap?: number
  /**
   * Region names, so a layout used on its own still has something to put in a
   * tooltip. Without the boundary pack there is no other source for them.
   */
  names?: Record<string, string>
  /**
   * Keys in the boundary pack that this layout deliberately leaves out, so a
   * missing cell can be reported as a decision rather than an omission.
   */
  unplaced?: string[]
  /** Known departures from real geography, for the record. */
  compromises?: string[]
  source?: string
  license?: string
  attribution?: string
  vintage?: string
  boundaries?: string
}

export interface LayoutOptions {
  /**
   * Override {@link LayoutPack.gap} for one call. Only useful when calling the
   * generator directly; through the registry the pack's own value is used, so
   * that two maps sharing a layout cannot disagree about it.
   */
  gap?: number
}

/** Unit-radius corner offsets, and the distance between cell centres. */
interface Lattice {
  corners: ReadonlyArray<readonly [number, number]>
  pitchX: number
  pitchY: number
  /** Extra x per cell, by row parity. */
  shiftX: (row: number) => number
  /** Extra y per cell, by column parity. */
  shiftY: (col: number) => number
}

const SQRT3 = Math.sqrt(3)

function corners(count: number, startDegrees: number): Array<readonly [number, number]> {
  return Array.from({ length: count }, (_, i) => {
    const angle = ((startDegrees + (360 / count) * i) * Math.PI) / 180
    return [Math.cos(angle), Math.sin(angle)] as const
  })
}

function lattice(pack: LayoutPack): Lattice {
  const grid = pack.grid ?? 'hex'

  if (grid === 'square') {
    return {
      // Half-side 1, so a square cell is the same 2 radii across as a hexagon
      // is tall and the two grids can be swapped without resizing the figure.
      corners: [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ],
      pitchX: 2,
      pitchY: 2,
      shiftX: () => 0,
      shiftY: () => 0,
    }
  }

  const orientation = pack.orientation ?? 'pointy'
  const offset = pack.offset ?? (orientation === 'pointy' ? 'odd-r' : 'odd-q')

  if (orientation === 'pointy') {
    if (offset !== 'odd-r' && offset !== 'even-r') {
      throw new TypeError(
        `ApexMaps: layout offset "${offset}" cannot be used with pointy-top hexagons. ` +
          'Pointy-top rows are offset horizontally, so use "odd-r" or "even-r"; ' +
          '"odd-q" and "even-q" belong to flat-top hexagons.',
      )
    }
    const shifted = offset === 'odd-r' ? 1 : 0
    return {
      corners: corners(6, -90),
      pitchX: SQRT3,
      // Not 2. Rows overlap by a quarter of the hexagon's height.
      pitchY: 1.5,
      shiftX: (row) => (Math.abs(row % 2) === shifted ? SQRT3 / 2 : 0),
      shiftY: () => 0,
    }
  }

  if (orientation === 'flat') {
    if (offset !== 'odd-q' && offset !== 'even-q') {
      throw new TypeError(
        `ApexMaps: layout offset "${offset}" cannot be used with flat-top hexagons. ` +
          'Flat-top columns are offset vertically, so use "odd-q" or "even-q"; ' +
          '"odd-r" and "even-r" belong to pointy-top hexagons.',
      )
    }
    const shifted = offset === 'odd-q' ? 1 : 0
    return {
      corners: corners(6, 0),
      pitchX: 1.5,
      pitchY: SQRT3,
      shiftX: () => 0,
      shiftY: (col) => (Math.abs(col % 2) === shifted ? SQRT3 / 2 : 0),
    }
  }

  throw new TypeError(
    `ApexMaps: unknown layout orientation "${orientation}". Use "pointy" or "flat".`,
  )
}

/**
 * Signed area under the y-up convention, which is the one `d3-geo` reads even
 * though these coordinates are drawn with y growing downward.
 */
function signedArea(ring: Array<[number, number]>): number {
  let sum = 0
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
  }
  return sum / 2
}

/**
 * Turn a layout table into geometry.
 *
 * @throws if the pack is malformed: an unparseable cell, two regions on one
 *   cell, or an offset convention that contradicts the orientation. All three
 *   produce a map that renders and is wrong, which is worse than a throw.
 */
export function layoutToGeoJSON(
  pack: LayoutPack,
  options: LayoutOptions = {},
): FeatureCollection<Polygon> {
  if (!pack || typeof pack !== 'object') {
    throw new TypeError('ApexMaps: a layout pack must be an object')
  }
  if (!pack.keyField) {
    throw new TypeError(
      'ApexMaps: a layout pack needs a keyField naming the geometry field its cells are keyed by, ' +
        'so a join written against the boundary pack keeps working against the layout.',
    )
  }
  const entries = Object.entries(pack.cells ?? {})
  if (!entries.length) {
    throw new TypeError(`ApexMaps: layout "${pack.id ?? '(unnamed)'}" has no cells`)
  }

  const { corners: shape, pitchX, pitchY, shiftX, shiftY } = lattice(pack)
  const gap = options.gap ?? pack.gap ?? 0.06
  const radius = 1 - Math.min(Math.max(gap, 0), 0.9)
  const nameField = pack.nameField ?? 'name'

  const taken = new Map<string, string>()
  const features: Array<Feature<Polygon>> = []

  entries.forEach(([key, cell], index) => {
    if (!Array.isArray(cell) || cell.length < 2) {
      throw new TypeError(
        `ApexMaps: layout cell for "${key}" must be [col, row], received ${JSON.stringify(cell)}`,
      )
    }
    const [col, row] = cell
    if (!Number.isFinite(col) || !Number.isFinite(row)) {
      throw new TypeError(
        `ApexMaps: layout cell for "${key}" must be two finite numbers, received ${JSON.stringify(cell)}`,
      )
    }

    const slot = `${col},${row}`
    const occupant = taken.get(slot)
    if (occupant) {
      throw new TypeError(
        `ApexMaps: layout cell [${slot}] is claimed by both "${occupant}" and "${key}". ` +
          'Two regions on one cell means one of them is invisible.',
      )
    }
    taken.set(slot, key)

    const cx = col * pitchX + shiftX(row)
    // Not negated. These coordinates reach SVG through the identity projection,
    // where y grows downward, so row 0 being north means row 0 has the smallest
    // y. Negating it renders the country upside down while still looking like a
    // plausible honeycomb, which is why this comment exists.
    const cy = row * pitchY + shiftY(col)

    const ring: Array<[number, number]> = [...shape, shape[0]].map(([ux, uy]) => [
      cx + ux * radius,
      cy + uy * radius,
    ])
    // Measured rather than reasoned about. Whether a given corner order comes
    // out clockwise depends on the start angle and on which axis grows which
    // way, and getting it backwards renders each cell as the whole plane minus
    // the cell. Ingest would repair it and say so; better not to need repairing.
    if (signedArea(ring) > 0) ring.reverse()

    features.push({
      type: 'Feature',
      id: index,
      properties: {
        [pack.keyField]: key,
        [nameField]: pack.names?.[key] ?? key,
        col,
        row,
      },
      geometry: { type: 'Polygon', coordinates: [ring] },
    })
  })

  return { type: 'FeatureCollection', features }
}

/**
 * Provenance and rendering recommendations a layout carries about itself.
 *
 * These are not preferences a caller should have to discover. A layout is a
 * diagram: it must not be projected, there is no detail to zoom into, and its
 * cells are sized for a key rather than a name. Every one of those was set by
 * hand while prototyping, which is the evidence that they belong to the pack.
 */
export function layoutMeta(pack: LayoutPack): Record<string, unknown> {
  return {
    source: pack.source,
    license: pack.license,
    attribution: pack.attribution,
    vintage: pack.vintage,
    boundaries: pack.boundaries,
    keyField: pack.keyField,
    nameField: pack.nameField ?? 'name',
    levelName: pack.levelName,
    // The coordinates are a grid, so projecting them would be meaningless.
    projection: 'identity',
    // "Rhode Island" does not fit a cell sized for Rhode Island. Every
    // published hex map labels by key, which is also why the key is chosen to
    // be the postal abbreviation.
    labelField: pack.keyField,
    // A cartogram has no geography to explore: nothing sharpens on zoom and
    // there is nothing off-screen to pan to.
    fixed: true,
    layout: {
      grid: pack.grid ?? 'hex',
      orientation: pack.orientation ?? 'pointy',
      offset: pack.offset ?? ((pack.grid ?? 'hex') === 'hex' ? 'odd-r' : undefined),
      cells: Object.keys(pack.cells ?? {}).length,
      unplaced: pack.unplaced,
      compromises: pack.compromises,
      of: pack.of,
    },
  }
}
