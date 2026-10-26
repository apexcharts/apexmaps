import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The `--apx-*` family root token contract, guarded at the source.
 *
 * These are cascade facts, and jsdom resolves neither inheritance nor
 * stylesheets, so a rendered assertion is not available here. What the stylesheet
 * *says* is still worth pinning, because each line below encodes a decision that
 * is easy to undo by accident: which roles hand off to the family, which
 * deliberately do not, and that every fallback keeps the original default so a
 * page with no tokens renders exactly as before.
 */

const RAW = readFileSync(fileURLToPath(new URL('../src/ApexMaps.css', import.meta.url)), 'utf8')

/** Declarations only. The prose explaining these decisions names the tokens too. */
const CSS = RAW.replace(/\/\*[\s\S]*?\*\//g, '')

/** The `.apexmaps` block, where the light/default palette is declared. */
const LIGHT_BLOCK = CSS.slice(
  CSS.indexOf('.apexmaps {'),
  CSS.indexOf('.apexmaps > .apexmaps-breadcrumb'),
)

/** The `.apexmaps--dark` block. */
const DARK_BLOCK = CSS.slice(CSS.indexOf('.apexmaps--dark {'), CSS.indexOf('.apexmaps-plot'))

describe('family tokens: the roles that hand off to --apx-*', () => {
  it.each([
    ['--apexmaps-fg', '--apx-fore', '#1f2933'],
    ['--apexmaps-surface', '--apx-surface', '#ffffff'],
    ['--apexmaps-border', '--apx-grid', 'rgba(0, 0, 0, 0.12)'],
    ['--apexmaps-focus', '--apx-accent', '#2563eb'],
  ])('%s falls back to %s, keeping %s as the default', (local, token, fallback) => {
    // Read through the private copy: the public name first, then the family
    // token, then the default.
    const priv = local.replace('--apexmaps-', '--_apexmaps-')
    expect(LIGHT_BLOCK).toContain(`${priv}: var(${local}, var(${token}, ${fallback}));`)
  })

  it('leaves the original default in place, so a page with no tokens is unchanged', () => {
    // Every token-backed declaration still names the value it always had.
    const backed = [
      ...LIGHT_BLOCK.matchAll(
        /--_apexmaps-[\w-]+: var\(--apexmaps-[\w-]+, var\(--apx-[\w-]+, ([^)]*(?:\([^)]*\))?[^)]*)\)\);/g,
      ),
    ]
    expect(backed).toHaveLength(4)
    for (const [, fallback] of backed) expect(fallback.trim()).not.toBe('')
  })
})

describe('family tokens: the roles that deliberately do not', () => {
  it('--apexmaps-bg stays transparent so the host card shows through', () => {
    expect(LIGHT_BLOCK).toContain('--_apexmaps-bg: var(--apexmaps-bg, transparent);')
    expect(LIGHT_BLOCK).not.toContain('--apexmaps-bg, var(--apx-')
  })

  it('the dark palette takes no family tokens at all', () => {
    // A single set of --apx-* values describes one appearance. Applying a light
    // brand surface to the palette chosen for dark mode is how the chrome ends
    // up white-on-white, so dark stays self-contained.
    expect(DARK_BLOCK).toContain('--_apexmaps-fg: var(--apexmaps-fg, #e5e7eb);')
    expect(DARK_BLOCK).not.toContain('--apx-')
  })
})

describe('the public --apexmaps-* names are only ever read', () => {
  it('declares none of them, so a value set above the map is inherited', () => {
    // A declaration on the element beats an inherited value whatever the
    // selector, so declaring a public name would cut the map off from a theme
    // set on :root, a dashboard panel or a web component's shadow host.
    const declared = [...CSS.matchAll(/(^|[;{\s])(--apexmaps-[\w-]+)\s*:/g)].map((m) => m[2])
    const themeable = declared.filter((name) =>
      /^--apexmaps-(fg|fg-muted|bg|surface|border|shadow|focus|halo|radius|font-size)$/.test(name),
    )
    expect(themeable).toEqual([])
  })
})

describe('side legend box model', () => {
  /**
   * Reported against 1.1.1 (#2). The plot is measured against the container
   * minus `--apexmaps-legend-width`, so the legend's box has to be exactly that
   * wide, padding included. Under the browser's `content-box` default it was
   * 12px wider, and on any page without a border-box reset the legend wrapped
   * below the map at every width.
   */
  it('sizes the side legend column by its border box', () => {
    const start = CSS.indexOf('.apexmaps-legend--left,\n.apexmaps-legend--right {')
    expect(start).toBeGreaterThan(-1)
    const block = CSS.slice(start, CSS.indexOf('}', start))
    expect(block).toContain('box-sizing: border-box;')
    expect(block).toContain('width: var(--apexmaps-legend-width, 180px);')
  })
})
