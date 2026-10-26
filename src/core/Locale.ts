/**
 * The map's own text, with its English defaults.
 *
 * Kept in one place so a translation has one list to work through, and so a
 * string added to a component later has an obvious home rather than becoming
 * the next English literal nobody can reach.
 *
 * @module core/Locale
 */

import type { LocaleOptions } from '../types'

/** Every key of {@link LocaleOptions}, filled in. */
export type ResolvedLocale = {
  [K in keyof LocaleOptions]-?: NonNullable<LocaleOptions[K]> extends string
    ? string
    : Required<NonNullable<LocaleOptions[K]>>
}

export const DEFAULT_LOCALE: ResolvedLocale = {
  zoomControls: { group: 'Zoom', zoomIn: 'Zoom in', zoomOut: 'Zoom out', reset: 'Reset view' },
  breadcrumb: { label: 'Drilldown trail', root: 'All areas' },
  dataTable: { caption: 'Map data', area: 'Area', item: 'Item', value: 'Value' },
  noData: 'No data',
  sizeLegend: 'Circle sizes: {sizes}',
  drilldown: {
    announce: 'Showing {count} {level}.',
    announceIn: 'Showing {count} {level} in {where}. Press Escape to go back.',
    areas: 'areas',
  },
}

/**
 * The caller's strings over the defaults, one group at a time.
 *
 * A group is merged rather than replaced, so translating `zoomIn` alone keeps
 * the English `zoomOut` instead of leaving it blank. An empty string is kept:
 * it is a deliberate choice, not a missing translation.
 */
export function resolveLocale(locale: LocaleOptions | undefined): ResolvedLocale {
  const out = { ...DEFAULT_LOCALE } as Record<string, unknown>
  for (const [key, value] of Object.entries(locale ?? {})) {
    if (value == null) continue
    const fallback = (DEFAULT_LOCALE as Record<string, unknown>)[key]
    if (fallback === undefined) continue
    if (typeof fallback === 'string') {
      if (typeof value === 'string') out[key] = value
    } else if (typeof value === 'object') {
      const group = { ...(fallback as Record<string, string>) }
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === 'string' && k in group) group[k] = v
      }
      out[key] = group
    }
  }
  return out as ResolvedLocale
}

/** Fill `{name}` placeholders. One with no value is left as written. */
export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  )
}
