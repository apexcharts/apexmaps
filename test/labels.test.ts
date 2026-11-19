// @vitest-environment jsdom
/**
 * Label text: how wide the collision test thinks a string is, and which font it
 * is drawn in.
 *
 * The width is an estimate on purpose (measuring needs a reflow per label per
 * frame), so what is pinned here is the property that matters to a reader: a
 * label the estimate calls narrower than it is overlaps its neighbour without
 * the collision test noticing. CJK text was the case that got that wrong, at a
 * Latin average of 0.58em per character for glyphs that are a full em.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { geoContains } from 'd3-geo'
import { feature as topoFeature } from 'topojson-client'
import ApexMaps from '../src/ApexMaps'
import { Labels, estimateTextWidth, labelAnchor } from '../src/components/Labels'
import { Viewport } from '../src/geo/Viewport'

const WORLD = JSON.parse(
  readFileSync(resolve(process.cwd(), 'node_modules/world-atlas/countries-110m.json'), 'utf8'),
)

describe('estimateTextWidth', () => {
  it('counts a two-kanji label as at least two em', () => {
    expect(estimateTextWidth('秋田', 11)).toBeGreaterThanOrEqual(22)
    expect(estimateTextWidth('北海道', 20)).toBeGreaterThanOrEqual(60)
  })

  it('counts kana, hangul and fullwidth forms as wide too', () => {
    expect(estimateTextWidth('とうきょう', 10)).toBeGreaterThanOrEqual(50)
    expect(estimateTextWidth('カタカナ', 10)).toBeGreaterThanOrEqual(40)
    expect(estimateTextWidth('서울', 10)).toBeGreaterThanOrEqual(20)
    expect(estimateTextWidth('ＡＢ', 10)).toBeGreaterThanOrEqual(20)
  })

  it('counts a supplementary ideograph once, not once per UTF-16 unit', () => {
    // U+20B9F, two UTF-16 code units.
    expect(estimateTextWidth('\u{20B9F}', 10)).toBeCloseTo(10)
  })

  it('leaves Latin text at the average it always used', () => {
    expect(estimateTextWidth('Akita', 10)).toBeCloseTo(5 * 0.58 * 10)
  })

  it('widens narrow glyphs only for a monospace face', () => {
    expect(estimateTextWidth('AB', 10, 'Menlo, monospace')).toBeCloseTo(12)
    expect(estimateTextWidth('AB', 10, '"Noto Sans JP", sans-serif')).toBeCloseTo(11.6)
    // A wide glyph is an em in any face.
    expect(estimateTextWidth('秋', 10, 'monospace')).toBeCloseTo(10)
  })

  it('weighs mixed scripts glyph by glyph', () => {
    expect(estimateTextWidth('秋田 2025', 10)).toBeCloseTo(2 * 10 + 5 * 5.8)
  })

  it('counts an emoji as one wide glyph, however many code points draw it', () => {
    // A supplementary-plane pictograph: one code point, two UTF-16 units.
    expect(estimateTextWidth('🍣', 10)).toBeCloseTo(10)
    expect(estimateTextWidth('🍣 Sushi', 10)).toBeCloseTo(10 + 6 * 5.8)
    // A flag is two regional indicators drawn as one glyph.
    expect(estimateTextWidth('🇯🇵', 10)).toBeCloseTo(10)
    // A narrow symbol asked for in emoji presentation, a skin tone, a keycap.
    expect(estimateTextWidth('❤\u{FE0F}', 10)).toBeCloseTo(10)
    expect(estimateTextWidth('👍\u{1F3FD}', 10)).toBeCloseTo(10)
    expect(estimateTextWidth('1\u{FE0F}\u{20E3}', 10)).toBeCloseTo(10)
    // A joined sequence is one glyph.
    expect(estimateTextWidth('👨\u{200D}👩\u{200D}👧', 10)).toBeCloseTo(10)
    // An emoji with a wide default presentation in the BMP.
    expect(estimateTextWidth('⚡', 10)).toBeCloseTo(10)
  })

  it('adds nothing for a combining accent', () => {
    expect(estimateTextWidth('e\u0301', 10)).toBeCloseTo(estimateTextWidth('\u00e9', 10))
  })
})

describe('labelAnchor', () => {
  const viewport = (collection: unknown) => {
    const vp = new Viewport({ width: 800, height: 800 })
    vp.setProjection('mercator')
    vp.fit(collection, 0)
    return vp
  }
  const square = (x: number, y: number, size: number) => [
    [
      [x, y],
      [x, y + size],
      [x + size, y + size],
      [x + size, y],
      [x, y],
    ],
  ]

  it('anchors a region drawn in several parts on its largest one', () => {
    const geometry = {
      type: 'MultiPolygon' as const,
      coordinates: [square(10, 10, 0.2), square(0, 0, 2), square(5, -5, 0.3)],
    }
    const feature = { key: 'A', geometry, properties: {}, index: 0 }
    const vp = viewport({ type: 'Feature', geometry, properties: {} })
    const anchor = labelAnchor(vp, feature)!
    const [lon, lat] = vp.screenToLonLat(anchor.world)!
    expect(lon).toBeCloseTo(1, 1)
    expect(lat).toBeCloseTo(1, 1)
  })

  it('anchors a single polygon on its centroid, as before', () => {
    const geometry = { type: 'Polygon' as const, coordinates: square(0, 0, 2) }
    const feature = { key: 'A', geometry, properties: {}, index: 0 }
    const vp = viewport({ type: 'Feature', geometry, properties: {} })
    expect(labelAnchor(vp, feature)!.world).toEqual(vp.path!.centroid(geometry))
  })

  it("keeps Okinawa's and Tokyo's labels on land, not out among their islands", () => {
    // The centroid of the whole prefecture is in the sea for both: Okinawa's
    // between Okinawa Island and the Sakishima Islands, Tokyo's pulled south by
    // the Izu and Ogasawara islands.
    const topology = JSON.parse(
      readFileSync(resolve(process.cwd(), 'geo/jp-admin1-10m.json'), 'utf8'),
    )
    const collection = topoFeature(topology, topology.objects.admin1) as unknown as {
      features: { geometry: never; properties: Record<string, unknown> }[]
    }
    const vp = viewport(collection)
    for (const key of ['JP-47', 'JP-13']) {
      const f = collection.features.find((x) => x.properties.iso_3166_2 === key)!
      const anchor = labelAnchor(vp, { key, geometry: f.geometry, properties: {}, index: 0 })!
      expect(geoContains(f as never, vp.screenToLonLat(anchor.world)!), key).toBe(true)
    }
  })
})

/** A label engine over a bare overlay, with the camera at its fit. */
function engine(style: Record<string, unknown> = {}) {
  const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  const viewport = new Viewport({ width: 400, height: 300 })
  const labels = new Labels({
    renderer: { overlay: () => overlay } as never,
    viewport,
    options: { enabled: true, collision: 'hide', minFeatureArea: 0, style },
  })
  return { labels, overlay }
}

describe('label collisions', () => {
  it('drops the second of two kanji labels closer than their real width', () => {
    // Centres 16px apart at 11px: each label is 22px wide, so they overlap by
    // 6px. At 0.58em per character each was estimated at 12.8px, the boxes
    // missed each other, and both were drawn on top of one another.
    const { labels, overlay } = engine({ fontSize: 11 })
    labels.setCandidates([
      { text: '秋田', world: [100, 100], priority: 2, featureArea: 1e4 },
      { text: '岩手', world: [116, 100], priority: 1, featureArea: 1e4 },
    ])
    labels.layout()
    expect(labels.placedCount).toBe(1)
    expect(labels.droppedCount).toBe(1)
    expect(overlay.querySelectorAll('text')).toHaveLength(1)
    expect(overlay.querySelector('text')!.textContent).toBe('秋田')
  })

  it('still places two kanji labels that clear each other', () => {
    const { labels } = engine({ fontSize: 11 })
    labels.setCandidates([
      { text: '秋田', world: [100, 100], priority: 2, featureArea: 1e4 },
      { text: '岩手', world: [124, 100], priority: 1, featureArea: 1e4 },
    ])
    labels.layout()
    expect(labels.placedCount).toBe(2)
  })
})

describe('dataLabels.style.fontFamily', () => {
  it('reaches the label element', () => {
    const { labels, overlay } = engine({ fontFamily: '"Noto Sans JP", sans-serif' })
    labels.setCandidates([{ text: '秋田', world: [100, 100], priority: 1, featureArea: 1e4 }])
    labels.layout()
    expect(overlay.querySelector('text')!.getAttribute('font-family')).toBe(
      '"Noto Sans JP", sans-serif',
    )
  })

  it('leaves the label inheriting the chart font when unset', () => {
    const { labels, overlay } = engine()
    labels.setCandidates([{ text: 'Akita', world: [100, 100], priority: 1, featureArea: 1e4 }])
    labels.layout()
    expect(overlay.querySelector('text')!.hasAttribute('font-family')).toBe(false)
  })
})

describe('on a rendered map', () => {
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
    vi.unstubAllGlobals()
  })

  it('draws data labels in the chosen family, and hands the field function the feature', async () => {
    const seen: unknown[] = []
    map = new ApexMaps(el, {
      chart: { width: 960, height: 500 },
      geo: { map: WORLD, projection: 'equalEarth' },
      debug: { enabled: false },
      dataLabels: {
        enabled: true,
        minFeatureArea: 0,
        collision: 'none',
        style: { fontFamily: 'serif' },
        field: (feature) => {
          seen.push(feature)
          return feature.name ?? feature.key
        },
      },
      series: [{ type: 'choropleth', data: [] }],
    })
    await map.render()

    const label = el.querySelector('text.apexmaps-label')
    expect(label).not.toBeNull()
    expect(label!.getAttribute('font-family')).toBe('serif')

    // What the type now says: the feature being labelled, not a data row.
    const first = seen[0] as { key?: unknown; properties?: unknown }
    expect(typeof first.key).toBe('string')
    expect(typeof first.properties).toBe('object')
  })

  it('sizes an annotation chip for CJK text and draws it in the chosen family', async () => {
    map = new ApexMaps(el, {
      chart: { width: 960, height: 500 },
      geo: { map: WORLD, projection: 'equalEarth' },
      debug: { enabled: false },
      annotations: {
        points: [
          {
            at: [140.1, 39.7],
            label: { text: '秋田県', fontSize: 12, padding: 4, fontFamily: '"Noto Sans JP"' },
          },
        ],
      },
      series: [],
    })
    await map.render()

    const chip = el.querySelector('rect.apexmaps-annotation-chip')!
    // Three em of text plus the padding either side.
    expect(Number(chip.getAttribute('width'))).toBeGreaterThanOrEqual(3 * 12 + 2 * 4)
    const text = el.querySelector('text.apexmaps-annotation-text')!
    expect(text.getAttribute('font-family')).toBe('"Noto Sans JP"')
  })
})

describe('the labels.field type', () => {
  /**
   * Compiled for real, because the claim is about the declarations: the
   * function is typed as receiving the feature, so a caller can read
   * `feature.properties` without a cast. Under the old `(datum: unknown)` that
   * snippet does not compile.
   */
  it('types the accessor argument as the feature it is called with', () => {
    const dir = resolve(process.cwd(), 'test')
    const file = resolve(dir, '__label-field.typecheck.ts')
    const source = [
      "import type { DataLabelOptions, SeriesLabelOptions } from '../src/types'",
      'export const a: DataLabelOptions = {',
      '  field: (feature) => String(feature.properties.nam_ja ?? feature.key),',
      '}',
      'export const b: SeriesLabelOptions = {',
      '  show: true,',
      '  field: (feature) => feature.name ?? feature.key,',
      '}',
      // A caller who wrote the old signature still compiles.
      'export const c: DataLabelOptions = { field: (datum: unknown) => String(datum) }',
    ].join('\n')

    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'],
      types: [],
    }
    const host = ts.createCompilerHost(options)
    const getSourceFile = host.getSourceFile.bind(host)
    host.getSourceFile = (name, version, ...rest) =>
      resolve(name) === file
        ? ts.createSourceFile(name, source, version)
        : getSourceFile(name, version, ...rest)
    const fileExists = host.fileExists.bind(host)
    host.fileExists = (name) => resolve(name) === file || fileExists(name)

    const program = ts.createProgram([file], options, host)
    const errors = ts
      .getPreEmitDiagnostics(program, program.getSourceFile(file))
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    expect(errors).toEqual([])
  })
})
