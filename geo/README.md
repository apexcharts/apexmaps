# Geometry packs

These files are the built output of `npm run data:build` (`scripts/build-geo.mjs`)
and are committed so a clone can run the examples and tests without network
access. They are distributed separately from the library as the `apexmaps-geo`
dataset; see `src/core/GeoCatalogue.ts` for the authoritative pack list, and
`ApexMaps.mapMeta(id)` for per-pack provenance at runtime.

## Sources and licences

| Files | Source | Licence | Attribution |
|---|---|---|---|
| `world-*`, `*-admin1-*` | [Natural Earth](https://www.naturalearthdata.com/) 5.1.1 | Public domain | None required |
| `us-states-*`, `us-counties-*` | US Census Bureau TIGER/Line, via [us-atlas](https://github.com/topojson/us-atlas) 3.0 | Public domain | None required |
| `eu-nuts*` | [Eurostat GISCO](https://ec.europa.eu/eurostat/web/gisco) NUTS 2021, 1:20 million | CC BY 4.0, and the [EuroGeographics](https://eurogeographics.org/) terms for the administrative boundaries apply | © EuroGeographics for the administrative boundaries |

The library renders the required attribution automatically whenever a NUTS pack
is on screen (`attributionFor` in `src/core/MapRegistry.ts`); this file is the
redistribution notice for the copies committed here.

Redistribution of the Eurostat files must keep the EuroGeographics attribution.
Do not add packs from sources whose licence forbids commercial redistribution
(GADM is the recorded example).
