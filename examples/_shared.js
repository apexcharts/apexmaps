/*
 * Shared demo plumbing.
 *
 * Two jobs, and only two. It points the geometry registry at the packs committed
 * to this repository, and it gives every page the same readiness contract so
 * `npm run check:examples` can load all of them and tell whether they actually
 * drew anything. Nothing here is library API: a reader copying a demo should be
 * copying map code, not this file.
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
