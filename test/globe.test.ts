// @vitest-environment jsdom
/**
 * Globe rotation.
 *
 * The bug this exists to prevent: a drag on an orthographic panning the sphere
 * around inside its box instead of turning it, which leaves the far hemisphere
 * unreachable and reads as a broken globe rather than a design decision.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import ApexMaps from '../src/ApexMaps'

/** Boxes spread right around the equator, so half are always hidden. */
const AROUND_THE_WORLD = {
  type: 'FeatureCollection',
  features: [
    box('AAA', 'Alpha', 0),
    box('BBB', 'Beta', 90),
    box('CCC', 'Gamma', 180),
    box('DDD', 'Delta', -90),
  ],
}

function box(key, name, lon) {
  return {
    type: 'Feature',
    properties: { iso_a3: key, name },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [lon - 8, -8],
          [lon + 8, -8],
          [lon + 8, 8],
          [lon - 8, 8],
          [lon - 8, -8],
        ],
      ],
    },
  }
}

let el
let map

beforeEach(() => {
  el = document.createElement('div')
  document.body.appendChild(el)
  vi.stubGlobal('requestAnimationFrame', ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame)
  vi.stubGlobal('cancelAnimationFrame', ((id: number) =>
    clearTimeout(id)) as unknown as typeof cancelAnimationFrame)
})

afterEach(() => {
  map?.destroy?.()
  map = null
  el.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

async function renderGlobe(options = {}) {
  map = new ApexMaps(el, {
    chart: { width: 400, height: 400 },
    geo: { map: AROUND_THE_WORLD, projection: 'orthographic', view: { fit: 'world' } },
    debug: { enabled: false },
    // Momentum off by default here: a glide outliving the assertion would make
    // every rotation number in this file a race.
    interaction: { rotate: { inertia: false } },
    ...options,
  })
  await map.render()
  return map
}

/**
 * jsdom reports a zero-origin bounding box for every element, so client
 * coordinates are already plot coordinates.
 */
function drag(instance, from, to, steps = 2) {
  instance.plot.dispatchEvent(
    new window.PointerEvent('pointerdown', {
      bubbles: true,
      pointerId: 1,
      button: 0,
      clientX: from[0],
      clientY: from[1],
    }),
  )
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    window.dispatchEvent(
      new window.PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 1,
        clientX: from[0] + (to[0] - from[0]) * t,
        clientY: from[1] + (to[1] - from[1]) * t,
      }),
    )
  }
  window.dispatchEvent(
    new window.PointerEvent('pointerup', {
      bubbles: true,
      pointerId: 1,
      clientX: to[0],
      clientY: to[1],
    }),
  )
}

/** Let the rAF-coalesced redraw run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const keysOnScreen = () =>
  [...el.querySelectorAll('path.apexmaps-feature')].map((p) => p.getAttribute('data-key'))

describe('globe rotation', () => {
  it('turns the sphere on drag instead of panning it', async () => {
    await renderGlobe()
    const camera = { ...map.viewport.camera }

    drag(map, [200, 200], [280, 200])

    // The whole point: the projection turned, and the camera did not move.
    expect(map.rotation[0]).toBeGreaterThan(10)
    expect(map.viewport.camera).toEqual(camera)
  })

  it('keeps the point under the cursor, at any latitude', async () => {
    await renderGlobe()

    for (const [grab, drop] of [
      [
        [200, 200],
        [250, 230],
      ],
      // High on the disc, where accumulating Euler angles would whip the sphere
      // around: a degree of longitude near the pole is worth almost no surface.
      [
        [200, 130],
        [255, 150],
      ],
    ]) {
      const lonLat = map.viewport.screenToLonLat(grab)
      expect(lonLat).not.toBeNull()

      drag(map, grab, drop, 4)

      const landed = map.viewport.lonLatToScreen(lonLat)
      expect(landed[0]).toBeCloseTo(drop[0], 0)
      expect(landed[1]).toBeCloseTo(drop[1], 0)
    }
  })

  it('stays exact when the globe is zoomed in', async () => {
    await renderGlobe()
    // Zoom is still the camera's job on a globe, so a drag afterwards has to
    // read the pointer through the camera transform to find what it grabbed.
    map.camera.jumpTo({ k: 2.5 })
    const grab = [210, 190]
    const drop = [240, 215]
    const lonLat = map.viewport.screenToLonLat(grab)
    expect(lonLat).not.toBeNull()

    drag(map, grab, drop, 4)

    const landed = map.viewport.lonLatToScreen(lonLat)
    expect(landed[0]).toBeCloseTo(drop[0], 0)
    expect(landed[1]).toBeCloseTo(drop[1], 0)
  })

  it('spins right through 360 degrees rather than stopping at the antimeridian', async () => {
    await renderGlobe()

    let turned = 0
    let previous = map.rotation[0]
    // Ten drags across the disc, each worth roughly a quarter turn.
    for (let i = 0; i < 10; i++) {
      drag(map, [140, 200], [260, 200], 4)
      const next = map.rotation[0]
      turned += ((((next - previous) % 360) + 540) % 360) - 180
      previous = next
    }

    expect(turned).toBeGreaterThan(360)
    // Wrapped rather than accumulated, so a long spin cannot drift off into
    // thousands of degrees.
    expect(Math.abs(map.rotation[0])).toBeLessThanOrEqual(180)
  })

  it('redraws the geometry, so the far hemisphere comes into view', async () => {
    await renderGlobe()
    await flush()
    // Facing 0 degrees longitude: the box at 180 is behind the globe.
    expect(keysOnScreen()).toContain('AAA')
    expect(keysOnScreen()).not.toContain('CCC')

    map.rotateTo([180, 0, 0])
    await flush()

    expect(keysOnScreen()).toContain('CCC')
    expect(keysOnScreen()).not.toContain('AAA')
  })

  it('moves the label anchors and the arcs with the sphere', async () => {
    await renderGlobe({
      series: [
        { name: 'Score', joinBy: ['iso_a3', 'code'], data: [{ code: 'AAA', value: 1 }] },
        { type: 'arc', name: 'Route', data: [{ from: [0, 0], to: [80, 10], value: 1 }] },
      ],
    })
    await flush()
    const anchor = map.anchors.get(0).world
    const arc = map.series[1].paths()[0].d

    map.rotateTo([60, 0, 0])
    await flush()

    expect(map.anchors.get(0).world[0]).not.toBeCloseTo(anchor[0], 1)
    expect(map.series[1].paths()[0].d).not.toEqual(arc)
  })

  it('leaves flat projections panning', async () => {
    await renderGlobe({ geo: { map: AROUND_THE_WORLD, projection: 'equirectangular' } })
    const before = { ...map.viewport.camera }

    drag(map, [200, 200], [240, 200])

    expect(map.viewport.camera.x).toBeCloseTo(before.x + 40, 5)
    expect(map.rotation).toEqual([0, 0, 0])
  })

  it('gives the drag back to panning when rotation is turned off', async () => {
    await renderGlobe({ interaction: { rotate: { enabled: false } } })
    const before = { ...map.viewport.camera }

    drag(map, [200, 200], [240, 200])

    expect(map.viewport.camera.x).toBeCloseTo(before.x + 40, 5)
    expect(map.rotation).toEqual([0, 0, 0])
  })

  it('rotates a non-globe projection when the caller asks for it', async () => {
    await renderGlobe({
      geo: { map: AROUND_THE_WORLD, projection: 'stereographic', view: { fit: 'world' } },
      interaction: { rotate: { enabled: true, inertia: false } },
    })
    const before = { ...map.viewport.camera }

    drag(map, [200, 200], [240, 200])

    expect(map.rotation[0]).not.toBe(0)
    expect(map.viewport.camera).toEqual(before)
  })

  it('respects pan.enabled: false rather than substituting a different drag', async () => {
    await renderGlobe({ interaction: { pan: { enabled: false } } })
    const before = { ...map.viewport.camera }

    drag(map, [200, 200], [240, 200])

    expect(map.rotation).toEqual([0, 0, 0])
    expect(map.viewport.camera).toEqual(before)
  })

  it('keeps a drag from also counting as a click on the feature it ended over', async () => {
    const clicks: unknown[] = []
    await renderGlobe()
    map.on('featureClick', (payload) => clicks.push(payload))
    await flush()

    drag(map, [180, 200], [230, 200])
    const path = el.querySelector('path.apexmaps-feature')
    path.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))

    expect(clicks).toHaveLength(0)

    // The control: without a drag in front of it the same click does select,
    // so the assertion above is about the drag and not about a dead listener.
    path.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    expect(clicks).toHaveLength(1)
  })

  it('emits rotate while turning and rotateEnd once it settles', async () => {
    await renderGlobe()
    const turns: number[] = []
    let ended = 0
    map.on('rotate', ({ rotate }) => turns.push(rotate[0]))
    map.on('rotateEnd', () => (ended += 1))

    drag(map, [200, 200], [250, 200], 3)

    expect(turns.length).toBeGreaterThanOrEqual(3)
    expect(ended).toBe(1)

    // A press that never moved is a click on the map, not a spin: no end event,
    // and no reprojection either, which is the expensive half of that mistake.
    const quiet = turns.length
    drag(map, [200, 200], [200, 200], 1)
    expect(ended).toBe(1)
    expect(turns).toHaveLength(quiet)
  })

  it('glides to a stop when inertia is on, and stops dead when it is not', async () => {
    await renderGlobe({ interaction: { rotate: { inertia: true } } })
    drag(map, [200, 200], [260, 200], 2)
    const released = map.rotation[0]

    await flush()
    await flush()

    expect(map.rotation[0]).toBeGreaterThan(released)
  })

  it('survives a resize with the spin intact', async () => {
    await renderGlobe({ chart: { width: '100%', height: 400 } })
    map.rotateTo([120, -20, 0])
    await flush()

    el.getBoundingClientRect = () => ({ width: 600, height: 400, top: 0, left: 0 })
    map._relayout()
    await flush()

    expect(map.rotation[0]).toBeCloseTo(120, 5)
    expect(map.rotation[1]).toBeCloseTo(-20, 5)
    expect(map.viewport.width).toBe(600)
  })

  it('returns a spun globe to where it opened on resetView', async () => {
    await renderGlobe({
      geo: {
        map: AROUND_THE_WORLD,
        projection: { name: 'orthographic', rotate: [-25, -18] },
        view: { fit: 'world' },
      },
    })
    expect(map.rotation).toEqual([-25, -18, 0])

    drag(map, [200, 200], [280, 240])
    expect(map.rotation[0]).not.toBeCloseTo(-25, 1)

    await map.resetView({ transition: 'jump' })

    expect(map.rotation[0]).toBeCloseTo(-25, 5)
    expect(map.rotation[1]).toBeCloseTo(-18, 5)
  })

  it('ignores rotation on a composite projection, which insets break under', async () => {
    await renderGlobe({
      geo: { map: AROUND_THE_WORLD, projection: 'albersUsa', view: { fit: 'data' } },
    })

    map.rotateTo([90, 0, 0])

    expect(map.rotation).toEqual([0, 0, 0])
    expect(map.viewport.rotatable).toBe(false)
  })

  it('keeps turning when the cursor leaves the disc', async () => {
    await renderGlobe()
    // Starts on the sphere, ends well outside it, where there is no point to
    // grab and versor has nothing to solve for.
    drag(map, [200, 200], [560, 200], 6)

    expect(Math.abs(map.rotation[0])).toBeGreaterThan(20)
    expect(Number.isFinite(map.rotation[0])).toBe(true)
    expect(Number.isFinite(map.rotation[1])).toBe(true)
  })
})

/**
 * Camera moves on a globe.
 *
 * The bug these exist to prevent: `flyTo({ center })` resolving to a pure
 * screen-space pan, which on a sphere cannot reach the far hemisphere at all.
 * The map looked like it zoomed in place and never went anywhere.
 */
describe('camera on a globe', () => {
  /** Somewhere on the far side of the world from Brazil, as the bug report has it. */
  const BRAZIL: [number, number] = [-53, -10]
  const INDIA: [number, number] = [79, 22]

  /**
   * A frame clock. The suite-wide stub reports a timestamp of 0 forever, which
   * is fine for a coalesced redraw and would hang an animation: the camera
   * derives its progress from the clock, so a clock that never moves never
   * finishes.
   */
  function runFrames(step = 16) {
    let now = 0
    vi.stubGlobal('requestAnimationFrame', ((cb: FrameRequestCallback) =>
      setTimeout(() => {
        now += step
        cb(now)
      }, 0)) as unknown as typeof requestAnimationFrame)
  }

  async function renderFacing(center: [number, number], options = {}) {
    runFrames()
    return renderGlobe({
      geo: {
        map: AROUND_THE_WORLD,
        projection: { name: 'orthographic', rotate: [-center[0], -center[1]], clipAngle: 90 },
        view: { fit: 'world' },
      },
      ...options,
    })
  }

  /** How far a place is from the middle of the plot, in pixels. */
  function offCentre(instance, lonLat) {
    const screen = instance.viewport.lonLatToScreen(lonLat)
    if (!screen) return Number.POSITIVE_INFINITY
    return Math.hypot(
      screen[0] - instance.viewport.width / 2,
      screen[1] - instance.viewport.height / 2,
    )
  }

  it('flies to the far side of the planet, and lands centred', async () => {
    await renderFacing(BRAZIL)
    // The starting state is the bug: India is more than a quarter turn away, so
    // it is behind the planet and no pan can reach it. (The projection still
    // returns a point for it, mirrored onto the near disc, which is precisely
    // why the old pan-only path looked like it did something.)
    expect(greatCircle(map.viewport.subObserver(), INDIA)).toBeGreaterThan(90)

    await map.camera.flyTo({ center: INDIA })

    expect(offCentre(map, INDIA)).toBeLessThan(1)
    // It turned rather than panned: the sphere is facing India now.
    expect(map.rotation[0]).toBeCloseTo(-79, 6)
    expect(map.rotation[1]).toBeCloseTo(-22, 6)
  })

  it('does not pan on top of the rotation', async () => {
    await renderFacing(BRAZIL)
    const start = { ...map.viewport.camera }

    await map.camera.flyTo({ center: INDIA })
    const afterIndia = { ...map.viewport.camera }
    await map.camera.flyTo({ center: [-40, 70] })

    // The turn does all the work, so at a fixed zoom the screen-space transform
    // is the same wherever on the planet the camera is pointed. Resolving the
    // destination against the old orientation instead would leave a translate
    // that differs per target, which is the double-move this guards against.
    expect(afterIndia.x).toBeCloseTo(start.x, 6)
    expect(afterIndia.y).toBeCloseTo(start.y, 6)
    expect(map.viewport.camera.x).toBeCloseTo(start.x, 6)
    expect(map.viewport.camera.y).toBeCloseTo(start.y, 6)
  })

  it('actually rotates through the move rather than jumping at the end', async () => {
    await renderFacing(BRAZIL)
    const seen: number[] = []
    map.on('rotate', ({ rotate }) => seen.push(rotate[1]))

    await map.camera.flyTo({ center: INDIA })

    // Many intermediate orientations, and each one a real reprojection.
    expect(seen.length).toBeGreaterThan(10)
    const midway = seen[Math.floor(seen.length / 2)]
    expect(midway).toBeGreaterThan(Math.min(10, -22))
    expect(midway).toBeLessThan(10)
  })

  it('takes the short way round and never wobbles', async () => {
    // Two places either side of the antimeridian: component-wise interpolation
    // of longitude would drag the globe the long way, right across the Atlantic.
    await renderFacing([170, 0])
    const path: [number, number][] = []
    map.on('rotate', ({ rotate }) => path.push([-rotate[0], -rotate[1]]))

    await map.camera.flyTo({ center: [-170, 0] })

    expect(offCentre(map, [-170, 0])).toBeLessThan(1)
    expect(path.length).toBeGreaterThan(5)
    // Every step of the way stays inside the 20 degrees between the two, and
    // latitude never leaves the equator, which a naive lerp would not manage.
    for (const [lon, lat] of path) {
      expect(Math.abs(lat)).toBeLessThan(0.001)
      expect(Math.abs(lon) > 169.5).toBe(true)
    }
  })

  it('moves at a steady angular pace, with no detour', async () => {
    await renderFacing([0, 0])
    const path: [number, number][] = []
    map.on('rotate', ({ rotate }) => path.push([-rotate[0], -rotate[1]]))

    await map.camera.easeTo({ center: [90, 45], ease: 'linear', duration: 320 })

    // Under a linear ease a slerp advances by equal angles per frame. Allowing
    // a 3x spread between the largest and smallest step is loose enough for a
    // ragged final frame and tight enough to catch a wobble or a swing-out.
    const steps: number[] = []
    for (let i = 1; i < path.length; i++) steps.push(greatCircle(path[i - 1], path[i]))
    const real = steps.filter((s) => s > 1e-9)
    expect(real.length).toBeGreaterThan(5)
    expect(Math.max(...real)).toBeLessThan(Math.min(...real) * 3)
  })

  it('scales its duration with the angle turned', async () => {
    const { rotationDuration } = await import('../src/geo/Camera')

    const nudge = rotationDuration([0, 0], [10, 0])
    const quarter = rotationDuration([0, 0], [90, 0])
    const halfTurn = rotationDuration([0, 0], [180, 0])

    expect(nudge).toBeLessThan(quarter)
    expect(quarter).toBeLessThan(halfTurn)
    // Proportional to the great circle, not to the difference in longitude:
    // a quarter turn is half a half-turn however you get there.
    expect(halfTurn / quarter).toBeCloseTo(2, 5)
    expect(rotationDuration([0, 0], [0, 0])).toBe(0)
    // Crossing the antimeridian is 20 degrees, not 340.
    expect(rotationDuration([170, 0], [-170, 0])).toBeCloseTo(rotationDuration([0, 0], [20, 0]), 6)
  })

  it('jumps with no animation, and lands in exactly the same place', async () => {
    await renderFacing(BRAZIL)
    const flown = await (async () => {
      await map.camera.flyTo({ center: INDIA })
      return { rotation: [...map.rotation], camera: { ...map.viewport.camera } }
    })()

    map.rotateTo([-BRAZIL[0], -BRAZIL[1], 0])
    map.camera.jumpTo({ center: INDIA })

    expect(map.rotation[0]).toBeCloseTo(flown.rotation[0], 6)
    expect(map.rotation[1]).toBeCloseTo(flown.rotation[1], 6)
    expect(map.viewport.camera.x).toBeCloseTo(flown.camera.x, 6)
    expect(map.viewport.camera.y).toBeCloseTo(flown.camera.y, 6)
    expect(offCentre(map, INDIA)).toBeLessThan(1)
  })

  it('retargets mid-turn instead of snapping or queueing', async () => {
    await renderFacing(BRAZIL)
    const first = map.camera.flyTo({ center: INDIA })
    // Run frames until the turn is genuinely under way. Driven by how far the
    // sphere has actually come rather than by a frame count, so the test says
    // what it means and does not depend on the clock's granularity.
    for (let i = 0; i < 200 && greatCircle(map.viewport.subObserver(), BRAZIL) < 20; i++) {
      await flush()
    }
    // Left Brazil, nowhere near India: an interruption, not a finished move.
    expect(greatCircle(map.viewport.subObserver(), BRAZIL)).toBeGreaterThan(15)
    expect(greatCircle(map.viewport.subObserver(), INDIA)).toBeGreaterThan(15)
    expect(map.camera.animating).toBe(true)

    await map.camera.flyTo({ center: [0, 60] })
    await first

    expect(offCentre(map, [0, 60])).toBeLessThan(1)
    expect(map.rotation[0]).toBeCloseTo(0, 6)
    expect(map.rotation[1]).toBeCloseTo(-60, 6)
  })

  it('honours prefers-reduced-motion by arriving without the journey', async () => {
    await renderFacing(BRAZIL)
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }))
    const seen: number[] = []
    map.on('rotate', ({ rotate }) => seen.push(rotate[0]))

    await map.camera.flyTo({ center: INDIA })

    expect(offCentre(map, INDIA)).toBeLessThan(1)
    expect(seen).toHaveLength(1)
  })

  it('zooms as well as turns, and the two land together', async () => {
    await renderFacing(BRAZIL)
    const k = map.viewport.camera.k

    await map.camera.flyTo({ center: INDIA, zoom: k * 2 })

    expect(map.viewport.camera.k).toBeCloseTo(k * 2, 6)
    expect(offCentre(map, INDIA)).toBeLessThan(1)
  })

  it('frames a feature on the far side of the globe', async () => {
    await renderFacing([0, 0])
    await flush()
    // 'CCC' sits at longitude 180, directly behind the viewer: clipped away, so
    // it has no path on screen and no bounding box to fit.
    expect(keysOnScreen()).not.toContain('CCC')

    await map.frameFeature('CCC')

    expect(offCentre(map, [180, 0])).toBeLessThan(1)
    expect(map.viewport.camera.k).toBeGreaterThan(1)
  })

  it('leaves a flat map panning, to the pixel', async () => {
    runFrames()
    // The regression guard. Equal Earth resolves a centre the way it always
    // has, and the expectation is computed the old way: project under the
    // current rotation, then translate the screen.
    map = new ApexMaps(el, {
      chart: { width: 400, height: 300 },
      geo: { map: AROUND_THE_WORLD, projection: 'equalEarth' },
      debug: { enabled: false },
    })
    await map.render()

    const k = map.viewport.camera.k
    const world = map.viewport.project(INDIA)
    const expected = { x: 200 - world[0] * k, y: 150 - world[1] * k }

    await map.camera.flyTo({ center: INDIA })

    expect(map.rotation).toEqual([0, 0, 0])
    expect(map.viewport.camera.x).toBeCloseTo(expected.x, 6)
    expect(map.viewport.camera.y).toBeCloseTo(expected.y, 6)
  })

  it('leaves a conic panning too, even though it can rotate', async () => {
    runFrames()
    // `conicEqualArea` has a `rotate` method and is not composite, so the old
    // `supportsRecentre` would have claimed it. It is defined by its standard
    // parallels, not by a centre, and turning it would re-skew the whole map.
    map = new ApexMaps(el, {
      chart: { width: 400, height: 300 },
      geo: { map: AROUND_THE_WORLD, projection: { name: 'conicEqualArea', rotate: [-100, 0] } },
      debug: { enabled: false },
    })
    await map.render()
    const before = [...map.rotation]

    await map.camera.flyTo({ center: INDIA })

    expect(map.rotation).toEqual(before)
    expect(map.viewport.supportsRecentre()).toBe(false)
  })

  it('takes the sphere off a coasting drag rather than fighting it', async () => {
    runFrames()
    await renderGlobe({ interaction: { rotate: { inertia: true } } })
    // Fling it, then fly somewhere while it is still coasting. Two writers, one
    // sphere: the glide has to yield or it drags the flight off course.
    drag(map, [200, 200], [280, 200], 2)
    expect(map.globe.spinning).toBe(true)

    await map.camera.flyTo({ center: [79, 22] })
    const landed = [...map.rotation]
    for (let i = 0; i < 10; i++) await flush()

    expect(map.globe.spinning).toBe(false)
    expect(map.rotation[0]).toBeCloseTo(-79, 6)
    expect(map.rotation).toEqual(landed)
  })

  it('still pans on a globe when the target is a zoom rather than a place', async () => {
    await renderFacing(BRAZIL)
    const before = [...map.rotation]

    await map.camera.flyTo({ zoom: 2 })

    expect(map.rotation).toEqual(before)
    expect(map.viewport.camera.k).toBeCloseTo(2, 6)
  })
})

/** Angular distance in degrees, for asserting on the shape of a path. */
function greatCircle([lon0, lat0], [lon1, lat1]) {
  const r = Math.PI / 180
  const [p0, p1] = [lat0 * r, lat1 * r]
  const d = (lon1 - lon0) * r
  return (
    Math.acos(
      Math.max(
        -1,
        Math.min(1, Math.sin(p0) * Math.sin(p1) + Math.cos(p0) * Math.cos(p1) * Math.cos(d)),
      ),
    ) / r
  )
}
