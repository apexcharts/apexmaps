/**
 * The Angular component.
 *
 * Angular's own primitives replace most of what the React and Vue wrappers had to
 * build by hand: signal inputs give change notification without a watcher,
 * `afterNextRender` gives browser-only construction without a platform check (it
 * simply never runs on the server), and `DestroyRef` gives teardown without a
 * lifecycle interface. What Angular adds that the others do not have at all is
 * the zone, and both halves of that contract are load-bearing:
 *
 * - The map is constructed and driven **outside** the zone. Construction attaches
 *   pointermove listeners, and zone.js patches `addEventListener`, so a map built
 *   inside the zone runs change detection on every pointer movement over every
 *   feature. That is the classic "the page is slow but nothing is wrong" bug.
 * - Outputs are emitted back **inside** the zone. An event fired from an
 *   unpatched listener is invisible to zone-based change detection, so a handler
 *   that sets component state would update nothing until some unrelated event
 *   flushed it. Under zoneless change detection `NgZone` is a no-op
 *   implementation and both calls degrade to plain function calls, so the same
 *   code is correct in both modes.
 *
 * @module apexmaps.component
 */

import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  NgZone,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core'
import type { OutputEmitterRef } from '@angular/core'
import ApexMaps from 'apexmaps'
import type { ApexMapsEventMap, ApexMapsEventName, ApexMapsOptions, Series } from 'apexmaps'
import { equal, sameOptions, snapshotOptions, snapshotSeries } from 'apexmaps/wrappers'

/** What the last applied update looked like. A snapshot, never a reference. */
interface Applied {
  options: ApexMapsOptions
  series: readonly Series[] | undefined
  width: number | string | undefined
  height: number | string | undefined
}

/**
 * A map, as an Angular component.
 *
 * ```html
 * <apx-map
 *   [options]="{ geo: { map: 'world' } }"
 *   [series]="series"
 *   [height]="480"
 *   (featureClick)="select($event.key)"
 * />
 * ```
 *
 * Two elements, and the split is load-bearing rather than tidy. The host element
 * (`<apx-map>`) belongs to the caller: their class and style bindings land there,
 * and Angular manages them. The inner `<div>` belongs to the core, which writes
 * its own classes ('apexmaps', 'apexmaps--dark') and custom properties onto its
 * container. Angular's class bindings are additive per key rather than
 * whole-attribute writes, so the collision is gentler than React's or Vue's, but
 * a caller using `[attr.class]` still replaces the attribute wholesale, and the
 * host element split makes the question moot. `:host` gets `display: block`
 * because an unknown element is inline by default, and an inline host measures
 * uselessly.
 */
@Component({
  selector: 'apx-map',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div #host style="width: 100%; height: 100%"></div>`,
  styles: [':host { display: block; }'],
})
export class ApexMapsComponent {
  /** The same options object the core takes. */
  readonly options = input.required<ApexMapsOptions>()
  /**
   * Series data. Equivalent to `options.series` and takes precedence over it;
   * both routes reach `updateSeries`, so both tween.
   */
  readonly series = input<readonly Series[] | undefined>(undefined)
  /** Shorthand for `options.chart.width`. */
  readonly width = input<number | string | undefined>(undefined)
  /** Shorthand for `options.chart.height`. */
  readonly height = input<number | string | undefined>(undefined)

  // One output per core event, under the core's own name. The `OUTPUTS` table
  // below is what keeps this list exhaustive: a new core event fails the build
  // there until a field exists here.
  readonly rendered = output<ApexMapsEventMap['rendered']>()
  readonly updated = output<ApexMapsEventMap['updated']>()
  readonly resized = output<ApexMapsEventMap['resized']>()
  readonly featureClick = output<ApexMapsEventMap['featureClick']>()
  readonly featureHover = output<ApexMapsEventMap['featureHover']>()
  readonly featureFocus = output<ApexMapsEventMap['featureFocus']>()
  readonly markClick = output<ApexMapsEventMap['markClick']>()
  readonly markHover = output<ApexMapsEventMap['markHover']>()
  readonly clusterClick = output<ApexMapsEventMap['clusterClick']>()
  readonly drilldown = output<ApexMapsEventMap['drilldown']>()
  readonly drillup = output<ApexMapsEventMap['drillup']>()
  readonly selectionChange = output<ApexMapsEventMap['selectionChange']>()
  readonly legendToggle = output<ApexMapsEventMap['legendToggle']>()
  readonly zoom = output<ApexMapsEventMap['zoom']>()
  readonly panEnd = output<ApexMapsEventMap['panEnd']>()

  /**
   * The live instance, for the imperative API (`drillTo`, `exportPNG`,
   * `frameFeature`, `diagnoseJoin`). A signal so a `viewChild` consumer can
   * `effect()` on availability; null until the first render and after destroy.
   */
  readonly map = signal<ApexMaps | null>(null)

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host')
  private readonly zone = inject(NgZone)
  private readonly injector = inject(Injector)

  private ready: Promise<unknown> | null = null
  private applied: Applied | null = null

  constructor() {
    // Cannot be built in the constructor (no DOM yet) nor in the first effect run
    // (which happens during change detection, before the view is attached).
    // `afterNextRender` is exactly "the view exists, and we are in a browser":
    // it never fires during server rendering, which is the whole SSR story.
    afterNextRender(() => {
      const el = this.host().nativeElement

      this.applied = this.take()
      // No `runOutsideAngular` here, because `afterNextRender` callbacks already
      // run outside the Angular zone, so construction attaches its pointer
      // listeners unpatched without any help. Effect callbacks carry the same
      // framework guarantee, which makes the explicit wrapper around the update
      // calls below technically redundant today; it stays because it makes the
      // no-patched-listeners contract local and load-bearing rather than
      // inherited from two framework behaviours, and `zone.test.ts` pins the
      // contract itself either way.
      const map = new ApexMaps(el, this.configOf(this.applied!))
      this.map.set(map)

      const outputs: { [K in ApexMapsEventName]: OutputEmitterRef<ApexMapsEventMap[K]> } = {
        rendered: this.rendered,
        updated: this.updated,
        resized: this.resized,
        featureClick: this.featureClick,
        featureHover: this.featureHover,
        featureFocus: this.featureFocus,
        markClick: this.markClick,
        markHover: this.markHover,
        clusterClick: this.clusterClick,
        drilldown: this.drilldown,
        drillup: this.drillup,
        selectionChange: this.selectionChange,
        legendToggle: this.legendToggle,
        zoom: this.zoom,
        panEnd: this.panEnd,
      }
      for (const event of Object.keys(outputs) as ApexMapsEventName[]) {
        map.on(event, ((payload: never) => {
          // Back inside the zone: the event originated from an unpatched
          // listener, so without this a handler that sets component state would
          // change nothing on screen until something else triggered a flush.
          this.zone.run(() => outputs[event].emit(payload))
        }) as never)
      }

      // Async because geometry may be a URL or a lazy pack, and the promise is
      // kept so updates can queue behind it. Nothing throws if one lands
      // mid-flight, which is what makes it worth the code: `_draw` returns early
      // while `geo` is still null, so the update paints nothing, and then
      // `render()` resumes and installs the geometry it resolved *before* the
      // update. The map ends up showing the map it was told to stop showing.
      this.ready = this.zone.runOutsideAngular(() =>
        map.render().catch((error: unknown) => {
          console.error('[ngx-apexmaps] render failed:', error)
        }),
      )

      // The update effect is created HERE, not in the constructor, and the
      // placement is correctness rather than style. A view effect's first run can
      // precede the first application of the template's input bindings, and
      // reading a required input before it is set throws NG0950. Inside
      // `afterNextRender` the first full render has happened, so every input is
      // set, the map exists, and the effect's initial run is a cheap no-op
      // comparison instead of a crash. Created outside the constructor there is
      // no ambient injection context, hence the explicit injector, which also
      // ties the effect's lifetime to the component's.
      //
      // Signal inputs make the diffing cheaper than Vue's but not simpler than
      // React's: a template binding like `[options]="build()"` re-evaluates on
      // every change detection cycle and hands over a brand new object each
      // time, so reference inequality still cannot mean "changed". The
      // comparison is the same shared deep one, against a snapshot. (The
      // snapshot also covers the caller who mutates a bound object in place and
      // later triggers any other input change: with a stored reference, their
      // earlier mutation would make the comparison silently agree with itself.)
      effect(
        () => {
          this.options()
          this.series()
          this.width()
          this.height()
          untracked(() => this.apply())
        },
        { injector: this.injector },
      )
    })

    inject(DestroyRef).onDestroy(() => {
      const map = this.map()
      this.map.set(null)
      this.ready = null
      this.applied = null
      try {
        this.zone.runOutsideAngular(() => map?.destroy())
      } catch {
        // A component destroyed before render() finished can leave destroy()
        // with half-built state. A throw from a destroy hook propagates into
        // Angular's teardown of the whole view tree, which is never the right
        // trade for a map that is going away anyway.
      }
    })
  }

  private take(): Applied {
    return {
      options: snapshotOptions(this.options()),
      series: snapshotSeries(this.series() ?? this.options().series),
      width: this.width(),
      height: this.height(),
    }
  }

  private configOf(state: Applied): ApexMapsOptions {
    const next: ApexMapsOptions = { ...state.options }
    if (state.series) next.series = [...state.series]
    if (state.width !== undefined || state.height !== undefined) {
      next.chart = { ...state.options.chart }
      if (state.width !== undefined) next.chart.width = state.width
      if (state.height !== undefined) next.chart.height = state.height
    }
    return next
  }

  private apply(): void {
    const map = this.map()
    if (!map || !this.applied) return

    const next = this.take()
    const optionsChanged =
      !sameOptions(this.applied.options, next.options) ||
      this.applied.width !== next.width ||
      this.applied.height !== next.height
    const seriesChanged = !equal(this.applied.series, next.series)
    if (!optionsChanged && !seriesChanged) return

    this.applied = next

    const run = () => {
      if (this.map() !== map) return
      this.zone.runOutsideAngular(() => {
        // Series-only changes go to `updateSeries`, which tweens. Routing them
        // through `updateOptions` would look identical in a test and would
        // silently replace every transition with a redraw.
        if (optionsChanged) void map.updateOptions(this.configOf(next))
        else map.updateSeries(next.series ?? [])
      })
    }

    if (map.rendered) run()
    else void (this.ready ?? Promise.resolve()).then(run)
  }
}
