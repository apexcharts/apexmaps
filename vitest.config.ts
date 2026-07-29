/**
 * Vitest configuration.
 *
 * The suite ran on Vitest's defaults until the framework wrappers arrived, and it
 * still would if not for one thing: a wrapper imports `apexmaps` the way a
 * consumer does, by package name. Through the workspace symlink that resolves to
 * this package's `exports`, which point at `dist/`, so wrapper tests would only
 * pass after a build and would silently test the *previous* build if one was
 * stale. Aliasing the bare specifier to source means `npm test` needs no build
 * step and a wrapper is always tested against the core in the working tree.
 *
 * The alias is anchored so it cannot swallow subpath imports like
 * `apexmaps/apexmaps.css`, which must keep resolving through the package.
 */
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^apexmaps$/,
        replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      },
    ],
  },
})
