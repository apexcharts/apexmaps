/**
 * The React component.
 *
 * `'use client'` is added by the build as a banner rather than written here,
 * because rollup discards a module-level directive when it bundles. See the
 * rollup config: the directive is load-bearing for Next.js and is checked.
 *
 * Written with `createElement` rather than JSX on purpose: it renders two bare
 * `<div>`s, so JSX would buy nothing and would cost a JSX runtime decision, a
 * Babel preset and a `jsx` compiler option in three config files. The core build
 * pipeline compiles this file as-is.
 *
 * @module ApexMapsReact
 */

import { createElement, useEffect, useRef } from 'react'
import type { HTMLAttributes } from 'react'
import ApexMaps from 'apexmaps'
import type { ApexMapsEventMap, ApexMapsEventName, ApexMapsOptions, Series } from 'apexmaps'
import { equal, sameOptions } from './equal'

/**
 * Every core event, as a prop.
 *
 * `Record<ApexMapsEventName, ...>` makes this exhaustive: adding an event to
 * `ApexMapsEventMap` in the core fails this build until it is listed here, which
 * is the drift protection a hand-written list of strings would not have. The
 * value type pins the name too, so `drillup` cannot be exposed as `onDrillUp`
 * while the props type says `onDrillup`.
 */
const EVENT_PROPS: { [K in ApexMapsEventName]: `on${Capitalize<K>}` } = {
  rendered: 'onRendered',
  updated: 'onUpdated',
  resized: 'onResized',
  featureClick: 'onFeatureClick',
  featureHover: 'onFeatureHover',
  featureFocus: 'onFeatureFocus',
  markClick: 'onMarkClick',
  markHover: 'onMarkHover',
  clusterClick: 'onClusterClick',
  drilldown: 'onDrilldown',
  drillup: 'onDrillup',
  selectionChange: 'onSelectionChange',
  legendToggle: 'onLegendToggle',
  zoom: 'onZoom',
  panEnd: 'onPanEnd',
}

const EVENT_PROP_NAMES: ReadonlySet<string> = new Set(Object.values(EVENT_PROPS))

export type ApexMapsEventProps = {
  [K in ApexMapsEventName as `on${Capitalize<K>}`]?: (payload: ApexMapsEventMap[K]) => void
}

export interface ApexMapsProps
  extends ApexMapsEventProps, Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  options: ApexMapsOptions
  /**
   * Series data. Equivalent to `options.series` and takes precedence over it;
   * both routes reach `updateSeries`, so both tween.
   */
  series?: readonly Series[]
  /** Shorthand for `options.chart.width`. */
  width?: number | string
  /** Shorthand for `options.chart.height`. */
  height?: number | string
  /**
   * Receives the live instance, for the imperative API: `drillTo`, `exportPNG`,
   * `frameFeature`, `diagnoseJoin`. Nulled on unmount.
   */
  mapRef?: { current: ApexMaps | null }
}

/** What the last applied render looked like, for change detection. */
interface Applied {
  options: ApexMapsOptions
  series: readonly Series[] | undefined
  width: number | string | undefined
  height: number | string | undefined
}

function configOf(props: ApexMapsProps): ApexMapsOptions {
  const { options, series, width, height } = props
  const next: ApexMapsOptions = { ...options }
  if (series) next.series = [...series]
  if (width !== undefined || height !== undefined) {
    next.chart = { ...options.chart }
    if (width !== undefined) next.chart.width = width
    if (height !== undefined) next.chart.height = height
  }
  return next
}

/**
 * A map, as a React component.
 *
 * ```tsx
 * <ApexMapsReact
 *   options={{ geo: { map: 'world' }, scale: { type: 'quantize' } }}
 *   series={[{ type: 'choropleth', data }]}
 *   onFeatureClick={({ key }) => setSelected(key)}
 *   style={{ height: 480 }}
 * />
 * ```
 *
 * Server-safe: the module is importable without a DOM and this function only ever
 * emits a `<div>` outside the browser, because everything else happens in effects
 * and effects do not run on the server. It is not server *rendered*, though. The
 * core has no HTML output path (`render()` returns early when there is no
 * document), so there is nothing to send down and hydrate, and shipping a
 * `/server` entry that returned an empty box would be worse than not having one.
 */
export default function ApexMapsReact(props: ApexMapsProps) {
  const { options, series, width, height, mapRef, ...rest } = props

  const host = useRef<HTMLDivElement | null>(null)
  const instance = useRef<ApexMaps | null>(null)
  const ready = useRef<Promise<unknown> | null>(null)
  const applied = useRef<Applied | null>(null)

  /**
   * The current props, read at emit time rather than captured at subscribe time.
   *
   * `onFeatureClick={() => ...}` is a new function on every render. Subscribing
   * it directly would mean unsubscribing and resubscribing every render, and any
   * event that fired in between would be dropped. Writing the ref during render
   * is the standard "latest value" pattern, and it is idempotent, so StrictMode's
   * double render is harmless.
   */
  const latest = useRef(props)
  latest.current = props

  useEffect(() => {
    const el = host.current
    if (!el) return

    // This effect's closure, not `latest`: React flushes an effect before the next
    // commit, so at this point the two are the same values, and the config the
    // instance is built from has to be the one recorded as applied below or the
    // first comparison is a false positive.
    const map = new ApexMaps(el, configOf(props))
    instance.current = map
    if (mapRef) mapRef.current = map
    applied.current = { options, series: series ?? options.series, width, height }

    // Every event is subscribed whether or not a handler was passed. The
    // trampoline is one property read against `latest`, and the payload the core
    // emits is built regardless of who is listening, so a missing handler costs
    // nothing measurable and the alternative is resubscribing whenever the *set*
    // of handler props changes.
    for (const [event, prop] of Object.entries(EVENT_PROPS) as [
      ApexMapsEventName,
      keyof ApexMapsEventProps,
    ][]) {
      map.on(event, ((payload: never) => {
        const handler = latest.current[prop] as ((value: unknown) => void) | undefined
        handler?.(payload)
      }) as never)
    }

    // Async because geometry may be a URL or a lazy pack, and the promise is kept
    // so updates can queue behind it.
    //
    // Nothing throws if an update lands mid-flight, which is what makes this
    // worth the code: `_draw` returns early while `geo` is still null, so the
    // update applies to the config and paints nothing, and then `render()`
    // resumes and installs the geometry it resolved *before* the update, which
    // is the geometry of the previous map. The visible result is a map that
    // ignores the prop it was given, with no error anywhere.
    ready.current = map.render().catch((error: unknown) => {
      console.error('[react-apexmaps] render failed:', error)
    })

    return () => {
      instance.current = null
      ready.current = null
      applied.current = null
      if (mapRef) mapRef.current = null
      try {
        map.destroy()
      } catch {
        // A container unmounted before render() finished can leave destroy() with
        // half-built state. Core guards its own teardown, but a throw here would
        // propagate out of a cleanup function and take the React tree with it,
        // which is never the right trade for a map that is going away anyway.
      }
      // No `off` for the subscriptions above: destroy() drops every listener, and
      // it has just run.
    }
    // Mount only, deliberately. Later prop changes are the other effect's job, and
    // rebuilding the instance for them would throw away camera position, selection
    // and drilldown depth.
  }, [])

  useEffect(() => {
    const map = instance.current
    const previous = applied.current
    if (!map || !previous) return

    // `series` and `options.series` are the same thing to the core, so they are
    // normalised to one value before comparing. Otherwise moving data from the
    // prop into the options tree would read as "options changed", costing a full
    // redraw for what is really a series update.
    const nextSeries = series ?? options.series
    const optionsChanged =
      !sameOptions(previous.options, options) ||
      previous.width !== width ||
      previous.height !== height
    const seriesChanged = !equal(previous.series, nextSeries)
    if (!optionsChanged && !seriesChanged) return

    applied.current = { options, series: nextSeries, width, height }

    let cancelled = false
    const apply = () => {
      if (cancelled || instance.current !== map) return
      // Series-only changes go to `updateSeries`, which tweens fills and radii.
      // Routing them through `updateOptions` would work and would look identical
      // in a test, and would silently replace every transition with a redraw.
      if (optionsChanged) void map.updateOptions(configOf(latest.current))
      else map.updateSeries(nextSeries ?? [])
    }

    if (map.rendered) apply()
    else void (ready.current ?? Promise.resolve()).then(apply)

    return () => {
      cancelled = true
    }
  }, [options, series, width, height])

  // Our own props must not reach the DOM, or React warns about every one of them.
  const attributes: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rest)) {
    if (!EVENT_PROP_NAMES.has(key)) attributes[key] = value
  }

  // Two elements, and the split is load-bearing rather than tidy.
  //
  // The core mounts into its container by writing the container's own `class`
  // ('apexmaps', 'apexmaps--dark', 'apexmaps--enter') and `style` (the state
  // custom properties, and `fontFamily`). React owns any element it renders
  // attributes for, and it applies `className` by replacing the whole attribute,
  // so handing the core an element whose class React also manages means the next
  // `className` change silently deletes 'apexmaps' and every style rule in the
  // package stops matching. A map that renders correctly and then loses all of
  // its styling when a parent toggles a class is the worst kind of bug to chase.
  //
  // So React owns the outer element and the caller's props, and the core owns the
  // inner one, whose props never change and which React therefore never writes to
  // again after mount. `height: 100%` is what carries a height set on the outer
  // element through to the core's measurement; against an auto-height parent it
  // resolves to auto, which is the behaviour a single element would have had.
  return createElement(
    'div',
    attributes,
    createElement('div', { ref: host, style: { width: '100%', height: '100%' } }),
  )
}
