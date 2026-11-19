// @vitest-environment jsdom
/**
 * Data labels take their ink from the fill under them.
 *
 * Every label used to be drawn in the page's text colour with a light halo, so
 * on a dark class only the halo kept it legible and every label read as a pale
 * sticker. Unless `dataLabels.style.color` is set, a label now takes the theme's
 * text or surface colour, whichever contrasts more with the fill drawn under it,
 * and a halo in that fill. A caller's colour and halo are honoured as before.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import ApexMaps from '../src/ApexMaps'
import { Labels, labelInk, resolveLabelHalo, resolveLabelTones } from '../src/components/Labels'
import type { LabelTones } from '../src/components/Labels'
import { contrastRatio, parseRgba, toHex } from '../src/scales/Color'
import { Viewport } from '../src/geo/Viewport'
import type { ApexMapsOptions } from '../src/types'

const PALE = '#f7fbff'
const DEEP = '#08306b'
const NO_DATA = '#eeeeee'

const box = (iso: string, lon: number) => ({
  type: 'Feature',
  properties: { iso_a3: iso, name: iso },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [lon, -20],
        [lon, 20],
        [lon + 30, 20],
        [lon + 30, -20],
        [lon, -20],
      ],
    ],
  },
})

/** Three wide boxes: a low value, a high value, and one with no data. */
const WORLD = {
  type: 'FeatureCollection',
  features: [box('LOW', -90), box('HIGH', -15), box('NONE', 60)],
}

const series = (data: { code: string; value: number }[], extra: Record<string, unknown> = {}) => ({
  type: 'choropleth' as const,
  joinBy: ['iso_a3', 'code'] as [string, string],
  data,
  scale: { type: 'threshold' as const, breaks: [50], palette: [PALE, DEEP] },
  ...extra,
})

const DATA = [
  { code: 'LOW', value: 10 },
  { code: 'HIGH', value: 90 },
]

let el: HTMLElement
let map: ApexMaps | null = null

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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function render(options: ApexMapsOptions = {}) {
  map = new ApexMaps(el, {
    chart: { width: 800, height: 400, animations: { enabled: false } },
    geo: { map: WORLD, projection: 'equirectangular' },
    legend: { show: false },
    debug: { enabled: false },
    series: [series(DATA)],
    ...options,
    dataLabels: { enabled: true, minFeatureArea: 0, collision: 'none', ...options.dataLabels },
  })
  await map.render()
  return map
}

/** The label drawn for a feature, by its text (the feature's name). */
const label = (name: string) =>
  [...el.querySelectorAll('text.apexmaps-label')].find((t) => t.textContent === name) ?? null

const fillOf = (key: string) =>
  el.querySelector(`path.apexmaps-feature[data-key="${key}"]`)?.getAttribute('fill')

const LIGHT = resolveLabelTones(false)
const DARK = resolveLabelTones(true)

/** The colour a tone's `paint` stands for, for contrast checks. */
const toneColor = (paint: string | null | undefined, tones: LabelTones = LIGHT) =>
  paint === tones.text.paint ? tones.text.color : tones.surface.color

/** `fill` at `alpha` over white, as the halo of a faded label writes it. */
const faded = (fill: string, alpha: number) => {
  const c = parseRgba(fill)!
  return toHex([0, 1, 2].map((i) => c[i] * alpha + 255 * (1 - alpha)) as [number, number, number])
}

describe('labelInk', () => {
  it('puts the surface tone on a dark fill and the text tone on a light one', () => {
    expect(labelInk(DEEP, 1, LIGHT).fill).toBe(LIGHT.surface.paint)
    expect(labelInk(PALE, 1, LIGHT).fill).toBe(LIGHT.text.paint)
  })

  it('picks by contrast, so the tones swap roles in dark mode', () => {
    // Dark mode's text colour is the light one, its surface the dark one.
    expect(labelInk(DEEP, 1, DARK).fill).toBe(DARK.text.paint)
    expect(labelInk(PALE, 1, DARK).fill).toBe(DARK.surface.paint)
  })

  it('reads every tone from the theme tokens, with the stylesheet defaults as fallback', () => {
    expect(LIGHT.text.paint).toBe('var(--_apexmaps-fg, #1f2933)')
    expect(LIGHT.surface.paint).toBe('var(--_apexmaps-surface, #ffffff)')
    expect(DARK.text.paint).toBe('var(--_apexmaps-fg, #e5e7eb)')
    expect(DARK.surface.paint).toBe('var(--_apexmaps-surface, #1f2937)')
  })

  it('reaches at least 4.5:1 on both ends of a ramp', () => {
    for (const fill of [PALE, DEEP, '#6baed6', '#2171b5', '#ffd700', '#7a0177']) {
      const ink = labelInk(fill, 1, LIGHT).fill
      const color = ink === LIGHT.text.paint ? LIGHT.text.color : LIGHT.surface.color
      expect(contrastRatio(fill, color), fill).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('halos in the fill itself, so the halo vanishes inside its own cell', () => {
    expect(labelInk(DEEP, 1, LIGHT).halo).toBe(`var(--apexmaps-halo, ${DEEP})`)
  })

  it('judges a faded fill by what shows through, the surface included', () => {
    // A quarter of a deep blue over white is a pale blue: dark text, pale halo.
    const ink = labelInk(DEEP, 0.25, LIGHT)
    expect(ink.fill).toBe(LIGHT.text.paint)
    expect(ink.halo).not.toContain(DEEP)
  })

  it('picks the text against a halo in force, composited over the fill', () => {
    // A light halo behind every glyph: the text edges touch the halo, not the
    // fill, so a deep class still takes the dark text.
    for (const halo of ['#f3eee3', 'rgba(255,255,255,0.85)']) {
      const ink = labelInk(DEEP, 1, LIGHT, halo)!
      expect(ink.fill, halo).toBe(LIGHT.text.paint)
    }
    // A dark halo on a pale class takes the light text.
    expect(labelInk(PALE, 1, LIGHT, '#111827')!.fill).toBe(LIGHT.surface.paint)
  })

  it('has no ink for a fill that is not a colour', () => {
    expect(labelInk('none', 1, LIGHT)).toBeNull()
    expect(labelInk('url(#hatch)', 1, LIGHT)).toBeNull()
    // Transparent is a colour: what shows through is the surface.
    expect(labelInk('transparent', 1, LIGHT)!.fill).toBe(LIGHT.text.paint)
  })

  it('reads no halo from one that is off, transparent or not a colour', () => {
    expect(resolveLabelHalo({ halo: false, haloColor: '#000000' })).toBeNull()
    expect(resolveLabelHalo({ haloColor: 'transparent' })).toBeNull()
    expect(resolveLabelHalo({ haloColor: 'none' })).toBeNull()
    expect(resolveLabelHalo({})).toBeNull()
    expect(resolveLabelHalo({ haloColor: '#F3EEE3' })).toBe('#f3eee3')
  })

  it('reads a token the map defines, in scope', () => {
    const tones: LabelTones = {
      text: { paint: 'var(--ink)', color: '#330000' },
      surface: { paint: 'var(--paper)', color: '#fff8e7' },
    }
    expect(labelInk(DEEP, 1, tones).fill).toBe('var(--paper)')
    expect(labelInk(PALE, 1, tones).fill).toBe('var(--ink)')
  })
})

describe('labels on a rendered choropleth', () => {
  it('draws light text on a dark class and dark text on a light one', async () => {
    await render()
    expect(label('HIGH')!.getAttribute('fill')).toBe(LIGHT.surface.paint)
    expect(label('LOW')!.getAttribute('fill')).toBe(LIGHT.text.paint)
  })

  it('halos each label in the fill drawn under it', async () => {
    await render()
    expect(fillOf('HIGH')).toBe(DEEP)
    expect(label('HIGH')!.getAttribute('stroke')).toBe(`var(--apexmaps-halo, ${DEEP})`)
    expect(label('LOW')!.getAttribute('stroke')).toBe(`var(--apexmaps-halo, ${PALE})`)
  })

  it('treats a no-data region by its no-data fill', async () => {
    await render()
    expect(fillOf('NONE')).toBe(NO_DATA)
    expect(label('NONE')!.getAttribute('fill')).toBe(LIGHT.text.paint)
    expect(label('NONE')!.getAttribute('stroke')).toBe(`var(--apexmaps-halo, ${NO_DATA})`)
  })

  it('uses the dark theme tones in dark mode', async () => {
    await render({ theme: { mode: 'dark' } })
    expect(label('HIGH')!.getAttribute('fill')).toBe(DARK.text.paint)
    expect(label('LOW')!.getAttribute('fill')).toBe(DARK.surface.paint)
  })

  it('honours an explicit colour exactly, with the theme halo it always had', async () => {
    await render({ dataLabels: { style: { color: '#ff00aa' } } })
    for (const name of ['LOW', 'HIGH', 'NONE']) {
      expect(label(name)!.getAttribute('fill')).toBe('#ff00aa')
      expect(label(name)!.getAttribute('stroke')).toBe(
        'var(--_apexmaps-halo, rgba(255,255,255,0.85))',
      )
    }
  })

  it('honours an explicit halo colour, picking text that reads on that halo', async () => {
    await render({ dataLabels: { style: { haloColor: '#f3eee3' } } })
    for (const name of ['LOW', 'HIGH', 'NONE']) {
      expect(label(name)!.getAttribute('stroke')).toBe('#f3eee3')
      // The glyph edges touch the halo, so that is what the text must clear.
      const text = toneColor(label(name)!.getAttribute('fill'))
      expect(contrastRatio(text, '#f3eee3'), name).toBeGreaterThanOrEqual(4.5)
    }
    expect(label('HIGH')!.getAttribute('fill')).toBe(LIGHT.text.paint)
  })

  it('keeps the page text colour and theme halo on a fill of none', async () => {
    // A basemap left unpainted: the label sits on the page, not on black.
    await render({ series: [], geo: { map: WORLD, projection: 'equirectangular', fill: 'none' } })
    expect(label('HIGH')!.getAttribute('fill')).toBe('currentColor')
    expect(label('HIGH')!.getAttribute('stroke')).toBe(
      'var(--_apexmaps-halo, rgba(255,255,255,0.85))',
    )
  })

  it('keeps the page text colour and theme halo on a no-data colour of none', async () => {
    await render({
      series: [
        series(DATA, {
          scale: { type: 'threshold', breaks: [50], palette: [PALE, DEEP], nullColor: 'none' },
        }),
      ],
    })
    expect(fillOf('NONE')).toBe('none')
    expect(label('NONE')!.getAttribute('fill')).toBe('currentColor')
    expect(label('HIGH')!.getAttribute('fill')).toBe(LIGHT.surface.paint)
  })

  it('takes the new tones when updateOptions switches the theme', async () => {
    await render()
    expect(label('HIGH')!.getAttribute('fill')).toBe(LIGHT.surface.paint)
    await map!.updateOptions({ theme: { mode: 'dark' } })
    expect(label('HIGH')!.getAttribute('fill')).toBe(DARK.text.paint)
    expect(label('LOW')!.getAttribute('fill')).toBe(DARK.surface.paint)
  })

  it('judges a dimmed label at the muted opacity, which replaces the series opacity', async () => {
    await render({ series: [series(DATA, { opacity: 0.6 })] })
    expect(label('HIGH')!.getAttribute('stroke')).toBe(`var(--apexmaps-halo, ${faded(DEEP, 0.6)})`)
    map!.toggleSelection('LOW')
    // 0.25, not 0.6 x 0.25: the CSS muting sets the mark's opacity outright.
    expect(label('HIGH')!.getAttribute('stroke')).toBe(`var(--apexmaps-halo, ${faded(DEEP, 0.25)})`)
    // The selected feature keeps the series opacity.
    expect(label('LOW')!.getAttribute('stroke')).toBe(`var(--apexmaps-halo, ${faded(PALE, 0.6)})`)
  })

  it('judges a label by the topmost feature series, the one drawn', async () => {
    const black = series(DATA, {
      scale: { type: 'threshold', breaks: [50], palette: ['#000000', '#000000'] },
    })
    await render({ series: [black, series(DATA)] })
    expect(label('LOW')!.getAttribute('fill')).toBe(LIGHT.text.paint)
    expect(label('LOW')!.getAttribute('stroke')).toBe(`var(--apexmaps-halo, ${PALE})`)
  })

  it('draws no halo at all when the halo is off', async () => {
    await render({ dataLabels: { style: { halo: false } } })
    expect(label('HIGH')!.hasAttribute('stroke')).toBe(false)
    expect(label('HIGH')!.getAttribute('fill')).toBe(LIGHT.surface.paint)
  })

  it('follows a fill change from updateSeries', async () => {
    await render()
    expect(label('HIGH')!.getAttribute('fill')).toBe(LIGHT.surface.paint)

    map!.updateSeries([
      series([
        { code: 'LOW', value: 90 },
        { code: 'HIGH', value: 10 },
      ]),
    ])
    await new Promise((r) => setTimeout(r, 0))

    expect(fillOf('HIGH')).toBe(PALE)
    expect(label('HIGH')!.getAttribute('fill')).toBe(LIGHT.text.paint)
    expect(label('LOW')!.getAttribute('fill')).toBe(LIGHT.surface.paint)
    expect(label('LOW')!.getAttribute('stroke')).toBe(`var(--apexmaps-halo, ${DEEP})`)
  })

  it('judges a translucent series by its fill over the surface', async () => {
    await render({ series: [series(DATA, { opacity: 0.2 })] })
    expect(label('HIGH')!.getAttribute('fill')).toBe(LIGHT.text.paint)
  })

  it('re-inks the labels of regions a selection dims, and restores them', async () => {
    await render()
    map!.toggleSelection('LOW')
    // HIGH is muted to a quarter of its deep blue over the surface: pale.
    expect(label('HIGH')!.getAttribute('fill')).toBe(LIGHT.text.paint)
    expect(label('HIGH')!.getAttribute('stroke')).not.toContain(DEEP)
    expect(label('LOW')!.getAttribute('fill')).toBe(LIGHT.text.paint)

    map!.toggleSelection('LOW')
    expect(label('HIGH')!.getAttribute('fill')).toBe(LIGHT.surface.paint)
    expect(label('HIGH')!.getAttribute('stroke')).toBe(`var(--apexmaps-halo, ${DEEP})`)
  })

  it('leaves a selected region on its own fill', async () => {
    await render()
    map!.toggleSelection('HIGH')
    expect(label('HIGH')!.getAttribute('fill')).toBe(LIGHT.surface.paint)
  })

  it('re-inks a label when the legend mutes its class to no-data', async () => {
    await render()
    const toggle = (map as unknown as { _onLegendToggle(c: number, s: number): void })
      ._onLegendToggle
    toggle.call(map, 1, 0)
    expect(fillOf('HIGH')).toBe(NO_DATA)
    expect(label('HIGH')!.getAttribute('fill')).toBe(LIGHT.text.paint)
    expect(label('HIGH')!.getAttribute('stroke')).toBe(`var(--apexmaps-halo, ${NO_DATA})`)
  })
})

describe('cost', () => {
  it('works out ink once per distinct fill, and not again on a camera change', () => {
    const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    const labels = new Labels({
      renderer: { overlay: () => overlay } as never,
      viewport: new Viewport({ width: 400, height: 300 }),
      options: { enabled: true, collision: 'none', minFeatureArea: 0 },
    })
    labels.setTheme(false)
    const candidates = Array.from({ length: 200 }, (_, i) => ({
      text: `R${i}`,
      world: [10 + (i % 20) * 18, 10 + Math.floor(i / 20) * 25] as [number, number],
      priority: i,
      featureArea: 1e4,
      fill: i % 2 ? DEEP : PALE,
    }))
    const internals = labels as unknown as { inkCache: Map<string, unknown>; tones: LabelTones }
    labels.setCandidates(candidates)
    expect(internals.inkCache.size).toBe(2)

    labels.layout()
    const fills = () => [...overlay.querySelectorAll('text')].map((t) => t.getAttribute('fill'))
    const drawn = fills()
    expect(new Set(drawn)).toEqual(new Set([LIGHT.text.paint, LIGHT.surface.paint]))

    // Tones that would ink every label differently: a layout that worked the
    // colour out again would pick them up. A camera change only lays out.
    internals.tones = {
      text: { paint: 'var(--x)', color: '#000000' },
      surface: { paint: 'var(--y)', color: '#ffffff' },
    }
    labels.layout()
    labels.layout()
    expect(fills()).toEqual(drawn)
    expect(internals.inkCache.size).toBe(2)
  })
})
