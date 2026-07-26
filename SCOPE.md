# ApexMaps Scope Tracker

Companion to the internal `PRODUCT-RESEARCH.md` (in `plans/`, not committed). This file exists to stop scope creep, which is the number-one risk to the product (maps + GIS + tiles + 3D + story is easily a five-year build).

**Last updated:** 2026-07-26 (P1 status audited against the code, section 0)

---

## The one-sentence test

> **Does this help someone make a point with geography, or does it help someone do GIS?**

Build the former. Integrate the latter. Every feature request gets this test before it gets an estimate.

**Second test, for pricing:** *Free = one beautiful map. Paid = the narrative, the linkage, and the scale.*

---

## 0. Where P1 stands

Audited against the code on 2026-07-26, not from memory. Section numbering below is unchanged, so
existing references still resolve.

**Shipped and tested** (241 tests, 51 kB gzipped of a 150 kB budget):

| Area | State |
|---|---|
| Engine | Three-space transform chain, projection layer over `d3-geo`, camera with van Wijk paths, SVG renderer with world/screen layer split |
| Data | GeoJSON, TopoJSON, bare geometry; winding repair by spherical area; `joinBy` with diagnostics, alias table, FIPS repair, opt-in fuzzy; keys map to feature lists |
| Projections | 13 named, composite `albersUsa`, spec objects with rotate/parallels/clipAngle, `registerProjection` |
| Series | choropleth, bubble (sqrt area, nested-circle legend), marker (7 shapes, categorical colour, distance-based clustering), arc (geodesic, antimeridian-cut), automatic basemap |
| Presentation | quantile/Jenks/equal-interval/threshold/linear/log/sqrt/ordinal, 17 OkLab-sampled palettes, classed + gradient + size legends, tooltips, collision-avoiding labels, dark mode, responsive |
| Interaction | wheel/pinch/double-click zoom, inertial pan, hover, selection, legend muting, roving-tabindex keyboard navigation |
| Camera | `flyTo`, `easeTo`, `jumpTo`, `fitBounds`, `frameFeature`, `resetView`, interruptible and retargeting |
| Geo registry v1 | 26 packs: world countries and land, US states and counties, EU NUTS 0-3, admin-1 for 15 countries, each with recommended key, projection, view and provenance |
| Accessibility | ARIA roles, generated description, keyboard navigation, live region, data table, `prefers-reduced-motion` |
| Platform | TypeScript with a discriminated `Series` union, ESM/UMD/IIFE, declarations, SSR-safe import, zero mandatory network calls |
| Performance | 2.8 ms p95 frame at 3,231 features against a 16 ms budget, guarded by invariant tests |

**Declared in the public options tree but not implemented.** These are worse than absent: a caller can
set them and get silence. Either build them or stop advertising them, and warn in dev meanwhile.

| Option | Current reality |
|---|---|
| `chart.renderer: 'auto'` | Config default only. No Canvas tier and no `RendererController` wiring, so it is always SVG |
| `drilldown` | Type plus a `undefined` default. Nothing reads it |
| `link: { group }` | Only registers the instance in the global list. No selection propagation |
| `annotations` | Type plus an empty-array default. Nothing renders |

**Not started, still in P1 scope:**

| Item | Notes |
|---|---|
| line / route series | Partly covered by arc; a non-geodesic polyline series is still missing |
| rectangle selection | Prerequisite for cross-filtering interaction |
| Voronoi invisible hit layer | Makes small marks clickable |
| PNG / SVG export | Procurement table stakes |
| framework wrappers | react, vue, ngx, svelte, Blazor |
| Canvas renderer tier + R-tree hit index | Not urgent at the measured frame cost, but `renderer: 'auto'` claims it |
| tweened value transitions on `updateSeries` | Data changes redraw rather than interpolate |
| `crs` declaration, `proj4` escape hatch, worker projection | Escape hatches for non-WGS84 and heavy ingest |

## 1. Hard "will not build" list

Changing anything here requires an explicit, recorded decision in section 4, not a pull request.

| # | Will not build | Instead |
|---|---|---|
| N1 | Tile server or hosted basemap service | Consume raster XYZ, MapLibre vector, PMTiles |
| N2 | Geocoding | Adapters for Nominatim, Photon, Mapbox, Google, Esri |
| N3 | Routing, isochrone, or drive-time computation | Accept polygons/paths from Valhalla, OSRM, Mapbox, Esri; animate them well |
| N4 | Spatial analysis engine (buffer, overlay, dissolve, kriging) | Document PostGIS / DuckDB Spatial / Turf.js recipes |
| N5 | Topology editing or digitizing tools | User-drawn annotation shapes only, never authoritative geometry |
| N6 | Full 3D city / terrain engine | Terrain-lite in P4 at most; delegate real 3D to Cesium/Mapbox/Google |
| N7 | A projection library from scratch | Wrap `d3-geo` and `proj4js`; contribute upstream |
| N8 | Million-point GPU engine in P1 | deck.gl adapter; native WebGL tier in P3 |
| N9 | Runtime Shapefile / NetCDF / DWG parsing | CLI converters in the geo toolchain |
| N10 | No-code SaaS competitor to Flourish | Visual story editor that emits specs, as a developer tool |
| N11 | Bundling GADM or proprietary postcode geometry | Permissively licensed sources only; document bring-your-own |
| N12 | An expression DSL (Mapbox-style) | Scale objects plus optional functions |
| N13 | Usage metering of map loads or geometry downloads for paying customers | Flat per-seat licensing |
| N14 | Gating the accessibility module behind a paid tier | a11y is free in every tier, permanently |

---

## 2. Budgets (enforced in CI, not by intention)

| Budget | Limit | Owner |
|---|---|---|
| Core bundle, gzipped, excluding geometry | **150 kB** (currently 48 kB) | build |
| Heavy dependencies in the default bundle | **zero** (MapLibre and deck.gl stay optional peers) | build |
| Mandatory network calls in the default build | **zero** | core |
| p95 pan/zoom frame time at 3,000 features | **under 16 ms** on a mid-range laptop (measured 3.1 ms at 3,231) | `examples/bench.html` + `test/perf.test.ts` |
| Named projections shipped in core | **~12** (rest via `proj4` escape hatch) | core |
| Public API concepts a developer must learn before first map | **5** (`chart`, `geo`, `series`, `joinBy`, `scale`) | API review |

Any PR that moves a budget requires a recorded decision.

---

## 3. Phase gates

A phase does not start until the previous phase's gate is met. Full feature lists are in PRODUCT-RESEARCH.md section 11.

| Gate | Condition |
|---|---|
| **P1 exit** | Unfamiliar developer goes from `npm install` to a styled choropleth in under 10 minutes. Default output judged publishable without configuration in a blind comparison against Datawrapper and Highcharts defaults. Perf budget met **(done: 3.1 ms p95 at 3,231 features)**. a11y module shipped. Geo registry v1 covers world + US + EU + top 15 countries at admin-1 **(done: 26 packs)** |
| **P2 entry** | Shared ecosystem contracts (`ApexBus`, `ApexSelection`, `ApexTime`, `ApexTheme`, `ApexAnnotations`, `ApexStory`, `ApexExport`) exist as versioned packages with a conformance test, even if only ApexMaps implements them |
| **P2 exit** | At least 20 stories published by third parties. Story spec schema frozen and validated. Static per-scene export works. Bake-off win rate against Highcharts Maps tracked with recorded loss reasons |
| **P3 entry** | Spec schema stable enough for LLM authoring (needed by ideas 32-35) and renderer abstraction proven at the Canvas tier (needed by the WebGL tier) |
| **P4 entry** | Cross-product adoption measurably rising (share of new ApexMaps customers adopting a second Apex product) |

---

## 4. Decision log

Append only. Each entry: date, decision, rationale, and what would reverse it.

| Date | Decision | Rationale | Reversal condition |
|---|---|---|---|
| 2026-07-26 | **Feature-gated free tier, no watermark on basic maps.** Watermark reserved for the premium-feature trial state | The price floor for a basic map is zero; the audience that generates our marketing (journalists, education, OSS) cannot publish third-party branding | Evidence that free-tier users never convert, or that the family mandates a uniform watermark policy |
| 2026-07-26 | **Accessibility is never gated.** Free in every tier, permanently | Ethical baseline plus procurement: gating a11y blocks the public-sector buyer we most want to upgrade | None anticipated |
| 2026-07-26 | **Join diagnostics ships in P1**; the cartographic advisor is separated and deferred to P3 | Join failures are the largest support-ticket category in map libraries and the fix is a set difference plus string distance (2-3 days). The advisor needs real statistical heuristics | If P1 slips and this is the last item, it can move to the first patch release, not later |
| 2026-07-26 | **Reuse `RendererController`** from apexcharts-js rather than building a parallel renderer-selection system | It already implements registry, mark-count auto-selection, SVG fallback, and anticipates `gpu`. Divergence would break `renderer: 'auto'` parity between charts and maps | A map-specific requirement that the controller genuinely cannot express |
| 2026-07-26 | **Morphing is a candidate for promotion from P3 to P2**, pending a spike | Core already ships `MorphTypeChange.js`, `svg/PathMorphing`, `morphPaths`, `PathReconcile` with an opt-in feature-module contract; map-to-chart morphing may be an extension rather than a build | Spike shows choropleth path sets cannot be handed to the existing engine without renderer surgery |
| 2026-07-26 | **TypeScript, not checked JavaScript.** Migrated all 20 source files and the test suite before adding the second and third series | The product's main asset is a large *discriminated* options spec (`Series` union now, story scenes later), which is exactly what JSDoc cannot express: it cannot say "if type is 'arc' then from and to are required". Verified by probe: 3 of 3 invalid configs are now compile errors. `apex-grid` and `apexgantt-webcomponent` are already TypeScript, so the family tolerates it | None anticipated; reverting would cost more than the migration did |
| 2026-07-26 | **Do not bundle GADM**, ever | Non-commercial license only; a real legal exposure that has caught other products | None |
| 2026-07-26 | **O4 resolved: both npm and CDN, and the geometry ships as a separate `apexmaps-geo` dataset** versioned independently of the library | 6.7 MB of geometry does not belong in a charting dependency, and a boundary correction must not require a library upgrade. `setGeoSource()` takes a base URL or a loader function, so self-hosting, air-gapped installs and bundler imports are all the same feature. The packs are committed to this repo so a clone can run the examples without network | Evidence that users overwhelmingly want geometry in the main package, which would argue for a slim default pack plus the CDN for the rest |
| 2026-07-26 | **Packs carry a recommended join key, projection and view**, and the library uses them as defaults | For several packs the generic default is not suboptimal but wrong: admin-1 geometry also carries `adm0_a3`, so detection would give all 47 Japanese prefectures the key `JPN`; NUTS geometry reaches Réunion, so fitting its extent leaves Europe a few pixels across; Alaska's Aleutians cross the antimeridian, so the US spans the world. These are cartography decisions that belong with the geometry, not with every caller. Explicit options always win | A pack recommendation that turns out to be contested editorially; the field is optional, so it can simply be dropped |
| 2026-07-26 | **Pack ids are declared in reviewed source (`src/core/GeoCatalogue.ts`), not generated from the pipeline manifest** | Ids are public API: once `map: 'us/counties@10m'` is in someone's dashboard it cannot be renamed. The build and the test suite both fail if the catalogue and the pipeline disagree | None |
| 2026-07-26 | **The perf budget is guarded by an invariant test, not a millisecond assertion** | A wall-clock budget in CI fails on a loaded runner, gets marked skip, and then nothing is enforced. The property that matters is that a camera frame applies one transform to one group and never touches feature geometry: deterministic, machine-independent, and exactly what a refactor would break. Reprojecting 3,000 features per frame would still pass a generous millisecond budget on a fast laptop | A renderer where the invariant genuinely does not hold, for example a Canvas tier that must redraw per frame; that tier needs its own guard |
| 2026-07-26 | **Clustering is an option on the marker series, not a separate series type** (a deliberate deviation from the roadmap, which listed `cluster` among the series) | The data is identical; clustering only changes how points that would overlap are drawn. A separate type forks position resolution, hit testing, colouring and the legend, and forces the caller to swap series at a zoom threshold | A clustering mode that genuinely cannot be expressed as a drawing decision, for example server-side aggregation returning pre-clustered rows |
| 2026-07-26 | **Per-series defaults live in `seriesDefaults`, never in the series classes alone** | Config always beats a `?? fallback` inside a class, so a shared default silently overrode each series' intended opacity and stroke: arcs rendered fully opaque with `?? 0.75` sitting in unreachable code. `test/config.test.ts` now pins every type's resolved values | None |
| 2026-07-26 | **A join key maps to a list of features, not one** | Published geometry shares keys on purpose (Natural Earth gives Australia's external territories the same `iso_a3`; Lord Howe Island carries `AU-NSW`). Last-one-wins left mainland Australia in no-data grey while colouring an uninhabited island, silently, which is the exact failure the join diagnostic exists to prevent | None |

---

## 5. Open decisions (blocking, with owners to be assigned)

Full context in PRODUCT-RESEARCH.md Appendix C.

| # | Question | Blocks | Recommendation on file |
|---|---|---|---|
| O1 | Does the ecosystem commit to shared contracts across six products? | The largest moat; P2 entry gate | Yes. Cost is roughly four additive changes per product, one landing once in `BaseChart`. The risk is drift, not effort |
| O2 | Revenue-threshold community license on top of feature gating? | Pricing page, license manager config | Match whatever apexcharts and apex-grid already do; do not invent a third model |
| O3 | Is the story engine sold to developers or to the newsroom/comms buyer? | Editor priority, possibly the business model | Developers first; the editor is a P2-alpha developer tool, not a publishing platform |
| O5 | How deeply does MapLibre integrate? | Bundle budget, vector basemap fidelity | Optional peer dependency only |
| O6 | Do non-geographic maps (floor plans, wafers, stadiums) belong in ApexMaps or a sibling product? | P3 scope, addressable market | In ApexMaps; they share nearly all machinery and broaden the market considerably |
| O7 | Which three flagship demos ship first? | Marketing, and which features get finished | Election night (cartogram morph), airline route launch (arc drawing + camera flight), logistics disruption replay (time playback + linked grid). Three distinct buyers, full feature surface |

---

## 6. Creep watchlist

Requests that will arrive, sound reasonable, and must be answered with a pointer to section 1 rather than a discussion.

| Request that will arrive | Answer |
|---|---|
| "Can it geocode addresses?" | N2. Adapter, not a feature |
| "Can it compute drive-time areas?" | N3. We display isochrones you supply |
| "Can we edit boundaries in the browser?" | N5. Annotation shapes only |
| "Can it do 3D buildings like Google?" | N6. Terrain-lite at most, P4 |
| "Can we add ZIP code polygons for the US?" | ZCTA (public domain) yes, real USPS ZIP geometry no. N11 |
| "Can it read our Shapefiles directly?" | N9. CLI converter |
| "Can we host tiles for customers?" | N1. Document PMTiles self-hosting |
| "Can it handle 10 million points natively?" | N8 in P1. deck.gl adapter, then the P3 WebGL tier |
| "Can we make story mode free to drive adoption?" | No. It is the primary paid differentiator; see the pricing line in section 0 |
| "Can we add a Mapbox-style expression syntax?" | N12. Functions and scale objects |
| "Can you add admin-2 for every country?" | Not in v1. The pipeline takes a country list, so adding a country is a one-line change, but each pack is a licence review and a size budget, not a config entry |
| "Can the registry auto-download whatever id I type?" | No. Unknown ids fail with suggestions. A registry that silently fetches arbitrary URLs is a supply-chain hole |
