/**
 * The map's theme for one render: its mode, and the colours the engine paints
 * from JS rather than from the stylesheet.
 *
 * The chrome (text, borders, focus, tooltip surface) is CSS: `ApexMaps.css`
 * chains each private `--_apexmaps-*` value through the page's `--apexmaps-*`
 * token, then the `--apx-*` family token, then the default. The colours below
 * are SVG attributes worked out in JS (the basemap, no-data, outlines, the
 * selection ring and the series defaults), so they take the same chain here,
 * read once per render from the map's computed style. Higher wins:
 *
 *   1. the option the page passed (the caller checks that, see `ApexMaps`)
 *   2. the map's own token: `--apexmaps-basemap`, `--apexmaps-no-data`,
 *      `--apexmaps-outline`, `--apexmaps-selected`
 *   3. the `--apx-*` family token: `--apx-series-N`, `--apx-font-family`
 *   4. a palette the page named (`theme.palette`), which keeps the series
 *      defaults built in
 *   5. the built-in default for the mode
 *
 * Token values are used as written, never normalised: an SVG attribute takes
 * any CSS colour, and the colour maths resolve the rest inside the map.
 *
 * SSR-safe: with no computed style every role is its default.
 *
 * @module core/Theme
 */

import { resolveTokenLayers } from 'apex-commons'

import type { ResolvedOptions } from '../types'

/** Built-in colours per mode. Outlines and the selection ring do not change with the mode. */
export const THEME_DEFAULTS = {
  light: { basemap: '#dfe4ea', noData: '#eeeeee', outline: '#ffffff', selected: '#111111' },
  dark: { basemap: '#374151', noData: '#374151', outline: '#ffffff', selected: '#111111' },
} as const

/** The map's own tokens for the JS-painted roles. */
export const MAP_TOKENS = {
  basemap: '--apexmaps-basemap',
  noData: '--apexmaps-no-data',
  outline: '--apexmaps-outline',
  selected: '--apexmaps-selected',
} as const

export type ThemeRole = keyof typeof MAP_TOKENS

export interface MapTheme extends Record<ThemeRole, string> {
  dark: boolean
  /**
   * The categorical palette a token layer supplied, row 1 first: the default
   * for ordinal scales and, through row 1, for single-colour series. Absent
   * when no layer did, so the built-in `apex` palette stays.
   */
  series?: readonly string[]
  /** `--apx-font-family`, as written. */
  font?: string
}

export interface ResolveThemeInput {
  element: Element | null | undefined
  theme: ResolvedOptions['theme'] | undefined
  /** Whether the OS asks for dark, for `mode: 'auto'`. */
  osDark: () => boolean
}

/** Resolve the theme for one render. */
export function resolveTheme({ element, theme = {}, osDark }: ResolveThemeInput): MapTheme {
  const mode = theme.mode
  const dark = mode === 'dark' || (mode === 'auto' && osDark())
  const out: MapTheme = { dark, ...THEME_DEFAULTS[dark ? 'dark' : 'light'] }

  const cs = declaration(element)
  if (!cs) return out

  for (const role of Object.keys(MAP_TOKENS) as ThemeRole[]) {
    const value = cs.getPropertyValue(MAP_TOKENS[role]).trim()
    if (value) out[role] = value
  }

  if (theme.tokens === false) return out
  const { css } = resolveTokenLayers(element, undefined, { designSystem: false })
  if (css.font) out.font = css.font
  // Series are taken whole, and a palette the page named keeps them built in.
  if (!theme.palette && css.series?.length) out.series = css.series
  return out
}

/** The element's live computed style, or null where there is none (SSR, detached). */
function declaration(element: Element | null | undefined): CSSStyleDeclaration | null {
  const view = element?.ownerDocument?.defaultView
  if (!element || !view || typeof view.getComputedStyle !== 'function') return null
  try {
    const cs = view.getComputedStyle(element)
    return typeof cs?.getPropertyValue === 'function' ? cs : null
  } catch {
    return null
  }
}
