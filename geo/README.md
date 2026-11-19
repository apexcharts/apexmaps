# apexmaps-geo

Boundary geometry for [ApexMaps](https://github.com/apexcharts/apexmaps): 26 TopoJSON
packs covering world countries and coastline, US states and all 3,231 counties, EU NUTS
levels 0 to 3, and admin-1 divisions for 15 more countries. Every pack carries its own
provenance: source, licence, attribution, vintage and boundary policy.

**You usually do not need to install this.** ApexMaps fetches packs from jsDelivr on
demand, so `geo: { map: 'world/countries@110m' }` works with nothing installed. Install
this package when you want the files locally: offline development, an air-gapped
deployment, a bundler that should resolve geometry at build time, or self-hosting.

```sh
npm install apexmaps-geo
```

## Using it with ApexMaps

Point the library at the installed copy, and nothing hits the network:

```js
import ApexMaps from 'apexmaps'

// Bundlers (Vite, webpack, Rollup, esbuild) resolve JSON imports natively.
ApexMaps.setGeoSource((file) => import(`apexmaps-geo/${file}`).then((m) => m.default))
```

In plain Node ESM, JSON needs an import attribute:

```js
ApexMaps.setGeoSource((file) =>
  import(`apexmaps-geo/${file}`, { with: { type: 'json' } }).then((m) => m.default),
)
```

Self-hosting instead? Copy the files anywhere your server can reach and give
`setGeoSource` a base URL:

```js
ApexMaps.setGeoSource('/static/geo/')
```

## Using it without ApexMaps

The files are ordinary TopoJSON, so nothing here is ApexMaps-specific:

```js
import { feature } from 'topojson-client'
import topology from 'apexmaps-geo/world-countries-110m.json'

const countries = feature(topology, topology.objects.countries)
```

`manifest.json` lists every pack with the TopoJSON object name to convert, the feature
count, the recommended join key, and full provenance:

```json
{
  "id": "au/admin1@10m",
  "file": "au-admin1-10m.json",
  "object": "admin1",
  "features": 12,
  "keyField": "iso_3166_2",
  "levelName": "States",
  "source": "Natural Earth 5.1.1",
  "license": "public domain",
  "vintage": "2022"
}
```

## Versioning

This dataset is versioned **independently of the ApexMaps library**, which is the reason
it is a separate package. Boundaries change on their own schedule: NUTS is revised every
three years, US counties re-district on the census, and countries rename themselves. A
boundary correction should not require a library upgrade, and a library patch should not
republish 6.8 MB of unchanged JSON.

The major version is a compatibility contract with the library, which requests
`apexmaps-geo@<major>` by default:

- **Patch** releases fix a file without changing its identifier, feature count or keys.
- **Minor** releases add packs.
- **Major** releases rename or remove a pack id, change a recommended join key, or change
  the file layout. Pack ids are public API, so this is rare and deliberate.

## Licences

This package is a compilation of separately licensed datasets, so terms apply per file.
Full detail is in [LICENSE](LICENSE); the short version:

| Files | Source | Licence | Attribution |
|---|---|---|---|
| `world-*`, `*-admin1-*` | Natural Earth 5.1.1 | Public domain | None required |
| `us-states-*`, `us-counties-*` | US Census TIGER/Line, via us-atlas 3.0 | Public domain | None required |
| `eu-nuts*` | Eurostat GISCO NUTS 2021 | CC BY 4.0, plus EuroGeographics terms | **© EuroGeographics for the administrative boundaries** |

The NUTS packs are the only ones carrying a mandatory attribution requirement. ApexMaps
renders that string automatically whenever a NUTS pack is on screen, so using the library
satisfies it for you. Using these files directly makes it your responsibility.

Boundary depiction follows each source's own editorial view and is not a political
statement by the ApexCharts project.

## Corrections

The packs follow their sources, with one exception: an island the source assigns to the
wrong subdivision is moved to the right one, when an authority for that subdivision says
where it belongs. Boundary views (disputed areas, de facto control) are never changed.
Each correction is applied by the build from `scripts/geo/corrections.mjs`, so a rebuild
keeps it, and is listed under `corrections` in that pack's `manifest.json` row.

**`jp/admin1@10m`, since 1.1.1.** Natural Earth 5.1.1 misassigns eight islands:

| Islands | Source has | Corrected to | Authority |
|---|---|---|---|
| Amami Oshima, Kakeromajima, Kikaijima, Tokunoshima, Okinoerabujima, Yoronjima (the Amami Islands) | Okinawa (`JP-47`) | Kagoshima (`JP-46`) | [Kagoshima Prefecture, Oshima branch office](https://www.pref.kagoshima.jp/aq01/chiiki/oshima/): Amami City and Oshima District |
| Nagashima, Shishijima | Kumamoto (`JP-43`) | Kagoshima (`JP-46`) | [Nagashima Town](https://www.town.nagashima.lg.jp/), Izumi District, Kagoshima Prefecture |

Before 1.1.1 the Amami Islands took Okinawa's colour and Nagashima and Shishijima took
Kumamoto's. Feature count, keys, properties and quantization are unchanged; the geometry is
the source's own, reassigned. What moves with it:

- Colour, hit-testing and `frameFeature` for the eight islands. Framing `JP-47` now ends at
  Iotorishima, 27.87 N, instead of 28.51 N; `JP-46` now reaches Yoronjima, 27.02 N.
- Anything placed at a region's centroid. With Amami gone, the Sakishima Islands pull
  `JP-47`'s centroid from near Okinawa Island to open sea about 130 km south-west of it, and
  `JP-46`'s moves south, offshore of the Satsuma Peninsula. Bubbles and markers joined to
  those prefectures by key sit at that centroid. Region labels in ApexMaps releases after
  1.3.0 anchor on a region's largest polygon, so they stay on Okinawa Island and mainland
  Kagoshima; ApexMaps 1.3.0 and earlier anchor labels on the centroid too, so with this
  pack their Okinawa label sits in the sea.

Every other island in the pack was checked too. Each of the 112 polygons not joined to a
neighbouring prefecture was compared with the prefecture of the nearest larger polygon
and of the nearest large one (at least 0.05 square degrees). That test cannot see a group
misassigned as a whole: Amami Oshima is the nearest larger polygon to the rest of Amami, so
before the correction the Amami Islands passed it. So each island was then also identified
and checked against the municipality it belongs to. The test flags, before or after the
correction, islands that are right as drawn, among them: Okinawa Island and Iotorishima
(Okinawa), whose nearest large neighbour is in Kagoshima; Amakusa Shimoshima (Kumamoto),
nearest to the Nagasaki mainland; the Izu and Ogasawara islands (Tokyo); Iki and Tsushima
(Nagasaki); Awaji (Hyogo); Omishima and Nakajima (Ehime); Teshima and the island of
Hiroshima off Marugame (Kagawa); and the Tokara Islands (Kagoshima). Checking by identity
also cleared the Daito Islands (Okinawa) and the rest of the outlying islands. Ukejima and
Yorojima, also Amami, are below the 1:10m resolution and are not in the pack.

## Regenerating

These files are built from source by `npm run data:build` in the
[ApexMaps repository](https://github.com/apexcharts/apexmaps), which downloads the
upstream data, simplifies and quantizes it, repairs identifiers, and writes
`manifest.json`. The build fails if the packs it produces disagree with the pack ids
declared in the library, because a catalogue entry with no file is a runtime 404 and a
file with no entry is invisible. `npm run data:build -- --only=jp` rebuilds one country
and leaves every other file and manifest row as it was.
