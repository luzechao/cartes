import { describe, expect, it } from 'vitest'
import {
  GEOMETRY_CLASSES,
  IDD_TABLE,
  IDD_VERSIONS,
  type IddClass,
} from '../src/parser/idd-table.generated.js'

/**
 * Guards on the table emitted by scripts/preprocess-idd.ts.
 *
 * These are not tests of the IDD (which is upstream data) but of our *reading* of it —
 * the compression, the version keying, and the domain facts the geometry layer will
 * depend on. If a future EnergyPlus release breaks one of these, that is exactly the
 * signal we want before the geometry code silently mis-indexes a field.
 */

function shapeAt(classKey: string, version: string): IddClass {
  const entry = IDD_TABLE[classKey]
  if (!entry) throw new Error(`class ${classKey} missing from table`)
  const idx = entry.byVersion[version]
  if (idx === undefined) throw new Error(`class ${classKey} absent in version ${version}`)
  return entry.shapes[idx]!
}

const LATEST = IDD_VERSIONS[IDD_VERSIONS.length - 1]!

describe('IDD table coverage', () => {
  it('spans the target version range', () => {
    expect(IDD_VERSIONS[0]).toBe('7.2')
    expect(IDD_VERSIONS.length).toBeGreaterThanOrEqual(27)
  })

  it('includes the classes that live outside the geometry group', () => {
    for (const k of ['version', 'building', 'construction']) {
      expect(IDD_TABLE[k], k).toBeDefined()
    }
  })

  it('covers every class the editor renders', () => {
    const required = [
      'zone',
      'buildingsurface:detailed',
      'fenestrationsurface:detailed',
      'shading:site:detailed',
      'shading:building:detailed',
      'shading:zone:detailed',
      'globalgeometryrules',
      'internalmass',
    ]
    for (const k of required) expect(GEOMETRY_CLASSES, k).toContain(k)
  })

  it('resolves every class in every covered version', () => {
    const gaps: string[] = []
    for (const [k, entry] of Object.entries(IDD_TABLE)) {
      for (const v of IDD_VERSIONS) {
        const idx = entry.byVersion[v]
        if (idx === undefined) continue // legitimately absent (e.g. Space before 9.6)
        if (entry.shapes[idx] === undefined) gaps.push(`${k}@${v}`)
      }
    }
    expect(gaps).toEqual([])
  })

  it('never emits an unnamed field', () => {
    const unnamed: string[] = []
    for (const [k, entry] of Object.entries(IDD_TABLE)) {
      entry.shapes.forEach((s, i) => {
        s.fields.forEach((f, j) => {
          if (f.name.trim() === '') unnamed.push(`${k} shape${i} field${j}`)
        })
      })
    }
    expect(unnamed).toEqual([])
  })
})

describe('extensible truncation', () => {
  it('collapses BuildingSurface:Detailed from 368 spelled-out fields to a head plus one group', () => {
    const s = shapeAt('buildingsurface:detailed', LATEST)
    expect(s.extensible).toEqual({ stride: 3, beginIndex: 11 })
    // Head (11) + exactly one vertex triple.
    expect(s.fields).toHaveLength(14)
    expect(s.fields.at(-3)!.name).toBe('Vertex 1 X-coordinate')
    expect(s.fields.at(-1)!.name).toBe('Vertex 1 Z-coordinate')
  })

  it('marks every detailed surface class as extensible with stride 3', () => {
    for (const k of [
      'buildingsurface:detailed',
      'wall:detailed',
      'roofceiling:detailed',
      'floor:detailed',
      'shading:site:detailed',
      'shading:building:detailed',
      'shading:zone:detailed',
    ]) {
      expect(shapeAt(k, LATEST).extensible?.stride, k).toBe(3)
    }
  })

  it('leaves FenestrationSurface:Detailed non-extensible — windows cap at 4 vertices', () => {
    // Verified against the IDD: no \extensible marker, last slot is `N15; Vertex 4 Z-coordinate`.
    // The geometry layer must reject sub-surfaces with more than 4 vertices rather than
    // assuming it can extend them like a base surface.
    const s = shapeAt('fenestrationsurface:detailed', LATEST)
    expect(s.extensible).toBeUndefined()
    expect(s.fields.at(-1)!.name).toBe('Vertex 4 Z-coordinate')
  })
})

describe('version-dependent field indices', () => {
  it('captures the 9.6 Space Name insertion that shifts every later field', () => {
    // This is the concrete bug a hardcoded index table would produce: reading
    // "Outside Boundary Condition" at index 4 silently yields the space name on 9.6+.
    const before = shapeAt('buildingsurface:detailed', '9.5')
    const after = shapeAt('buildingsurface:detailed', '9.6')

    expect(before.fields.findIndex((f) => f.name === 'Space Name')).toBe(-1)
    expect(after.fields.findIndex((f) => f.name === 'Space Name')).toBe(4)

    expect(before.fields.findIndex((f) => f.name === 'Outside Boundary Condition')).toBe(4)
    expect(after.fields.findIndex((f) => f.name === 'Outside Boundary Condition')).toBe(5)

    // Zone Name is ahead of the insertion, so it does not move.
    expect(before.fields.findIndex((f) => f.name === 'Zone Name')).toBe(3)
    expect(after.fields.findIndex((f) => f.name === 'Zone Name')).toBe(3)
  })

  it('keeps the extensible boundary in step with the insertion', () => {
    expect(shapeAt('buildingsurface:detailed', '9.5').extensible!.beginIndex).toBe(10)
    expect(shapeAt('buildingsurface:detailed', '9.6').extensible!.beginIndex).toBe(11)
  })
})

describe('GlobalGeometryRules — the class EPShape omits', () => {
  const s = shapeAt('globalgeometryrules', LATEST)

  it('has five fields', () => {
    expect(s.fields.map((f) => f.name)).toEqual([
      'Starting Vertex Position',
      'Vertex Entry Direction',
      'Coordinate System',
      'Daylighting Reference Point Coordinate System',
      'Rectangular Surface Coordinate System',
    ])
  })

  it('enumerates the choices the geometry layer must branch on', () => {
    expect(s.fields[0]!.choices).toEqual([
      'UpperLeftCorner',
      'LowerLeftCorner',
      'UpperRightCorner',
      'LowerRightCorner',
    ])
    expect(s.fields[1]!.choices).toEqual(['Counterclockwise', 'Clockwise'])
    expect(s.fields[2]!.choices).toEqual(['Relative', 'World'])
  })

  it('marks the three leading fields as required, with no defaults to fall back on', () => {
    for (const i of [0, 1, 2]) {
      expect(s.fields[i]!.required, s.fields[i]!.name).toBe(true)
      expect(s.fields[i]!.default, s.fields[i]!.name).toBeUndefined()
    }
    // The trailing two do default, so a 3-field GlobalGeometryRules is legal.
    expect(s.fields[3]!.default).toBe('Relative')
    expect(s.fields[4]!.default).toBe('Relative')
  })

  it('has been stable across the whole covered range', () => {
    const names = (v: string): string[] => shapeAt('globalgeometryrules', v).fields.map((f) => f.name)
    for (const v of IDD_VERSIONS) expect(names(v).slice(0, 3), v).toEqual(names(LATEST).slice(0, 3))
  })
})

describe('Zone — origin and rotation drive relative-coordinate resolution', () => {
  const s = shapeAt('zone', LATEST)

  it('exposes origin and north-axis at the expected indices', () => {
    expect(s.fields[0]!.name).toBe('Name')
    expect(s.fields[1]!.name).toBe('Direction of Relative North')
    expect(s.fields[2]!.name).toBe('X Origin')
    expect(s.fields[3]!.name).toBe('Y Origin')
    expect(s.fields[4]!.name).toBe('Z Origin')
  })

  it('holds those indices across every covered version', () => {
    for (const v of IDD_VERSIONS) {
      const f = shapeAt('zone', v).fields
      expect(f.slice(0, 5).map((x) => x.name), v).toEqual([
        'Name',
        'Direction of Relative North',
        'X Origin',
        'Y Origin',
        'Z Origin',
      ])
    }
  })
})
