# ngx-apexmaps

Angular component for [ApexMaps](https://github.com/apexcharts/apexmaps).

```bash
npm install apexmaps ngx-apexmaps
```

`apexmaps` and `@angular/core` (>= 20) are peer dependencies. Nothing else: no
`@angular/common`, no rxjs requirement of its own, no zone.js requirement, no NgModule.

## Quick start

```ts
import { Component, signal } from '@angular/core'
import { ApexMapsComponent } from 'ngx-apexmaps'
import 'apexmaps/apexmaps.css'

@Component({
  standalone: true,
  imports: [ApexMapsComponent],
  template: `
    <apx-map
      [options]="options"
      [series]="series()"
      [height]="480"
      (featureClick)="selected.set($event.key)"
    />
  `,
})
export class CoverageComponent {
  readonly options = { geo: { map: 'world' } }
  readonly series = signal([
    {
      type: 'choropleth',
      name: 'Coverage',
      data: [{ key: 'IND', value: 42 }],
      scale: { palette: 'blues', classes: 5 },
    },
  ])
  readonly selected = signal<string | null>(null)
}
```

## Inputs and outputs

| Input | Type | Notes |
| --- | --- | --- |
| `options` | `ApexMapsOptions` | Required. The same options object the core takes. |
| `series` | `Series[]` | Optional shorthand for `options.series`. Takes precedence over it. |
| `width` / `height` | `number \| string` | Shorthand for `options.chart.width` / `.height`. See sizing. |

One output per core event, under the core's own name: `rendered`, `updated`, `resized`,
`featureClick`, `featureHover`, `featureFocus`, `markClick`, `markHover`, `clusterClick`,
`drilldown`, `drillup`, `selectionChange`, `legendToggle`, `zoom`, `panEnd`. Each receives the
payload the core emits, fully typed.

## The zone contract

The reason this wrapper exists rather than "just call the library from Angular":

- **The map runs outside the Angular zone.** A map attaches pointer listeners to everything it
  draws, and zone-patched listeners run change detection on every event: with zone.js, every
  pointermove over every feature would tick your whole application. Construction, rendering and
  updates all happen outside the zone, and re-attached listeners stay unpatched.
- **Outputs are emitted back inside the zone.** Events originate from unpatched listeners, which
  zone-based change detection cannot see. The component re-enters the zone to emit, so a
  `(featureClick)` handler that sets component state repaints, in zoned and zoneless applications
  alike.

Measured in Chromium against the built package: 30 pointermoves over the map, zero change
detection passes; one click, one repaint.

## The imperative API

Camera moves, drilldown, export and diagnostics are methods rather than options. The component
exposes the live instance as a signal:

```ts
@Component({
  template: `<apx-map #map [options]="options" />
    <button (click)="map.map()?.frameFeature('IND')">Zoom to India</button>`,
  imports: [ApexMapsComponent],
  standalone: true,
})
```

`map()` is null until the first render completes and after destroy, so an `effect()` on it is the
way to run something once the map exists.

## What it does with your inputs

Bindings are compared deeply, not by reference, because a template expression like
`[options]="build()"` hands over a brand new object on every change detection cycle. A fresh but
equal tree is not a redraw; an inline `formatter` is compared by source rather than identity;
`geo.map` is compared by identity and never walked (pass a stable reference or a pack id). A
series-only change routes to `updateSeries`, which tweens; everything else to `updateOptions`.

Signal inputs do not fire on in-place mutation, so prefer replacing objects. If something else
later changes any input, an earlier in-place mutation is picked up with it rather than lost.

## Sizing

Use the `width` and `height` inputs, not CSS. The map's height comes from `options.chart.height`,
which defaults to `400`, and an explicit number wins over the container; width defaults to `'100%'`
and follows the container. `height="100%"` hands the height to the container:

```html
<apx-map [options]="options" height="100%" style="height: 60vh" />
```

The `<apx-map>` element is yours: class and style bindings land there (it is `display: block` by
default). The element inside it belongs to the map.

## SSR

Safe under Angular SSR and hydration: the component renders its container on the server and builds
the map in `afterNextRender`, which only ever runs in the browser. There is no server-rendered map
markup yet, because the core has no HTML output path.
