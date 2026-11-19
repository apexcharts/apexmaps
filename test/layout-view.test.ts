// @vitest-environment jsdom
/**
 * What a grid layout is framed with, and where the camera is after a toggle.
 *
 * A hex layout is a diagram on a plane, so a projection or a lon/lat fit box
 * written for the geography view has nothing to act on: applied anyway it flips
 * the grid or frames empty space. And because a layout turns zoom and pan off,
 * a camera carried over from a zoomed geography view leaves the reader stuck on
 * a few cells. Both are toggles a page makes with the rest of its options
 * unchanged, which is the case these tests set up.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import ApexMaps from '../src/ApexMaps'
import { _resetRegistry } from '../src/core/MapRegistry'
import {
  setGeoSource,
  DEFAULT_GEO_SOURCE,
  installCatalogue,
  _resetGeoLoads,
} from '../src/core/GeoCatalogue'
import type { ApexMapsOptions, GeoInput } from '../src/types'

const GEO_DIR = resolve(process.cwd(), 'geo')
const hasPacks =
  existsSync(resolve(GEO_DIR, 'us-states-hex.json')) &&
  existsSync(resolve(GEO_DIR, 'us-states-10m.json'))

function readPack(file: string): GeoInput {
  return JSON.parse(readFileSync(resolve(GEO_DIR, file), 'utf8')) as GeoInput
}

/** Lower 48, in lon/lat: the kind of box a page writes for its geography view. */
const CONUS: [number, number, number, number] = [-125, 24, -66, 50]

const WIDTH = 800
const HEIGHT = 500

describe.skipIf(!hasPacks)('a grid layout and the geography settings', () => {
  let hosts: HTMLElement[] = []
  let maps: ApexMaps[] = []

  const host = (): HTMLElement => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    hosts.push(el)
    return el
  }

  const make = async (options: ApexMapsOptions): Promise<ApexMaps> => {
    const map = new ApexMaps(host(), {
      chart: { width: WIDTH, height: HEIGHT },
      debug: { enabled: false },
      series: [],
      ...options,
    })
    maps.push(map)
    await map.render()
    return map
  }

  /** Whether the grid sits inside the plot and fills it along one axis. */
  const framed = (map: ApexMaps): boolean => {
    const b = map.viewport.measure(map.geo!.collection)!
    const inside = b[0][0] >= -1 && b[0][1] >= -1 && b[1][0] <= WIDTH + 1 && b[1][1] <= HEIGHT + 1
    const fills = b[1][0] - b[0][0] > WIDTH * 0.8 || b[1][1] - b[0][1] > HEIGHT * 0.8
    return inside && fills
  }

  beforeEach(() => {
    installCatalogue()
    setGeoSource((file) => Promise.resolve(readPack(file)))
  })

  afterEach(() => {
    for (const map of maps) map.destroy()
    for (const el of hosts) el.remove()
    maps = []
    hosts = []
    setGeoSource(DEFAULT_GEO_SOURCE)
    _resetGeoLoads()
    _resetRegistry()
    installCatalogue()
    vi.unstubAllGlobals()
  })

  it('draws the grid with its own projection, whatever the geography view asked for', async () => {
    const map = await make({ geo: { map: 'us', layout: 'hex', projection: 'mercator' } })
    expect(map.viewport.projectionName).toBe('identity')
    expect(framed(map)).toBe(true)
  })

  it('frames the grid with its own fit, not a lon/lat box meant for the geography', async () => {
    // Read as plane coordinates, a box round the lower 48 is nowhere near the
    // cells, which sit within a few dozen units of the origin.
    const map = await make({ geo: { map: 'us', layout: 'hex', view: { fit: CONUS } } })
    expect(framed(map)).toBe(true)
  })

  it('gives the geography view its projection and fit back on switching out of the grid', async () => {
    const geography: ApexMapsOptions = {
      geo: { map: 'us', projection: 'mercator', view: { fit: CONUS } },
    }
    const reference = await make(geography)
    const map = await make({ geo: { ...geography.geo, layout: 'hex' } })
    expect(map.viewport.projectionName).toBe('identity')

    await map.updateOptions({ geo: { layout: null } })
    expect(map.viewport.projectionName).toBe('mercator')
    // Framed exactly as a map that never saw the grid.
    for (const place of [
      [-122.4, 37.8],
      [-74, 40.7],
      [-87.6, 41.9],
    ] as [number, number][]) {
      const [x, y] = map.viewport.project(place)!
      const [rx, ry] = reference.viewport.project(place)!
      expect(x).toBeCloseTo(rx, 6)
      expect(y).toBeCloseTo(ry, 6)
    }

    await map.updateOptions({ geo: { layout: 'hex' } })
    expect(map.viewport.projectionName).toBe('identity')
    expect(framed(map)).toBe(true)
  })

  it('lets updateOptions clear a projection by passing undefined', async () => {
    const plain = await make({ geo: { map: 'us' } })
    const map = await make({ geo: { map: 'us', projection: 'mercator' } })
    expect(map.viewport.projectionName).toBe('mercator')

    await map.updateOptions({ geo: { projection: undefined } })
    expect(map.viewport.projectionName).toBe(plain.viewport.projectionName)
    expect(map.viewport.projectionName).not.toBe('mercator')
  })

  it('leaves a geography-only map framed by the caller as before', async () => {
    const map = await make({ geo: { map: 'us', projection: 'mercator', view: { fit: CONUS } } })
    expect(map.viewport.projectionName).toBe('mercator')
    // The box is fitted: its corners land inside the plot, at the padding.
    const [x0, y0] = map.viewport.project([CONUS[0], CONUS[3]])!
    const [x1, y1] = map.viewport.project([CONUS[2], CONUS[1]])!
    expect(Math.min(x0, y0)).toBeGreaterThanOrEqual(15)
    expect(Math.max(WIDTH - x1, HEIGHT - y1)).toBeGreaterThanOrEqual(15)
    expect(Math.min(x0 - 16, WIDTH - 16 - x1) < 1 || Math.min(y0 - 16, HEIGHT - 16 - y1) < 1).toBe(
      true,
    )
  })

  it('does not tell a tiled map to set the projection it already set when it turns into a grid', async () => {
    // The tiles stand down under the grid by design; the warning is for a
    // geography view on the wrong projection, which this is not.
    const tiles = { url: 'https://tiles.example/{z}/{x}/{y}.png' }
    const map = await make({ geo: { map: 'us', projection: 'webMercator', tiles } })
    const tileWarning = () => map.warnings.filter((w) => w.includes('geo.tiles'))
    expect(tileWarning()).toEqual([])

    await map.updateOptions({ geo: { layout: 'hex' } })
    expect(map.viewport.projectionName).toBe('identity')
    expect(tileWarning()).toEqual([])

    await map.updateOptions({ geo: { layout: null } })
    expect(map.viewport.projectionName).toBe('webMercator')
    expect(tileWarning()).toEqual([])

    // A geography view on a projection the tiles cannot use still says so.
    await map.updateOptions({ geo: { projection: 'equalEarth' } })
    expect(tileWarning()).toHaveLength(1)
  })
})

describe.skipIf(!hasPacks)('the camera across a layout toggle', () => {
  let el: HTMLElement
  let map: ApexMaps | null = null

  beforeEach(() => {
    installCatalogue()
    setGeoSource((file) => Promise.resolve(readPack(file)))
    el = document.createElement('div')
    document.body.appendChild(el)
  })

  afterEach(() => {
    map?.destroy()
    map = null
    el.remove()
    setGeoSource(DEFAULT_GEO_SOURCE)
    _resetGeoLoads()
    _resetRegistry()
    installCatalogue()
    vi.unstubAllGlobals()
  })

  /** A geography view the reader has zoomed into one corner of. */
  const zoomed = async (options: ApexMapsOptions = {}): Promise<ApexMaps> => {
    const instance = new ApexMaps(el, {
      chart: { width: WIDTH, height: HEIGHT },
      debug: { enabled: false },
      geo: { map: 'us' },
      series: [],
      ...options,
    })
    await instance.render()
    instance.camera!.jumpTo({ k: 6, x: -2400, y: -1500 })
    expect(instance.zoom).toBe(6)
    return instance
  }

  const atFit = (instance: ApexMaps) => {
    const { k, x, y } = instance.viewport.camera
    return { k, x: Math.round(x * 1e6) / 1e6, y: Math.round(y * 1e6) / 1e6 }
  }

  it('resets a zoomed camera to the fit when the layout changes', async () => {
    map = await zoomed({ chart: { width: WIDTH, height: HEIGHT, animations: { enabled: false } } })
    await map.updateOptions({ geo: { layout: 'hex' } })
    expect(atFit(map)).toEqual({ k: 1, x: 0, y: 0 })
  })

  it('resets it coming back out of the grid too', async () => {
    map = await zoomed({ chart: { width: WIDTH, height: HEIGHT, animations: { enabled: false } } })
    await map.updateOptions({ geo: { layout: 'hex' } })
    // A caller can still move the camera on a grid in code.
    map.camera!.jumpTo({ k: 3, x: -500, y: -300 })
    await map.updateOptions({ geo: { layout: null } })
    expect(atFit(map)).toEqual({ k: 1, x: 0, y: 0 })
  })

  it('jumps under reduced motion, even with animations on', async () => {
    vi.stubGlobal('matchMedia', ((query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof matchMedia)
    map = await zoomed()
    await map.updateOptions({ geo: { layout: 'hex' } })
    expect(atFit(map)).toEqual({ k: 1, x: 0, y: 0 })
  })

  it('eases alongside the morph, starting from where the reader was', async () => {
    let clock = 1000
    vi.stubGlobal('requestAnimationFrame', ((cb: FrameRequestCallback) => {
      clock += 100
      return setTimeout(() => cb(clock), 0) as unknown as number
    }) as unknown as typeof requestAnimationFrame)
    vi.stubGlobal('cancelAnimationFrame', ((id: number) =>
      clearTimeout(id)) as unknown as typeof cancelAnimationFrame)

    map = await zoomed()
    await map.updateOptions({ geo: { layout: 'hex' } })
    // The morph paints the old shapes first, so the camera must not have jumped
    // out from under them yet.
    expect(el.classList.contains('apexmaps--morphing')).toBe(true)
    expect(map.zoom).toBe(6)

    for (let i = 0; i < 30 && el.classList.contains('apexmaps--morphing'); i++) {
      await new Promise((r) => setTimeout(r, 0))
    }
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    expect(el.classList.contains('apexmaps--morphing')).toBe(false)
    expect(atFit(map)).toEqual({ k: 1, x: 0, y: 0 })
  })

  it('keeps the reader where they were across an unrelated update', async () => {
    map = await zoomed({ chart: { width: WIDTH, height: HEIGHT, animations: { enabled: false } } })
    await map.updateOptions({ legend: { show: false } })
    expect(map.zoom).toBe(6)
  })
})
