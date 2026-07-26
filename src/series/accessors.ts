/**
 * Field accessors shared by every series.
 *
 * Each accepts a key, a dotted path, or a function, so the same option can be
 * written declaratively (`valueField: 'metrics.total'`, which survives
 * serialisation) or imperatively (`valueField: (d) => d.a + d.b`) without the
 * series needing to care which.
 *
 * @module series/accessors
 */

export type FieldAccessor<T> = string | ((datum: unknown) => T | null | undefined)

/** Read a raw field value, resolving dotted paths and accessor functions. */
export function readField(source: unknown, field: FieldAccessor<unknown>): unknown {
  if (source == null) return undefined

  if (typeof field === 'function') return field(source)

  if (typeof field === 'string' && field.includes('.')) {
    return field
      .split('.')
      .reduce<unknown>(
        (acc, key) => (acc == null ? acc : (acc as Record<string, unknown>)[key]),
        source,
      )
  }

  return (source as Record<string, unknown>)[field as string]
}

/**
 * Read a numeric field. Returns null for anything that is not a finite number,
 * so a missing value can never be mistaken for zero.
 */
export function readNumber(source: unknown, field: FieldAccessor<number>): number | null {
  const raw = readField(source, field as FieldAccessor<unknown>)
  if (raw == null || raw === '') return null
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) ? n : null
}

/** Read a field as a display string, or undefined when absent. */
export function readText(source: unknown, field: FieldAccessor<string>): string | undefined {
  const raw = readField(source, field as FieldAccessor<unknown>)
  if (raw == null || raw === '') return undefined
  return String(raw)
}

/** Read a `[lon, lat]` pair, tolerating `{lon, lat}`, `{lng, lat}` and array form. */
export function readLonLat(value: unknown): [number, number] | null {
  if (Array.isArray(value) && value.length >= 2) {
    const [lon, lat] = value
    if (
      typeof lon === 'number' &&
      typeof lat === 'number' &&
      Number.isFinite(lon) &&
      Number.isFinite(lat)
    ) {
      return [lon, lat]
    }
    return null
  }

  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    const lon = typeof o.lon === 'number' ? o.lon : typeof o.lng === 'number' ? o.lng : null
    const lat = typeof o.lat === 'number' ? o.lat : null
    if (lon != null && lat != null && Number.isFinite(lon) && Number.isFinite(lat))
      return [lon, lat]
  }

  return null
}
