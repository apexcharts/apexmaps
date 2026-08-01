# Feature notes

The longer notes that used to live in the README: what each feature does, and why it behaves
the way it does rather than the obvious way. The [README](../README.md) is the short version,
[`examples/`](../examples) is one runnable demo per feature, and every option carries the same
reasoning in its JSDoc, so it shows on hover in an editor.

---

## Performance

Measured in headless Chromium with the frame rate unclamped, so the intervals reflect work rather
than the display's refresh rate. `npm run examples` then open [bench.html](../examples/bench.html) to
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

CI enforces the *invariant* rather than the milliseconds ([test/perf.test.ts](../test/perf.test.ts)): a
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

## Pattern and image fills

> **Licensed:** `fill.pattern` and `fill.image`. Licensed features work without a key so you can
> evaluate them, with a watermark on the map. See [Licensing](../README.md#licensing).

A flat fill is one colour per feature. `fill` adds a second channel over the top of it, and there are
three situations where it is not decoration:

- **Print and photocopy.** A five-step ramp collapses to about three once it has been through a
  photocopier or a mono laser printer. A tile per class survives both.
- **Colour-vision deficiency.** Two classes of a diverging ramp can read as one. A different tile
  keeps them apart without abandoning the ramp.
- **Kinds rather than amounts.** When the classes are categories, a sequential ramp implies an order
  that is not in the data. Texture carries the distinction and the colour stops doing work it should
  not be doing.

```js
series: [{ data, fill: { pattern: { type: 'dots' } } }]
```

The tile background is the colour the scale already chose, so the pattern is *added* to the encoding
rather than replacing it, and the ink defaults to whatever stays legible against that colour: white
on a mid-tone or dark class, a darkened tint on a pale one. A whole ramp therefore reads without
being configured class by class.

Eight tiles: `dots`, `squares`, `checks`, `lines`, `grid`, `diagonal`, `crosshatch`, and `custom`
with your own `path`. Each takes `size`, `color`, `background`, `strokeWidth`, `angle` and
`opacity`.

**`size` is the spacing between marks, not the size of one**, and the marks are deliberately small
against it: 10px spacing by default, with a dot covering about a twelfth of its tile and a bar a
fifth of its width. That ratio is the whole design. Tighten it and the ink starts averaging with the
fill into a shade that is on no scale, neighbouring classes stop being separable, and the map reads
as clogged rather than as drawn. The colour is still doing the work; the tile is a mark on it.

For the qualitative case, the pattern is a function of the feature:

```js
const TILES = ['dots', 'diagonal', 'grid', 'crosshatch', 'lines']

fill: {
  pattern: ({ classIndex, color, value, datum, key }) => ({ type: TILES[classIndex], size: 7 }),
}
```

**Legend swatches show the tile**, not a flat colour, off the same builder the map uses: a patterned
map with plain swatches tells the reader the texture means nothing.

**The tile holds its size on screen** as the reader zooms, on the same reasoning as the borders'
`non-scaling-stroke`: texture that grows with the camera stops reading as a fill and starts reading
as geometry.

**No-data areas are never textured**, and nor is a class muted from the legend. An absence has to
keep reading as an absence rather than as one more category.

### A picture per region

The same mechanism carries imagery. Each feature's own outline clips an image fitted to its bounding
box, which is how a map of flags, satellite crops or portraits is built:

```js
series: [{
  data,
  fill: {
    image: {
      src: ({ key }) => `/flags/${key.toLowerCase()}.svg`,
      fit: 'cover',   // 'contain' fits the whole image inside the box; 'fill' stretches
    },
  },
}]
```

`src` runs per feature and may return `null` to decline, which leaves that feature on its flat
colour. `background` (the feature's colour by default) shows through a `contain` fit and while the
file is still loading, so a slow image degrades to the choropleth rather than to a hole. Unlike a
texture tile, an image scales *with* the region: it is pinned to the ground it describes.

Under the hood both are one `<pattern>` in `<defs>` per distinct appearance, referenced by `fill`.
Five classes across three thousand features is five defs. Image fills are inherently per-feature,
because the tile is positioned on that feature's box, so this is the wrong tool for three thousand
counties.

Two things to know before you ship image fills:

- **PNG export and CORS.** Exporting to PNG rasterises through a canvas, and a browser refuses to
  read back a canvas that an image from another origin has touched. Same-origin files, or a host
  sending `Access-Control-Allow-Origin`, export cleanly. SVG export is unaffected either way.
- **`fit: 'fill'` with an SVG source may not stretch.** A referenced SVG brings its own aspect
  handling, and per spec it wins over the element referencing it. `'cover'` is handled: the crop is
  computed from the source's measured aspect ratio rather than asked for with an attribute, precisely
  so an SVG flag is not quietly letterboxed inside the region with the fill colour around it.
  `'contain'` needs nothing. Only `'fill'` still depends on the file, which needs
  `preserveAspectRatio="none"` of its own to distort. Raster sources are unaffected throughout.

`examples/patterns.html` and `examples/image-fill.html` are the two demos.

## Bubbles and arcs

> **Licensed:** the `arc` and `line` route series. Bubbles are free. Licensed features work without a key so
> you can evaluate them, with a watermark on the map. See [Licensing](../README.md#licensing).

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
  { type: 'arc', name: 'Routes', data: routes, endpoints: { show: true }, flow: true },
]
```

`flow` sends beads along each route, from `from` towards `to`. It exists because an arc says two
places are related without saying which way anything moves, and on a hub map every route leaves the
same airport, so the reader cannot infer it either. `flow: true` is the whole option: the bead takes
the route's colour, its size from the route's width, and its phase from a hash of the route's key, so
many departures out of one hub read as traffic rather than as a single pulse. `{ style: 'dash' }`
marches a dashed highlight instead. `speed` and `spacing` are screen pixels in the view the map opened
at: the beads are anchored to the ground, so zooming in spreads them with the geography rather than
fitting more of them onto the same route. Each of the three is bounded, because each degenerates
differently at the far end of the camera: size at three times what it opened at, pace at twice, spacing
at six, past which the flow looks the same however far the reader keeps going. `{ scale: 'screen' }`
holds all three fixed for a dashboard where the beads are furniture rather than geography. Under
`prefers-reduced-motion`, with
`chart.animations.enabled: false`, or past 600 routes on one series, the beads stay where they are and
stop travelling: a dotted route still reads as a route.

Rendering follows from what each mark encodes: arcs live in world space and scale with the camera,
while bubbles live in screen space and hold their radius, because that radius carries a value. Thin
arcs get an invisible wider hit path so a 1px flight line is still hoverable, and a flow's beads are
one more companion path, in a group of their own above the routes so that the only content that
repaints every frame is separated from the geometry that never moves.

## Markers and clustering

> **Licensed:** clustering. Markers themselves are free. Licensed features work without a key so you can
> evaluate them, with a watermark on the map. See [Licensing](../README.md#licensing).

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

## Drilldown

> **Licensed:** drilldown, and the breadcrumb with it. Licensed features work without a key so you can
> evaluate them, with a watermark on the map. See [Licensing](../README.md#licensing).

Click a state, get its counties. One option:

```js
series: [
  {
    name: 'Adoption',
    joinBy: { data: 'key' },
    data: rows,
    drilldown: { map: 'us/counties' },
  },
]
```

The child level is **restricted to the feature that was clicked**, which is the part that makes it a
drilldown rather than a zoom: showing all 3,231 US counties after clicking California leaves the
reader to find California again. Which counties belong to California is not configuration, because
published hierarchical geometry already says so, in one of two ways:

- **A property naming the parent.** TIGER counties carry `state_abbr` and `state_fips`, Eurostat NUTS
  carries `cntr_code`, Natural Earth admin-1 carries `adm0_a3`. The field is detected by matching
  against the parent's key, scoring candidates by how many children they match so a coincidence in
  one row cannot pick the hierarchy.
- **A key prefix.** County FIPS `06037` sits under state FIPS `06`, NUTS `DE12` under `DE1`. This is
  the fallback, and it is what carries NUTS below level 1 where `cntr_code` stops distinguishing
  levels.

Set `parentField` to name the property yourself, or `scope: 'all'` to draw the whole child map. When
neither route matches anything, **the drilldown is declined rather than performed**, with the reason
in the dev-mode diagnostics: landing on an empty map costs the reader the level they were reading and
gives nothing back.

Going deeper is a function of the clicked feature, so levels can differ, and returning `null`
declines:

```js
drilldown: {
  map: (context) => (context.depth === 1 ? 'eu/nuts2' : 'eu/nuts3'),
  animate: 'zoom',              // zoom, hand over, dissolve, divide. 'none' cuts
  breadcrumb: { rootLabel: 'Europe' },
}
```

Data for the deeper level can arrive two ways. Rows for every level can live in one array, since the
join takes whatever matches the level on screen, and the diagnostic says so instead of reporting the
other level's rows as a broken join. Or fetch per level from the event, which fires once the child is
already on screen:

```js
map.on('drilldown', ({ key, name, depth, featureCount }) => {
  fetchCounties(key).then((rows) => map.updateSeries([{ ...series, data: rows }]))
})
map.on('drillup', ({ depth }) => {})
```

Getting back out is deliberately over-provided, because a drilldown with no visible exit is a trap:
the breadcrumb above the map (real buttons, keyboard reachable), Escape, or `drillUp()` /
`drillUp(Infinity)`. None of them refetch: each level's geometry is still held, so climbing back is
synchronous. `drillTo(key)` drills programmatically, and `drillDepth` says where you are. The way in
works from the keyboard too: Enter on a focused feature drills exactly where a click would.

Two details worth knowing. The level change is continuous rather than a cut, in four steps: the camera
frames the clicked feature; the child level is handed **the exact box on screen that feature
occupied** instead of its own fit; the level being left dissolves out over it; and the child develops
out of the parent's own colour, each county's fill and boundary arriving together in a ripple from the
middle outwards. Because the child covers the same geography, nothing about the map moves across the
swap, and because it starts as a flat copy of the parent, it is never simply *there*: what the reader
sees is California dividing into its counties while its neighbours fade. Climbing back runs the camera
half in reverse, from wherever inside the child level the reader had moved to. Everything above is one
`transition` per mark on `--apexmaps-anim`, so it follows `chart.animations.speed`, degrades with the
motion budget, and turns into a plain swap under `prefers-reduced-motion`. And the selection does not
survive a level change, because those keys belong to the level you left.

## Selection, and linked maps

> **Licensed:** linking maps with `link: { group }`. Selection itself is free. Licensed features work without
> a key so you can evaluate them, with a watermark on the map. See [Licensing](../README.md#licensing).

Click a feature to select it. Shift-drag a box to select everything inside it, Alt to add to what is
already selected, Escape to abandon the box, and a box over nothing clears the selection, which is
the only obvious way for a reader to undo one.

```js
interaction: {
  selection: {
    enabled: true,
    multiple: true,
    rectangle: true,       // default. A plain drag still pans
    modifier: 'shift',     // 'alt' | 'meta' | 'ctrl' | 'none' ('none' needs pan off)
  },
},
states: { muted: { opacity: 0.25 } },   // 1 turns dimming off
```

A box tests each candidate's **anchor**, not its bounding box. Bounding-box intersection reads
plausibly and behaves badly: Alaska's bbox spans the Pacific, so any box touching the Aleutians would
select it, and a box over the Great Lakes would select half a dozen states it does not visibly cover.
Points are tested at their own position, and the automatic basemap is left out, since a country drawn
only so the bubbles have a coastline carries no data and could not filter anything.

While anything is selected, everything else dims to `states.muted.opacity`. That is what makes a
selection legible on a dense map: an outline on 3 of 3,000 counties is nearly invisible, while 2,997
dimmed ones read instantly.

**Linked maps** share a selection:

```js
// on every map that should brush together
link: { group: 'sales-dashboard', filter: 'bidirectional' }   // or 'emit' / 'receive'
```

Brushing one map applies the selection to the others in the group and dims them the same way. Keys
have to mean the same thing across the group, which they do whenever the maps are of the same
geography; when a received selection matches nothing, dev mode says so rather than leaving one map
mysteriously blank. A map that receives a selection never rebroadcasts it, so a bidirectional pair
cannot ring. `link.group` is a licensed feature, and evaluating it watermarks the map.

One detail that is invisible when right and obvious when wrong: **the click that ends a drag is not a
click on whatever it landed on**. The browser fires `click` after any drag that starts and ends on the
same element, so without suppressing it, panning the map would select the country under the release,
and dragging a box across a feature with a drilldown would drill into it.

## Spinning the globe

On `orthographic` a drag turns the sphere. It has to: panning a globe slides a picture of the earth
around inside its box and leaves the far hemisphere permanently unreachable, which reads as a broken
map rather than a choice. Wheel zoom, pinch and double-click still belong to the camera, so the two
gestures compose: zoom into the Mediterranean, then spin to the Pacific.

```js
interaction: {
  rotate: {
    enabled: 'auto',   // default: globes spin, flat maps pan. true forces it on any
                       // projection that can rotate and invert; false gives the drag back
    inertia: true,     // defaults to pan.inertia
  },
},
```

```js
map.rotateTo([-25, -18])   // absolute [lambda, phi, gamma], as a drag would leave it
map.rotation               // where it is now
map.on('rotate', ({ rotate }) => {})     // while turning
map.on('rotateEnd', ({ rotate }) => {})  // once the glide settles
await map.resetView()      // the camera *and* the rotation the map opened at
```

The rotation is **versor-based** (Bostock and Davies): the point under the cursor stays under the
cursor for the whole drag, at any latitude, however far the globe has already turned. Accumulating
Euler angles instead is a dozen lines shorter and immediately recognisable as the cheap version,
because near the poles a horizontal drag whips the sphere around. Dragging past the edge of the disc
keeps turning rather than freezing, and longitude wraps, so the spin runs through 360 degrees and out
the other side.

Rotation is a projection change, not a camera transform, so unlike a pan it reprojects every
coordinate on the map. The work is coalesced to one pass per animation frame, and it is the reason
this is opt-out on flat maps: on a Mercator a drag should move the map, and it still does.

### Flying to a place on a globe

The camera moves know this too. On an **azimuthal** projection (`orthographic`, `stereographic`,
`gnomonic`, both `azimuthal*`) a `center` target is a rotation rather than a pan, because the camera
is a screen-space transform and no amount of translating it reaches the far side of a sphere:

```js
// Facing Brazil. India is behind the planet, and this turns the globe to it.
await map.camera.flyTo({ center: [79, 22] })
await map.camera.easeTo({ center: [79, 22], duration: 600 })
map.camera.jumpTo({ center: [79, 22] })
await map.frameFeature('Australia')   // turns first, then frames what it finds
```

The turn interpolates as a **quaternion slerp**, so it takes the short way round (a move across the
antimeridian goes 20 degrees, not 340), holds a steady angular pace, and does not swing out sideways
crossing a pole the way interpolating `[lambda, phi]` component-wise does. `flyTo` derives its
duration from the angle covered, the rotation analogue of the Van Wijk path length, and when a move
both turns and zooms the longer of the two sets the pace so they land together. `easeTo` keeps its
fixed duration, rotation included, because a caller who asked for 400 ms asked for 400 ms.

Everything laid out flat is untouched: on Equal Earth, Mercator, the conics and Albers USA a
`center` is the same pan it has always been, to the pixel. `viewport.supportsRecentre()` is the
switch, and the conics are deliberately on the flat side of it: they are defined by their standard
parallels rather than by a centre, so turning one would re-skew the whole map under the reader.

