// @vitest-environment jsdom
/**
 * Which touch gestures a map takes from the page.
 *
 * The bug this exists to prevent: every map claimed every touch gesture
 * (`touch-action: none`), including a map that neither pans nor zooms, such as a
 * hex layout by default. On a phone a swipe over a full-width map of that kind
 * could not scroll the page, so the map trapped the reader. The surface has to
 * claim exactly what the map handles: the one-finger drag when it pans (or spins
 * the globe, or draws a selection box), the pinch when it zooms, nothing else.
 *
 * jsdom has no touch input, so these check the value and the listeners that make
 * each combination work; real touch belongs to a browser check.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import ApexMaps from '../src/ApexMaps'
import { applyTouchAction } from '../src/interaction/ZoomPan'
import { _resetRegistry } from '../src/core/MapRegistry'
import {
  setGeoSource,
  DEFAULT_GEO_SOURCE,
  installCatalogue,
  _resetGeoLoads,
} from '../src/core/GeoCatalogue'
import type { ApexMapsOptions, GeoInput } from '../src/types'

const GEO = {
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

let el: HTMLElement
let map: ApexMaps | null = null

async function build(options: ApexMapsOptions = {}): Promise<ApexMaps> {
  map = new ApexMaps(el, {
    chart: { width: 400, height: 300 },
    debug: { enabled: false },
    geo: { map: GEO },
    series: [{ type: 'choropleth', data: [{ key: 'AAA', value: 1 }] }],
    ...options,
  } as ApexMapsOptions)
  await map.render()
  return map
}

const surface = () => el.querySelector('.apexmaps-svg') as SVGSVGElement
const touchAction = () => surface().style.touchAction
const plot = () => el.querySelector('.apexmaps-plot') as HTMLElement

/** A touchmove with `fingers` touches, which jsdom cannot build from `Touch` objects. */
function touchMove(fingers: number, target: Element = surface()): Event {
  const event = new Event('touchmove', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', { value: { length: fingers } })
  target.dispatchEvent(event)
  return event
}

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
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('touch-action follows the gestures the map handles', () => {
  it('claims every gesture on a map that pans and zooms (the default)', async () => {
    await build()
    expect(touchAction()).toBe('none')
  })

  it('leaves scroll and pinch to the page on a map that neither pans nor zooms', async () => {
    await build({ interaction: { zoom: { enabled: false }, pan: { enabled: false } } })
    expect(touchAction()).toBe('manipulation')
  })

  it('takes the one-finger drag and leaves the pinch on a map that only pans', async () => {
    await build({ interaction: { zoom: { enabled: false } } })
    expect(touchAction()).toBe('pinch-zoom')
  })

  it('takes the pinch and leaves one-finger scrolling on a map that only zooms', async () => {
    await build({ interaction: { pan: { enabled: false } } })
    expect(touchAction()).toBe('pan-x pan-y')
  })

  it('takes the drag when a plain drag draws a selection box', async () => {
    // A finger has no modifier keys, so this is the only box a touch reader can draw.
    await build({
      interaction: {
        zoom: { enabled: false },
        pan: { enabled: false },
        selection: { enabled: true, multiple: true, modifier: 'none' },
      },
    })
    expect(touchAction()).toBe('pinch-zoom')
  })

  it('does not take the drag for a selection box that needs a modifier', async () => {
    await build({
      interaction: {
        zoom: { enabled: false },
        pan: { enabled: false },
        selection: { enabled: true, multiple: true, modifier: 'shift' },
      },
    })
    expect(touchAction()).toBe('manipulation')
  })

  it('follows updateOptions in both directions', async () => {
    await build()
    expect(touchAction()).toBe('none')

    await map!.updateOptions({ interaction: { zoom: { enabled: false }, pan: { enabled: false } } })
    expect(touchAction()).toBe('manipulation')

    await map!.updateOptions({ interaction: { zoom: { enabled: true } } })
    expect(touchAction()).toBe('pan-x pan-y')

    await map!.updateOptions({ interaction: { pan: { enabled: true } } })
    expect(touchAction()).toBe('none')
  })

  it('takes the drag when a projection change makes it spin the globe', async () => {
    // A composite projection cannot rotate, so the drag is nobody's; switching to
    // a globe with `rotate: true` hands it to the map with `interaction` untouched.
    await build({
      geo: { map: GEO, projection: 'albersUsa' },
      interaction: {
        zoom: { enabled: false },
        pan: { enabled: false },
        rotate: { enabled: true, inertia: false },
      },
    })
    expect(touchAction()).toBe('manipulation')

    await map!.updateOptions({ geo: { projection: 'orthographic' } })
    expect(touchAction()).toBe('pinch-zoom')
  })

  it('is written on the SVG, so the zoom buttons beside it keep the page gestures', async () => {
    await build()
    expect(surface().style.touchAction).toBe('none')
    expect(plot().style.touchAction).toBe('')
  })
})

describe('the pinch on a map that zooms but does not pan', () => {
  it('cancels a two-finger move, so the page cannot turn the pinch into a scroll', async () => {
    await build({ interaction: { pan: { enabled: false } } })
    expect(touchMove(2).defaultPrevented).toBe(true)
  })

  it('never cancels a one-finger move, so the page still scrolls', async () => {
    await build({ interaction: { pan: { enabled: false } } })
    expect(touchMove(1).defaultPrevented).toBe(false)
  })

  it('leaves a two-finger move alone on a map that does not zoom', async () => {
    await build({ interaction: { zoom: { enabled: false }, pan: { enabled: false } } })
    expect(touchMove(2).defaultPrevented).toBe(false)
  })

  it('leaves a pinch that starts on the zoom buttons to the page', async () => {
    // The buttons sit in the plot beside the SVG and keep the page's gestures,
    // the default map (pan and zoom on) included.
    for (const interaction of [{ pan: { enabled: false } }, {}]) {
      await build({ interaction })
      const buttons = el.querySelector('.apexmaps-zoom')
      expect(buttons).not.toBeNull()
      expect(touchMove(2, buttons!).defaultPrevented).toBe(false)
      map!.destroy()
      map = null
    }
  })

  it('stops cancelling once updateOptions turns zoom off', async () => {
    await build({ interaction: { pan: { enabled: false } } })
    await map!.updateOptions({ interaction: { zoom: { enabled: false } } })
    expect(touchMove(2).defaultPrevented).toBe(false)
  })
})

describe('applyTouchAction', () => {
  /** A style that, like a browser without the value, ignores what it does not know. */
  function styleWithout(unsupported: string, initial: string) {
    let value = initial
    return {
      style: {
        get touchAction() {
          return value
        },
        set touchAction(next: string) {
          if (next !== unsupported) value = next
        },
      },
    } as unknown as SVGElement
  }

  it('falls back when the browser lacks the preferred value, rather than keeping the old one', () => {
    // The old value hands the drag to the page; keeping it would be the bug.
    const el = styleWithout('pinch-zoom', 'manipulation')
    expect(applyTouchAction(el, ['pinch-zoom', 'none'])).toBe('none')
    expect(el.style.touchAction).toBe('none')
  })

  it('takes the preferred value where it is supported', () => {
    const el = styleWithout('nothing-is-unsupported', 'manipulation')
    expect(applyTouchAction(el, ['pinch-zoom', 'none'])).toBe('pinch-zoom')
  })
})

describe('the stylesheet', () => {
  it('starts the surface with the page keeping its gestures, not with none', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/ApexMaps.css'), 'utf8')
    const rule = css.match(/\.apexmaps-svg\s*\{([^}]*)\}/)
    expect(rule).not.toBeNull()
    const body = rule![1].replace(/\/\*[\s\S]*?\*\//g, '')
    expect(body).toMatch(/touch-action:\s*manipulation\s*;/)
  })
})

const GEO_DIR = resolve(process.cwd(), 'geo')
const hasPacks =
  existsSync(resolve(GEO_DIR, 'us-states-hex.json')) &&
  existsSync(resolve(GEO_DIR, 'us-states-10m.json'))

describe.skipIf(!hasPacks)('a hex layout, which turns zoom and pan off by default', () => {
  const readPack = (file: string): GeoInput =>
    JSON.parse(readFileSync(resolve(GEO_DIR, file), 'utf8')) as GeoInput

  beforeEach(() => {
    installCatalogue()
    setGeoSource((file) => Promise.resolve(readPack(file)))
  })

  afterEach(() => {
    setGeoSource(DEFAULT_GEO_SOURCE)
    _resetGeoLoads()
    _resetRegistry()
    installCatalogue()
  })

  const usMap = (options: ApexMapsOptions = {}) =>
    build({ geo: { map: 'us' }, series: [], ...options } as ApexMapsOptions)

  it('gives every gesture back to the page', async () => {
    await usMap({ geo: { map: 'us', layout: 'hex' } })
    expect(touchAction()).toBe('manipulation')
  })

  it('follows a geography-to-hex toggle and back', async () => {
    await usMap()
    expect(touchAction()).toBe('none')

    await map!.updateOptions({ geo: { layout: 'hex' } })
    expect(touchAction()).toBe('manipulation')

    await map!.updateOptions({ geo: { layout: null } })
    expect(touchAction()).toBe('none')
  })

  it('claims the pinch on a hex layout whose caller turned zoom back on', async () => {
    await usMap({ geo: { map: 'us', layout: 'hex' }, interaction: { zoom: { enabled: true } } })
    expect(touchAction()).toBe('pan-x pan-y')
  })
})
