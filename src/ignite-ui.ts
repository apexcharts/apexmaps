/**
 * `apexmaps/ignite-ui`: the Ignite UI add-on.
 *
 * Import it once (or load `apexmaps.ignite-ui.min.js` with a script tag, before
 * or after `apexmaps.min.js`) and maps follow the Ignite UI theme on the page:
 * the series colours, text, borders, focus ring, tooltip surface, font, the
 * basemap and no-data greys, outlines, and light or dark. Without it the
 * `--ig-*` tokens are ignored, with no error; the `--apx-*` and `--apexmaps-*`
 * tokens work either way. `theme: { designSystem: false }` turns it off for one
 * map. It is free: no licence key involved.
 *
 * It registers the Ignite UI adapter the Apex products share (from
 * `apex-commons/ignite-ui`), so ApexTree, ApexSankey and ApexGantt on the page
 * follow it too; ApexCharts takes its own add-on. It also lists the two greys
 * only the maps paint. Import it before the first render: a map rendered
 * earlier picks it up on its next `updateOptions()` (`updateOptions({})`
 * applies it at once).
 *
 * The module body writes two `globalThis` slots and nothing else: no DOM, no
 * timers, so it is safe to import under SSR.
 *
 * @module ignite-ui
 */
import 'apex-commons/ignite-ui'

/** `MAP_DESIGN_SYSTEM_SLOT` in `core/Theme`, repeated so this entry carries no core code. */
const SLOT = '__apexmaps_design_systems_v1__'

const host = globalThis as Record<string, unknown>
if (!host[SLOT] || typeof host[SLOT] !== 'object') host[SLOT] = {}
const slot = host[SLOT] as Record<string, unknown>
// The basemap and no-data greys (plan 36, OPEN-14). The first copy stays, so a
// second import is a no-op.
slot.igniteui ??= Object.freeze({
  basemap: Object.freeze(['--ig-gray-100']),
  noData: Object.freeze(['--ig-gray-200']),
})

export {}
