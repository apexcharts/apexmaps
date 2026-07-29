/**
 * The Vue 3 component.
 *
 * Written with `h()` in a `.ts` file rather than as an SFC: it renders two bare
 * `<div>`s and has no template, no scoped styles and no `<style>` block, so an SFC
 * would add `@vitejs/plugin-vue` and `vue-tsc` to the build for markup that is two
 * function calls.
 *
 * The interesting difference from the React wrapper is not the API, it is the
 * change model. A React caller replaces `options` with a new object; a Vue caller
 * mutates reactive state in place, so the last-applied options and the current
 * props are frequently *the same object*. That shapes both the watchers and the
 * snapshot below, and getting it wrong produces a map that simply never updates.
 *
 * @module ApexMapsVue
 */

import { defineComponent, h, onBeforeUnmount, onMounted, ref, shallowRef, toRaw, watch } from 'vue'
import type { PropType } from 'vue'
import ApexMaps from 'apexmaps'
import type { ApexMapsEventName, ApexMapsOptions, Series } from 'apexmaps'
import { equal, sameOptions, snapshotOptions, snapshotSeries, withoutData } from 'apexmaps/wrappers'

/**
 * Every core event, emitted under its own name.
 *
 * Typed as `readonly ApexMapsEventName[]` and checked for exhaustiveness below, so
 * adding an event to the core fails this build until it is listed. Vue matches a
 * template's `@feature-click` to `emit('featureClick')`, so both spellings work
 * without a second name to keep in step.
 */
const EVENTS = [
  'rendered',
  'updated',
  'resized',
  'featureClick',
  'featureHover',
  'featureFocus',
  'markClick',
  'markHover',
  'clusterClick',
  'drilldown',
  'drillup',
  'selectionChange',
  'legendToggle',
  'zoom',
  'panEnd',
] as const satisfies readonly ApexMapsEventName[]

/**
 * Fails the build if a core event is missing from `EVENTS`. A `satisfies` clause
 * alone only checks that every listed name is real, not that every real name is
 * listed, and the second direction is the one that goes stale.
 */
type Unlisted = Exclude<ApexMapsEventName, (typeof EVENTS)[number]>
const _everyEventIsEmitted: Record<Unlisted, never> = {} as Record<Unlisted, never>
void _everyEventIsEmitted

/** What the last applied update looked like. A snapshot, never a reference. */
interface Applied {
  options: ApexMapsOptions
  series: readonly Series[] | undefined
  width: number | string | undefined
  height: number | string | undefined
}

export default defineComponent({
  name: 'ApexMaps',

  props: {
    options: {
      type: Object as PropType<ApexMapsOptions>,
      required: true,
    },
    /**
     * Series data. Equivalent to `options.series` and takes precedence over it;
     * both routes reach `updateSeries`, so both tween.
     */
    series: {
      type: Array as PropType<readonly Series[]>,
      default: undefined,
    },
    /** Shorthand for `options.chart.width`. */
    width: {
      type: [Number, String] as PropType<number | string>,
      default: undefined,
    },
    /** Shorthand for `options.chart.height`. */
    height: {
      type: [Number, String] as PropType<number | string>,
      default: undefined,
    },
  },

  // Spread rather than passed directly: Vue's `emits` takes a mutable `string[]`,
  // and a `readonly` tuple fails every `defineComponent` overload with a wall of
  // unrelated inference errors.
  emits: [...EVENTS],

  setup(props, { emit, expose }) {
    const host = ref<HTMLDivElement | null>(null)
    /**
     * `shallowRef`, and this is correctness rather than performance.
     *
     * `ref()` converts an object it holds into a `reactive()` proxy, so `map.value`
     * would hand back a proxied ApexMaps. Every method then runs with `this` bound
     * to the proxy, and every object it reaches (the container element, the
     * viewport, the renderer's layers) comes back proxied too. Most of that merely
     * costs a trap per access, but the core keeps element-keyed bookkeeping (the
     * watermark's tracking set) and compares `event.target` against elements it
     * stored, and a proxy is not `===` the node it wraps. So a reactive instance
     * does not just run slowly, it silently fails lookups.
     */
    const map = shallowRef<ApexMaps | null>(null)
    let ready: Promise<unknown> | null = null
    let applied: Applied | null = null

    const currentSeries = () => props.series ?? props.options.series

    /**
     * A plain, non-reactive copy of the props.
     *
     * Everything the core receives comes from here, and none of it is a Vue proxy.
     * That is not tidiness. `reactive()` proxies lazily, on access, so handing the
     * core a reactive topology means Vue creates a proxy for every feature, every
     * geometry and every coordinate array as the ingest walks it: tens of thousands
     * of proxies for a county map, and a trap on every read afterwards. `clone`
     * inside `snapshotOptions` already produces plain objects, and `toRaw` handles
     * the one thing it keeps by reference.
     *
     * Comparison uses these snapshots on both sides, never a snapshot against live
     * props. Mixing them would compare a raw topology against its proxy, conclude
     * the geometry changed, and reproject on every tick.
     */
    const take = (): Applied => {
      const options = snapshotOptions(props.options)
      const geometry = props.options.geo?.map
      if (options.geo && geometry && typeof geometry === 'object') {
        options.geo.map = toRaw(geometry) as typeof options.geo.map
      }
      return {
        options,
        series: snapshotSeries(currentSeries()),
        width: props.width,
        height: props.height,
      }
    }

    const configOf = (state: Applied): ApexMapsOptions => {
      const next: ApexMapsOptions = { ...state.options }
      if (state.series) next.series = [...state.series]
      if (state.width !== undefined || state.height !== undefined) {
        next.chart = { ...state.options.chart }
        if (state.width !== undefined) next.chart.width = state.width
        if (state.height !== undefined) next.chart.height = state.height
      }
      return next
    }

    const apply = () => {
      const instance = map.value
      if (!instance || !applied) return

      const next = take()
      const optionsChanged =
        !sameOptions(applied.options, next.options) ||
        applied.width !== next.width ||
        applied.height !== next.height
      const seriesChanged = !equal(applied.series, next.series)
      // The watchers below deliberately over-fire (a deep watcher cannot know what
      // changed), so this is the gate that decides whether the core is touched.
      if (!optionsChanged && !seriesChanged) return

      applied = next

      const run = () => {
        if (map.value !== instance) return
        // Series-only changes go to `updateSeries`, which tweens. Routing them
        // through `updateOptions` would look identical in a test and would silently
        // replace every transition with a redraw.
        if (optionsChanged) void instance.updateOptions(configOf(next))
        else instance.updateSeries(next.series ?? [])
      }

      // Both update paths need the geometry that `render()` is still loading. See
      // the mount below.
      if (instance.rendered) run()
      else void (ready ?? Promise.resolve()).then(run)
    }

    onMounted(() => {
      const el = host.value
      if (!el) return

      applied = take()
      const instance = new ApexMaps(el, configOf(applied))
      map.value = instance

      // `emit` is stable for the component's lifetime, so unlike React there is no
      // handler identity to chase: subscribe once and forward.
      for (const event of EVENTS) {
        instance.on(event, ((payload: never) => {
          emit(event, payload)
        }) as never)
      }

      // Async because geometry may be a URL or a lazy pack, and the promise is kept
      // so updates can queue behind it. Nothing throws if one lands mid-flight,
      // which is what makes it worth the code: `_draw` returns early while `geo` is
      // still null, so the update paints nothing, and then `render()` resumes and
      // installs the geometry it resolved *before* the update. The map ends up
      // showing the map it was told to stop showing, with no error anywhere.
      ready = instance.render().catch((error: unknown) => {
        console.error('[vue-apexmaps] render failed:', error)
      })
    })

    onBeforeUnmount(() => {
      const instance = map.value
      map.value = null
      ready = null
      applied = null
      try {
        instance?.destroy()
      } catch {
        // A component unmounted before render() finished can leave destroy() with
        // half-built state. A throw from a teardown hook would propagate into Vue's
        // unmount, which is never the right trade for a map that is going away.
      }
      // No `off` for the subscriptions above: destroy() drops every listener.
    })

    // Four watchers rather than one deep watcher on everything, and the split is
    // the point.
    //
    // A deep watcher traverses what it watches. Pointed at `options` it would walk
    // whatever `geo.map` holds, and a topology in reactive state is thousands of
    // proxies walked on every check: the exact cost the identity comparison exists
    // to avoid, reintroduced by the watcher instead of the comparison. So the
    // configuration is watched deeply with the geometry removed, and the geometry
    // is watched by reference alone.
    watch(withoutDataOf, apply, { deep: true, flush: 'post' })
    watch(() => props.options.geo?.map, apply, { flush: 'post' })
    watch(currentSeries, apply, { deep: true, flush: 'post' })
    watch([() => props.width, () => props.height], apply, { flush: 'post' })

    function withoutDataOf() {
      return withoutData(props.options)
    }

    // `expose` rather than returning bindings: setup returns a render function
    // here, which means nothing is exposed automatically. `ref="m"` then gives
    // `m.value.map` for the imperative API (drillTo, exportPNG, frameFeature).
    expose({ map })

    // Two elements, and the split is load-bearing rather than tidy.
    //
    // The core mounts into its container by writing that container's own `class`
    // ('apexmaps', 'apexmaps--dark', 'apexmaps--enter') and `style` (the state
    // custom properties, and `fontFamily`). Vue patches `class` by assigning the
    // whole attribute, exactly as React does, so handing the core the element Vue
    // manages means the next class change deletes 'apexmaps' and every rule in the
    // package stops matching: a map that renders correctly and then loses all of
    // its styling, with nothing thrown.
    //
    // So Vue owns the outer element, where fallthrough attributes land, and the
    // core owns the inner one, whose props never change. `height: 100%` is what
    // carries a height set on the outer element through to the core's measurement;
    // against an auto-height parent it resolves to auto, which is the behaviour a
    // single element would have had.
    return () => h('div', null, [h('div', { ref: host, style: { width: '100%', height: '100%' } })])
  },
})
