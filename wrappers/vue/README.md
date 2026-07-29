# vue-apexmaps

Vue 3 component for [ApexMaps](https://github.com/apexcharts/apexmaps).

```bash
npm install apexmaps vue-apexmaps
```

`apexmaps` and `vue` are peer dependencies, so there is one copy of each in your app.

## Quick start

```vue
<script setup>
import ApexMaps from 'vue-apexmaps'
import 'apexmaps/apexmaps.css'

const options = { geo: { map: 'world' } }
const series = [
  {
    type: 'choropleth',
    name: 'Coverage',
    data: [{ key: 'IND', value: 42 }],
    scale: { palette: 'blues', classes: 5 },
  },
]
</script>

<template>
  <ApexMaps :options="options" :series="series" :height="480" @feature-click="onClick" />
</template>
```

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `options` | `ApexMapsOptions` | Required. The same options object the core takes. |
| `series` | `Series[]` | Optional shorthand for `options.series`. Takes precedence over it. |
| `width` / `height` | `number \| string` | Shorthand for `options.chart.width` / `.height`. See sizing. |

Anything else you bind (`class`, `style`, `id`, `aria-*`) falls through to the outer element.

## Events

One event per core event, emitted under its own name, so both `@feature-click` and `@featureClick`
work:

`rendered`, `updated`, `resized`, `feature-click`, `feature-hover`, `feature-focus`, `mark-click`,
`mark-hover`, `cluster-click`, `drilldown`, `drillup`, `selection-change`, `legend-toggle`, `zoom`,
`pan-end`.

Each receives the payload the core emits.

## The imperative API

Camera moves, drilldown, export and diagnostics are methods rather than options. Reach them through
a template ref:

```vue
<script setup>
import { useTemplateRef } from 'vue'
const el = useTemplateRef('mapEl')
const zoomToIndia = () => el.value.map.frameFeature('IND')
</script>

<template>
  <ApexMaps ref="mapEl" :options="options" />
</template>
```

## Reactivity

The component is built for the Vue change model rather than adapted from the React one, and three
things follow from that.

**Mutating in place works.** `options.legend.position = 'top'` on reactive state is seen, because the
component keeps a structural snapshot of the last applied options rather than a reference to them. A
reference would be the very object you just mutated, so every comparison would say nothing changed
and the map would never update.

**Reactive geometry never reaches the map.** `reactive()` creates proxies lazily as an object is read,
so a topology handed to the core would be proxied feature by feature and coordinate by coordinate as
the ingest walks it: tens of thousands of proxies, and a trap on every read after that. The component
unwraps it with `toRaw`, and passes plain objects for everything else. You do not have to do anything,
but `markRaw` on imported geometry is still worth it so Vue never proxies it in the first place:

```js
import { markRaw } from 'vue'
import counties from './us-counties.json'

const options = { geo: { map: markRaw(counties) } }
```

**Deep watching stops at the geometry.** Configuration is watched deeply; `geo.map` is watched by
reference alone. Replacing it with a new object (or a different pack id) is a change; rebuilding an
equal topology on every render is also a change, and will reproject every time, which is the one case
where a `markRaw` module-level constant matters for correctness of intent rather than speed.

Inline formatters are compared by source rather than identity, so writing
`:options="{ dataLabels: { formatter: v => `${v}%` } }"` in a template does not redraw on every render.

## Sizing

Use the `width` and `height` props, not CSS. The map's height comes from `options.chart.height`, which
defaults to `400`, and an explicit number wins over the container. So a `style="height: 600px"` on its
own gives you a 600px box with a 400px map in it.

Width behaves differently, because `chart.width` defaults to `'100%'`: it does follow the container,
and keeps following it as the container resizes.

To have the height follow the container too, say so:

```vue
<ApexMaps :options="options" height="100%" style="height: 60vh" />
```

## The DOM it renders

Two nested `<div>`s. Vue owns the outer one and your fallthrough attributes land there. ApexMaps owns
the inner one and writes its own class and custom properties.

They are separate on purpose: Vue patches `class` by assigning the whole attribute, so if the two
shared an element then changing a bound class would delete the `apexmaps` class and every style rule in
the package would stop matching, leaving a map that renders correctly once and then silently loses all
of its styling.

## Nuxt and SSR

Safe to import and render on the server: the component emits its container and does nothing else,
because everything that touches a document happens in `onMounted`. It hydrates and then builds the map
on the client.

It is not server *rendered*. The core has no HTML output path yet, so there is nothing to send down
ahead of hydration. Wrap it in `<ClientOnly>` if you would rather not render the empty container at
all.
