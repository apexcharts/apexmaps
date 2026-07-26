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

## Regenerating

These files are built from source by `npm run data:build` in the
[ApexMaps repository](https://github.com/apexcharts/apexmaps), which downloads the
upstream data, simplifies and quantizes it, repairs identifiers, and writes
`manifest.json`. The build fails if the packs it produces disagree with the pack ids
declared in the library, because a catalogue entry with no file is a runtime 404 and a
file with no entry is invisible.
