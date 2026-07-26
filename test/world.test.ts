// @vitest-environment jsdom
/**
 * Integration test against real geometry.
 *
 * Synthetic fixtures cannot catch the things that actually break a map library:
 * antimeridian-crossing countries (Russia, Fiji), multipolygons, holes, real
 * winding from a real pipeline, and the name spellings that make joins fail.
 * This runs the full stack over Natural Earth 110m via world-atlas (public
 * domain, 177 countries).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { geoArea } from 'd3-geo'
import ApexMaps from '../src/ApexMaps'

// Read straight from the installed package rather than the demo copy under
// examples/, so the suite works on a fresh clone with nothing but `npm install`.
// Resolved from the project root rather than `import.meta.url` because under the
// jsdom environment the module URL is an http: URL, which `fileURLToPath` rejects.
const WORLD = JSON.parse(
  readFileSync(resolve(process.cwd(), 'node_modules/world-atlas/countries-110m.json'), 'utf8'),
)

let el
let map

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
  vi.unstubAllGlobals()
})

/**
 */
async function renderWorld(options = {}) {
  map = new ApexMaps(el, {
    chart: { width: 960, height: 500 },
    geo: { map: WORLD, projection: 'equalEarth' },
    debug: { enabled: false },
    ...options,
  })
  await map.render()
  return map
}

describe('real-world geometry', () => {
  it('renders all 177 Natural Earth countries', async () => {
    await renderWorld()
    expect(map.geo.features).toHaveLength(177)
    expect(el.querySelectorAll('path.apexmaps-feature')).toHaveLength(177)
  })

  it('leaves d3-authored geometry alone and never renders a feature inside-out', async () => {
    await renderWorld()

    // world-atlas is authored for a d3 pipeline, so it is already correctly
    // wound and must pass through untouched. An earlier implementation "repaired"
    // it with a planar shoelace test and inverted Russia and Fiji into covering
    // the entire globe, so this asserts both halves of the contract.
    expect(map.warnings.join(' ')).not.toContain('repaired winding')

    const HEMISPHERE = 2 * Math.PI
    for (const feature of map.geo.features) {
      const area = geoArea({ type: 'Feature', geometry: feature.geometry })
      expect(area, feature.name).toBeLessThan(HEMISPHERE)
    }
  })

  it('keeps antimeridian-crossing countries at their true size', async () => {
    await renderWorld()
    // Russia is about 3.4% of the globe and Fiji is a rounding error. Getting
    // either wound backwards inflates it to nearly 4pi, which is what produced a
    // solid-filled map before the winding check moved to spherical area.
    const areaOf = (name: any) => {
      const f = map.geo.features.find((x: any) => x.name === name)
      return geoArea({ type: 'Feature', geometry: f.geometry }) / (4 * Math.PI)
    }
    expect(areaOf('Russia')).toBeGreaterThan(0.02)
    expect(areaOf('Russia')).toBeLessThan(0.06)
    expect(areaOf('Fiji')).toBeLessThan(0.001)
  })

  it('gives every country a distinct centroid', async () => {
    await renderWorld()
    const anchors = [...map.anchors.values()].map(
      (a: any) => `${Math.round(a.world[0])},${Math.round(a.world[1])}`,
    )
    // The whole-sphere-complement bug manifests as every anchor collapsing onto
    // the container centre, so distinctness is the canary.
    expect(new Set(anchors).size).toBeGreaterThan(170)
  })

  it('keeps every country inside the fitted viewport', async () => {
    await renderWorld()
    for (const [, anchor] of map.anchors) {
      expect(anchor.world[0]).toBeGreaterThanOrEqual(-1)
      expect(anchor.world[0]).toBeLessThanOrEqual(961)
      expect(anchor.world[1]).toBeGreaterThanOrEqual(-1)
      expect(anchor.world[1]).toBeLessThanOrEqual(501)
    }
  })

  it('handles antimeridian-crossing countries without degenerate paths', async () => {
    await renderWorld()
    for (const name of ['Russia', 'Fiji', 'United States of America']) {
      const feature = map.geo.features.find((f: any) => f.name === name)
      expect(feature, name).toBeTruthy()
      const d = el.querySelector(`path[data-index="${feature.index}"]`)?.getAttribute('d')
      expect(d, name).toBeTruthy()
      expect(d.length, name).toBeGreaterThan(50)
      expect(d, name).not.toContain('NaN')
    }
  })

  it('produces no NaN in any rendered path', async () => {
    await renderWorld()
    for (const path of el.querySelectorAll('path.apexmaps-feature')) {
      expect(path.getAttribute('d')).not.toContain('NaN')
    }
  })

  it('joins real data by country name and reports genuine mismatches', async () => {
    await renderWorld({
      series: [
        {
          name: 'Score',
          joinBy: 'name',
          data: [
            { name: 'France', value: 10 },
            { name: 'Germany', value: 20 },
            { name: 'Brazil', value: 30 },
            // The classic failures, in the exact forms published datasets use.
            { name: 'Ivory Coast', value: 40 },
            { name: 'United States', value: 50 },
            { name: 'Democratic Republic of the Congo', value: 60 },
          ],
        },
      ],
    })

    const join = map.diagnoseJoin()
    expect(join.matched).toBe(3)
    expect(join.unmatchedData).toHaveLength(3)

    const byKey = Object.fromEntries(
      join.unmatchedData.map((u: any) => [u.key, u.suggestions.map((s: any) => s.featureKey)]),
    )
    expect(byKey['Ivory Coast']).toContain("Côte d'Ivoire")
    expect(byKey['United States']).toContain('United States of America')
    expect(byKey['Democratic Republic of the Congo']).toContain('Dem. Rep. Congo')
  })

  it('resolves those same names when fuzzy joining is enabled', async () => {
    await renderWorld({
      series: [
        {
          name: 'Score',
          joinBy: 'name',
          fuzzyJoin: true,
          data: [
            { name: 'Ivory Coast', value: 40 },
            { name: 'United States', value: 50 },
            { name: 'Russia', value: 60 },
          ],
        },
      ],
    })

    const join = map.diagnoseJoin()
    expect(join.matched).toBe(3)
    expect(join.applied.length).toBeGreaterThanOrEqual(2)
  })

  it('renders every core projection without producing NaN', async () => {
    for (const projection of [
      'equalEarth',
      'mercator',
      'naturalEarth',
      'orthographic',
      'albers',
      'conicConformal',
      'azimuthalEqualArea',
      'equirectangular',
    ]) {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const instance = new ApexMaps(container, {
        chart: { width: 400, height: 300 },
        geo: { map: WORLD, projection },
        debug: { enabled: false },
      })
      await instance.render()

      const paths = container.querySelectorAll('path.apexmaps-feature')
      expect(paths.length, projection).toBeGreaterThan(0)
      for (const p of paths) expect(p.getAttribute('d'), projection).not.toContain('NaN')

      instance.destroy()
      container.remove()
    }
  })

  it('clips to the visible hemisphere in an orthographic projection', async () => {
    await renderWorld({
      geo: { map: WORLD, projection: { name: 'orthographic', rotate: [0, 0] } },
    })
    // Half the world faces away from the camera, so a good chunk of countries
    // must produce no path at all rather than being smeared across the disc.
    const drawn = el.querySelectorAll('path.apexmaps-feature').length
    expect(drawn).toBeLessThan(177)
    expect(drawn).toBeGreaterThan(40)
  })

  it('places a sensible number of labels on a world map', async () => {
    await renderWorld({ dataLabels: { enabled: true } })
    const placed = el.querySelectorAll('text.apexmaps-label').length
    // Not all 177: the point of collision handling is that crowded Europe and the
    // Caribbean thin out while the large countries keep their labels.
    expect(placed).toBeGreaterThan(15)
    expect(placed).toBeLessThan(120)
    expect(map.labels.droppedCount).toBeGreaterThan(0)

    const texts = [...el.querySelectorAll('text.apexmaps-label')].map((t) => t.textContent)
    for (const big of ['Russia', 'Brazil', 'Canada']) expect(texts).toContain(big)
  })

  it('frames a single country tightly', async () => {
    await renderWorld()
    await map.frameFeature('Germany', { transition: 'jump', padding: 20 })
    expect(map.viewport.camera.k).toBeGreaterThan(8)
  })

  it('frames a country with overseas territories loosely, because its bbox is huge', async () => {
    await renderWorld()
    // Natural Earth's France includes French Guiana and Réunion, so its bounding
    // box spans roughly 110 degrees of longitude. Framing it therefore zooms out,
    // which is correct and is exactly why inset-map support (phase 2) exists.
    await map.frameFeature('France', { transition: 'jump', padding: 20 })
    expect(map.viewport.camera.k).toBeLessThan(5)
  })

  it('survives a projection switch on a full world map', async () => {
    await renderWorld()
    const before = el.querySelector('path.apexmaps-feature')?.getAttribute('d')
    await map.updateOptions({ geo: { projection: 'mercator' } })
    const after = el.querySelector('path.apexmaps-feature')?.getAttribute('d')
    expect(after).not.toBe(before)
    expect(el.querySelectorAll('path.apexmaps-feature')).toHaveLength(177)
  })
})
