import { describe, it, expect } from 'vitest'
import { normalizeGeo, indexByKey } from '../src/geo/GeoData'
import {
  createProjection,
  listProjections,
  hasProjection,
  isComposite,
  isGlobal,
} from '../src/geo/Projections'
import { Viewport } from '../src/geo/Viewport'
import { geoArea } from 'd3-geo'
import { interpolateZoom } from '../src/geo/Camera'

/**
 * A 20-degree square around the origin with a **counterclockwise** exterior ring.
 *
 * That is what RFC 7946 asks for and what most published GeoJSON contains, and it
 * is exactly what d3-geo cannot consume: it reads the ring as the whole sphere
 * minus the square. So this is the fixture that needs repairing.
 */
const CCW_SQUARE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { iso_a3: 'AAA', name: 'Alpha' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-10, -10],
            [10, -10],
            [10, 10],
            [-10, 10],
            [-10, -10],
          ],
        ],
      },
    },
  ],
}

/**
 * Shoelace signed area. Negative is clockwise in lon/lat order.
 *
 */
function shoelace(ring) {
  let sum = 0
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[i][1] + ring[j][1])
  }
  return sum / 2
}

describe('normalizeGeo', () => {
  it('accepts a FeatureCollection and resolves a join key', () => {
    const geo = normalizeGeo(CCW_SQUARE)
    expect(geo.features).toHaveLength(1)
    expect(geo.keyField).toBe('iso_a3')
    expect(geo.features[0].key).toBe('AAA')
    expect(geo.features[0].name).toBe('Alpha')
    expect(geo.source).toBe('geojson')
  })

  it('repairs reversed exterior winding by default and reports it', () => {
    const geo = normalizeGeo(structuredClone(CCW_SQUARE))
    expect(geo.warnings.join(' ')).toContain('repaired winding')

    const ring = geo.features[0].geometry.coordinates[0]
    // Shoelace area must now be negative, i.e. the exterior ring is clockwise,
    // which is the convention d3-geo requires (NOT RFC 7946's).
    expect(shoelace(ring)).toBeLessThan(0)

    // And the authoritative check: the polygon must measure as the small region
    // it is, not as the whole sphere minus itself.
    expect(geoArea({ type: 'Feature', geometry: geo.features[0].geometry })).toBeLessThan(Math.PI)
  })

  it('leaves already-clockwise geometry untouched and shares its arrays', () => {
    const clockwise = structuredClone(CCW_SQUARE)
    clockwise.features[0].geometry.coordinates[0].reverse()
    const original = clockwise.features[0].geometry.coordinates[0]

    const geo = normalizeGeo(clockwise)
    expect(geo.warnings.join(' ')).not.toContain('repaired winding')
    // Copy-on-write: nothing needed fixing, so nothing was cloned.
    expect(geo.features[0].geometry.coordinates[0]).toBe(original)
  })

  it('is idempotent: repairing repaired geometry changes nothing', () => {
    const once = normalizeGeo(structuredClone(CCW_SQUARE))
    const twice = normalizeGeo({
      type: 'Feature',
      properties: {},
      geometry: once.features[0].geometry,
    })
    expect(twice.warnings.join(' ')).not.toContain('repaired winding')
  })

  it('preserves holes under either input convention', () => {
    /**
     */
    const close = (pts) => pts.concat([pts[0]])
    const ccwOuter = close([
      [-10, -10],
      [10, -10],
      [10, 10],
      [-10, 10],
    ])
    const cwOuter = close([
      [-10, -10],
      [-10, 10],
      [10, 10],
      [10, -10],
    ])
    const ccwHole = close([
      [-3, -3],
      [3, -3],
      [3, 3],
      [-3, 3],
    ])
    const cwHole = close([
      [-3, -3],
      [-3, 3],
      [3, 3],
      [3, -3],
    ])

    // An RFC 7946 donut and a d3-convention donut must converge on the same
    // geometry, with the hole still subtracting rather than adding area.
    for (const rings of [
      [ccwOuter, cwHole],
      [cwOuter, ccwHole],
    ]) {
      const geo = normalizeGeo({ type: 'Polygon', coordinates: rings })
      const geometry = geo.features[0].geometry
      const outer = geoArea({
        type: 'Polygon',
        coordinates: [geometry.coordinates[0]],
      })
      const whole = geoArea({ type: 'Feature', geometry })
      expect(whole).toBeGreaterThan(0)
      expect(whole).toBeLessThan(outer)
    }
  })

  it("never mutates the caller's coordinates", () => {
    const input = structuredClone(CCW_SQUARE)
    const before = JSON.stringify(input)
    normalizeGeo(input)
    // Geometry is routinely shared between maps or frozen in a module, so
    // repairing one map's winding must not change the caller's object.
    expect(JSON.stringify(input)).toBe(before)
  })

  it('leaves winding alone when repair is disabled', () => {
    const geo = normalizeGeo(structuredClone(CCW_SQUARE), {
      repairWinding: false,
    })
    expect(geo.warnings.join(' ')).not.toContain('repaired winding')
  })

  it('accepts a bare Feature, a bare geometry and an array', () => {
    expect(normalizeGeo(CCW_SQUARE.features[0]).features).toHaveLength(1)
    expect(normalizeGeo(CCW_SQUARE.features[0].geometry).features).toHaveLength(1)
    expect(normalizeGeo(CCW_SQUARE.features).features).toHaveLength(1)
  })

  it('honours an explicit keyField', () => {
    const geo = normalizeGeo(CCW_SQUARE, { keyField: 'name' })
    expect(geo.features[0].key).toBe('Alpha')
  })

  it('warns about duplicate join keys', () => {
    const dupe = structuredClone(CCW_SQUARE)
    dupe.features.push(structuredClone(CCW_SQUARE.features[0]))
    const geo = normalizeGeo(dupe)
    expect(geo.warnings.join(' ')).toContain('duplicate join keys')
  })

  it('converts TopoJSON and picks the conventional object', () => {
    const topology = {
      type: 'Topology',
      objects: {
        land: { type: 'GeometryCollection', geometries: [] },
        countries: {
          type: 'GeometryCollection',
          geometries: [
            {
              type: 'Polygon',
              arcs: [[0]],
              properties: { iso_a3: 'BBB', name: 'Beta' },
            },
          ],
        },
      },
      arcs: [
        [
          [0, 0],
          [1000, 0],
          [0, 1000],
          [-1000, 0],
          [0, -1000],
        ],
      ],
      transform: { scale: [0.001, 0.001], translate: [0, 0] },
    }

    const geo = normalizeGeo(topology)
    expect(geo.source).toBe('topojson')
    expect(geo.objectName).toBe('countries')
    expect(geo.features[0].key).toBe('BBB')
  })

  it('throws a helpful error for a missing TopoJSON object', () => {
    const topology = {
      type: 'Topology',
      objects: { land: { type: 'GeometryCollection', geometries: [] } },
      arcs: [],
    }
    expect(() => normalizeGeo(topology, { object: 'countries' })).toThrow(/not found/)
  })

  it('rejects unusable input', () => {
    expect(() => normalizeGeo(null)).toThrow()
    expect(() => normalizeGeo('nope')).toThrow()
  })

  it('indexes features by key', () => {
    const geo = normalizeGeo(CCW_SQUARE)
    expect(indexByKey(geo.features).get('AAA')?.name).toBe('Alpha')
  })
})

describe('Projections', () => {
  it('ships the core set including an equal-area world default', () => {
    const names = listProjections()
    for (const expected of [
      'equalEarth',
      'mercator',
      'albersUsa',
      'orthographic',
      'conicConformal',
    ]) {
      expect(names).toContain(expected)
    }
    expect(hasProjection('equalEarth')).toBe(true)
  })

  it('aliases the names developers actually type', () => {
    expect(hasProjection('webMercator')).toBe(true)
    expect(hasProjection('epsg:3857')).toBe(true)
    expect(hasProjection('epsg:4326')).toBe(true)
  })

  it('throws on an unknown projection rather than falling back silently', () => {
    expect(() => createProjection('winkel3')).toThrow(/unknown projection/)
  })

  it('applies rotate and parallels from a spec', () => {
    const p = createProjection({
      name: 'conicEqualArea',
      parallels: [29.5, 45.5],
      rotate: [96, 0],
    })
    // d3-geo stores angles in radians, so reading them back is lossy at the last
    // bit. Comparing approximately is correct here, not a workaround.
    expect(p.parallels()[0]).toBeCloseTo(29.5, 9)
    expect(p.parallels()[1]).toBeCloseTo(45.5, 9)
    expect(p.rotate()[0]).toBeCloseTo(96, 9)
  })

  it('refuses to re-centre a composite projection', () => {
    // geoAlbersUsa translates Alaska and Hawaii internally; rotating it breaks
    // the composite layout, so the spec fields must be ignored.
    expect(isComposite('albersUsa')).toBe(true)
    const p = createProjection({ name: 'albersUsa', rotate: [90, 0] })
    expect(typeof p.rotate).toBe('undefined')
  })

  it('knows which projections cover the whole sphere', () => {
    expect(isGlobal('equalEarth')).toBe(true)
    expect(isGlobal('orthographic')).toBe(false)
    expect(isGlobal('albersUsa')).toBe(false)
  })
})

describe('Viewport transform chain', () => {
  /** The repaired collection, which is what ApexMaps always fits against. */
  const SQUARE = normalizeGeo(structuredClone(CCW_SQUARE)).collection

  /** @returns {Viewport} */
  function setup() {
    const vp = new Viewport({ width: 400, height: 300 })
    vp.setProjection('equirectangular')
    vp.fit(SQUARE, 0)
    return vp
  }

  it('reads unrepaired counterclockwise geometry as the whole sphere', () => {
    // The silent failure winding repair exists to prevent, pinned so a future
    // change cannot quietly reintroduce it. Unrepaired, a 20-degree square
    // measures as the entire globe: a 2:1 box filling the container's full width.
    // Every feature would then share one centroid, breaking label anchors,
    // tooltip positions and camera framing, with nothing thrown.
    const bad = new Viewport({ width: 400, height: 300 })
    bad.setProjection('equirectangular')
    bad.fit(CCW_SQUARE, 0)
    const badBounds = bad.measure(CCW_SQUARE as any)
    expect(badBounds[0][0]).toBeCloseTo(0, 0)
    expect(badBounds[1][0]).toBeCloseTo(400, 0)
    expect(badBounds[1][1] - badBounds[0][1]).toBeCloseTo(200, 0)

    // Repaired, it measures as the square it is, and the fit lands entirely
    // inside the container. Height is the limiting dimension rather than width,
    // because d3-geo resamples edges along great circles: an edge between two
    // points at the same latitude bows poleward, so the rendered shape is a few
    // pixels taller than a naive lon/lat box would be.
    const good = setup()
    const goodBounds = good.measure(SQUARE as any)
    expect(goodBounds[0][0]).toBeGreaterThanOrEqual(-0.01)
    expect(goodBounds[0][1]).toBeGreaterThanOrEqual(-0.01)
    expect(goodBounds[1][0]).toBeLessThanOrEqual(400.01)
    expect(goodBounds[1][1]).toBeLessThanOrEqual(300.01)
    expect(goodBounds[1][1] - goodBounds[0][1]).toBeCloseTo(300, 0)
    expect(goodBounds[1][0] - goodBounds[0][0]).toBeGreaterThan(290)
  })

  it('gives each feature its own centroid once winding is repaired', () => {
    const three = {
      type: 'FeatureCollection',
      features: [-30, -10, 10].map((lon, i) => ({
        type: 'Feature',
        properties: { iso_a3: `F${i}` },
        geometry: {
          type: 'Polygon',
          // Counterclockwise, as published GeoJSON usually is.
          coordinates: [
            [
              [lon, 0],
              [lon + 8, 0],
              [lon + 8, 8],
              [lon, 8],
              [lon, 0],
            ],
          ],
        },
      })),
    }

    const geo = normalizeGeo(three)
    const vp = new Viewport({ width: 400, height: 300 })
    vp.setProjection('equirectangular')
    vp.fit(geo.collection, 0)

    const xs = geo.features.map((f) => vp.path.centroid(f.geometry as any)[0])
    expect(new Set(xs.map((x) => Math.round(x))).size).toBe(3)
    expect(xs[0]).toBeLessThan(xs[1])
    expect(xs[1]).toBeLessThan(xs[2])
  })

  it('projects lon/lat into world space and back', () => {
    const vp = setup()
    const world = vp.project([0, 0])
    expect(world).not.toBeNull()
    const backToLonLat = vp.screenToLonLat(vp.worldToScreen(world as any))
    expect(backToLonLat?.[0]).toBeCloseTo(0, 6)
    expect(backToLonLat?.[1]).toBeCloseTo(0, 6)
  })

  it('round-trips world and screen space under a camera transform', () => {
    const vp = setup()
    vp.camera = { k: 2.5, x: -40, y: 17 }
    const world = [123, 45] as [number, number]
    const [wx, wy] = vp.screenToWorld(vp.worldToScreen(world))
    expect(wx).toBeCloseTo(123, 9)
    expect(wy).toBeCloseTo(45, 9)
  })

  it('does not reproject when the camera changes', () => {
    const vp = setup()
    const before = vp.pathFor({ geometry: SQUARE.features[0].geometry } as any)
    vp.camera = { k: 8, x: 100, y: 200 }
    const after = vp.pathFor({ geometry: SQUARE.features[0].geometry } as any)
    // Identical path data: the camera is an affine transform applied downstream,
    // which is what makes pan and zoom cheap.
    expect(after).toBe(before)
  })

  it('fits content into the container with padding', () => {
    const vp = setup()
    const bounds = vp.measure(SQUARE)
    expect(bounds).not.toBeNull()
    const [[x0, y0], [x1, y1]] = bounds as any
    expect(x0).toBeGreaterThanOrEqual(-0.01)
    expect(y0).toBeGreaterThanOrEqual(-0.01)
    expect(x1).toBeLessThanOrEqual(400.01)
    expect(y1).toBeLessThanOrEqual(300.01)
  })

  it('computes a padding-aware camera for a bounding box', () => {
    const vp = setup()
    const cam = vp.cameraForBounds(
      [
        [0, 0],
        [100, 100],
      ],
      { padding: { left: 200, right: 0, top: 0, bottom: 0 } },
    )
    // With 200px reserved on the left, the box must be centred in the remaining
    // 200px, i.e. around x = 300 on screen.
    const centreScreen = cam.x + 50 * cam.k
    expect(centreScreen).toBeCloseTo(300, 6)
  })

  it('centres on a geographic point', () => {
    const vp = setup()
    const cam = vp.cameraForCenter([5, 5], 3)
    expect(cam).not.toBeNull()
    vp.camera = cam as any
    const screen = vp.lonLatToScreen([5, 5])
    expect(screen?.[0]).toBeCloseTo(200, 6)
    expect(screen?.[1]).toBeCloseTo(150, 6)
  })
})

describe('interpolateZoom (Van Wijk)', () => {
  it('hits both endpoints exactly', () => {
    const i = interpolateZoom([0, 0, 100], [500, 300, 25])
    const start = i(0)
    const end = i(1)
    expect(start[0]).toBeCloseTo(0, 6)
    expect(start[2]).toBeCloseTo(100, 6)
    expect(end[0]).toBeCloseTo(500, 6)
    expect(end[1]).toBeCloseTo(300, 6)
    expect(end[2]).toBeCloseTo(25, 6)
  })

  it('arcs out to a wider view mid-flight on a long move', () => {
    const i = interpolateZoom([0, 0, 100], [5000, 0, 100])
    // The defining property: the midpoint zooms out rather than sliding across at
    // a constant scale, which is what makes a long camera move readable.
    expect(i(0.5)[2]).toBeGreaterThan(100)
  })

  it('derives a longer duration for a longer path', () => {
    const shortMove = interpolateZoom([0, 0, 100], [50, 0, 100])
    const longMove = interpolateZoom([0, 0, 100], [5000, 0, 100])
    expect(longMove.duration).toBeGreaterThan(shortMove.duration)
  })

  it('handles a pure zoom with no pan', () => {
    const i = interpolateZoom([10, 10, 200], [10, 10, 50])
    expect(i(0)[2]).toBeCloseTo(200, 6)
    expect(i(1)[2]).toBeCloseTo(50, 6)
  })

  it('is monotonic in position along a straight move', () => {
    const i = interpolateZoom([0, 0, 100], [1000, 0, 100])
    let last = -Infinity
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const x = i(Math.min(1, t))[0]
      expect(x).toBeGreaterThanOrEqual(last - 1e-9)
      last = x
    }
  })
})
