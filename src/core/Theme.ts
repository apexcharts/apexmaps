/**
 * The map's theme for one render: its mode, and the colours the engine paints
 * from JS rather than from the stylesheet.
 *
 * The chrome (text, borders, focus, tooltip surface) is CSS: `ApexMaps.css`
 * chains each private `--_apexmaps-*` value through the page's `--apexmaps-*`
 * token, then the `--apx-*` family token, then the design system's step, then
 * the default. The colours below are SVG attributes worked out in JS (the
 * basemap, no-data, outlines, the selection ring and the series defaults), so
 * they take the same chain here, read once per render from the map's computed
 * style. Higher wins:
 *
 *   1. the option the page passed (the caller checks that, see `ApexMaps`)
 *   2. the map's own token: `--apexmaps-basemap`, `--apexmaps-no-data`,
 *      `--apexmaps-outline`, `--apexmaps-selected`
 *   3. the `--apx-*` family token: `--apx-series-N`, `--apx-font-family`, and
 *      while the design system's chrome applies, `--apx-fore` (the selection)
 *      and `--apx-grid` (the basemap's outline)
 *   4. a palette the page named (`theme.palette`), which keeps the series
 *      defaults built in
 *   5. the design system (Ignite UI), only while an add-on such as
 *      `apexmaps/ignite-ui` is loaded
 *   6. the built-in default for the mode
 *
 * The mode ranks the same way: `theme.mode` when the page passed one, then a
 * dark design-system variant, then light. The design system's text, line and
 * surface colours apply only while the map's mode is its variant (the commons
 * D6 gate), so a dark sheet's light greys never land on a light map. While
 * they apply, the stylesheet's dark palette takes the `--apx-*` tokens too.
 *
 * Token values are used as written, never normalised: an SVG attribute takes
 * any CSS colour, and the colour maths resolve the rest inside the map. Design
 * system colours arrive normalised (hex or `rgba()`).
 *
 * SSR-safe: with no computed style every role is its default.
 *
 * @module core/Theme
 */

import { resolveTokenLayers } from 'apex-commons'
import type { DesignSystemLayer } from 'apex-commons'

import { normalizeColor, withColorScope } from '../scales/Color'
import { getPalette } from '../scales/Palettes'
import type { ResolvedOptions } from '../types'

/** Built-in colours per mode. Outlines and the selection ring do not change with the mode. */
export const THEME_DEFAULTS = {
  light: { basemap: '#dfe4ea', noData: '#eeeeee', outline: '#ffffff', selected: '#111111' },
  dark: { basemap: '#374151', noData: '#374151', outline: '#ffffff', selected: '#111111' },
} as const

/** The dark paper, which `ApexMaps.css` also paints, for a raster export base. */
const DARK_PAPER = '#111827'

/** The map's own tokens for the JS-painted roles. */
export const MAP_TOKENS = {
  basemap: '--apexmaps-basemap',
  noData: '--apexmaps-no-data',
  outline: '--apexmaps-outline',
  selected: '--apexmaps-selected',
} as const

export type ThemeRole = keyof typeof MAP_TOKENS

/**
 * Where a design-system add-on lists the tokens behind the two greys only the
 * maps paint, keyed by the layer's id: `{ igniteui: { basemap: [...], noData:
 * [...] } }`, each a fallback chain of custom-property names. Internal, like
 * the commons slot it sits beside; `apexmaps/ignite-ui` fills it.
 */
export const MAP_DESIGN_SYSTEM_SLOT = '__apexmaps_design_systems_v1__'

/** The design system's private steps in `ApexMaps.css`, by the layer role that fills each. */
const DS_VARS = {
  fore: '--_apexmaps-ds-fg',
  muted: '--_apexmaps-ds-muted',
  grid: '--_apexmaps-ds-grid',
  overlay: '--_apexmaps-ds-overlay',
} as const

export interface MapTheme extends Record<ThemeRole, string> {
  dark: boolean
  /** The dark mode came from the design system's variant, not from the page. */
  fromVariant: boolean
  /**
   * The design system's chrome applies: a layer is on and its variant is the
   * map's mode (the D6 gate). The stylesheet then ranks `--apx-*` above it in
   * dark mode as it does in light (`.apexmaps--design-system`).
   */
  designSystem: boolean
  /**
   * The basemap's region outline: `outline`, except while the design system's
   * chrome applies. A basemap is substrate, so its borders are lines and take
   * the line colour, ranked as the stylesheet ranks its borders (`--apx-grid`
   * above the design system). The paper beside an Ignite UI `--ig-gray-100`
   * basemap measured 1.00 to 1.09:1 in the light themes: no borders at all.
   */
  basemapOutline: string
  /**
   * The categorical palette a token layer supplied, row 1 first: the default
   * for ordinal scales and, through row 1, for single-colour series. Absent
   * when no layer did, so the built-in `apex` palette stays.
   */
  series?: readonly string[]
  /** `--apx-font-family` as written, else the design system's font. */
  font?: string
  /**
   * Custom properties for the stylesheet's design-system steps, written on the
   * map's element. Empty without a design system.
   */
  vars: Record<string, string>
  /**
   * The opaque base for a raster export when nothing up the tree paints one: a
   * dark mode the variant filled leaves the map's own paper transparent.
   */
  rasterPaper?: string
}

export interface ResolveThemeInput {
  element: Element | null | undefined
  theme: ResolvedOptions['theme'] | undefined
  /** Whether the OS asks for dark, for `mode: 'auto'`. */
  osDark: () => boolean
}

/** Resolve the theme for one render. */
export function resolveTheme({ element, theme = {}, osDark }: ResolveThemeInput): MapTheme {
  const cs = declaration(element)
  // `tokens: false` drops the family tokens and the design system with them,
  // its variant included; `designSystem: false` drops the design system only.
  const layers =
    cs && theme.tokens !== false
      ? resolveTokenLayers(element, undefined, { designSystem: theme.designSystem !== false })
      : null
  const ds = layers?.designSystem ?? null

  const mode = theme.mode
  // The variant fills a mode the page left unset, and only a dark one: unset
  // already renders light.
  const fromVariant = !mode && ds?.variant === 'dark'
  const dark = fromVariant || mode === 'dark' || (mode === 'auto' && osDark())
  const defaults = THEME_DEFAULTS[dark ? 'dark' : 'light']
  const out: MapTheme = {
    dark,
    fromVariant,
    designSystem: false,
    vars: {},
    ...defaults,
    basemapOutline: defaults.outline,
  }
  if (!cs) return out

  if (ds && element) applyDesignSystem(out, ds, element, cs)

  // While the design system's chrome applies, the two roles it paints from its
  // text and line colours take the family token for that colour first (rank 3
  // over rank 5). Without it neither token reaches them, as before.
  if (out.designSystem && layers) {
    const { fore, grid } = layers.css
    if (fore) out.selected = fore
    if (grid) out.basemapOutline = grid
  }

  for (const role of Object.keys(MAP_TOKENS) as ThemeRole[]) {
    const value = cs.getPropertyValue(MAP_TOKENS[role]).trim()
    if (!value) continue
    out[role] = value
    // The page's outline is every outline, the basemap's included.
    if (role === 'outline') out.basemapOutline = value
  }

  if (!layers) return out
  const { css } = layers
  const font = css.font || ds?.font
  if (font) out.font = font
  // Series are taken whole, and a palette the page named keeps them built in.
  if (!theme.palette) {
    if (css.series?.length) out.series = css.series
    else if (ds?.series.some(Boolean)) {
      const rows = ds.palette(getPalette('apex')?.stops ?? [])
      // `--apx-accent` alone is row 1, and the design system fills the rest.
      out.series = css.accent ? [css.accent, ...rows.slice(1)] : rows
    }
  }
  return out
}

/**
 * The design system's share of the theme (rank 5): the stylesheet's private
 * steps, and the JS-painted colours, each only where the D6 gate lets it.
 */
function applyDesignSystem(
  out: MapTheme,
  ds: DesignSystemLayer,
  element: Element,
  cs: CSSStyleDeclaration,
): void {
  const mode = out.dark ? 'dark' : 'light'
  for (const role of Object.keys(DS_VARS) as (keyof typeof DS_VARS)[]) {
    const value = ds.color(role, mode)
    if (value) out.vars[DS_VARS[role]] = value
  }
  // The brand colour is the same in both variants, but the dark palette takes
  // a design system's colours only from a dark sheet.
  if (ds.colors.focus && (!out.dark || ds.variant === 'dark')) {
    out.vars['--_apexmaps-ds-focus'] = ds.colors.focus
  }
  if (out.fromVariant) {
    // D6b: the design system's own surface shows through, as under a light map.
    out.vars['--_apexmaps-ds-paper'] = 'transparent'
    out.rasterPaper = ds.paperCheck || DARK_PAPER
  }

  if ((ds.variant ?? 'light') !== mode) return
  out.designSystem = true
  if (ds.paperCheck) out.outline = ds.paperCheck
  // Plan 36 OPEN-14 takes outlines from the paper. Under the basemap that
  // leaves none in the light themes (see `basemapOutline`), so its borders
  // take the line colour; data regions and symbols keep the paper.
  out.basemapOutline = ds.color('grid', mode) || out.outline
  const fore = ds.color('fore', mode)
  if (fore) out.selected = fore

  const extra = (globalThis as Record<string, unknown>)[MAP_DESIGN_SYSTEM_SLOT] as
    Record<string, Partial<Record<'basemap' | 'noData', readonly string[]>>> | undefined
  const roles = extra?.[ds.id]
  for (const role of ['basemap', 'noData'] as const) {
    for (const name of roles?.[role] ?? []) {
      const raw = cs.getPropertyValue(name).trim()
      const value = raw && withColorScope(element, () => normalizeColor(raw))
      if (value) {
        out[role] = value
        break
      }
    }
  }
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
