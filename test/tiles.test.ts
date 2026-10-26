// @vitest-environment jsdom
/**
 * `geo.tiles` and the `viewChange` event.
 *
 * Asked for against 1.1.1 (#5): point maps of offices or incidents, where the
 * reader zooms into a city and needs streets to read the points against. The
 * event is the smaller half of the ask, so a host can keep its own layer in
 * step with the map; the tile layer is the built-in version of the same thing.
 *
 * jsdom loads no images, so a tile's arrival is a `load` event dispatched by
 * hand, which is also how these tests decide when it arrives.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import ApexMaps from '../src/ApexMaps'
import { fillTileUrl } from '../src/renderers/TileLayer'
import { serializeSvg } from '../src/export/Exporter'
import type { ApexMapsOptions, TileOptions } from '../src/types'

const GEO = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { iso_a3: 'BOX', name: 'Box' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-10, -10],
            [-10, 10],
            [10, 10],
            [10, -10],
            [-10, -10],
          ],
        ],
      },
    },
  ],
}

const TILES: TileOptions = {
  url: 'https://{s}.tiles.test/{z}/{x}/{y}.png',
  attribution: '© Test tiles',
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
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function build(options: ApexMapsOptions = {}, tiles: TileOptions | null = TILES) {
  const { geo, ...rest } = options
  map = new ApexMaps(el, {
    chart: { width: 400, height: 300, animations: { enabled: false } },
    debug: { enabled: false },
    series: [{ type: 'marker', name: 'Sites', data: [{ lon: 0, lat: 0 }] }],
    ...rest,
    geo: { map: GEO as never, projection: 'webMercator', ...(tiles ? { tiles } : {}), ...geo },
  })
  await map.render()
  return map
}

const tiles = () => [...el.querySelectorAll<SVGImageElement>('image.apexmaps-tile')]
const levels = () => [...el.querySelectorAll<SVGGElement>('g.apexmaps-tiles')]
const hrefs = () => tiles().map((t) => t.getAttribute('href'))
const flush = () => new Promise((r) => setTimeout(r, 0))
const loadAll = () => tiles().forEach((t) => t.dispatchEvent(new Event('load')))

describe('fillTileUrl', () => {
  it('fills z, x and y, and picks a subdomain by position', () => {
    expect(fillTileUrl(TILES, { z: 3, x: 4, y: 2 })).toBe('https://a.tiles.test/3/4/2.png')
    expect(fillTileUrl(TILES, { z: 3, x: 4, y: 3 })).toBe('https://b.tiles.test/3/4/3.png')
    expect(fillTileUrl({ url: '{s}/{z}', subdomains: 'xy' }, { z: 1, x: 1, y: 0 })).toBe('y/1')
  })
})

describe('geo.tiles', () => {
  it('requests nothing unless a url is configured', async () => {
    await build({}, null)
    expect(tiles()).toHaveLength(0)
    expect(el.classList.contains('apexmaps--tiles')).toBe(false)
  })

  it('draws the tiles in view, at the level that matches the camera', async () => {
    await build()
    await flush()
    const z = Math.round(map.viewport.webZoom())
    expect(levels().map((g) => g.getAttribute('data-z'))).toEqual([String(z)])
    expect(tiles().length).toBeGreaterThan(0)
    for (const href of hrefs())
      expect(href).toMatch(new RegExp(`^https://[abc]\\.tiles\\.test/${z}/\\d+/\\d+\\.png$`))
  })

  it('places a tile on the rectangle its corners project to', async () => {
    await build()
    await flush()
    const tile = tiles()[0]
    const [, z, x, y] = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(tile.getAttribute('href')!)!.map(Number)
    const n = 2 ** z
    const lon = (x / n) * 360 - 180
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
    const [wx, wy] = map.viewport.project([lon, lat])
    expect(Number(tile.getAttribute('x'))).toBeCloseTo(wx, 6)
    expect(Number(tile.getAttribute('y'))).toBeCloseTo(wy, 6)
  })

  it('sits in the world group, under the series, so the camera moves it', async () => {
    await build()
    await flush()
    const layer = el.querySelector('.apexmaps-layer-tiles')!
    expect(layer.parentElement!.classList.contains('apexmaps-world')).toBe(true)
    expect(layer.nextElementSibling!.classList.contains('apexmaps-layer-marks')).toBe(true)
  })

  it('gives the basemap way and credits the provider while tiles show', async () => {
    await build()
    await flush()
    expect(el.classList.contains('apexmaps--tiles')).toBe(true)
    expect(el.querySelector('.apexmaps-attribution')!.textContent).toContain('© Test tiles')
  })

  it('draws nothing below minZoom', async () => {
    await build({}, { ...TILES, minZoom: 30 })
    await flush()
    expect(tiles()).toHaveLength(0)
    expect(el.classList.contains('apexmaps--tiles')).toBe(false)
    expect(el.querySelector('.apexmaps-attribution')?.textContent ?? '').not.toContain('Test tiles')
  })

  it('stretches the last level past maxZoom instead of asking for more', async () => {
    await build({}, { ...TILES, maxZoom: 2 })
    await flush()
    expect(levels().map((g) => g.getAttribute('data-z'))).toEqual(['2'])
  })

  it('draws nothing on a projection the tiles were not cut in, and says why', async () => {
    await build({ geo: { projection: 'equirectangular' } })
    await flush()
    expect(tiles()).toHaveLength(0)
    expect(map.warnings.join('\n')).toMatch(/geo\.tiles needs geo\.projection 'webMercator'/)
  })

  it('clears when the Mercator is turned', async () => {
    await build()
    await flush()
    expect(tiles().length).toBeGreaterThan(0)
    map.rotateTo([30, 0, 0])
    expect(tiles()).toHaveLength(0)
  })

  it('fetches the tiles a pan uncovers, without touching the ones in view', async () => {
    await build()
    await flush()
    const before = new Set(hrefs())
    const first = tiles()[0]
    map.camera.panBy(-map.viewport.width, 0)
    await flush()
    const after = hrefs()
    expect(after.some((h) => !before.has(h))).toBe(true)
    // Same level: no new group, and a tile still near the view kept its element.
    expect(levels()).toHaveLength(1)
    if (first.isConnected) expect(tiles()).toContain(first)
  })

  it('keeps the old level under the new one until the new one has loaded', async () => {
    await build()
    await flush()
    loadAll()
    const z = Number(levels()[0].getAttribute('data-z'))

    map.camera.jumpTo({ zoom: map.viewport.camera.k * 4 })
    // Still mid-zoom as far as the layer knows: no requests at the new level yet.
    expect(levels()).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 200))
    await flush()

    expect(levels().map((g) => Number(g.getAttribute('data-z')))).toEqual([z, z + 2])
    loadAll()
    expect(levels().map((g) => Number(g.getAttribute('data-z')))).toEqual([z + 2])
  })

  it('hands every tile to the request hook, and loads what it returns', async () => {
    const request = vi.fn((url: string) => url.replace('https://', 'https://proxy.test/'))
    await build({}, { ...TILES, request })
    await flush()
    expect(request).toHaveBeenCalled()
    const [url, coord] = request.mock.calls[0] as unknown as [string, { z: number }]
    expect(url).toMatch(/^https:\/\/[abc]\.tiles\.test\//)
    expect(coord).toEqual({ z: expect.any(Number), x: expect.any(Number), y: expect.any(Number) })
    for (const href of hrefs()) expect(href).toMatch(/^https:\/\/proxy\.test\//)
  })

  it('fetches with headers when the hook asks for them, and frees the bytes after', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['png']) }))
    vi.stubGlobal('fetch', fetchMock)
    let n = 0
    const created: string[] = []
    const revoke = vi.fn()
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: () => {
          const u = `blob:tile-${n++}`
          created.push(u)
          return u
        },
        revokeObjectURL: revoke,
      }),
    )

    await build(
      {},
      { ...TILES, request: (url) => ({ url, headers: { Authorization: 'Bearer k' } }) },
    )
    await new Promise((r) => setTimeout(r, 10))

    expect(fetchMock).toHaveBeenCalled()
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toEqual({ Authorization: 'Bearer k' })
    expect(hrefs().every((h) => h!.startsWith('blob:tile-'))).toBe(true)

    map.destroy()
    expect(revoke.mock.calls.map(([u]) => u).sort()).toEqual([...created].sort())
  })

  it('leaves out a tile the server could not supply', async () => {
    await build()
    await flush()
    const count = tiles().length
    tiles()[0].dispatchEvent(new Event('error'))
    expect(tiles()).toHaveLength(count - 1)
  })

  it('is left out of an export', async () => {
    await build()
    await flush()
    loadAll()
    expect(serializeSvg(map.renderer.root)).not.toContain('apexmaps-tile')
    // The live map is untouched by the export.
    expect(tiles().length).toBeGreaterThan(0)
  })

  it('re-places its tiles when the map is resized', async () => {
    await build()
    await flush()
    const tile = tiles()[0]
    const before = tile.getAttribute('width')
    await map.updateOptions({ chart: { width: 800, height: 600 } })
    await flush()
    if (tile.isConnected) expect(tile.getAttribute('width')).not.toBe(before)
    else expect(tiles().length).toBeGreaterThan(0)
  })

  it('drops everything on destroy', async () => {
    await build()
    await flush()
    map.destroy()
    expect(tiles()).toHaveLength(0)
    expect(el.classList.contains('apexmaps--tiles')).toBe(false)
  })
})

describe('viewChange', () => {
  it('reports the bounds, centre and web zoom once rendered, and on every move', async () => {
    const seen: any[] = []
    map = new ApexMaps(el, {
      chart: { width: 400, height: 300, animations: { enabled: false } },
      geo: { map: GEO as never, projection: 'webMercator' },
      debug: { enabled: false },
    })
    map.on('viewChange', (view: any) => seen.push(view))
    await map.render()

    expect(seen).toHaveLength(1)
    const [[west, south], [east, north]] = seen[0].bounds
    // The box fills the plot, less padding, so the view holds it with a little room.
    expect(west).toBeLessThan(-10)
    expect(east).toBeGreaterThan(10)
    expect(south).toBeLessThan(-10)
    expect(north).toBeGreaterThan(10)
    expect(seen[0].center[0]).toBeCloseTo(0, 6)
    expect(seen[0].zoom).toBeCloseTo(map.viewport.webZoom(), 9)
    expect(seen[0].k).toBe(1)

    map.camera.jumpTo({ zoom: 2 })
    const last = seen.at(-1)
    expect(last.k).toBe(2)
    expect(last.zoom).toBeCloseTo(seen[0].zoom + 1, 9)
    expect(last.bounds[1][0] - last.bounds[0][0]).toBeCloseTo((east - west) / 2, 6)
    expect(map.getView()).toEqual(last)
  })

  it('has no web zoom where no tile level matches the map', async () => {
    map = new ApexMaps(el, {
      chart: { width: 400, height: 300 },
      geo: { map: GEO as never, projection: 'equirectangular' },
      debug: { enabled: false },
    })
    await map.render()
    const view = map.getView()
    expect(view.zoom).toBeNull()
    expect(view.bounds).not.toBeNull()
  })
})
