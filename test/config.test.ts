import { describe, it, expect } from 'vitest'
import { buildConfig, seriesDefaults } from '../src/core/Config'
import type { Series } from '../src/types'

/**
 * Config defaults and the series classes have to agree.
 *
 * The classes each carry a `config.x ?? default` fallback, but config always wins,
 * so a value set in `seriesDefaults` makes the class's own default unreachable.
 * That is how arcs ended up fully opaque with `?? 0.75` sitting in dead code. These
 * tests pin the resolved values so the two cannot drift apart again.
 */
describe('per-series defaults', () => {
  const resolved = (type: string) => {
    const config = buildConfig({ series: [{ type, data: [] }] } as never)
    return config.series[0] as Series & { opacity?: number; stroke?: { width?: number } }
  }

  it('gives each series type its own opacity', () => {
    expect(resolved('choropleth').opacity).toBe(1)
    expect(resolved('bubble').opacity).toBe(0.85)
    expect(resolved('arc').opacity).toBe(0.75)
    expect(resolved('line').opacity).toBe(0.9)
    expect(resolved('marker').opacity).toBe(0.9)
  })

  it('gives each series type its own stroke', () => {
    expect(resolved('choropleth').stroke?.width).toBe(0.5)
    expect(resolved('bubble').stroke?.width).toBe(1)
    expect(resolved('marker').stroke?.width).toBe(1.5)
    // Arcs and lines are strokes themselves; a second outline is meaningless.
    expect(resolved('arc').stroke).toBeUndefined()
    expect(resolved('line').stroke).toBeUndefined()
  })

  it('still applies the shared defaults', () => {
    const marker = seriesDefaults('marker')
    expect(marker.visible).toBe(true)
    expect(marker.valueField).toBe('value')
    expect(marker.fuzzyJoin).toBe(false)
  })

  it('lets the caller override any of it', () => {
    const config = buildConfig({
      series: [{ type: 'marker', data: [], opacity: 0.2, stroke: { width: 4 } }],
    } as never)
    const series = config.series[0] as { opacity: number; stroke: { width: number } }
    expect(series.opacity).toBe(0.2)
    expect(series.stroke.width).toBe(4)
  })
})
