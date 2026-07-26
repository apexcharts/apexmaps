/**
 * Shared base for Apex visualization products.
 *
 * Mirrors the `BaseChart` shape already present in apexsankey, apextree and
 * apexgantt (`element`, `destroy()`, `getInstanceId()`), because the cross-product
 * bus described in PRODUCT-RESEARCH.md section 6.6 is meant to be implemented
 * **once here** rather than six times. When that lands, registration with the
 * shared instance registry and the `applySelection` / `clearSelection` contract
 * belong on this class.
 *
 * @module core/BaseChart
 */

let counter = 0

export abstract class BaseChart {
  protected element: HTMLElement
  private readonly _instanceId: string

  constructor(element: HTMLElement, instanceId?: string) {
    this.element = element
    this._instanceId =
      instanceId ?? `apexmaps-${++counter}-${Math.floor(globalThis.performance?.now?.() ?? 0)}`
  }

  /**
   * Stable identifier for this instance. Used as the `source` on cross-filter
   * events so a product can ignore echoes of its own selection.
   */
  getInstanceId(): string {
    return this._instanceId
  }

  /**
   * Whether this instance lives inside a shadow root, which changes how styles and
   * global listeners must be attached.
   */
  isShadowDOM(): boolean {
    let node: Node | null = this.element
    while (node) {
      if (typeof ShadowRoot !== 'undefined' && node instanceof ShadowRoot) return true
      node = node.parentNode
    }
    return false
  }

  /** Release resources. Subclasses override and call `super.destroy()` last. */
  destroy(): void {
    // Intentionally minimal: subclasses own their DOM.
  }
}
