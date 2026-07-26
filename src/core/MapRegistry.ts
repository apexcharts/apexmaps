/**
 * Geometry registry.
 *
 * `geo.map` accepts a registry id (`'world/countries@2024'`), a URL, or a raw
 * GeoJSON/TopoJSON object. The registry exists so that geometry can carry
 * **provenance**: source, licence, vintage and simplification level travel with
 * the geometry and can be surfaced in the UI, in exports, and in an automatic
 * attribution string.
 *
 * That metadata is the boring half of the moat described in PRODUCT-RESEARCH.md
 * section 5.7: boundaries change, statistical data is tied to a vintage, and
 * "which year's county lines are these?" is a question a research or government
 * user will eventually ask. A registry that cannot answer it is not trustworthy.
 *
 * @module core/MapRegistry
 */

import type { GeoInput, MapSource } from '../types'
import { similarity, normalizeKey } from '../data/Join'

export interface MapMeta {
  /** e.g. 'Natural Earth 5.1.1'. */
  source?: string
  /** e.g. 'public domain'. */
  license?: string
  /** Text to display. Empty for public-domain sources. */
  attribution?: string
  /** Boundary vintage, e.g. '2024'. */
  vintage?: string
  detail?: 'low' | 'medium' | 'high'
  /** Disputed-territory policy this file encodes. */
  boundaries?: string
  /** Recommended join key. */
  keyField?: string
  [key: string]: unknown
}

export type MapLoader = () => Promise<GeoInput>

export interface MapEntry {
  /** Geometry, or a loader for it. */
  data: GeoInput | MapLoader
  meta?: MapMeta
}

const registry = new Map<string, MapEntry>()
const inflight = new Map<string, Promise<GeoInput>>()

/**
 * Register geometry under an id.
 *
 * The value may be a loader function returning a promise, which is how the
 * on-demand CDN packs will work without making the core bundle fetch anything by
 * default.
 *
 */
export function registerMap(id: string, data: GeoInput | MapLoader, meta?: MapMeta): void {
  if (typeof id !== 'string' || !id) {
    throw new TypeError('ApexMaps: map id must be a non-empty string')
  }
  if (!data) throw new TypeError(`ApexMaps: no geometry supplied for map "${id}"`)
  registry.set(id, { data, meta })
}

export function hasMap(id: string): boolean {
  return registry.has(id)
}

export function listMaps(): string[] {
  return [...registry.keys()].sort()
}

export function mapMeta(id: string): MapMeta | undefined {
  return registry.get(id)?.meta
}

function looksLikeUrl(value: string): boolean {
  return (
    /^(https?:)?\/\//.test(value) ||
    value.startsWith('/') ||
    value.startsWith('./') ||
    value.endsWith('.json')
  )
}

/**
 * Resolve `geo.map` to geometry.
 *
 */
export async function resolveMap(
  source: MapSource | null | undefined,
): Promise<{ data: GeoInput; meta?: MapMeta; id?: string }> {
  if (!source) {
    throw new Error(
      'ApexMaps: geo.map is required. Pass a registered id, a URL, or a GeoJSON/TopoJSON object.',
    )
  }

  if (typeof source !== 'string') return { data: source }

  const entry = registry.get(source)
  if (entry) {
    const data = typeof entry.data === 'function' ? await loadOnce(source, entry.data) : entry.data
    return { data, meta: entry.meta, id: source }
  }

  if (looksLikeUrl(source)) {
    const data = await loadOnce(source, () => fetchJson(source))
    return { data, id: source }
  }

  const available = listMaps()
  if (!available.length) {
    throw new Error(
      `ApexMaps: unknown map "${source}". No maps are registered. ` +
        'Use ApexMaps.registerMap(id, geometry) or pass geometry to geo.map directly.',
    )
  }

  // Forty-odd registered ids make "here is the whole list" useless, so answer the
  // question the developer actually asked. Same edit distance the join uses: a
  // mistyped id is the same class of mistake as a mistyped country name.
  const suggestions = suggestMapIds(source)
  throw new Error(
    `ApexMaps: unknown map "${source}". ` +
      (suggestions.length
        ? `Did you mean ${suggestions.map((s) => `"${s}"`).join(' or ')}? `
        : `${available.length} maps are registered. `) +
      'ApexMaps.listMaps() lists them all.',
  )
}

/**
 * Closest registered ids to something that did not resolve.
 *
 */
export function suggestMapIds(wanted: string, limit = 3): string[] {
  const target = normalizeKey(wanted)
  if (!target) return []
  return listMaps()
    .map((id) => ({ id, score: similarity(target, normalizeKey(id)) }))
    .filter((s) => s.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.id)
}

/**
 * Deduplicate concurrent loads of the same id, so ten maps of the same country
 * on one dashboard cause one fetch.
 *
 */
function loadOnce(key: string, loader: MapLoader): Promise<GeoInput> {
  const existing = inflight.get(key)
  if (existing) return existing

  const promise = loader()
    .then((data) => {
      // Replace the loader with the resolved value so later renders are synchronous.
      const entry = registry.get(key)
      if (entry) registry.set(key, { ...entry, data })
      inflight.delete(key)
      return data
    })
    .catch((error) => {
      inflight.delete(key)
      throw error
    })

  inflight.set(key, promise)
  return promise
}

async function fetchJson(url: string): Promise<GeoInput> {
  if (typeof fetch !== 'function') {
    throw new Error(
      `ApexMaps: cannot load "${url}" because fetch is unavailable in this environment`,
    )
  }
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`ApexMaps: failed to load geometry from "${url}" (HTTP ${response.status})`)
  }
  return response.json()
}

/**
 * Attribution string for a set of map ids, deduplicated. Rendered automatically
 * so a licence obligation cannot be forgotten.
 *
 */
export function attributionFor(ids: (string | undefined)[]): string {
  const seen = new Set<string>()
  for (const id of ids) {
    if (!id) continue
    const meta = mapMeta(id)
    if (meta?.attribution) seen.add(meta.attribution)
  }
  return [...seen].join(' · ')
}

/** Clear the registry. Test helper. */
export function _resetRegistry(): void {
  registry.clear()
  inflight.clear()
}
