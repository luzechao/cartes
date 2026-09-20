/**
 * Colour mapping — the "colour by surface type and by construction" half of Phase 3.
 *
 * Pure data, so it is tested pure. The interesting assertions are the ones about *stability*:
 * a construction's colour must not depend on what other constructions exist, or the whole
 * model changes colour when you add a wall type and it looks like a bug.
 */
import { describe, expect, it } from 'vitest'
import type { Surface } from '../../src/model/index.js'
import {
  constructionColor,
  SURFACE_TYPE_COLORS,
  surfaceCategory,
  type SurfaceCategory,
} from '../../src/render/index.js'

function base(surfaceType: string): Surface {
  return {
    kind: 'base',
    id: 'x',
    name: 'S',
    className: 'BuildingSurface:Detailed',
    classKey: 'buildingsurface:detailed',
    surfaceType,
    constructionName: '',
    zoneName: '',
    spaceName: '',
    outsideBoundaryCondition: '',
    outsideBoundaryConditionObject: '',
    sunExposure: '',
    windExposure: '',
    declaredVertexCount: '',
    vertices: [],
    subSurfaces: [],
    attachedShading: [],
  }
}

function sub(surfaceType: string): Surface {
  return {
    kind: 'sub',
    id: 'x',
    name: 'S',
    className: 'FenestrationSurface:Detailed',
    classKey: 'fenestrationsurface:detailed',
    surfaceType,
    constructionName: '',
    baseSurfaceName: '',
    outsideBoundaryConditionObject: '',
    frameAndDividerName: '',
    multiplier: 1,
    declaredVertexCount: '',
    vertices: [],
    attachedShading: [],
  }
}

function shading(shadingKind: 'site' | 'building' | 'zone'): Surface {
  return {
    kind: 'shading',
    id: 'x',
    name: 'S',
    className: 'Shading:Site:Detailed',
    classKey: 'shading:site:detailed',
    shadingKind,
    baseSurfaceName: '',
    transmittanceScheduleName: '',
    declaredVertexCount: '',
    vertices: [],
  }
}

describe('surfaceCategory', () => {
  /**
   * The corpus writes these in every casing there is — `Wall`, `WALL`, `wall`, `GLASSDOOR`,
   * `GlassDoor`. IDF is case-insensitive, so a case-sensitive lookup would silently paint a
   * whole file magenta.
   */
  it('classifies base surface types whatever the casing', () => {
    for (const [written, expected] of [
      ['Wall', 'wall'],
      ['WALL', 'wall'],
      ['wall', 'wall'],
      ['Floor', 'floor'],
      ['ROOF', 'roof'],
      ['Ceiling', 'ceiling'],
    ] as Array<[string, SurfaceCategory]>) {
      expect(surfaceCategory(base(written)), written).toBe(expected)
    }
  })

  it('classifies sub-surface types, including the GlazedDoor spelling', () => {
    for (const [written, expected] of [
      ['Window', 'window'],
      ['Door', 'door'],
      ['GlassDoor', 'glassdoor'],
      ['GLASSDOOR', 'glassdoor'],
      ['GlazedDoor', 'glassdoor'],
      ['TubularDaylightDome', 'window'],
      ['TubularDaylightDiffuser', 'window'],
    ] as Array<[string, SurfaceCategory]>) {
      expect(surfaceCategory(sub(written)), written).toBe(expected)
    }
  })

  it('gives all three shading kinds one colour', () => {
    for (const kind of ['site', 'building', 'zone'] as const) {
      expect(surfaceCategory(shading(kind)), kind).toBe('shading')
    }
  })

  /**
   * A `Wall` is only a wall on a base surface. Sharing one table across both kinds would let
   * a fenestration typed `Wall` — which EnergyPlus rejects — paint itself as an opaque wall
   * rather than showing up as the anomaly it is.
   */
  it('does not read a base type as a sub type, or the reverse', () => {
    expect(surfaceCategory(sub('Wall'))).toBe('other')
    expect(surfaceCategory(base('Window'))).toBe('other')
  })

  it('falls through to `other` for an unknown or blank type', () => {
    expect(surfaceCategory(base(''))).toBe('other')
    expect(surfaceCategory(base('Bulkhead'))).toBe('other')
  })

  it('has a colour for every category it can return', () => {
    const categories: SurfaceCategory[] = [
      'wall',
      'floor',
      'roof',
      'ceiling',
      'window',
      'glassdoor',
      'door',
      'shading',
      'other',
    ]
    for (const c of categories) expect(typeof SURFACE_TYPE_COLORS[c], c).toBe('number')
  })
})

describe('constructionColor', () => {
  it('is stable for a name and insensitive to case and surrounding space', () => {
    const a = constructionColor('Exterior Wall')
    expect(constructionColor('Exterior Wall')).toBe(a)
    expect(constructionColor('  exterior wall  ')).toBe(a)
    expect(constructionColor('EXTERIOR WALL')).toBe(a)
  })

  /**
   * The reason for hashing the name rather than indexing into a sorted list: adding a
   * construction must not repaint the ones already on screen. A positional scheme passes
   * every other test in this file and fails this one.
   */
  it('does not depend on what other constructions exist', () => {
    const before = ['Roof', 'Slab', 'Wall'].map(constructionColor)
    const after = ['Ceiling', 'Roof', 'Slab', 'Wall', 'Window'].map(constructionColor)
    expect([after[1], after[2], after[3]]).toEqual(before)
  })

  it('spreads a realistic construction list over distinct colours', () => {
    const names = [
      'Exterior Wall',
      'Interior Wall',
      'Exterior Roof',
      'Interior Ceiling',
      'Exterior Floor',
      'Interior Floor',
      'Exterior Window',
      'Interior Window',
      'Exterior Door',
      'Air Wall',
    ]
    expect(new Set(names.map(constructionColor)).size).toBe(names.length)
  })

  it('marks a blank construction with the same magenta as an unknown type', () => {
    expect(constructionColor('')).toBe(SURFACE_TYPE_COLORS.other)
    expect(constructionColor('   ')).toBe(SURFACE_TYPE_COLORS.other)
  })

  /**
   * Mid-range lightness, always. A construction hashing to white is invisible against the
   * background and one hashing to black is invisible against its own edges — either reads as
   * "the surface failed to load".
   */
  it('never lands on a colour that disappears against the background or the edges', () => {
    for (let i = 0; i < 500; i++) {
      const hex = constructionColor(`Construction ${i}`)
      const r = (hex >> 16) & 0xff
      const g = (hex >> 8) & 0xff
      const b = hex & 0xff
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      expect(luma, `Construction ${i}`).toBeGreaterThan(0.15)
      expect(luma, `Construction ${i}`).toBeLessThan(0.9)
    }
  })
})
