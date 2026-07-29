# react-apexmaps

React component for [ApexMaps](https://github.com/apexcharts/apexmaps).

```bash
npm install apexmaps react-apexmaps
```

`apexmaps` and `react` are peer dependencies, so there is one copy of each in your app.

## Quick start

```jsx
import ApexMaps from 'react-apexmaps'
import 'apexmaps/apexmaps.css'

const data = [
  { key: 'IND', value: 42 },
  { key: 'BRA', value: 71 },
]

export default function Coverage() {
  return (
    <ApexMaps
      options={{ geo: { map: 'world' }, scale: { palette: 'blues', classes: 5 } }}
      series={[{ type: 'choropleth', name: 'Coverage', data }]}
      onFeatureClick={({ key }) => console.log(key)}
      height={480}
    />
  )
}
```

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `options` | `ApexMapsOptions` | Required. The same options object the core takes. |
| `series` | `Series[]` | Optional shorthand for `options.series`. Takes precedence over it. |
| `width` / `height` | `number \| string` | Shorthand for `options.chart.width` / `.height`. See sizing. |
| `mapRef` | `{ current: ApexMaps \| null }` | Receives the live instance. Nulled on unmount. |
| `on*` | function | One prop per core event, listed below. |
| anything else | | Forwarded to the outer `<div>`: `className`, `style`, `id`, `aria-*`. |

Every core event has a prop: `onRendered`, `onUpdated`, `onResized`, `onFeatureClick`,
`onFeatureHover`, `onFeatureFocus`, `onMarkClick`, `onMarkHover`, `onClusterClick`, `onDrilldown`,
`onDrillup`, `onSelectionChange`, `onLegendToggle`, `onZoom`, `onPanEnd`. Each receives the payload
the core emits, fully typed. Handlers are read at emit time, so an inline arrow function costs
nothing and never misses an event.

## Sizing

Use the `width` and `height` props, not CSS. The map's height comes from
`options.chart.height`, which defaults to `400`, and an explicit number wins over the container. So a
`style={{ height: 600 }}` on its own gives you a 600px box with a 400px map in it.

Width behaves differently, because `chart.width` defaults to `'100%'`: it does follow the container,
and keeps following it as the container resizes.

To have the height follow the container too, say so:

```jsx
<ApexMaps options={options} height="100%" style={{ height: '60vh' }} />
```

Both props accept a number (pixels) or a CSS string, and a percentage string is what puts the
dimension under the container's control.

## The imperative API

Camera moves, drilldown, export and diagnostics are methods rather than options, because they are
actions rather than state. Reach them through `mapRef`:

```jsx
const map = useRef(null)

<ApexMaps mapRef={map} options={options} />
<button onClick={() => map.current?.frameFeature('IND')}>Zoom to India</button>
<button onClick={() => map.current?.exportPNG()}>Download</button>
```

## What it does with your props

React hands the component a brand new `options` object every time the parent renders, so the
component compares deeply rather than by reference. Four rules in that comparison are worth knowing,
because each one is a deliberate trade:

**Functions compare by source, not identity.** An inline `formatter` is a new function on every
render but usually the same behaviour, and treating that as a change would make every render a
redraw. Editing the formatter's source is noticed; a formatter that reads changed state through its
closure is not, so lift such values into `options` where they are data.

**`geo.map` compares by identity and is never walked.** Object geometry can be megabytes, and deep
comparing it every render would cost more than the redraw it avoids. Pass a stable reference (a
module-level constant, `useMemo`, or a pack id string). Rebuilding an equal topology object inline on
every render will redraw on every render.

**Series-only changes go to `updateSeries`, which tweens.** Everything else goes to `updateOptions`,
which redraws. This holds whether the data is in the `series` prop or in `options.series`.

**A map or projection change reprojects; nothing else does.** Camera position, selection and
drilldown depth survive an options change, so a parent re-render does not throw away where the reader
had navigated to.

### One thing to watch

`updateOptions` merges, so **removing a key from `options` does not reset it**. This is core
behaviour rather than something the wrapper adds, and it does not fit the declarative style:

```jsx
// Turning `show` off leaves the labels on, because `dataLabels` merely disappears.
options={{ ...base, ...(show && { dataLabels: { enabled: true } }) }}

// Pass the value instead of omitting the key.
options={{ ...base, dataLabels: { enabled: show } }}
```

## Server rendering

The component is safe to import and render on the server: it emits its container and does nothing
else, because everything that touches a document happens in an effect. It hydrates and then builds
the map on the client.

It is not server *rendered*. The core has no HTML output path yet, so there is no markup to send down
ahead of hydration, and there is no `react-apexmaps/server` entry rather than one that returns an
empty box.

## The DOM it renders

Two nested `<div>`s. React owns the outer one and applies your `className`, `style` and other
attributes to it. ApexMaps owns the inner one and writes its own class and custom properties there.

They are separate on purpose: React applies `className` by replacing the whole attribute, so if the
two shared an element then changing `className` would delete the `apexmaps` class and every style
rule in the package would stop matching, leaving a map that renders correctly once and then silently
loses all of its styling.
