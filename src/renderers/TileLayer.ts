/**
 * Raster tiles under the map.
 *
 * The layer lives inside the world group, beside the geometry, so the camera's
 * one transform moves the tiles and the regions together: a pan frame costs no
 * tile work at all, and the streets cannot drift off the points drawn on them.
 * Tile work happens only when a new tile comes into view or the level changes.
 *
 * A tile is placed by projecting its corners. On an unturned Mercator, which
 * is the only projection this draws on, a tile's corners land on an
 * axis-aligned rectangle in world space, so the image is that rectangle and
 * nothing is resampled.
 *
 * Level changes keep the outgoing level on screen, under the incoming one,
 * until the incoming tiles in view have loaded. Swapping at once would blank
 * the map for as long as the network takes, on every zoom step.
 *
 * @module renderers/TileLayer
 */

import { svg, remove } from '../utils/dom'
import type { Viewport } from '../geo/Viewport'
import type { LonLat, TileCoord, TileOptions, TileRequest } from '../types'

const DEFAULT_SUBDOMAINS = ['a', 'b', 'c']
const DEFAULT_MAX_ZOOM = 19
/** Spherical Mercator stops here: the latitude that makes the world square. */
const MAX_LATITUDE = 85.0511287798066
/**
 * How long a zoom has to rest before tiles are requested at its new level. A
 * wheel or a pinch passes through several levels on its way, and fetching each
 * of them would spend the reader's bandwidth on tiles that are never seen.
 */
const LEVEL_DELAY = 150
/**
 * A tile range this large means a degenerate view rather than a map, for
 * instance a plot a few pixels tall. Requesting it would be a burst of
 * hundreds of requests for nothing a reader could see.
 */
const MAX_TILES = 400

interface Tile {
  coord: TileCoord
  el: SVGImageElement
  settled: boolean
  /** Set when the tile leaves before its request finishes. */
  cancelled: boolean
  abort?: AbortController
  objectUrl?: string
}

interface Level {
  z: number
  group: SVGGElement
  tiles: Map<string, Tile>
}

export class TileLayer {
  readonly layer: SVGGElement
  private readonly viewport: Viewport
  private readonly onVisibility: (visible: boolean) => void
  private options: TileOptions | null = null
  private level: Level | null = null
  /** The previous level, kept under the new one until the new one has loaded. */
  private retiring: Level | null = null
  private levelTimer: ReturnType<typeof setTimeout> | null = null
  private _visible = false

  constructor({
    layer,
    viewport,
    onVisibility,
  }: {
    /** The group to draw into. Inside the world group, under the geometry. */
    layer: SVGGElement
    viewport: Viewport
    /** Tiles appeared or went away, for the attribution and the basemap. */
    onVisibility: (visible: boolean) => void
  }) {
    this.layer = layer
    this.viewport = viewport
    this.onVisibility = onVisibility
  }

  get visible(): boolean {
    return this._visible
  }

  /**
   * Why tiles cannot be drawn with these options on this projection, or null.
   * Debug mode reports it; the layer itself just stays empty.
   */
  get problem(): string | null {
    if (!this.options?.url) return null
    if (this.viewport.tileAligned) return null
    return (
      `geo.tiles needs geo.projection 'webMercator' with no rotation, because that is ` +
      `the projection the tiles were cut in. On '${this.viewport.projectionName}' they ` +
      'would not line up with the map, so none are drawn.'
    )
  }

  /** New options. A different source drops every tile that came from the old one. */
  setOptions(options: TileOptions | null | undefined): void {
    const next = options?.url ? options : null
    const sameSource =
      next != null &&
      this.options != null &&
      next.url === this.options.url &&
      next.request === this.options.request &&
      String(next.subdomains ?? '') === String(this.options.subdomains ?? '') &&
      (next.tileSize ?? 256) === (this.options.tileSize ?? 256)
    if (!sameSource) this.clear()
    this.options = next
    this.layer.setAttribute('opacity', String(next?.opacity ?? 1))
  }

  /**
   * Bring the tiles in line with the camera. Called on every camera frame, so
   * the common case (a pan inside tiles already loaded) returns after a few
   * divisions.
   */
  update(): void {
    const options = this.options
    const zoom = this.viewport.webZoom()
    if (!options || zoom == null || zoom < (options.minZoom ?? 0)) {
      this.clear()
      return
    }

    const z = Math.max(0, Math.min(options.maxZoom ?? DEFAULT_MAX_ZOOM, Math.round(zoom)))
    if (this.level && this.level.z !== z) {
      // Mid-zoom: leave the current level riding the transform and come back
      // once the camera has settled on a level.
      if (this.levelTimer !== null) clearTimeout(this.levelTimer)
      this.levelTimer = setTimeout(() => {
        this.levelTimer = null
        this._show(z)
      }, LEVEL_DELAY)
      return
    }
    if (this.levelTimer !== null) {
      // Back at the level on screen before the timer fired: nothing to switch.
      clearTimeout(this.levelTimer)
      this.levelTimer = null
    }
    this._show(z)
  }

  /**
   * The projection was refitted (a resize, a new map, a drilldown), so every
   * tile's world rectangle moved. Re-place what is there, then fill in.
   */
  refresh(): void {
    for (const level of [this.retiring, this.level]) {
      if (!level) continue
      for (const tile of level.tiles.values()) this._place(tile)
    }
    this.update()
  }

  /** Every tile gone, every request abandoned. */
  clear(): void {
    if (this.levelTimer !== null) {
      clearTimeout(this.levelTimer)
      this.levelTimer = null
    }
    this._drop(this.retiring)
    this._drop(this.level)
    this.retiring = null
    this.level = null
    this._setVisible(false)
  }

  destroy(): void {
    this.clear()
    remove(this.layer)
  }

  private _show(z: number): void {
    const range = this._range(z)
    if (!range) {
      this.clear()
      return
    }

    if (!this.level || this.level.z !== z) {
      // One level kept for cover at most. A second zoom before the first has
      // loaded would otherwise stack levels for as long as the reader keeps going.
      this._drop(this.retiring)
      this.retiring = this.level
      const group = svg('g', { class: 'apexmaps-tiles', 'data-z': z }) as SVGGElement
      this.layer.appendChild(group)
      this.level = { z, group, tiles: new Map() }
    }

    const level = this.level
    const [x0, y0, x1, y1] = range
    // Tiles just outside the view are kept, so panning back and forth across a
    // tile edge does not fetch the same tile again and again.
    for (const [key, tile] of level.tiles) {
      const { x, y } = tile.coord
      if (x < x0 - 1 || x > x1 + 1 || y < y0 - 1 || y > y1 + 1) {
        this._dropTile(tile)
        level.tiles.delete(key)
      }
    }
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const key = `${z}/${x}/${y}`
        if (!level.tiles.has(key)) level.tiles.set(key, this._load({ z, x, y }, level))
      }
    }

    this._setVisible(true)
    this._retireIfCovered()
  }

  /** Inclusive tile index range on screen at level `z`, or null for none. */
  private _range(z: number): [number, number, number, number] | null {
    const { width, height } = this.viewport
    const nw = this.viewport.screenToLonLat([0, 0])
    const se = this.viewport.screenToLonLat([width, height])
    if (!nw || !se) return null
    const n = 2 ** z
    const clamp = (i: number) => Math.max(0, Math.min(n - 1, Math.floor(i)))
    const x0 = clamp(lonToTileX(nw[0], n))
    const x1 = clamp(lonToTileX(se[0], n))
    const y0 = clamp(latToTileY(nw[1], n))
    const y1 = clamp(latToTileY(se[1], n))
    // Panned clean off the world: nothing on screen has a tile.
    if (se[0] <= -180 || nw[0] >= 180) return null
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_TILES) return null
    return [x0, y0, x1, y1]
  }

  private _load(coord: TileCoord, level: Level): Tile {
    const el = svg('image', {
      class: 'apexmaps-tile',
      preserveAspectRatio: 'none',
      'aria-hidden': 'true',
    }) as SVGImageElement
    const tile: Tile = { coord, el, settled: false, cancelled: false }
    this._place(tile)
    level.group.appendChild(el)

    const settle = (ok: boolean) => {
      if (tile.cancelled || tile.settled) return
      tile.settled = true
      // A tile the server could not supply is left out rather than drawn
      // broken. The level underneath, if any, still covers its square.
      if (ok) el.classList.add('is-loaded')
      else remove(el)
      this._retireIfCovered()
    }
    el.addEventListener('load', () => settle(true))
    el.addEventListener('error', () => settle(false))

    void this._resolve(tile)
      .then((href) => {
        if (tile.cancelled) return
        if (href == null) settle(false)
        else el.setAttribute('href', href)
      })
      .catch(() => settle(false))
    return tile
  }

  /** The URL to put on the image, after the host's request hook has had its say. */
  private async _resolve(tile: Tile): Promise<string | null> {
    const options = this.options
    if (!options) return null
    const url = fillTileUrl(options, tile.coord)
    const request: TileRequest = options.request ? await options.request(url, tile.coord) : url
    if (tile.cancelled) return null
    if (typeof request === 'string') return request
    if (!request?.url) return null
    if (!request.headers || !Object.keys(request.headers).length) return request.url

    // Headers cannot ride on an image request, so the tile is fetched and the
    // image pointed at the bytes. The object URL is revoked when the tile goes.
    tile.abort = typeof AbortController === 'undefined' ? undefined : new AbortController()
    const response = await fetch(request.url, {
      headers: request.headers,
      signal: tile.abort?.signal,
    })
    if (!response.ok) return null
    const blob = await response.blob()
    if (tile.cancelled) return null
    tile.objectUrl = URL.createObjectURL(blob)
    return tile.objectUrl
  }

  private _place(tile: Tile): void {
    const { z, x, y } = tile.coord
    const n = 2 ** z
    const nw = this.viewport.project([tileXToLon(x, n), tileYToLat(y, n)])
    const se = this.viewport.project([tileXToLon(x + 1, n), tileYToLat(y + 1, n)])
    if (!nw || !se) return
    const width = se[0] - nw[0]
    const height = se[1] - nw[1]
    // Half a source pixel of overlap on the far edges. Neighbouring images are
    // antialiased independently, and without it the seam between them shows
    // through as a hairline grid at most zoom levels.
    const bleed = 0.5 / (this.options?.tileSize ?? 256)
    tile.el.setAttribute('x', String(nw[0]))
    tile.el.setAttribute('y', String(nw[1]))
    tile.el.setAttribute('width', String(width * (1 + bleed)))
    tile.el.setAttribute('height', String(height * (1 + bleed)))
  }

  /** Drop the outgoing level once every tile of the incoming one has settled. */
  private _retireIfCovered(): void {
    if (!this.retiring || !this.level) return
    for (const tile of this.level.tiles.values()) if (!tile.settled) return
    this._drop(this.retiring)
    this.retiring = null
  }

  private _drop(level: Level | null): void {
    if (!level) return
    for (const tile of level.tiles.values()) this._dropTile(tile)
    level.tiles.clear()
    remove(level.group)
  }

  private _dropTile(tile: Tile): void {
    tile.cancelled = true
    tile.abort?.abort()
    if (tile.objectUrl) URL.revokeObjectURL(tile.objectUrl)
    remove(tile.el)
  }

  private _setVisible(visible: boolean): void {
    if (visible === this._visible) return
    this._visible = visible
    this.onVisibility(visible)
  }
}

/** The template with this tile's numbers, and a subdomain chosen by position. */
export function fillTileUrl(options: TileOptions, { z, x, y }: TileCoord): string {
  const subdomains =
    typeof options.subdomains === 'string'
      ? options.subdomains.split('')
      : (options.subdomains ?? DEFAULT_SUBDOMAINS)
  // By position rather than at random, so a tile always comes from the same
  // host and the browser cache recognises it on the way back.
  const s = subdomains.length ? subdomains[Math.abs(x + y) % subdomains.length] : ''
  return options.url
    .replace(/\{z\}/g, String(z))
    .replace(/\{x\}/g, String(x))
    .replace(/\{y\}/g, String(y))
    .replace(/\{s\}/g, s)
}

function lonToTileX(lon: number, n: number): number {
  return ((lon + 180) / 360) * n
}

function latToTileY(lat: number, n: number): number {
  const phi = (Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat)) * Math.PI) / 180
  return ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n
}

function tileXToLon(x: number, n: number): LonLat[0] {
  return (x / n) * 360 - 180
}

function tileYToLat(y: number, n: number): LonLat[1] {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
}
