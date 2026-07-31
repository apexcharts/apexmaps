// @vitest-environment jsdom
/**
 * Flow: the beads that travel along a route.
 *
 * The mechanism is a dashed companion path animated on its dash offset, and every
 * property that makes it work rather than merely exist is asserted here:
 *
 * - the dash period is the spacing, and the travel is one period, because that is
 *   what makes the duration independent of the route's length;
 * - the beads are wider than the hairline they sit on, and at full opacity, or
 *   they are invisible;
 * - the offset animates negative, or the beads flow from the destination back to
 *   the origin;
 * - they sit above every route, and they never take the pointer;
 * - reduced motion and a route count past the budget stop the travel and keep the
 *   beads;
 * - they are anchored to the ground, so zooming spreads them rather than fitting
 *   more of them onto the same route.
 *
 * jsdom runs no animations and no layout, so what is checked is the contract the
 * browser is handed: attributes, custom properties, class names and order.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ApexMaps from '../src/ApexMaps'
import { resolveFlow } from '../src/series/flow'
import { FLOW_BUDGET } from '../src/utils/motion'

const WORLD = JSON.parse(
  readFileSync(resolve(process.cwd(), 'node_modules/world-atlas/countries-110m.json'), 'utf8'),
)

const TOKYO: [number, number] = [139.7, 35.7]
const NEW_YORK: [number, number] = [-74.0, 40.7]
const LONDON: [number, number] = [-0.13, 51.5]
const SYDNEY: [number, number] = [151.2, -33.9]

const ROUTES = [
  { name: 'NRT-JFK', from: TOKYO, to: NEW_YORK, value: 900 },
  { name: 'LHR-SYD', from: LONDON, to: SYDNEY, value: 400 },
]

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
  map?.destroy?.()
  map = null
  el.remove()
  vi.unstubAllGlobals()
})

async function render(series: Record<string, unknown>, options: Record<string, unknown> = {}) {
  map = new ApexMaps(el, {
    chart: { width: 960, height: 500 },
    geo: { map: WORLD, projection: 'equalEarth' },
    debug: { enabled: false },
    series: [{ type: 'arc', name: 'Routes', data: ROUTES, ...series }],
    ...options,
  } as never)
  await map.render()
  return map
}

const beads = () => [...el.querySelectorAll<SVGPathElement>('path.apexmaps-flow')]
const arcs = () => [...el.querySelectorAll<SVGPathElement>('path.apexmaps-arc')]
const dashOf = (bead: SVGPathElement) =>
  bead.getAttribute('stroke-dasharray')!.split(' ').map(Number)

describe('resolveFlow', () => {
  it('is off unless asked for', () => {
    expect(resolveFlow(undefined, { key: 'a', width: 2, color: '#000' })).toBeUndefined()
    expect(resolveFlow(false, { key: 'a', width: 2, color: '#000' })).toBeUndefined()
  })

  it('derives the duration from spacing and speed, not from the route', () => {
    const flow = resolveFlow({ spacing: 30, speed: 60 }, { key: 'a', width: 2, color: '#000' })!
    // 30px of travel at 60px/s. Nothing about the route entered into it, which is
    // the whole reason `getTotalLength` is never called.
    expect(flow.duration).toBeCloseTo(0.5, 6)
    expect(flow.dash + flow.gap).toBeCloseTo(30, 6)
  })

  it('paints the beads without motion at zero speed', () => {
    const flow = resolveFlow({ speed: 0 }, { key: 'a', width: 2, color: '#000' })!
    expect(flow.duration).toBe(0)
    expect(flow.delay).toBe(0)
    expect(flow.dash + flow.gap).toBeGreaterThan(0)
  })

  it('gives a bead a legible size on a hairline route', () => {
    // A 0.75px arc is the thin end of the default width range, and a 0.75px bead
    // on it would be no bead at all.
    const thin = resolveFlow(true, { key: 'a', width: 0.75, color: '#000' })!
    expect(thin.width).toBeGreaterThan(2.5)
    // A heavy corridor carries a fatter bead, but not an unbounded one.
    const heavy = resolveFlow(true, { key: 'a', width: 6, color: '#000' })!
    expect(heavy.width).toBeGreaterThan(thin.width)
    expect(heavy.width).toBeLessThanOrEqual(7)
  })

  it('stands the bead off the route it sits on', () => {
    const flow = resolveFlow(true, { key: 'a', width: 1, color: '#f80' })!
    // Same colour as the route by default, but at full opacity while the route is
    // drawn under it: identical colour and identical opacity would be invisible.
    expect(flow.color).toBe('#f80')
    expect(flow.opacity).toBe(1)
  })

  it('staggers by a stable hash rather than at random', () => {
    const a = resolveFlow(true, { key: 'route-a', width: 2, color: '#000' })!
    const again = resolveFlow(true, { key: 'route-a', width: 2, color: '#000' })!
    const b = resolveFlow(true, { key: 'route-b', width: 2, color: '#000' })!

    // Same key, same phase: a re-render, an SSR pass and a screenshot must agree.
    expect(again.delay).toBe(a.delay)
    expect(b.delay).not.toBe(a.delay)
    // Negative, so a staggered route starts part-way through the pattern rather
    // than standing still until its turn comes.
    expect(a.delay).toBeLessThanOrEqual(0)
    expect(a.delay).toBeGreaterThan(-a.duration)
  })

  it('marches a dashed highlight under style: dash', () => {
    const dots = resolveFlow({ spacing: 20 }, { key: 'a', width: 2, color: '#000' })!
    const dash = resolveFlow({ spacing: 20, style: 'dash' }, { key: 'a', width: 2, color: '#000' })!
    // Both loop over the same period; the dash spends much more of it inked.
    expect(dash.dash + dash.gap).toBeCloseTo(dots.dash + dots.gap, 6)
    expect(dash.dash).toBeGreaterThan(dots.dash * 10)
  })
})

describe('flow rendering', () => {
  it('draws no companion path when flow is off', async () => {
    await render({})
    expect(arcs()).toHaveLength(2)
    expect(beads()).toHaveLength(0)
  })

  it('draws one bead path per route, dashed and travelling', async () => {
    await render({ flow: true })
    const painted = beads()
    expect(painted).toHaveLength(2)

    for (const bead of painted) {
      const [dash, gap] = dashOf(bead)
      expect(gap).toBeGreaterThan(dash)
      expect(bead.getAttribute('stroke-linecap')).toBe('round')
      // Everything about a bead is written in screen pixels against this, so that
      // the renderer can scale its spacing and its width by different laws. Left in
      // world units for the camera transform to scale, the two would be locked
      // together and an uncapped bead would end up a blob. See `applyFlowScale`.
      expect(bead.getAttribute('vector-effect')).toBe('non-scaling-stroke')
      expect(bead.classList.contains('apexmaps-flow--moving')).toBe(true)
      expect(bead.style.getPropertyValue('--apexmaps-flow-travel')).toBe(`${dash + gap}px`)
      expect(
        Number.parseFloat(bead.style.getPropertyValue('--apexmaps-flow-duration')),
      ).toBeGreaterThan(0)
    }
  })

  it('shares the route’s path data, so the beads sit on the route', async () => {
    await render({ flow: true })
    const routes = arcs().map((a) => a.getAttribute('d'))
    for (const bead of beads()) expect(routes).toContain(bead.getAttribute('d'))
  })

  it('is wider than the hairline it travels along', async () => {
    await render({ flow: true })
    for (const bead of beads()) {
      const route = arcs().find((a) => a.getAttribute('d') === bead.getAttribute('d'))!
      expect(Number(bead.getAttribute('stroke-width'))).toBeGreaterThan(
        Number(route.getAttribute('stroke-width')),
      )
    }
  })

  it('keeps every bead above every route, and out of the way of the pointer', async () => {
    await render({ flow: true })
    const group = () => el.querySelector('g.apexmaps-series--flow')!
    // Last child of the series group: a route drawn after a bead would cut it.
    expect(group().parentElement!.lastElementChild).toBe(group())
    expect(group().querySelectorAll('path.apexmaps-flow')).toHaveLength(2)
    for (const bead of beads()) expect(bead.getAttribute('pointer-events')).toBe('none')

    // And still last after a route arrives, which is the case that actually
    // regresses: a new route is appended to the series group, which is where the
    // bead group already sits.
    await map.updateSeries([
      {
        type: 'arc',
        name: 'Routes',
        data: [...ROUTES, { name: 'JFK-LHR', from: NEW_YORK, to: LONDON, value: 600 }],
        flow: true,
      },
    ])
    expect(arcs()).toHaveLength(3)
    expect(group().parentElement!.lastElementChild).toBe(group())
  })

  it('takes its colour and size from the option when given one', async () => {
    await render({ flow: { color: '#ff0055', size: 5, spacing: 40, speed: 20 } })
    for (const bead of beads()) {
      expect(bead.getAttribute('stroke')).toBe('#ff0055')
      expect(Number(bead.getAttribute('stroke-width'))).toBe(5)
      const [dash, gap] = dashOf(bead)
      expect(dash + gap).toBeCloseTo(40, 6)
      // 40px at 20px/s.
      expect(bead.style.getPropertyValue('--apexmaps-flow-duration')).toBe('2s')
    }
  })

  it('removes the beads and their group when flow is turned off again', async () => {
    await render({ flow: true })
    expect(beads()).toHaveLength(2)

    await map.updateSeries([{ type: 'arc', name: 'Routes', data: ROUTES }])
    expect(beads()).toHaveLength(0)
    expect(el.querySelector('g.apexmaps-series--flow')).toBeNull()
    // The routes themselves survived the update.
    expect(arcs()).toHaveLength(2)
  })

  it('drops a bead when its route disappears', async () => {
    await render({ flow: true })
    await map.updateSeries([{ type: 'arc', name: 'Routes', data: [ROUTES[0]], flow: true }])
    expect(arcs()).toHaveLength(1)
    expect(beads()).toHaveLength(1)
  })

  it('paints the beads but stops them when animations are off', async () => {
    await render(
      { flow: true },
      { chart: { width: 960, height: 500, animations: { enabled: false } } },
    )
    const painted = beads()
    expect(painted).toHaveLength(2)
    for (const bead of painted) {
      // Still spaced along the route: a dotted route reads as a route. It just
      // does not move.
      expect(dashOf(bead)[1]).toBeGreaterThan(0)
      expect(bead.classList.contains('apexmaps-flow--moving')).toBe(false)
    }
  })

  it('stops the travel past the flow budget rather than dropping frames forever', async () => {
    // Synthetic pairs, one per degree of longitude, cheap to project and past the
    // budget by one.
    const many = Array.from({ length: FLOW_BUDGET + 1 }, (_, i) => ({
      name: `r${i}`,
      from: [-180 + (i % 360), 0] as [number, number],
      to: [-180 + (i % 360), 40] as [number, number],
      value: i,
    }))
    await render({ data: many, flow: true, geodesic: false })

    const painted = beads()
    expect(painted.length).toBe(FLOW_BUDGET + 1)
    for (const bead of painted) expect(bead.classList.contains('apexmaps-flow--moving')).toBe(false)
    expect(map.series[0].advise().join(' ')).toContain('flow budget')
  })

  it('works the same on a line series', async () => {
    await render(
      {},
      {
        series: [
          {
            type: 'line',
            name: 'Lane',
            data: [{ name: 'Suez', path: [TOKYO, [80, 5], LONDON] }],
            flow: true,
          },
        ],
      },
    )
    expect(el.querySelectorAll('path.apexmaps-line')).toHaveLength(1)
    expect(beads()).toHaveLength(1)
  })
})

describe('beads belong to the ground, not to the screen', () => {
  const period = (bead: SVGPathElement) => {
    const [dash, gap] = dashOf(bead)
    return dash + gap
  }

  it('spreads and grows them as the camera zooms in', async () => {
    const m = await render({ flow: { spacing: 40, size: 4, speed: 40 } })
    const bead = beads()[0]
    expect(period(bead)).toBeCloseTo(40, 3)
    expect(Number(bead.getAttribute('stroke-width'))).toBeCloseTo(4, 3)

    m.camera!.set({ k: m.viewport.camera.k * 2 })
    // Twice the zoom, twice the spacing: the bead stays over the same stretch of
    // route instead of the route acquiring twice as many beads.
    expect(period(bead)).toBeCloseTo(80, 3)
    expect(Number(bead.getAttribute('stroke-width'))).toBeCloseTo(8, 3)
    // The keyframe travels one period, so it has to follow the pattern, or the
    // beads would jump backwards each cycle.
    expect(bead.style.getPropertyValue('--apexmaps-flow-travel')).toBe('80px')
  })

  it('bounds each of the three, and each at its own zoom', async () => {
    const m = await render({ flow: { spacing: 40, size: 4, speed: 50 } })
    const bead = beads()[0]
    const opening = m.viewport.camera.k
    const width = () => Number(bead.getAttribute('stroke-width'))

    // Under every bound, all three track the camera.
    m.camera!.set({ k: opening * 2 })
    expect(period(bead)).toBeCloseTo(80, 3)
    expect(width()).toBeCloseTo(8, 3)
    expect(pace(bead)).toBeCloseTo(100, 3)

    // Size stops next: routes keep their own width however far the reader zooms, so
    // a bead that went on growing would be a blob on a hairline.
    m.camera!.set({ k: opening * 4 })
    expect(width()).toBeCloseTo(12, 3)
    expect(period(bead)).toBeCloseTo(160, 3)

    // Spacing stops last, and only because the viewport does not grow with the
    // zoom: beads that spread without limit eventually leave none of them in view.
    m.camera!.set({ k: opening * 6 })
    expect(period(bead)).toBeCloseTo(240, 3)

    // Past all three the camera changes nothing about the flow at all.
    for (const k of [8, 64, 2048]) {
      m.camera!.set({ k: opening * k })
      expect(period(bead)).toBeCloseTo(240, 3)
      expect(width()).toBeCloseTo(12, 3)
      expect(pace(bead)).toBeCloseTo(100, 3)
    }
  })

  it('comes back to the calibrated look when the camera does', async () => {
    const m = await render({ flow: { spacing: 40, size: 4 } })
    const bead = beads()[0]
    const opening = m.viewport.camera.k
    m.camera!.set({ k: opening * 4 })
    expect(period(bead)).toBeCloseTo(160, 3)
    m.camera!.set({ k: opening })
    expect(period(bead)).toBeCloseTo(40, 3)
    expect(Number(bead.getAttribute('stroke-width'))).toBeCloseTo(4, 3)
  })

  /*
   * Apparent speed is the travel divided by the cycle, and the travel is one dash
   * period, which scales. So the pace scales with the zoom unless the cycle is
   * stretched to match, and at the far end of the camera that is not brisk, it is
   * frantic.
   */
  const pace = (bead: SVGPathElement) =>
    period(bead) / Number.parseFloat(bead.style.getPropertyValue('--apexmaps-flow-duration'))

  it('lets the pace rise with the zoom, but only so far', async () => {
    const m = await render({ flow: { spacing: 40, size: 4, speed: 50 } })
    const bead = beads()[0]
    const opening = m.viewport.camera.k
    expect(pace(bead)).toBeCloseTo(50, 3)

    // Up to the cap the beads cover the same ground per second, so the screen pace
    // tracks the zoom.
    m.camera!.set({ k: opening * 2 })
    expect(pace(bead)).toBeCloseTo(100, 3)

    // Past it the pace holds while the beads go on spreading.
    m.camera!.set({ k: opening * 4 })
    expect(period(bead)).toBeCloseTo(160, 3)
    expect(pace(bead)).toBeCloseTo(100, 3)
    // And it is the cycle that was stretched, not the travel. Capping the travel
    // is the obvious way to hold the speed and the wrong one: a travel shorter
    // than the pattern it advances makes the beads jump back once per cycle
    // instead of looping.
    expect(bead.style.getPropertyValue('--apexmaps-flow-travel')).toBe('160px')

    // And at the very end of the camera it is still twice, not four thousand times.
    m.camera!.set({ k: opening * 1000 })
    expect(pace(bead)).toBeCloseTo(100, 3)
  })

  it('keeps the routes staggered when the cycle stretches', async () => {
    const m = await render({ flow: { spacing: 40, speed: 50 } })
    const bead = beads()[0]
    const fraction = (el: SVGPathElement) =>
      -Number.parseFloat(el.style.getPropertyValue('--apexmaps-flow-delay')) /
      Number.parseFloat(el.style.getPropertyValue('--apexmaps-flow-duration'))

    const before = fraction(bead)
    expect(before).toBeGreaterThan(0)
    m.camera!.set({ k: m.viewport.camera.k * 8 })
    // The delay is in seconds and the cycle just got four times longer: left alone,
    // every route's phase would shrink towards zero and the map would drift into
    // one synchronised pulse.
    expect(fraction(bead)).toBeCloseTo(before, 6)
  })

  it('holds them fixed under scale: screen', async () => {
    const m = await render({ flow: { spacing: 40, size: 4, speed: 50, scale: 'screen' } })
    const bead = beads()[0]
    m.camera!.set({ k: m.viewport.camera.k * 4 })
    expect(period(bead)).toBeCloseTo(40, 3)
    expect(Number(bead.getAttribute('stroke-width'))).toBeCloseTo(4, 3)
    expect(pace(bead)).toBeCloseTo(50, 3)
  })

  it('calibrates against the view the map opened at, whatever it was fitted to', async () => {
    // `spacing: 40` has to mean forty screen pixels in the view the reader is first
    // given, or every default would be wrong on every map not fitted to the world.
    // It does, and for a reason worth pinning: `view.fit` fits the projection and
    // leaves the camera at 1, so the camera's own zoom is already relative to the
    // opening view. If fitting ever started moving the camera instead, the beads on
    // this map would open several times too far apart and this is what would say so.
    const m = await render(
      { flow: { spacing: 40, size: 4 } },
      {
        geo: { map: WORLD, projection: 'equalEarth', view: { fit: [-10, 35, 30, 62] } },
      },
    )
    expect(m.viewport.camera.k).toBeCloseTo(1, 6)
    expect(period(beads()[0])).toBeCloseTo(40, 3)
  })

  it('does not re-anchor when the data changes at some other zoom', async () => {
    const m = await render({ flow: { spacing: 40, size: 4 } })
    const opening = m.viewport.camera.k
    m.camera!.set({ k: opening * 2 })
    await m.updateSeries([
      { type: 'arc', name: 'Routes', data: ROUTES, flow: { spacing: 40, size: 4 } },
    ])
    // Still twice the calibrated spacing. Anchoring to the current camera instead
    // would snap the beads back to 40px here, in the middle of a zoomed-in view.
    expect(period(beads()[0])).toBeCloseTo(80, 3)
  })
})

describe('the stylesheet half of the mechanism', () => {
  /*
   * jsdom parses no keyframes and runs no animations, so the two lines that decide
   * which way the beads travel and whether they travel at all cannot be observed
   * from a rendered map. This is a text assertion and it knows it: it cannot prove
   * the beads move correctly, only that the sign nobody would think to re-check has
   * not been flipped, and that the reduced-motion block still names the class the
   * renderer actually writes.
   */
  const css = readFileSync(resolve(process.cwd(), 'src/ApexMaps.css'), 'utf8')

  it('animates the dash offset negative, which is origin towards destination', () => {
    expect(css).toContain('stroke-dashoffset: calc(-1 * var(--apexmaps-flow-travel, 0px))')
  })

  it('stops the travel under prefers-reduced-motion', () => {
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(block).toContain('.apexmaps-flow--moving')
  })

  it('names the same custom properties the renderer writes', () => {
    for (const property of [
      '--apexmaps-flow-travel',
      '--apexmaps-flow-duration',
      '--apexmaps-flow-delay',
    ]) {
      expect(css).toContain(property)
    }
  })
})

describe('flow under reduced motion', () => {
  it('leaves the beads in place and stops them', async () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia

    try {
      await render({ flow: true })
      const painted = beads()
      expect(painted).toHaveLength(2)
      for (const bead of painted) {
        expect(bead.classList.contains('apexmaps-flow--moving')).toBe(false)
        expect(dashOf(bead)[1]).toBeGreaterThan(0)
      }
    } finally {
      window.matchMedia = original
    }
  })
})
