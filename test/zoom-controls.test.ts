// @vitest-environment jsdom
/**
 * On-screen zoom controls.
 *
 * The bugs this exists to prevent, in order of how badly they read: a map whose
 * only way to change scale is a gesture (no keyboard path at all), a `+` that
 * still looks live at maximum scale, and a press on the buttons that the plot
 * underneath also hears as the start of a pan.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import ApexMaps from '../src/ApexMaps'

const GEO = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { iso_a3: 'AAA', name: 'Alpha' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-10, -10],
            [10, -10],
            [10, 10],
            [-10, 10],
            [-10, -10],
          ],
        ],
      },
    },
  ],
}

let el: HTMLElement
let map: any

async function build(options: Record<string, unknown> = {}) {
  map = new ApexMaps(el, {
    chart: { width: 400, height: 300 },
    geo: { map: GEO },
    series: [{ type: 'choropleth', data: [{ key: 'AAA', value: 1 }] }],
    ...options,
  })
  await map.render()
  return map
}

const group = () => el.querySelector('.apexmaps-zoom')
const buttons = () =>
  [...el.querySelectorAll('.apexmaps-zoom-button')] as unknown as HTMLButtonElement[]
const button = (label: string) =>
  el.querySelector(`.apexmaps-zoom-button[aria-label="${label}"]`) as HTMLButtonElement | null

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
  map = null
  el.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('zoom controls', () => {
  it('renders zoom in, zoom out and reset by default, as real buttons', async () => {
    await build()
    expect(group()).toBeTruthy()
    expect(buttons().map((b) => b.getAttribute('aria-label'))).toEqual([
      'Zoom in',
      'Zoom out',
      'Reset view',
    ])
    // Announced as controls, not as decoration: a `<div>` with a click handler is
    // invisible to a keyboard and to a screen reader.
    for (const b of buttons()) expect(b.tagName).toBe('BUTTON')
    expect(group()!.getAttribute('role')).toBe('group')
  })

  it('sits over the plot, not in the container flow', async () => {
    await build()
    // Inside the plot, whose corners are the map's corners. In the container it
    // would push the legend around and claim a row of layout.
    expect(group()!.parentElement).toBe(map.plot)
  })

  it('takes the configured corner', async () => {
    await build({ interaction: { zoom: { controls: { position: 'bottom-left' } } } })
    expect(group()!.classList.contains('apexmaps-zoom--bottom-left')).toBe(true)
  })

  it('omits reset when asked', async () => {
    await build({ interaction: { zoom: { controls: { reset: false } } } })
    expect(button('Reset view')).toBeNull()
    expect(buttons()).toHaveLength(2)
  })

  it('renders nothing when controls are off', async () => {
    await build({ interaction: { zoom: { controls: false } } })
    expect(group()).toBeNull()
  })

  it('renders nothing when the map does not zoom', async () => {
    // Controls on a map that cannot zoom would be the same lie as an enabled `+`
    // at maximum scale.
    await build({ interaction: { zoom: { enabled: false } } })
    expect(group()).toBeNull()
  })

  it('appears and disappears on updateOptions', async () => {
    await build()
    await map.updateOptions({ interaction: { zoom: { controls: false } } })
    expect(group()).toBeNull()
    await map.updateOptions({ interaction: { zoom: { controls: true } } })
    expect(group()).toBeTruthy()
  })

  it('steps the camera in by the configured factor, about the plot centre', async () => {
    await build({ interaction: { zoom: { step: 2 } } })
    const ease = vi.spyOn(map.camera, 'easeTo')

    button('Zoom in')!.click()

    expect(ease).toHaveBeenCalledTimes(1)
    expect(ease.mock.calls[0][0].k).toBeCloseTo(2, 6)
    // Anchored at the centre, so the geography there stays there: a button press
    // has no position on the map, and anchoring at the corner it sits in would drag
    // the map towards it.
    const { x, y } = ease.mock.calls[0][0]
    expect(x).toBeCloseTo(-200, 6)
    expect(y).toBeCloseTo(-150, 6)
    // Nothing has moved yet: the step is animated rather than a teleport.
    expect(map.camera.state.k).toBe(1)
  })

  it('steps out by the reciprocal', async () => {
    await build({ interaction: { zoom: { step: 2, min: 0.1 } } })
    const ease = vi.spyOn(map.camera, 'easeTo')
    button('Zoom out')!.click()
    expect(ease.mock.calls[0][0].k).toBeCloseTo(0.5, 6)
  })

  it('emits zoom, so a host hears a button press as it hears a wheel', async () => {
    await build()
    const seen: number[] = []
    map.on('zoom', (p: { k: number }) => seen.push(p.k))
    map.zoomIn()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeGreaterThan(1)
  })

  it('disables each control at its end of the range', async () => {
    await build({ interaction: { zoom: { min: 0.5, max: 4 } } })
    expect(button('Zoom in')!.disabled).toBe(false)
    expect(button('Zoom out')!.disabled).toBe(false)

    map.camera.set({ k: 4 })
    expect(button('Zoom in')!.disabled).toBe(true)
    expect(button('Zoom out')!.disabled).toBe(false)

    map.camera.set({ k: 0.5 })
    expect(button('Zoom in')!.disabled).toBe(false)
    expect(button('Zoom out')!.disabled).toBe(true)
  })

  it('offers reset only once there is something to undo', async () => {
    await build()
    expect(button('Reset view')!.disabled).toBe(true)
    map.camera.panBy(40, 0)
    expect(button('Reset view')!.disabled).toBe(false)
  })

  it('does not let a press on the buttons reach the plot as a gesture', async () => {
    await build()
    const plot = map.plot as HTMLElement
    const heard: string[] = []
    plot.addEventListener('pointerdown', () => heard.push('pointerdown'))
    plot.addEventListener('dblclick', () => heard.push('dblclick'))

    button('Zoom in')!.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true }),
    )
    button('Zoom in')!.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
    )

    // Otherwise a press starts a pan, and a double-press zooms twice: once by the
    // button and once by ZoomPan's double-click, on whatever is under the corner.
    expect(heard).toEqual([])
  })

  it('zooms from the keyboard whether or not the buttons are rendered', async () => {
    await build({ interaction: { zoom: { controls: false, step: 2, min: 0.1 } } })
    const ease = vi.spyOn(map.camera, 'easeTo')
    const svg = map.renderer.root as SVGElement

    svg.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }))
    expect(ease.mock.calls[0][0].k).toBeCloseTo(2, 6)

    // The unshifted keys the reader actually has under a finger.
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true }))
    expect(ease.mock.calls[1][0].k).toBeCloseTo(0.5, 6)
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: '=', bubbles: true }))
    expect(ease.mock.calls[2][0].k).toBeCloseTo(2, 6)
  })

  it('leaves the zoom keys alone on a map that does not zoom', async () => {
    await build({ interaction: { zoom: { enabled: false } } })
    const ease = vi.spyOn(map.camera, 'easeTo')
    map.renderer.root.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }))
    expect(ease).not.toHaveBeenCalled()
  })

  it('leaves the zoom keys to host content inside the container', async () => {
    await build()
    const input = document.createElement('input')
    el.appendChild(input)
    const ease = vi.spyOn(map.camera, 'easeTo')

    // A `-` typed into a host's own field is a character, not a gesture, and the
    // keydown listener is on the whole container.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true }))
    expect(ease).not.toHaveBeenCalled()
  })

  it('is taken down with the map', async () => {
    await build()
    map.destroy()
    expect(group()).toBeNull()
  })
})
