# ApexMaps

Interactive geographic data visualization and storytelling for the ApexCharts ecosystem.

> **Status: phase 1, pre-alpha (0.1.0).** Written in TypeScript. The engine, three series
> (choropleth, bubble, arc), projections, joins, scales, legend, tooltip, labels, camera, geometry
> registry and accessibility layer are working and tested. The story engine and tiles are not built
> yet. See
> [SCOPE.md](SCOPE.md) for what is deliberately out of scope, and the internal `PRODUCT-RESEARCH.md`
> (kept in `plans/`, not published) for the strategy behind it.

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
| Series | `choropleth`, `bubble` (proportional symbols), `marker` (seven shapes, categorical colour, clustering), `arc` (great-circle connections), plus an automatic basemap whenever no feature series is present |
| Projections | 13 core projections with aliases (`equalEarth` default, `webMercator`, `epsg:3857`, `albersUsa`, `orthographic`, conics, azimuthals), spec objects with `rotate` / `parallels` / `clipAngle`, and `ApexMaps.registerProjection()` for the rest of `d3-geo-projection` |
| Geometry | 26 built-in packs: world countries and land, US states and counties, EU NUTS 0-3, and admin-1 for 15 more countries. Lazy, one request per pack, provenance and attribution attached |
| Data | GeoJSON, TopoJSON, bare geometry, feature arrays; automatic winding repair; join-key auto-detection |
| Joins | Explicit `joinBy`, mismatch diagnostics with suggestions, FIPS leading-zero repair, opt-in `fuzzyJoin` |
| Scales | quantile, equal interval, Jenks, threshold, linear, log, sqrt, ordinal; OkLab-sampled ramps; 17 palettes; automatic diverging selection; square-root size scales with nested-circle legends |
| Interaction | Anchored wheel zoom, inertial pan, pinch, double-click zoom, hover states, selection, legend class muting |
| Camera | `flyTo` (Van Wijk zoom-and-pan path), `easeTo`, `jumpTo`, `fitBounds`, `frameFeature`, `resetView`, interruptible and retargeting |
| Components | Classed, gradient and nested-circle legends, HTML tooltips with edge flipping, collision-avoiding labels with halos |
| Accessibility | ARIA roles, auto-generated description, roving-tabindex keyboard navigation, live-region announcements, optional data table, `prefers-reduced-motion` |
| Platform | TypeScript source with a discriminated `Series` union, ESM / UMD / IIFE builds, emitted declarations, SSR-safe import, 51 kB gzipped core |

## Try the examples

```sh
npm install
npm run examples       # builds, then serves on http://localhost:8080/examples/
```

That is all: the geometry packs are committed under `geo/`, so nothing has to be downloaded or
generated first. `npm run data:build` only exists to regenerate them from source.

The examples cover default styling, projection switching, a basemap with no data, bubbles, arcs, the
geometry registry, a printout of the catalogue, and a live join diagnostics panel. `bench.html` on the
same server measures frame times in your browser.

## The geometry registry

Finding, converting and hosting boundaries is the tax on every map project, and it is paid before
any chart is drawn. So the geometry is part of the product:

```js
geo: { map: 'world/countries@110m' }   // canonical id
geo: { map: 'world/countries' }        // detail-free: the lightest one
geo: { map: 'us' }                     // states
geo: { map: 'jp/prefectures' }         // the country's own word for its tier
geo: { map: 'eu/nuts2@20m' }           // Eurostat regions
```

26 packs cover world countries and coastline, US states and all 3,231 counties, NUTS levels 0 to 3,
and admin-1 for China, India, Japan, Germany, the UK, France, Italy, Canada, Brazil, Russia, Mexico,
Australia, South Korea, Spain and Indonesia. Nothing is fetched until a pack is used, and one pack is
one request no matter how many aliases or maps on the page ask for it.

Four things travel with each pack, and each of them removes a bug the caller would otherwise hit.

**A recommended join key.** Data is keyed the way data is actually keyed, so `us/states` joins on
`"CA"` and admin-1 packs join on ISO 3166-2 codes like `"DE-BY"`. Generic detection cannot get this
right: an admin-1 feature also carries `adm0_a3`, and choosing it would give all 47 Japanese
prefectures the key `JPN`. TIGER geometry carries only FIPS codes, so the pipeline adds the USPS
abbreviations.

**Repaired identifiers.** Natural Earth publishes `ISO_A3` as `-99` for France and Norway, among
others, because it splits their overseas parts into separate features. Anyone joining on `iso_a3`
loses two countries silently. The pipeline repairs them once, at build time, and records how.

**A recommended projection and view**, for the packs where the generic default is not merely
suboptimal but wrong. `us` gets `albersUsa`, because Alaska's Aleutians cross the antimeridian and
otherwise the United States spans the whole width of the world. NUTS packs get EPSG:3035 and a
mainland view, because the geometry reaches from French Guiana to Réunion and fitting all of it
leaves Europe a few pixels across. An explicit `geo.projection` or `geo.view` always wins.

**Provenance.** Source, licence, vintage, boundary policy and detail level, available through
`ApexMaps.mapMeta(id)` and `ApexMaps.catalogue()`. Required attribution renders automatically, so a
NUTS map credits EuroGeographics whether or not anyone remembered to.

The dataset ships separately from the library, because 6.7 MB of geometry has no business inside a
charting dependency:

```js
ApexMaps.setGeoSource('https://cdn.example.com/apexmaps-geo/')          // self-hosted
ApexMaps.setGeoSource((file) => import(`apexmaps-geo/${file}`))         // bundled, no network
```

The default source points at an `apexmaps-geo` npm package that is **not published yet**. In this
repository the packs are committed under `geo/`, which is where the examples read them from, and
`npm run data:build` regenerates them from Natural Earth, US Census TIGER and Eurostat GISCO.

## Performance

Measured in headless Chromium with the frame rate unclamped, so the intervals reflect work rather
than the display's refresh rate. `npm run examples` then open [bench.html](examples/bench.html) to
run it on your own machine.

| Pack | Features | Parse | Render | Reproject | JS per frame | Frame p50 | Frame p95 |
|---|---|---|---|---|---|---|---|
| `world/countries@110m` | 177 | 0.4 ms | 29 ms | 14 ms | 0.1 ms | 0.5 ms | 0.9 ms |
| `eu/nuts3@20m` | 1,514 | 1.5 ms | 42 ms | 33 ms | 0.1 ms | 1.2 ms | 1.6 ms |
| `us/counties@10m` | 3,231 | 3.0 ms | 331 ms | 87 ms | 0.1 ms | 2.4 ms | 3.1 ms |
| `us/counties@10m` + labels | 3,231 | 2.5 ms | 312 ms | 83 ms | 0.0 ms | 2.5 ms | 3.3 ms |

The budget is a p95 pan and zoom frame under 16 ms at 3,000 features. It comes in at **3.1 ms with
3,231 features**, and **0.1 ms of that is library code**.

That last column is the design. Features live in world space under a single group, so panning and
zooming write one `transform` on one element: the per-frame cost in our code is constant in the
feature count, and what scales is the browser rasterising paths it already has. Only marks whose
pixel size carries meaning (bubble radii, label positions) are rewritten per frame, and that cost is
O(marks), not O(features).

Two things worth knowing from the numbers. The 331 ms initial render for counties is mostly
projection maths: `albersUsa` is a composite of three sub-projections with a point-in-region test per
coordinate, and it costs roughly three times a simple projection, which is the price of insetting
Alaska and Hawaii. Labels are culled by projected area before any per-label work, so 3,142 candidates
produce 69 placed labels without measuring 3,142 of them.

CI enforces the *invariant* rather than the milliseconds ([test/perf.test.ts](test/perf.test.ts)): a
camera frame writes exactly one attribute regardless of feature count, and feature path data is
byte-identical before and after a pan. A wall-clock assertion would flake on a loaded runner, get
skipped, and then nothing would be enforced, and reprojecting 3,000 features per frame would still
pass a generous millisecond budget on a fast laptop.

## The join diagnostic

Around nine in ten real-world map failures are join failures, and every library renders them as
silent grey. In development ApexMaps prints what actually happened:

```
join: 3/6 data rows matched 3/177 features (geometry key "name", data key "name")
  3 data row(s) did not match geometry:
    "Ivory Coast" -> did you mean "Côte d'Ivoire"?
    "United States" -> did you mean "United States of America"?
    "Democratic Republic of the Congo" -> did you mean "Dem. Rep. Congo"?
  174 feature(s) had no data (rendered as no-data): Fiji, Tanzania, W. Sahara, ...
```

Available programmatically as `map.diagnoseJoin()`. Matching stays exact by default, because silently
guessing turns an obvious failure into a plausible wrong answer. Pass `fuzzyJoin: true` to apply the
suggestions, and the report lists every substitution it made.

One row can legitimately colour several shapes, and the report says when it does. Natural Earth gives
Australia, the Indian Ocean Territories and Ashmore and Cartier Islands the same `iso_a3`, and Lord
Howe Island carries `AU-NSW` alongside New South Wales, so a key maps to a list of features rather
than to one. Keeping only the last would leave mainland Australia grey while colouring an uninhabited
island.

## Bubbles and arcs

Both series exist to say something a choropleth cannot.

**Bubbles** are for absolute magnitudes. A choropleth of totals mostly redraws the map of where big
areas are; a circle's size is independent of the polygon under it. Three defaults are chosen for you
because the alternative is usually wrong: square-root radius scaling so *area* is proportional to
value, largest-first paint order so small circles stay clickable, and a radius range derived from the
plot size. The size legend nests three reference circles at round values, which is the only bubble
legend a reader can actually decode.

**Arcs** are for connections: routes, cables, trade, migration. They are geodesics by default,
because the shortest path between two places is a great circle and a straight line on a projected map
is neither the route nor the right length. Emitting each arc as a lon/lat `LineString` lets d3-geo cut
it at the antimeridian, so a trans-Pacific route leaves the right edge and re-enters on the left
instead of streaking backwards. `curvature` is available for the decorative fanned look and says so in
a dev-mode warning, since a bulged arc is no longer the true path.

```js
series: [
  { type: 'bubble', name: 'Population', data: cities },
  { type: 'arc', name: 'Routes', data: routes, endpoints: { show: true } },
]
```

Rendering follows from what each mark encodes: arcs live in world space and scale with the camera,
while bubbles live in screen space and hold their radius, because that radius carries a value. Thin
arcs get an invisible wider hit path so a 1px flight line is still hoverable.

## Markers and clustering

A marker says **"something is here"**, so its size is fixed. The moment size varies, a reader starts
decoding it as a quantity, and that is the bubble series, which scales by area and ships a legend
that can be decoded.

```js
series: [
  {
    type: 'marker',
    name: 'Sites',
    data: sites,              // { name, lon, lat, kind }
    shape: 'pin',             // circle, square, diamond, triangle, star, cross, pin
    colorBy: 'kind',          // ordinal scale plus a legend, automatically
    cluster: { radius: 55, maxZoom: 6 },
  },
]
```

Seven shapes, each generated as a path, so they scale without a sprite sheet, an icon font or an
image load that can fail CORS. `pin` is the only one anchored at its point rather than its centre,
because a pin floating above the place it marks is a pin pointing at nothing. Every mark gets an
invisible hit circle, so a 6px star does not demand pixel-perfect aim.

**Clustering is an option on the marker series, not a series of its own.** The data is identical
either way: clustering is a decision about how to draw points that would otherwise pile up, in the
same way classification is a decision about how to colour values. A separate series type would fork
position resolution, hit testing, colouring and the legend, and would force you to swap series types
at a zoom threshold.

Three things the clustering does that a quick implementation usually does not:

- **Merges by distance, not by grid cell.** Bucketing points into cells is simpler, but it separates
  two points a few pixels apart that happen to straddle a boundary while merging two at opposite
  corners of one cell. Readers notice, because the map contradicts what they can see. A grid is used
  only as a neighbour index; the merge test is real distance.
- **Clusters in world space at quantized zoom levels.** Panning never reclusters, so counts never
  shimmer or renumber under the cursor, and a smooth pinch recomputes a handful of times instead of
  sixty times a second.
- **Places each cluster at its members' centre of mass**, sized by the square root of the count, so
  a cluster of 100 does not read as a hundred times a cluster of 1.

Clicking a cluster flies to the bounds of its members, and emits `clusterClick` first if you would
rather do something else. Members that share a position would give a zero-size box and ask the camera
for infinite zoom, so that case steps in by a fixed amount instead.

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

## API sketch

```js
const map = new ApexMaps(element, {
  chart: { height: 520, renderer: 'auto', animations: { enabled: true } },
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
      joinBy: ['iso_a3', 'code'],     // [geometryProperty, dataKey]
      data: [/* ... */],
      normalizeBy: 'population',      // legend retitles itself
      scale: { type: 'quantile', classes: 5, palette: 'blues' },
      stroke: { color: '#ffffff', width: 0.5 },
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
      endpoints: { show: true },
    },
  ],
  dataLabels: { enabled: true, collision: 'hide' },
  legend: { position: 'bottom', interactive: true },
  tooltip: { formatter: ({ name, value }) => `${name}: ${value}` },
  a11y: { enabled: true, description: 'auto', dataTable: false },
})

await map.render()

map.camera.flyTo({ center: [2.35, 48.85], zoom: 8 })
await map.frameFeature('FRA', { padding: 40 })
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
ApexMaps.registerProjection(name, factory)
ApexMaps.registerPalette(name, { kind, stops })
ApexMaps.listMaps()
ApexMaps.listProjections()
```

## Licensing

Dual licensed on the same terms as the rest of the family: a free **Community License** for
individuals, non-profits, educators and organizations under $2M USD annual revenue, and a paid
Commercial or OEM license above that. One key works across every Apex product, so an ApexCharts or
ApexGrid customer does not buy a second one for maps. See [LICENSE](LICENSE).

What is licensed is a **short list of features**, not map count, map size, or geometry downloads.
There is no metering of map loads.

| Licensed feature | Status |
|---|---|
| Story mode and scrollytelling | Not built yet (phase 2) |
| Presentation mode | Not built yet (phase 2) |
| Map to chart morphing | Not built yet (phase 3) |
| WebGL renderer tier | Not built yet (phase 3) |
| Time playback | Not built yet (phase 3) |
| Cross-product linking (`link: { group }`) | Not built yet |

Without a valid key those features still work (**trial mode**) but the map shows a watermark. A valid
key removes it. Everything else, including every series type, every projection, the geometry registry
and the accessibility layer, is free and never watermarked. Because none of the licensed features
exists yet, a phase-1 map always renders clean.

```js
ApexMaps.setLicense('APEX-xxxxxxxx') // set once, before rendering; applies to every map on the page
```

The watermark is re-evaluated on every render, so a late `setLicense()` followed by `updateOptions()`
clears it. Get a license at [apexcharts.com/pricing](https://apexcharts.com/pricing).

Two commitments that do not change with tier:

- **Accessibility is never gated.** Free in every tier, permanently. Gating it would block the
  public-sector buyer we most want to serve, and it is the wrong thing to charge for.
- **No mandatory network calls.** The default build fetches nothing and phones home to nothing.
  Geometry is fetched only when you name a pack, from wherever you point `setGeoSource()`.

The reasoning behind the tier boundary is in the internal `PRODUCT-RESEARCH.md` section 12.5.

## Geometry and licences

**The software licence does not cover the geographic data**, which is published by third parties under
its own terms. [LICENSE](LICENSE) lists each source and its obligations.

Every pack, and any geometry you register yourself, carries its provenance (source, licence, vintage,
detail level, boundary policy), and required attribution renders automatically. The three sources
used are permissively licensed: Natural Earth 5.1.1 and US Census TIGER/Line are public domain,
Eurostat GISCO NUTS is CC BY 4.0 with EuroGeographics terms and is credited on screen. **GADM is
deliberately not used**: it is non-commercial only, which is a licence trap that has caught other
products.

Boundary policy is recorded rather than decided: the packs carry Natural Earth's and Eurostat's own
views, and `mapMeta(id).boundaries` says so.

## Development

```sh
npm test              # vitest, 241 tests, including the real geometry packs and perf invariants
npm run test:coverage
npm run lint
npm run typecheck
npm run format        # prettier, config matches apexcharts-js
npm run build         # rollup bundles + tsc declarations
npm run examples      # build, then serve examples/ on :8080
npm run data:build    # regenerate geo/ from source (needs network, ~45 MB of downloads)
```

`data:build` is the only script that touches the network. It caches its downloads in `.geo-cache/`,
and it fails if the packs it produced and the ids declared in `src/core/GeoCatalogue.ts` disagree,
because a catalogue entry with no file is a runtime 404 and a file with no entry is invisible.

## Dependencies

`d3-geo` (ISC) for projections, great-circle interpolation and spherical maths, `topojson-client`
(ISC), `apex-commons` for licensing. `d3-geo` is wrapped rather than reimplemented: spherical
clipping, antimeridian cutting and adaptive resampling are correctness traps that took it years to get
right, and the winding convention alone cost this project three attempts.

Type-checking runs as `npm run typecheck` (`tsc --noEmit`); bundling strips types via Babel, so there
is one source of truth for diagnostics and a fast build.
