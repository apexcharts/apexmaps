/**
 * Ambient declarations.
 *
 * The CSS shim exists because `src/ApexMaps.js` imports its stylesheet as a
 * side effect; the rollup `css-inline` plugin turns that import into an injected
 * <style> tag at build time, but `tsc` still needs to know the module resolves.
 */
declare module '*.css' {
  const content: string
  export default content
}

declare module 'apex-commons' {
  export class LicenseManager {
    static setLicense(key: string): void
    static isLicenseValid(): boolean
    static getLicenseStatus(): {
      readonly valid: boolean
      readonly expired: boolean
      readonly message?: string
      readonly data?: Record<string, unknown>
    }
  }

  export class Watermark {
    static add(container: HTMLElement): void
    static remove(container: HTMLElement): void
    static exists(container: HTMLElement): boolean
  }
}
