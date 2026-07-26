/**
 * Palette registry.
 *
 * Anchor stops only: the actual class colours are sampled in OkLab at render
 * time so a 4-class and a 9-class map of the same data stay perceptually
 * consistent.
 *
 * Sequential and diverging ramps follow the ColorBrewer families (Brewer and
 * Harrower), which are the de-facto standard for thematic cartography and are
 * colourblind-checked. `viridis` and `magma` come from the matplotlib
 * colormaps, which are perceptually uniform and CC0.
 *
 * @module scales/Palettes
 */

export type PaletteKind = 'sequential' | 'diverging' | 'categorical'

export interface Palette {
  kind: PaletteKind
  stops: string[]
  colorblindSafe?: boolean
}

const registry = new Map<string, Palette>()

export function registerPalette(name: string, palette: Palette): void {
  if (!name || !palette || !Array.isArray(palette.stops) || !palette.stops.length) {
    throw new TypeError('ApexMaps: a palette needs a name and a non-empty stops array')
  }
  registry.set(name, { colorblindSafe: false, ...palette })
}

export function getPalette(name: string): Palette | undefined {
  return registry.get(name)
}

export function listPalettes(): string[] {
  return [...registry.keys()].sort()
}

export function hasPalette(name: string): boolean {
  return registry.has(name)
}

// --- Sequential -------------------------------------------------------------

registerPalette('blues', {
  kind: 'sequential',
  colorblindSafe: true,
  stops: [
    '#f7fbff',
    '#deebf7',
    '#c6dbef',
    '#9ecae1',
    '#6baed6',
    '#4292c6',
    '#2171b5',
    '#08519c',
    '#08306b',
  ],
})
registerPalette('greens', {
  kind: 'sequential',
  colorblindSafe: true,
  stops: [
    '#f7fcf5',
    '#e5f5e0',
    '#c7e9c0',
    '#a1d99b',
    '#74c476',
    '#41ab5d',
    '#238b45',
    '#006d2c',
    '#00441b',
  ],
})
registerPalette('oranges', {
  kind: 'sequential',
  colorblindSafe: true,
  stops: [
    '#fff5eb',
    '#fee6ce',
    '#fdd0a2',
    '#fdae6b',
    '#fd8d3c',
    '#f16913',
    '#d94801',
    '#a63603',
    '#7f2704',
  ],
})
registerPalette('reds', {
  kind: 'sequential',
  colorblindSafe: true,
  stops: [
    '#fff5f0',
    '#fee0d2',
    '#fcbba1',
    '#fc9272',
    '#fb6a4a',
    '#ef3b2c',
    '#cb181d',
    '#a50f15',
    '#67000d',
  ],
})
registerPalette('purples', {
  kind: 'sequential',
  colorblindSafe: true,
  stops: [
    '#fcfbfd',
    '#efedf5',
    '#dadaeb',
    '#bcbddc',
    '#9e9ac8',
    '#807dba',
    '#6a51a3',
    '#54278f',
    '#3f007d',
  ],
})
registerPalette('greys', {
  kind: 'sequential',
  colorblindSafe: true,
  stops: [
    '#ffffff',
    '#f0f0f0',
    '#d9d9d9',
    '#bdbdbd',
    '#969696',
    '#737373',
    '#525252',
    '#252525',
    '#000000',
  ],
})
registerPalette('viridis', {
  kind: 'sequential',
  colorblindSafe: true,
  stops: [
    '#440154',
    '#482878',
    '#3e4a89',
    '#31688e',
    '#26828e',
    '#1f9e89',
    '#35b779',
    '#6dcd59',
    '#b4de2c',
    '#fde725',
  ],
})
registerPalette('magma', {
  kind: 'sequential',
  colorblindSafe: true,
  stops: [
    '#000004',
    '#1c1044',
    '#4f127b',
    '#812581',
    '#b5367a',
    '#e55964',
    '#fb8761',
    '#fec287',
    '#fcfdbf',
  ],
})
/**
 * Teal: a single-hue ramp held between 173 and 184 degrees, the green side of
 * cyan, from the lightest stop through to the darkest.
 *
 * Constructed rather than adopted, because ColorBrewer has no teal scheme and its
 * nearest neighbours all leave the hue before the dark end, which is where a
 * choropleth puts most of its ink: BuGn finishes in forest green, GnBu in blue.
 * This palette used to ship BuPu's stops outright, so `palette: 'teal'` drew a map
 * in purple.
 *
 * Two properties make it a legitimate sequential ramp rather than nine pleasant
 * colours, and `test/scale.test.ts` pins both: the hue holds across every stop, and
 * lightness falls monotonically, which is what keeps a single-hue ramp decodable
 * under all three common colour-vision deficiencies.
 */
registerPalette('teal', {
  kind: 'sequential',
  colorblindSafe: true,
  stops: [
    '#f2fbfa',
    '#e0f3f1',
    '#c3e8e4',
    '#9bd9d3',
    '#6ac4bf',
    '#3ea9a5',
    '#23888a',
    '#136a6e',
    '#06474b',
  ],
})

// --- Diverging --------------------------------------------------------------

registerPalette('rdbu', {
  kind: 'diverging',
  colorblindSafe: true,
  stops: [
    '#67001f',
    '#b2182b',
    '#d6604d',
    '#f4a582',
    '#fddbc7',
    '#f7f7f7',
    '#d1e5f0',
    '#92c5de',
    '#4393c3',
    '#2166ac',
    '#053061',
  ],
})
registerPalette('brbg', {
  kind: 'diverging',
  colorblindSafe: true,
  stops: [
    '#543005',
    '#8c510a',
    '#bf812d',
    '#dfc27d',
    '#f6e8c3',
    '#f5f5f5',
    '#c7eae5',
    '#80cdc1',
    '#35978f',
    '#01665e',
    '#003c30',
  ],
})
registerPalette('piyg', {
  kind: 'diverging',
  colorblindSafe: true,
  stops: [
    '#8e0152',
    '#c51b7d',
    '#de77ae',
    '#f1b6da',
    '#fde0ef',
    '#f7f7f7',
    '#e6f5d0',
    '#b8e186',
    '#7fbc41',
    '#4d9221',
    '#276419',
  ],
})
registerPalette('spectral', {
  kind: 'diverging',
  colorblindSafe: false,
  stops: [
    '#9e0142',
    '#d53e4f',
    '#f46d43',
    '#fdae61',
    '#fee08b',
    '#ffffbf',
    '#e6f598',
    '#abdda4',
    '#66c2a5',
    '#3288bd',
    '#5e4fa2',
  ],
})
registerPalette('rdylgn', {
  kind: 'diverging',
  colorblindSafe: false,
  stops: [
    '#a50026',
    '#d73027',
    '#f46d43',
    '#fdae61',
    '#fee08b',
    '#ffffbf',
    '#d9ef8b',
    '#a6d96a',
    '#66bd63',
    '#1a9850',
    '#006837',
  ],
})

// --- Categorical ------------------------------------------------------------

// Matches the ApexCharts default series palette so a map dropped beside a chart
// in the same dashboard is colour-consistent with no configuration.
registerPalette('apex', {
  kind: 'categorical',
  stops: [
    '#008FFB',
    '#00E396',
    '#FEB019',
    '#FF4560',
    '#775DD0',
    '#3F51B5',
    '#03A9F4',
    '#4CAF50',
    '#F9CE1D',
    '#FF9800',
  ],
})
registerPalette('tableau', {
  kind: 'categorical',
  stops: [
    '#4e79a7',
    '#f28e2c',
    '#e15759',
    '#76b7b2',
    '#59a14f',
    '#edc949',
    '#af7aa1',
    '#ff9da7',
    '#9c755f',
    '#bab0ab',
  ],
})
registerPalette('okabeIto', {
  kind: 'categorical',
  colorblindSafe: true,
  stops: ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#D55E00', '#F0E442', '#000000'],
})

/**
 * Pick a sensible default palette for a domain.
 *
 * A domain that straddles zero is almost always an anomaly, change, margin or
 * difference, so it gets a diverging ramp anchored at zero. Everything else gets
 * a sequential ramp. Choosing this automatically prevents the single most common
 * palette error: a sequential ramp on signed data, which hides the sign.
 *
 */
export function defaultPaletteFor(domain: [number, number]): string {
  const [lo, hi] = domain
  if (Number.isFinite(lo) && Number.isFinite(hi) && lo < 0 && hi > 0) return 'rdbu'
  return 'blues'
}
