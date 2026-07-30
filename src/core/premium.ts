/**
 * Which features require a licence.
 *
 * A module of its own rather than a constant in `ApexMaps.ts`, for two reasons.
 * The browser bundle declares `output.exports: 'default'` so that
 * `window.ApexMaps` is the class itself, which means the entry module may export
 * nothing else, and the guard test needs to read this list at runtime to check it
 * against the live gates. Keeping the policy separate from the class satisfies
 * both, and it puts the pricing decision somewhere a reader can find it.
 *
 * The line is that a map answering a question is free, and a map that becomes an
 * application is licensed. So a choropleth, bubbles or markers on any map, with
 * tooltips, a legend, labels, zoom and pan, scales, export and accessibility, is
 * the free tier and renders clean. Depth of interaction (drilling into a level,
 * linking views, playing time), authoring on top of the map (annotations, routes),
 * summarising points into clusters, and cartography beyond the built-in
 * projections are the licensed tier.
 *
 * Three members of the free tier are there deliberately rather than by omission.
 * The canvas renderer is a rendering strategy rather than a feature, so gating it
 * would mean "your map is slow unless you pay". The spatial index is internal
 * hit-testing that no caller opts into. Accessibility is never gated: a watermark
 * over a screen-reader affordance is indefensible, and in some markets it
 * disqualifies the product from procurement.
 *
 * A name here is inert until a call site passes it to `_requirePremium`, and
 * `test/premium.test.ts` fails on any name with no live gate: `story` sat here
 * ungated from the first release, so the list is not evidence of anything on its
 * own. `morph`, `presentation`, `timePlayback` and `webgl` are named ahead of the
 * features themselves and are the exception that test knows about.
 *
 * @module core/premium
 */

export const PREMIUM_FEATURES = [
  'annotations',
  'clustering',
  'customProjection',
  'drilldown',
  'linkGroup',
  'morph',
  'presentation',
  'routes',
  'story',
  'timePlayback',
  'webgl',
] as const

export type PremiumFeature = (typeof PREMIUM_FEATURES)[number]
