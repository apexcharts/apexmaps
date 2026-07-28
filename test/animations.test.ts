// @vitest-environment jsdom
/**
 * Value transitions and the entrance fade.
 *
 * The transitions themselves are CSS and only a real browser runs them
 * (`scratchpad` Chromium probes cover the interpolation); what jsdom can hold
 * to account is the contract between config and mechanism: the variables the
 * stylesheet reads, the classes that arm the entrance, the motion budget's
 * degradation order, and reduced motion switching everything off.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import ApexMaps from '../src/ApexMaps'
import { motionBudget, resolveSpeed } from '../src/utils/motion'

const BOX = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { id: 'AAA', name: 'Box' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-20, -20],
            [-20, 20],
            [20, 20],
            [20, -20],
            [-20, -20],
          ],
        ],
      },
    },
  ],
}

let el: HTMLElement
let map: any

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
  vi.restoreAllMocks()
})

async function render(options: Record<string, unknown> = {}) {
  map = new ApexMaps(el, {
    chart: { width: 600, height: 400 },
    geo: { map: BOX },
    debug: { enabled: false },
    ...options,
  } as any)
  await map.render()
  return map
}

function stubReducedMotion(matches: boolean) {
  vi.stubGlobal('matchMedia', ((query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? matches : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia)
}

describe('resolveSpeed', () => {
  it('maps the keywords and passes numbers through', () => {
    expect(resolveSpeed('slow')).toBe(700)
    expect(resolveSpeed('normal')).toBe(350)
    expect(resolveSpeed('fast')).toBe(180)
    expect(resolveSpeed('instant')).toBe(0)
    expect(resolveSpeed(undefined)).toBe(350)
    expect(resolveSpeed(120)).toBe(120)
    expect(resolveSpeed(-5)).toBe(0)
  })
})

describe('motionBudget', () => {
  it('degrades geometry first, then everything', () => {
    expect(motionBudget(100)).toEqual({ animate: true, properties: 'all' })
    expect(motionBudget(10_000).properties).toBe('cheap')
    expect(motionBudget(10_000).animate).toBe(true)
    expect(motionBudget(100_000).animate).toBe(false)
  })

  it('stops animating entirely under prefers-reduced-motion', () => {
    stubReducedMotion(true)
    expect(motionBudget(10).animate).toBe(false)
  })
})

describe('animation variables', () => {
  it('publishes the configured speed for the stylesheet to read', async () => {
    await render({ chart: { animations: { speed: 'slow' } } })
    expect(el.style.getPropertyValue('--apexmaps-anim')).toBe('700ms')
    expect(el.style.getPropertyValue('--apexmaps-anim-geom')).toBe('700ms')
  })

  it('zeroes both when animations are disabled', async () => {
    await render({ chart: { animations: { enabled: false } } })
    expect(el.style.getPropertyValue('--apexmaps-anim')).toBe('0ms')
    expect(el.style.getPropertyValue('--apexmaps-anim-geom')).toBe('0ms')
  })

  it("zeroes both for speed 'instant'", async () => {
    await render({ chart: { animations: { speed: 'instant' } } })
    expect(el.style.getPropertyValue('--apexmaps-anim')).toBe('0ms')
  })

  it('zeroes both under prefers-reduced-motion regardless of config', async () => {
    stubReducedMotion(true)
    await render({ chart: { animations: { speed: 'slow' } } })
    expect(el.style.getPropertyValue('--apexmaps-anim')).toBe('0ms')
    expect(el.style.getPropertyValue('--apexmaps-anim-geom')).toBe('0ms')
  })

  it('follows a speed change through updateOptions', async () => {
    await render()
    expect(el.style.getPropertyValue('--apexmaps-anim')).toBe('350ms')
    await map.updateOptions({ chart: { animations: { speed: 80 } } })
    expect(el.style.getPropertyValue('--apexmaps-anim')).toBe('80ms')
  })
})

describe('entrance', () => {
  it('does not play for a default dashboard map', async () => {
    await render()
    expect(el.classList.contains('apexmaps--enter')).toBe(false)
  })

  it("plays once under context 'story' and then retires itself", async () => {
    await render({ chart: { context: 'story', animations: { speed: 40 } } })
    expect(el.classList.contains('apexmaps--enter')).toBe(true)
    await new Promise((r) => setTimeout(r, 200))
    expect(el.classList.contains('apexmaps--enter')).toBe(false)
  })

  it('plays when asked for explicitly', async () => {
    await render({ chart: { animations: { entrance: true, speed: 40 } } })
    expect(el.classList.contains('apexmaps--enter')).toBe(true)
  })

  it("an explicit entrance: false beats the story context", async () => {
    await render({ chart: { context: 'story', animations: { entrance: false } } })
    expect(el.classList.contains('apexmaps--enter')).toBe(false)
  })

  it('does not play under prefers-reduced-motion', async () => {
    stubReducedMotion(true)
    await render({ chart: { context: 'story' } })
    expect(el.classList.contains('apexmaps--enter')).toBe(false)
  })

  it('destroy cancels the pending class removal cleanly', async () => {
    await render({ chart: { context: 'story', animations: { speed: 40 } } })
    map.destroy()
    map = null
    expect(el.classList.contains('apexmaps--enter')).toBe(false)
    // The timer was cleared; waiting past it must not throw or resurrect state.
    await new Promise((r) => setTimeout(r, 200))
    expect(el.classList.contains('apexmaps--enter')).toBe(false)
  })
})
