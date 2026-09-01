# ApexMaps

Interactive geographic data visualization and storytelling for the ApexCharts ecosystem.

> **Status: phase 1, pre-alpha (0.3.0).** Written in TypeScript. The engine, six series
> (choropleth, bubble, marker, hexbin, arc, line), hex tile layouts and the morph between them,
> projections, joins, scales, pattern and image fills, legend, tooltip, labels, annotations, camera,
> geometry registry, drilldown, clustering, selection and accessibility layer are working and
> tested. The story engine and tiles are not built yet.

```js
import ApexMaps from 'apexmaps'

const map = new ApexMaps(document.querySelector('#map'), {
  geo: { map: 'world/countries@110m' },
  series: [
    {
      name: 'Unemployment rate',
      joinBy: ['iso_a3', 'code'],
      data: [{ code: 'FRA', value: 7.3 }, { code: 'DEU', value: 5.7 }],
    },
  ],
})

await map.render()
```

That is the whole example. No geometry to find, host or parse, and no projection, palette,
classification, legend, label or tooltip configuration: the defaults are meant to be publishable.

## What works today

| Area | Detail |
|---|---|
| Series | `choropleth`, `bubble` (proportional symbols), `marker` (seven shapes, categorical colour, clustering&nbsp;†), `hexbin` (point density on a hexagonal lattice, count/sum/mean/min/max, refining with the zoom)&nbsp;†, `arc` (great-circle connections, travelling `flow` beads)&nbsp;†, `line` (routes through given vertices)&nbsp;†, plus an automatic basemap whenever no feature series is present |
| Projections | 13 core projections with aliases (`equalEarth` default, `webMercator`, `epsg:3857`, `albersUsa`, `orthographic`, conics, azimuthals), spec objects with `rotate` / `parallels` / `clipAngle`, and `ApexMaps.registerProjection()`&nbsp;† for the rest of `d3-geo-projection` |
| Geometry | 26 built-in packs: world countries and land, US states and counties, EU NUTS 0-3, and admin-1 for 15 more countries. Lazy, one request per pack, provenance and attribution attached |
| Layouts | `layout: 'hex'` redraws a region set as a hex tile map (honeycomb, tilegram): one equal cell per region, keyed the way the boundary pack is keyed, so the same data and the same `joinBy` serve both. Toggling it **morphs**, region by region, so the reader can see which cell is which place. Seven ship (US states, Australia, Canada, Germany, Brazil, Japan, Europe), each scored against its boundary pack by `npm run check:layout`; `ApexMaps.registerLayout()` takes your own&nbsp;† |
| Data | GeoJSON, TopoJSON, bare geometry, feature arrays; automatic winding repair; join-key auto-detection |
| Joins | Explicit `joinBy`, mismatch diagnostics with suggestions, FIPS leading-zero repair, opt-in `fuzzyJoin` |
| Scales | quantile, equal interval, Jenks, threshold, linear, log, sqrt, ordinal; OkLab-sampled ramps; 17 palettes; automatic diverging selection; square-root size scales with nested-circle legends |
| Fills | Flat colour, or eight pattern tiles with automatic ink contrast and patterned legend swatches&nbsp;†, or an image per region clipped to its outline&nbsp;† |
| Interaction | Anchored wheel zoom, inertial pan, pinch, double-click zoom, on-screen zoom controls, versor globe dragging on `orthographic`, hover states, click and box selection with dimming, cross-map linked selection&nbsp;†, legend class muting, drilldown with automatic parent detection and a breadcrumb&nbsp;† |
| Camera | `flyTo` (Van Wijk zoom-and-pan path), `easeTo`, `jumpTo`, `fitBounds`, `frameFeature`, `resetView`, interruptible and retargeting; on azimuthal projections a move to a place turns the sphere (quaternion slerp) instead of panning |
| Components | Classed, gradient and nested-circle legends with a hover marker that tracks the pointer along the bar, HTML tooltips with edge flipping, collision-avoiding labels with halos, editorial annotations&nbsp;† |
| Accessibility | ARIA roles, auto-generated description, roving-tabindex keyboard navigation, live-region announcements, optional data table, `prefers-reduced-motion` |
| Platform | TypeScript source with a discriminated `Series` union, ESM / UMD / IIFE builds, emitted declarations, SSR-safe import, 82 kB gzipped core |
| Frameworks | [`react-apexmaps`](wrappers/react), [`vue-apexmaps`](wrappers/vue) and [`ngx-apexmaps`](wrappers/angular), typed against this package's own options |

† Licensed feature. It works without a key so you can evaluate it, with a watermark on the map. See
[Licensing](#licensing) for the whole list and the reasoning.

**Where the detail lives.** Every option carries its reasoning in its own JSDoc, so it shows on hover
in an editor. [`examples/`](examples) is one runnable demo per feature, and each page carries the
longer notes on why the feature behaves the way it does rather than the obvious way.

## Frameworks

```sh
npm install apexmaps react-apexmaps    # or vue-apexmaps, or ngx-apexmaps
```

```jsx
import ApexMaps from 'react-apexmaps'

<ApexMaps options={options} series={series} onFeatureClick={({ key }) => setSelected(key)} height={480} />
```

```vue
<ApexMaps :options="options" :series="series" :height="480" @feature-click="onClick" />
```

```html
<apx-map [options]="options" [series]="series()" [height]="480" (featureClick)="onClick($event)" />
```

Each is built for its own framework's change model rather than adapted from the React one:

- [**React**](wrappers/react): props are compared deeply, so a fresh `options` object on every parent
  render is not a redraw, and a series-only change tweens rather than rebuilding the DOM.
- [**Vue 3**](wrappers/vue): mutating `options` in place on reactive state is seen, and no reactive
  proxy ever reaches the map.
- [**Angular**](wrappers/angular): a standalone component with signal inputs, zoneless-ready. The map
  runs outside the Angular zone and outputs re-enter it, so handlers that set state repaint in zoned
  and zoneless apps alike.

A Svelte wrapper will live in the same tree and is not built yet.

## Try the examples

```sh
npm install
npm run examples          # builds, then serves on http://localhost:8084/examples/
npm run check:examples    # loads every demo and fails on one that errors or draws nothing
```

That is all: the geometry packs are committed under `geo/`, so nothing has to be downloaded or
generated first. `npm run data:build` only exists to regenerate them from source.

**One page per feature**, so each demo loads on its own, can be linked to directly, and cannot be
broken by an unrelated one:

| Demo | Shows |
|---|---|
| [choropleth](examples/choropleth.html) | What two option keys and no styling produce |
| [scales](examples/scales.html) | Quantile, Jenks, equal interval and threshold on one skewed dataset |
| [palettes](examples/palettes.html) | All 17 ramps, and the automatic diverging choice |
| [normalize](examples/normalize.html) | Counts versus rates, side by side |
| [projections](examples/projections.html) | Eight projections, spec objects, rotation |
| [basemap](examples/basemap.html) | Geometry with no data, and label collision |
| [patterns](examples/patterns.html) | A tile per region, with the colour still leading |
| [image-fill](examples/image-fill.html) | A picture per region, clipped to its own outline |
| [honeycomb](examples/honeycomb.html) | One hexagon per state, and the same map toggled back to real boundaries |
| [hexbin](examples/hexbin.html) | Twenty thousand points binned, and what drawing every one of them costs |
| [bubbles](examples/bubbles.html) | Square-root versus linear sizing, second colour encoding |
| [markers](examples/markers.html) | Seven shapes, categorical colour, clustering |
| [arcs](examples/arcs.html) | Great circles, antimeridian cutting, curvature, travelling flow |
| [registry](examples/registry.html) | Three packs with no configuration, plus the catalogue |
| [joins](examples/joins.html) | A failing join explained, then repaired |
| [drilldown](examples/drilldown.html) | States into counties, and back out |
| [selection](examples/selection.html) | Box selection brushing a linked pair of maps |
| [camera](examples/camera.html) | flyTo, easeTo, fitBounds, interruption, flying across a globe |
| [a11y](examples/a11y.html) | Keyboard navigation, generated description, data table |
| [theming](examples/theming.html) | Dark mode, CSS custom properties, responsive rules |
| [extending](examples/extending.html) | registerMap with a floor plan, registerPalette, a loader function |
| [bench](examples/bench.html) | Frame times in your own browser, up to 3,231 features |

`check:examples` opens all of them in headless Chromium and fails on a console error, a demo that
never becomes ready, a map that drew zero marks, or a page missing from the index. The blank-map case
is the one worth automating: a demo that throws is obvious, while a demo that renders nothing because
a pack id moved looks fine in a diff.

## The geometry registry

Finding, converting and hosting boundaries is the tax on every map project, and it is paid before any
chart is drawn. So the geometry is part of the product:

```js
geo: { map: 'world/countries@110m' }   // canonical id
geo: { map: 'world/countries' }        // detail-free: the lightest one
geo: { map: 'us' }                     // states
geo: { map: 'jp/prefectures' }         // the country's own word for its tier
geo: { map: 'eu/nuts2@20m' }           // Eurostat regions
geo: { map: 'us', layout: 'hex' }      // the same states as one hexagon each
```

Seven region sets also have a **hex tile layout**, which is the same regions drawn as
equal cells instead of real boundaries: `us` (51), `jp` (47), `eu` (37), `br` (27), `de` (16),
`ca` (13) and `au` (8). Reach one with `layout: 'hex'` or by its own id (`us/states@hex`,
`au/hex`). The layout is keyed the way its boundary pack is keyed, so one dataset serves both,
and it resolves independently: asking for the honeycomb never downloads the boundaries.

### Hexagons twice, for two different things

`layout: 'hex'` and `type: 'hexbin'` both draw hexagons and are unrelated, which is worth
saying once because the word does double duty:

|  | `layout: 'hex'` | `type: 'hexbin'` |
|---|---|---|
| What a cell is | one **region**, placed by hand | one patch of the **projection** |
| What it needs | a region set, and the layout to exist | points with coordinates |
| Cell count | fixed: however many regions | whatever the data and the radius give |
| Boundaries | replaced by it | ignored by it, so it sits on a basemap |
| Reading it | which region, at equal weight | how much landed where |

A hexbin is the answer to more points than pixels. Twenty thousand markers give you the shape
of the data without its magnitude, because overlapping marks stop counting once they overlap.
Binning aggregates instead: `count` by default and needing no value field, or `sum`, `mean`,
`min`, `max` over one. The radius is in screen pixels, so the lattice **refines as the reader
zooms** rather than magnifying, rebuilt at quantized levels so a pan never re-bins. The colour
domain follows the bins, which means the class breaks move with the zoom and the legend moves
with them; pass `scale.domain` to pin them when two maps have to be compared.

Turning a layout on or off through `updateOptions` morphs the regions between the two
representations rather than swapping them: each outline is resampled at equal arc length,
rotated to its closest match and walked to its cell. It is not decoration. The hardest thing
about reading a cartogram is knowing which cell is which region, and watching Texas walk to
its own is what tells you. It runs off `chart.animations` and stands down above the motion
budget, since unlike every other transition here it is vertex work every frame.

Every one is hand-authored, because no country has a canonical tilegram and curating the table
*is* the work. `npm run check:layout` scores each against the boundary pack it claims to
represent: whether west-to-east and north-to-south order survive, and what share of the real
shared-arc borders still touch. All seven have no order errors; borders kept run from 72%
(Germany) to 100% (Australia). Where a compromise is forced the pack records it in prose and
exempts the pair by name, so a decision already taken cannot hide a new mistake.

26 boundary packs cover world countries and coastline, US states and all 3,231 counties, NUTS levels 0 to 3,
and admin-1 for China, India, Japan, Germany, the UK, France, Italy, Canada, Brazil, Russia, Mexico,
Australia, South Korea, Spain and Indonesia. Nothing is fetched until a pack is used, and one pack is
one request no matter how many aliases or maps on the page ask for it.

Four things travel with each pack, and each removes a bug the caller would otherwise hit: a
**recommended join key** (`us/states` joins on `"CA"`, admin-1 packs on ISO 3166-2 codes, because
generic detection would give all 47 Japanese prefectures the key `JPN`), **repaired identifiers**
(Natural Earth publishes `ISO_A3` as `-99` for France and Norway, so anyone joining on `iso_a3` loses
two countries silently), a **recommended projection and view** for the packs where the generic
default is wrong rather than merely suboptimal (`us` gets `albersUsa`; NUTS gets EPSG:3035 and a
mainland view), and **provenance** through `ApexMaps.mapMeta(id)`, with required attribution rendered
automatically.

The dataset ships as a separate package, [`apexmaps-geo`](geo/README.md), versioned independently:
boundaries change on their own schedule, and a boundary correction should not require a library
upgrade. By default packs are fetched from jsDelivr, so nothing needs installing.

```sh
npm install apexmaps-geo   # only when you want the files locally
```

```js
ApexMaps.setGeoSource((file) => import(`apexmaps-geo/${file}`).then((m) => m.default))  // no network
ApexMaps.setGeoSource('https://cdn.example.com/apexmaps-geo/')                         // self-hosted
```

> **Status:** `apexmaps-geo@1.0.0` is published, and the 26 boundary packs load from the default
> CDN source with no configuration. The seven hex layout files are not in that release yet, so
> `layout: 'hex'` needs `setGeoSource()` pointed at a copy that has them until the next dataset
> publish. `npm run check:geo` reads this repository's own `geo/` directory, so it cannot tell you
> this: check the CDN before relying on a pack in production.

## Performance

Measured in headless Chromium with the frame rate unclamped. `npm run examples` then open
[bench.html](examples/bench.html) to run it on your own machine.

| Pack | Features | Parse | Render | Reproject | JS per frame | Frame p50 | Frame p95 |
|---|---|---|---|---|---|---|---|
| `world/countries@110m` | 177 | 0.4 ms | 29 ms | 14 ms | 0.1 ms | 0.5 ms | 0.9 ms |
| `eu/nuts3@20m` | 1,514 | 1.5 ms | 42 ms | 33 ms | 0.1 ms | 1.2 ms | 1.6 ms |
| `us/counties@10m` | 3,231 | 3.0 ms | 331 ms | 87 ms | 0.1 ms | 2.4 ms | 3.1 ms |

The budget is a p95 pan and zoom frame under 16 ms at 3,000 features. It comes in at **3.1 ms with
3,231 features**, and **0.1 ms of that is library code**: features live in world space under a single
group, so a camera frame writes one `transform` on one element and the per-frame cost in our code is
constant in the feature count. CI enforces that invariant rather than the milliseconds
([test/perf.test.ts](test/perf.test.ts)), because a wall-clock assertion would flake on a loaded
runner, get skipped, and then nothing would be enforced.
[Run the numbers yourself](examples/bench.html).

## Joins fail loudly

Around nine in ten real-world map failures are join failures, and every library renders them as
silent grey. In development ApexMaps prints what actually happened:

```
join: 3/6 data rows matched 3/177 features (geometry key "name", data key "name")
  3 data row(s) did not match geometry:
    "Ivory Coast" -> did you mean "Côte d'Ivoire"?
    "United States" -> did you mean "United States of America"?
  174 feature(s) had no data (rendered as no-data): Fiji, Tanzania, W. Sahara, ...
```

Available programmatically as `map.diagnoseJoin()`. Matching stays exact by default, because silently
guessing turns an obvious failure into a plausible wrong answer; `fuzzyJoin: true` applies the
suggestions and reports every substitution.
[More on one-to-many joins](examples/joins.html).

## API sketch

```js
const map = new ApexMaps(element, {
  chart: { height: 520, animations: { enabled: true } },
  geo: {
    map: 'world/countries@110m',   // registry id, URL, GeoJSON or TopoJSON
    projection: 'equalEarth',      // name, or { name, rotate, parallels, ... }
    view: { fit: 'data', padding: 24 },
    graticule: { show: true, step: 20 },
    sphere: { show: true },
  },
  series: [
    {
      type: 'choropleth',
      name: 'Unemployment rate',
      joinBy: ['iso_a3', 'code'],         // [geometryProperty, dataKey]
      data: [/* ... */],
      normalizeBy: 'population',          // legend retitles itself
      scale: { type: 'quantile', classes: 5, palette: 'blues' },
      fill: { pattern: { type: 'dots' } },   // or { image: { src } }, both licensed
      drilldown: { map: 'us/counties' },     // child level, scoped to the clicked feature
    },
    {
      type: 'bubble',
      name: 'Metro population',
      // Positions come from the data, or from geometry centroids via joinBy.
      data: [{ name: 'Tokyo', lon: 139.7, lat: 35.7, value: 37_400_000 }],
      size: { scale: 'sqrt', range: [3, 28] },   // sqrt is the default, and why
      colorScale: { palette: 'reds' },           // optional second encoding
    },
    {
      type: 'marker',
      name: 'Sites',
      data: [{ name: 'Depot 4', lon: -0.12, lat: 51.5, kind: 'depot' }],
      shape: 'pin',                   // 7 shapes, all generated paths
      colorBy: 'kind',                // ordinal scale plus a legend
      cluster: { radius: 60 },        // merges by distance, dissolves on zoom
    },
    {
      type: 'arc',
      name: 'Weekly flights',
      // Endpoints may be [lon, lat] pairs or geometry keys.
      data: [{ from: [103.99, 1.36], to: 'GBR', value: 900 }],
      geodesic: true,                 // default: the real great circle
      flow: true,                     // beads travelling from -> to
      endpoints: { show: true },
    },
  ],
  dataLabels: { enabled: true, collision: 'hide' },
  interaction: {
    zoom: { enabled: true, wheel: true, controls: { position: 'top-right' } },
    pan: { enabled: true, inertia: true },
    rotate: { enabled: 'auto' },    // a drag spins a globe instead of panning it
    selection: { multiple: true, rectangle: true, modifier: 'shift' },
  },
  link: { group: 'dashboard' },   // brush this map, brush the others (licensed)
  legend: {
    position: 'bottom',           // 'top' | 'left' | 'right' too; a side is a column
    style: 'gradient',            // one bar; classed scales draw as hard bands
    marker: true,                 // arrow on the bar tracks the hovered feature
  },
  tooltip: { formatter: ({ name, value }) => `${name}: ${value}` },
  a11y: { enabled: true, description: 'auto', dataTable: false },
})

await map.render()

map.camera.flyTo({ center: [2.35, 48.85], zoom: 8 })   // a pan here, a rotation on a globe
map.zoomIn(); map.zoomOut()     // one step, what the buttons and the +/- keys do
await map.resetView()           // back to the opening fit, and a globe's opening spin
map.rotateTo([-25, -18])        // turns the sphere, on a projection that can be turned
await map.frameFeature('FRA', { padding: 40 })
await map.drillTo('FRA')        // as a click would; drillUp() / drillUp(Infinity) climb back
map.setSelection(['FRA', 'DEU'])
map.updateSeries([{ name: 'Unemployment rate', joinBy: ['iso_a3', 'code'], data: next }])
await map.updateOptions({ geo: { projection: 'mercator' } })
map.on('featureClick', ({ key, value, datum }) => {})
const spec = map.toSpec()   // JSON-serialisable
```

### Statics

```js
ApexMaps.setLicense(key)                        // shared across the ApexCharts family
ApexMaps.registerMap(id, geometry, meta)        // meta carries source, licence, vintage
ApexMaps.registerLayout(id, { keyField, cells }) // one equal cell per region
ApexMaps.registerProjection(name, factory)
ApexMaps.registerPalette(name, { kind, stops })
ApexMaps.listMaps()
ApexMaps.listProjections()
ApexMaps.listPalettes()
ApexMaps.palette('blues')                       // { kind, stops, colorblindSafe }
ApexMaps.mapMeta('us/counties@10m')             // source, licence, vintage, key, view
ApexMaps.catalogue()                            // every built-in pack, with provenance
```

## Theming

The map's chrome is styled with CSS custom properties under the `--apexmaps-*`
namespace. Set any of them on the container (or anywhere above it) and the map
follows, with no configuration:

```css
.my-map {
  --apexmaps-surface: #faf7ff;
  --apexmaps-border: rgba(91, 33, 182, 0.2);
  --apexmaps-focus: #5b21b6;
}
```

### Family tokens (`--apx-*`)

Every product in the ApexCharts family reads the same five root tokens, so a
page can state its brand once and have maps, plots, trees, flow diagrams and
Gantt charts all follow:

| Token | Role |
| --- | --- |
| `--apx-accent` | The colour that means interactive or selected |
| `--apx-fore` | Text and anything that must stay legible on the surface |
| `--apx-grid` | Hairlines: borders and separators |
| `--apx-surface` | The plane content sits on |
| `--apx-series-1` … `--apx-series-N` | An ordered categorical palette (1-based) |

```css
:root {
  --apx-accent: #5b21b6;
  --apx-fore: #1f2933;
  --apx-grid: rgba(0, 0, 0, 0.12);
  --apx-surface: #ffffff;
}
```

Custom properties inherit, so declaring them on `:root` reaches every chart on
the page. They sit **below** anything you set yourself, so adopting them cannot
change a map you had already themed:

```
--apexmaps-* you set  >  --apx-* family token  >  built-in default
```

`--apexmaps-fg`, `--apexmaps-surface`, `--apexmaps-border` and
`--apexmaps-focus` take them. `--apexmaps-bg` deliberately does not: its default
is `transparent` so your own card shows through, and painting it with
`--apx-surface` would cover a background you chose.

### Why dark mode does not take them

A single set of `--apx-*` values describes **one** appearance. The map's mode is
chosen by `theme.mode` (`'light'`, `'dark'` or `'auto'`), not by the page, so
the two can disagree: a page with a light brand surface plus `theme.mode:
'dark'` would paint the dark palette white and put white text on it. Rather than
guess, the dark palette stays self-contained and always legible.

To brand dark mode, override the `--apexmaps-*` tokens under `.apexmaps--dark`
(or on the container), which still wins over everything.

## Opinionated defaults, and why

- **Equal Earth, not Web Mercator.** Most developers never choose a projection, so the default has to
  be the defensible one. Mercator exaggerates high-latitude area by an order of magnitude, which is
  exactly wrong when area encodes a value.
- **Quantile classification with visible breaks.** Every class is populated and the actual break
  values appear in the legend, because classification silently changes a choropleth's conclusion.
- **Ramps sampled in OkLab.** Interpolating through sRGB turns ramp midpoints muddy grey, and readers
  infer magnitude from perceived lightness.
- **No-data is its own colour.** An unmatched feature never falls into the lowest class, which would
  understate it.
- **Winding is repaired on ingest.** A counterclockwise ring makes `d3-geo` render the whole sphere
  minus your polygon: solid fill, identical centroids for every feature, nothing thrown.
- **Accessibility is on by default and free in every tier.**

## Licensing

Dual licensed on the same terms as the rest of the family: a free **Community License** for
individuals, non-profits, educators and organizations under $2M USD annual revenue, and a paid
Commercial or OEM license above that. One key works across every Apex product, so an ApexCharts or
ApexGrid customer does not buy a second one for maps. See [LICENSE](LICENSE).

What is licensed is a **set of features**, not map count, map size, or geometry downloads. There is
no metering of map loads, no seat counting in the library, and no network call to check anything.

The line is that **a map that answers a question is free, and a map that becomes an application is
licensed.** A rule rather than a list, because a list invites an argument per feature and a rule
survives the next one.

| Free, always | Licensed |
|---|---|
| `choropleth`, `bubble` and `marker` series, and the automatic basemap | Point clustering (`cluster`) and point density (`type: 'hexbin'`) |
| Every one of the 13 built-in projections, with spec objects | Projections you register yourself (`registerProjection`) |
| The geometry registry, all 26 packs, provenance and attribution | Drilldown and the breadcrumb (`drilldown`) |
| Real boundaries, in every pack and projection | Hex tile layouts (`layout: 'hex'`, `registerLayout`) |
| Tooltips, legends, labels, data labels, states and themes | Editorial annotations (`annotations`) |
| Zoom, pan, pinch, hover, click and box selection, the camera API | `arc` and `line` route series |
| Joins, including `fuzzyJoin`, and the join diagnostics | Linked selection across maps (`link: { group }`) |
| Scales, palettes, size legends, responsive rules | Story mode (`chart: { context: 'story' }`) |
| Flat fills, in every scale and palette | Pattern fills (`fill: { pattern }`) and image fills (`fill: { image }`) |
| PNG and SVG export | Presentation mode, map-to-chart morphing, time playback, the WebGL tier *(not built yet)* |
| The accessibility layer | |

Without a valid key the licensed features **still work, in full, with a watermark on the map**. That
is deliberate: evaluate the thing before paying for it, in your own app, with your own data. A valid
key removes the watermark, without a reload. A map that uses none of them renders clean, with or
without a key.

```js
ApexMaps.setLicense('APEX-xxxxxxxx') // before rendering; applies to every map on the page
```

One key covers every Apex product, but **each product needs its own call**: `ApexMaps.setLicense()`
and `ApexCharts.setLicense()` set different copies of the licence manager, because each library
bundles its own. A page with a chart and a map calls both, with the same key. Get a license at
[apexcharts.com/pricing](https://apexcharts.com/pricing).

Two commitments that do not change with tier:

- **Accessibility is never gated.** Free in every tier, permanently, along with the free tier's
  answer to colour vision: the `okabeIto` palette and the automatic diverging-palette selection.
  Pattern fills are the cartographic and print form of the same idea and are priced with the
  authoring surface. That is a pricing decision rather than a technical one, and it lives in
  [`src/core/premium.ts`](src/core/premium.ts) where it can be argued with.
- **No mandatory network calls.** The default build fetches nothing and phones home to nothing.
  Geometry is fetched only when you name a pack, from wherever you point `setGeoSource()`.

## Geometry and licences

**The software licence does not cover the geographic data**, which is published by third parties
under its own terms. [LICENSE](LICENSE) lists each source and its obligations.

The three sources used are permissively licensed: Natural Earth 5.1.1 and US Census TIGER/Line are
public domain, Eurostat GISCO NUTS is CC BY 4.0 with EuroGeographics terms and is credited on screen.
**GADM is deliberately not used**: it is non-commercial only, which is a licence trap that has caught
other products. Boundary policy is recorded rather than decided, and `mapMeta(id).boundaries` says
whose view a pack carries.

## Development

```sh
npm test                # vitest, 682 tests, including the real geometry packs and perf invariants
npm run test:coverage
npm run lint
npm run typecheck
npm run format          # prettier, config matches apexcharts-js
npm run build           # rollup bundles + tsc declarations (cleans dist/ first)
npm run check:size      # fail if a bundle crosses the 150 kB gzipped budget
npm run check:license   # drive the BUILT bundle through licence enforcement (gates publishing)
npm run check:geo       # verify the geo/ dataset and the library agree (gates publishing)
npm run check:layout    # score every hand-authored hex layout against its boundary pack
npm run check:geo-source # verify the default CDN geometry source actually serves geometry
npm run examples        # build, then serve examples/ on :8084
npm run check:examples  # load every demo in Chromium, fail on an error or an empty map
npm run data:build      # regenerate geo/ from source (needs network, ~45 MB of downloads)

npm run build:wrappers     # build every package under wrappers/ (needs npm run build first)
npm run typecheck:wrappers # check wrapper props against this package's emitted declarations
npm run check:wrappers     # packaging: 'use client' survives, peers external, wrappers subpath imported
```

The framework wrappers are npm workspaces, so one `npm install` covers them and `npm test` runs their
tests alongside the core's. They resolve `apexmaps` through its published `exports`, which is why
`npm test` on a fresh clone wants `npm run build && npm run build:wrappers` first: the Angular suite
tests the built `ngx-apexmaps` package itself, because signal inputs and outputs are initializer APIs
that only exist after the Angular compiler has run. Without them those tests fail with exactly that
instruction rather than a resolution error.

All of it runs on every push and pull request (`.github/workflows/ci.yml`), including the bundle
budget and the demo smoke check, so a claim in this file is a job in that one. **A feature is not
finished until it has a demo page that `check:examples` loads**: the unit tests prove the behaviour,
the demo proves someone can use it, and the check stops the demo rotting.

`data:build` is the only script that touches the network. It caches its downloads in `.geo-cache/`,
and it fails if the packs it produced and the ids declared in `src/core/GeoCatalogue.ts` disagree,
because a catalogue entry with no file is a runtime 404 and a file with no entry is invisible.

## Dependencies

`d3-geo` (ISC) for projections, great-circle interpolation and spherical maths, `topojson-client`
(ISC), `apex-commons` for licensing. `d3-geo` is wrapped rather than reimplemented: spherical
clipping, antimeridian cutting and adaptive resampling are correctness traps that took it years to
get right, and the winding convention alone cost this project three attempts.
