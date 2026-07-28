// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import ApexMaps from '../src/ApexMaps'

/**
 * Teardown races.
 *
 * `render()`, `updateOptions()` and the drill paths are async, because geometry
 * may be a URL or a lazy pack. A caller that tears the map down without awaiting
 * (a fast unmount, React StrictMode's mount/unmount/mount) leaves those tails
 * crossing the event loop, and each one used to finish against the destroyed
 * map: rebuilding the DOM, attaching interaction and a ResizeObserver into a
 * container that destroy() had already cleaned, with nothing left to ever clean
 * them again.
 *
 * The licence half of this (a dead container re-registered for watermarking)
 * is pinned in license.test.ts. These pin the general half.
 */

const BOX = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { iso_a3: 'AAA', name: 'Alpha' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [8, 0],
            [8, 8],
            [0, 8],
            [0, 0],
          ],
        ],
      },
    },
  ],
}

function host(): HTMLElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientWidth', { value: 800, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true })
  document.body.appendChild(el)
  return el
}

function makeMap(el: HTMLElement) {
  return new ApexMaps(el, {
    geo: { map: BOX as never },
    series: [{ type: 'choropleth', data: [{ key: 'AAA', value: 1 }] }],
  } as never)
}

describe('destroy races', () => {
  let el: HTMLElement

  beforeEach(() => {
    el = host()
  })

  afterEach(() => {
    el.remove()
  })

  it('a render that resolves after destroy leaves the container empty', async () => {
    const map = makeMap(el)
    const pending = map.render()
    map.destroy()
    await pending

    expect(el.querySelector('svg')).toBeNull()
    expect(el.classList.contains('apexmaps')).toBe(false)
    expect(map.rendered).toBe(false)
  })

  it('a render resolved after destroy does not emit "rendered"', async () => {
    const map = makeMap(el)
    let emitted = false
    map.on('rendered', () => {
      emitted = true
    })

    const pending = map.render()
    map.destroy()
    await pending

    expect(emitted).toBe(false)
  })

  it('render() on an already-destroyed instance is a no-op', async () => {
    const map = makeMap(el)
    map.destroy()
    await map.render()

    expect(el.querySelector('svg')).toBeNull()
    expect(map.rendered).toBe(false)
  })

  it('an updateOptions that resolves after destroy does not rebuild', async () => {
    // A lazy pack forces updateOptions across the event loop, which is where
    // the race lives: geometry passed inline resolves synchronously.
    ApexMaps.registerMap('test/late', () => Promise.resolve(BOX as never))

    const map = makeMap(el)
    await map.render()

    const pending = map.updateOptions({ geo: { map: 'test/late' } } as never)
    map.destroy()
    await pending

    expect(el.querySelector('svg')).toBeNull()
  })

  it('updateOptions() on an already-destroyed instance is a no-op', async () => {
    const map = makeMap(el)
    await map.render()
    map.destroy()

    await map.updateOptions({ series: [] } as never)
    expect(el.querySelector('svg')).toBeNull()
  })

  it('drillTo() resolved after destroy does not swap the level in', async () => {
    ApexMaps.registerMap('test/children', () => Promise.resolve(BOX as never))

    const map = new ApexMaps(el, {
      geo: { map: BOX as never },
      series: [
        {
          type: 'choropleth',
          data: [{ key: 'AAA', value: 1 }],
          drilldown: { map: 'test/children', animate: 'none' },
        },
      ],
    } as never)
    await map.render()

    const pending = map.drillTo('AAA')
    map.destroy()

    expect(await pending).toBe(false)
    expect(el.querySelector('svg')).toBeNull()
    expect(map.drillPath.length).toBe(0)
  })
})
