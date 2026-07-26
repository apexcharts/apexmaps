// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import ApexMaps from '../src/ApexMaps'

/** Three well-separated boxes, so anchors are far apart in screen space. */
const THREE_BOXES = {
  type: 'FeatureCollection',
  features: [box('AAA', 'Alpha', -60), box('BBB', 'Beta', -10), box('CCC', 'Gamma', 40)],
}

function box(key, name, lon) {
  return {
    type: 'Feature',
    properties: { iso_a3: key, name },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [lon, 0],
          [lon + 10, 0],
          [lon + 10, 10],
          [lon, 10],
          [lon, 0],
        ],
      ],
    },
  }
}

const DATA = [
  { code: 'AAA', value: 10 },
  { code: 'BBB', value: 50 },
  { code: 'CCC', value: 90 },
]

let el
let map
let extra

beforeEach(() => {
  el = document.createElement('div')
  document.body.appendChild(el)
  vi.stubGlobal('requestAnimationFrame', ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame)
  vi.stubGlobal('cancelAnimationFrame', ((id: number) =>
    clearTimeout(id)) as unknown as typeof cancelAnimationFrame)
})

afterEach(() => {
  map?.destroy?.()
  extra?.instance?.destroy?.()
  map = null
  extra = null
  el.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

async function render(options = {}, container = el) {
  const instance = new ApexMaps(container, {
    chart: { width: 400, height: 300 },
    geo: { map: THREE_BOXES, projection: 'equirectangular' },
    debug: { enabled: false },
    series: [{ name: 'Score', joinBy: ['iso_a3', 'code'], data: DATA }],
    ...options,
  })
  await instance.render()
  return instance
}

/** Screen position of a feature's anchor, which is what a box is tested against. */
function anchorAt(instance, index) {
  return instance.viewport.worldToScreen(instance.anchors.get(index).world)
}

/** A box around the given screen points, with a little slack. */
function around(points, pad = 6) {
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  return [
    [Math.min(...xs) - pad, Math.min(...ys) - pad],
    [Math.max(...xs) + pad, Math.max(...ys) + pad],
  ]
}

function drag(instance, [from, to], { shiftKey = false, altKey = false, metaKey = false } = {}) {
  const plot = instance.plot
  plot.dispatchEvent(
    new window.PointerEvent('pointerdown', {
      bubbles: true,
      pointerId: 1,
      button: 0,
      clientX: from[0],
      clientY: from[1],
      shiftKey,
      altKey,
      metaKey,
    }),
  )
  // Two moves, so the box is seen mid-drag as well as at the end.
  const mid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]
  for (const point of [mid, to]) {
    window.dispatchEvent(
      new window.PointerEvent('pointermove', {
        bubbles: true,
        pointerId: 1,
        clientX: point[0],
        clientY: point[1],
        shiftKey,
        altKey,
        metaKey,
      }),
    )
  }
  return () =>
    window.dispatchEvent(
      new window.PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 1,
        clientX: to[0],
        clientY: to[1],
        shiftKey,
        altKey,
        metaKey,
      }),
    )
}

const selectBox = () => el.querySelector('rect.apexmaps-select-box')
const selected = () => [...map.selection].sort()

describe('box selection', () => {
  it('selects the features a shift-drag encloses, and only those', async () => {
    map = await render()
    const region = around([anchorAt(map, 0), anchorAt(map, 1)])

    const release = drag(map, region, { shiftKey: true })
    expect(selectBox()).not.toBe(null)
    release()

    expect(selected()).toEqual(['AAA', 'BBB'])
    // The box is a gesture, not state: it disappears with the pointer.
    expect(selectBox()).toBe(null)
  })

  it('tests anchors rather than bounding boxes', async () => {
    // A box that covers the left edge of Alpha but not its anchor selects nothing.
    // Bounding-box intersection would select it, and would also let a box over the
    // Great Lakes select half a dozen US states it does not visibly cover.
    map = await render()
    const anchor = anchorAt(map, 0)
    const release = drag(map, [
      [anchor[0] - 60, anchor[1] - 4],
      [anchor[0] - 20, anchor[1] + 4],
    ])
    release()
    expect(selected()).toEqual([])
  })

  it('replaces the selection, and adds to it with Alt', async () => {
    map = await render()

    let release = drag(map, around([anchorAt(map, 0)]), { shiftKey: true })
    release()
    expect(selected()).toEqual(['AAA'])

    release = drag(map, around([anchorAt(map, 2)]), { shiftKey: true })
    release()
    expect(selected()).toEqual(['CCC'])

    release = drag(map, around([anchorAt(map, 1)]), { shiftKey: true, altKey: true })
    release()
    expect(selected()).toEqual(['BBB', 'CCC'])
  })

  it('clears the selection with a box that catches nothing', async () => {
    map = await render()
    map.setSelection(['AAA'])

    const release = drag(
      map,
      [
        [380, 280],
        [398, 296],
      ],
      { shiftKey: true },
    )
    release()

    // The only obvious way for a reader to undo a selection.
    expect(selected()).toEqual([])
  })

  it('leaves a plain drag to pan', async () => {
    map = await render()
    const before = { ...map.viewport.camera }

    const release = drag(map, [
      [100, 100],
      [160, 130],
    ])
    release()

    expect(selected()).toEqual([])
    expect(selectBox()).toBe(null)
    expect(map.viewport.camera.x).not.toBe(before.x)
  })

  it('does not treat the click that ends a drag as a click on a feature', async () => {
    // The browser fires `click` after a drag that starts and ends on one element,
    // so without suppression panning the map selects whatever is under the release.
    map = await render()
    const clicked = vi.fn()
    map.on('featureClick', clicked)

    const path = el.querySelectorAll('path.apexmaps-feature')[1]
    const release = drag(map, [
      [100, 100],
      [160, 130],
    ])
    release()
    path.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))

    expect(clicked).not.toHaveBeenCalled()
    expect(selected()).toEqual([])

    // The next real click still works: the flag is consumed, not sticky.
    path.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    expect(clicked).toHaveBeenCalledOnce()
    expect(selected()).toEqual(['BBB'])
  })

  it('abandons a box on Escape', async () => {
    map = await render()
    const changed = vi.fn()
    map.on('selectionChange', changed)

    drag(map, around([anchorAt(map, 0)]), { shiftKey: true })
    expect(selectBox()).not.toBe(null)

    el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(selectBox()).toBe(null)
    expect(changed).not.toHaveBeenCalled()
    expect(selected()).toEqual([])
  })

  it('treats a shift-click as a click, not as an empty box', async () => {
    map = await render()
    const plot = map.plot
    plot.dispatchEvent(
      new window.PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 1,
        button: 0,
        clientX: 50,
        clientY: 50,
        shiftKey: true,
      }),
    )
    window.dispatchEvent(
      new window.PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 1,
        clientX: 50,
        clientY: 50,
        shiftKey: true,
      }),
    )

    expect(selectBox()).toBe(null)
    expect(map.zoomPan.shouldSwallowClick()).toBe(false)
  })

  it('honours a configured modifier', async () => {
    map = await render({ interaction: { selection: { modifier: 'meta' } } })

    let release = drag(map, around([anchorAt(map, 0)]), { shiftKey: true })
    release()
    expect(selected()).toEqual([])

    release = drag(map, around([anchorAt(map, 0)]), { metaKey: true })
    release()
    expect(selected()).toEqual(['AAA'])
  })

  it('can be turned off, and is off when only one thing can be selected', async () => {
    map = await render({ interaction: { selection: { rectangle: false } } })
    let release = drag(map, around([anchorAt(map, 0)]), { shiftKey: true })
    release()
    expect(selected()).toEqual([])
    map.destroy()

    map = await render({ interaction: { selection: { multiple: false } } })
    release = drag(map, around([anchorAt(map, 0)]), { shiftKey: true })
    release()
    expect(selected()).toEqual([])
  })

  it("needs pan disabled for modifier 'none', and says so", async () => {
    map = await render({ interaction: { selection: { modifier: 'none' } } })
    let release = drag(map, around([anchorAt(map, 0)]))
    release()
    expect(selected()).toEqual([])
    expect(map.warnings.join('\n')).toContain('pan.enabled: false')
    map.destroy()

    map = await render({
      interaction: { selection: { modifier: 'none' }, pan: { enabled: false } },
    })
    release = drag(map, around([anchorAt(map, 0)]))
    release()
    expect(selected()).toEqual(['AAA'])
  })

  it('selects point marks by their own position, and not the basemap under them', async () => {
    map = await render({
      series: [
        {
          type: 'bubble',
          name: 'Cities',
          data: [
            { name: 'West', lon: -55, lat: 5, value: 10 },
            { name: 'East', lon: 45, lat: 5, value: 20 },
          ],
        },
      ],
    })

    const item = map.series[0].items.find((i) => i.key === 'West')
    const release = drag(map, around([map.viewport.worldToScreen(item.anchor)], 10), {
      shiftKey: true,
    })
    release()

    // 'AAA' is the country the bubble sits on. It is drawn as substrate so the
    // bubbles have a coastline, carries no data, and selecting it could not filter
    // anything, so a box leaves it out.
    expect(selected()).toEqual(['West'])
  })

  it('dims what is not selected, and stops dimming when the selection clears', async () => {
    map = await render()
    const paths = [...el.querySelectorAll('path.apexmaps-feature')]

    map.setSelection(['BBB'])
    expect(paths.map((p) => p.classList.contains('is-muted'))).toEqual([true, false, true])
    expect(paths[1].classList.contains('is-selected')).toBe(true)
    expect(el.style.getPropertyValue('--apexmaps-muted-opacity')).toBe('0.25')

    map.clearSelection()
    expect(paths.some((p) => p.classList.contains('is-muted'))).toBe(false)
  })

  it('does not dim when muting is turned off', async () => {
    map = await render({ states: { muted: { opacity: 1 } } })
    map.setSelection(['BBB'])
    expect(
      [...el.querySelectorAll('path.apexmaps-feature')].some((p) =>
        p.classList.contains('is-muted'),
      ),
    ).toBe(false)
  })
})

describe('linked maps', () => {
  /** A second map in its own container, so both are live at once. */
  async function pair(groupOptions = {}, peerOptions = groupOptions) {
    const second = document.createElement('div')
    document.body.appendChild(second)
    map = await render({ link: { group: 'g1', ...groupOptions } })
    const instance = await render({ link: { group: 'g1', ...peerOptions } }, second)
    extra = { instance, element: second }
    return instance
  }

  it('shares a selection with the other maps in its group', async () => {
    const peer = await pair()
    const heard = vi.fn()
    peer.on('selectionChange', heard)

    map.setSelection(['AAA', 'BBB'])

    expect([...peer.selection].sort()).toEqual(['AAA', 'BBB'])
    expect(heard).toHaveBeenCalledOnce()
    // The payload names the map the selection came from, not the receiver.
    expect(heard.mock.calls[0][0].source).toBe(map.getInstanceId())
  })

  it('dims the peer as well, which is what cross-filtering looks like', async () => {
    await pair()
    map.setSelection(['CCC'])
    const paths = [...extra.element.querySelectorAll('path.apexmaps-feature')]
    expect(paths.map((p) => p.classList.contains('is-muted'))).toEqual([true, true, false])
  })

  it('does not echo back', async () => {
    const peer = await pair()
    const here = vi.fn()
    map.on('selectionChange', here)

    map.setSelection(['AAA'])

    // One local emit. A receiver applying a selection must not rebroadcast it, or
    // a bidirectional pair rings forever.
    expect(here).toHaveBeenCalledOnce()
    expect([...peer.selection]).toEqual(['AAA'])
  })

  it('respects one-way filters', async () => {
    const peer = await pair({ filter: 'receive' }, { filter: 'emit' })

    // The 'receive' map does not emit.
    map.setSelection(['AAA'])
    expect([...peer.selection]).toEqual([])

    // The 'emit' map does.
    peer.setSelection(['BBB'])
    expect([...map.selection]).toEqual(['BBB'])
  })

  it('keeps separate groups separate', async () => {
    const second = document.createElement('div')
    document.body.appendChild(second)
    map = await render({ link: { group: 'left' } })
    const other = await render({ link: { group: 'right' } }, second)
    extra = { instance: other, element: second }

    map.setSelection(['AAA'])
    expect([...other.selection]).toEqual([])
  })

  it('leaves unlinked maps alone', async () => {
    const second = document.createElement('div')
    document.body.appendChild(second)
    map = await render()
    const other = await render({}, second)
    extra = { instance: other, element: second }

    map.setSelection(['AAA'])
    expect([...other.selection]).toEqual([])
  })

  it('is a licensed feature, so it watermarks unlicensed', async () => {
    map = await render()
    expect(el.querySelector('[data-apexcharts-watermark]')).toBe(null)

    await map.updateOptions({ link: { group: 'g1' } })
    // The watermark is the trial state for premium capability, and a link group is
    // the first premium thing shipped. A basic map stays clean.
    expect(el.querySelector('[data-apexcharts-watermark]')).not.toBe(null)
  })
})
