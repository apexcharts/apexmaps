/*
 * Shared demo plumbing.
 *
 * Three jobs. It points the geometry registry at the packs committed to this
 * repository, it gives every page the same readiness contract so
 * `npm run check:examples` can load all of them and tell whether they actually
 * drew anything, and it supplies the presentation helpers the gallery leans on:
 * place coordinates, an illustrative field with real spatial structure, and
 * number formatters.
 *
 * Nothing here is library API: a reader copying a demo should be copying map
 * code, not this file.
 *
 * On the illustrative data. The gallery used to paint every choropleth with a
 * hash of the feature name, which is uniform noise: neighbouring countries land
 * in unrelated classes, no region reads as a region, and the result looks like a
 * test fixture because it is one. Real geographic data is spatially
 * autocorrelated, which is exactly what makes a choropleth worth drawing, so
 * `Demo.field()` returns a smooth function of longitude and latitude instead.
 * It is still deterministic, still fake, and every figure using it says
 * "illustrative" in its source line.
 */

/* global ApexMaps */
;(function () {
  // The dataset ships separately from the library, so a demo has to say where its
  // copy lives. Here that is the `geo/` directory of this repository.
  ApexMaps.setGeoSource('../geo/')

  const watched = []
  let resolveReady
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve
  })

  window.__demo = {
    ready: false,
    error: null,
    /** Maps the smoke check should find drawn. */
    maps: watched,
    whenReady: readyPromise,
  }

  const Demo = {
    /**
     * Deterministic pseudo-value for a key.
     *
     * Demos must look identical on every load, or a screenshot diff is noise and a
     * reviewer cannot tell a rendering change from a data change.
     */
    value(key, min = 10, max = 92) {
      // FNV-1a. A plain `h * 33 + char` sum barely moves for a one-character key,
      // so 'A' through 'F' all landed on the same two values and a six-zone map came
      // out nearly monochrome. Avalanche matters even for fake data.
      const text = String(key)
      let h = 2166136261
      for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i)
        h = Math.imul(h, 16777619)
      }
      return Math.round(min + ((h >>> 0) % 10007) / 10007 * (max - min))
    },

    /** `[{ key, value }]` for a list of join keys. */
    rows(keys, options = {}) {
      return keys.map((key) => ({
        key,
        value: Demo.value(key, options.min, options.max),
      }))
    },

    /** Feature names from a committed pack, for demos that want full coverage. */
    async names(file, object) {
      const response = await fetch(`../geo/${file}`)
      if (!response.ok) throw new Error(`HTTP ${response.status} for geo/${file}`)
      const topology = await response.json()
      const name = object ?? Object.keys(topology.objects)[0]
      return topology.objects[name].geometries.map((g) => g.properties.name)
    },

    /**
     * `[{ key, name, lon, lat, props }]` for every feature in a committed pack.
     *
     * The coordinate is the centre of the feature's largest ring rather than a
     * true centroid: it costs one pass over the arcs, it does not need d3-geo in
     * the page, and an island chain cannot drag it into the sea. It exists so a
     * demo can build data that varies over space before the map is constructed,
     * which keeps the copyable snippet a single pass instead of render-then-fill.
     */
    async places(file, object) {
      const response = await fetch(`../geo/${file}`)
      if (!response.ok) throw new Error(`HTTP ${response.status} for geo/${file}`)
      const topology = await response.json()
      const objectName = object ?? Object.keys(topology.objects)[0]
      const collection = topology.objects[objectName]
      const { scale = [1, 1], translate = [0, 0] } = topology.transform ?? {}

      /** Quantized deltas back to lon/lat, plus the ring's bounding box. */
      const ringBox = (indices) => {
        let x0 = Infinity
        let y0 = Infinity
        let x1 = -Infinity
        let y1 = -Infinity
        for (const raw of indices) {
          const arc = topology.arcs[raw < 0 ? ~raw : raw]
          if (!arc) continue
          let x = 0
          let y = 0
          for (const point of arc) {
            x += point[0]
            y += point[1]
            const lon = x * scale[0] + translate[0]
            const lat = y * scale[1] + translate[1]
            if (lon < x0) x0 = lon
            if (lon > x1) x1 = lon
            if (lat < y0) y0 = lat
            if (lat > y1) y1 = lat
          }
        }
        return [x0, y0, x1, y1]
      }

      /** Every ring in a geometry, whatever its nesting depth. */
      const rings = (arcs, out = []) => {
        if (!Array.isArray(arcs)) return out
        if (typeof arcs[0] === 'number') out.push(arcs)
        else for (const child of arcs) rings(child, out)
        return out
      }

      return collection.geometries.map((geometry) => {
        let best = null
        let bestArea = -1
        for (const ring of rings(geometry.arcs)) {
          const box = ringBox(ring)
          const area = (box[2] - box[0]) * (box[3] - box[1])
          if (area > bestArea) {
            bestArea = area
            best = box
          }
        }
        const props = geometry.properties ?? {}
        return {
          key: geometry.id ?? props.iso_a3 ?? props.name,
          name: props.name,
          lon: best ? (best[0] + best[2]) / 2 : 0,
          lat: best ? (best[1] + best[3]) / 2 : 0,
          props,
        }
      })
    },

    /**
     * A deterministic illustrative value that varies smoothly over the globe.
     *
     * Three sinusoids at different wavelengths, plus a little hash jitter so
     * neighbours are similar without being identical. That is the signature of
     * nearly every real geographic variable: regions, gradients, and a couple of
     * outliers. It is not data, and no figure using it claims otherwise.
     */
    field(place, options = {}) {
      const { min = 8, max = 96, phase = 0, jitter = 0.06 } = options
      const x = ((place.lon ?? 0) * Math.PI) / 180
      const y = ((place.lat ?? 0) * Math.PI) / 180
      const wave =
        0.54 * Math.sin(1.15 * x + 0.4 + phase) * Math.cos(1.55 * y - 0.25) +
        0.29 * Math.sin(2.7 * x - 1.1 + phase * 1.7) * Math.cos(0.95 * y + 0.8) +
        0.17 * Math.cos(3.9 * y + 0.3 - phase)
      // Gain before clamping. The raw sum of three sinusoids almost never
      // reaches its own bounds, so without it every value lands in the middle
      // third and the extreme classes of the legend go unused.
      const unit = Math.min(1, Math.max(0, (wave * 1.85 + 1) / 2))
      const noise = (Demo.value(place.key ?? place.name ?? '', 0, 1000) / 1000 - 0.5) * jitter
      const value = min + Math.min(1, Math.max(0, unit + noise)) * (max - min)
      return Math.round(value * 10) / 10
    },

    /** Number formatting, so no figure ships a raw float. */
    fmt: {
      compact: (value) =>
        new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(
          value,
        ),
      int: (value) => new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(value),
      one: (value) => new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value),
      pct: (value) => `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value)}%`,
    },

    /**
     * `[west, south, east, north]` for a world map without Antarctica.
     *
     * Every publication crops it: it is 6% of the frame's information and 18% of
     * its height, it is never in the data, and leaving it in pushes the populated
     * world into the top two thirds of the figure. One line, and the map suddenly
     * fills its frame.
     */
    INHABITED: [-180, -58, 180, 84],

    /** Track a map so the smoke check can assert it rendered marks. */
    watch(name, map) {
      watched.push({ name, map })
      return map
    },

    /**
     * Declare the page finished. Pass the promise the demo is waiting on; the
     * smoke check waits for this rather than for a fixed timeout, so a slow pack
     * load cannot be mistaken for a broken demo.
     */
    ready(promise) {
      Promise.resolve(promise)
        .then(() => {
          window.__demo.ready = true
          resolveReady(true)
        })
        .catch((error) => Demo.fail(error))
      return promise
    },

    /** Show a failure where a reader will see it, and record it for the check. */
    fail(error) {
      const message = error && error.stack ? error.stack : String(error)
      window.__demo.error = message
      window.__demo.ready = true
      resolveReady(false)
      const banner = document.createElement('div')
      banner.className = 'demo-error'
      banner.textContent = `This demo failed: ${message}\n\nServe the repository over HTTP (npm run examples) and build first (npm run build).`
      document.body.insertBefore(banner, document.body.firstChild)
    },
  }

  window.Demo = Demo
  window.addEventListener('error', (event) => {
    if (!window.__demo.error) Demo.fail(event.error ?? event.message)
  })
})()
