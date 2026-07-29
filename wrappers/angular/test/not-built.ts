/**
 * Stands in for `ngx-apexmaps` when the package has not been built.
 *
 * The Angular tests run against the built dist, not the source, because signal
 * inputs, outputs and signal queries are initializer APIs that only exist after
 * the Angular compiler has run: pure JIT over type-stripped source never
 * registers them, so a host template cannot bind `[options]` and a required
 * view query stays empty. ng-packagr's partial-Ivy output JIT-links at runtime
 * through `@angular/compiler`, which is also the artifact a consumer installs.
 *
 * @module not-built
 */
throw new Error(
  'ngx-apexmaps tests exercise the built package. Run `npm run build && npm run build:wrappers` first.',
)
export {}
