/**
 * Validation engine tests — Phase 4 of docs/05-implementation-plan.md.
 *
 * Verifies every rule from docs/03-idf-geometry.md §Validation on isolated, synthetic
 * models before running the corpus gate.
 */
import { describe, expect, it } from 'vitest'
import { parseIdf } from '../../src/parser/index.js'
import { buildModel } from '../../src/model/index.js'
import { resolveModel } from '../../src/geometry/resolve.js'
import { validateModel, type ValidationReport } from '../../src/geometry/validate.js'

function validate(source: string): ValidationReport {
  const doc = parseIdf(source)
  const model = buildModel(doc)
  const resolved = resolveModel(model)
  return validateModel(model, resolved, doc)
}

describe('surface degeneracy and planarity', () => {
  it('flags surfaces with fewer than 3 vertices', () => {
    const report = validate(`
Version, 26.1;
GlobalGeometryRules, UpperLeftCorner, Counterclockwise, World;
Zone, Z1, 0, 0, 0, 0, 1, 1;
BuildingSurface:Detailed, S1, Wall, Brick, Z1, , Outdoors, , SunExposed, WindExposed, , 2,
  0, 0, 0,
  4, 0, 0;
`)
    expect(report.issues.some((i) => i.code === 'surface-degenerate')).toBe(true)
    expect(report.errorCount).toBeGreaterThan(0)
  })

  it('flags consecutive duplicate vertices', () => {
    const report = validate(`
Version, 26.1;
GlobalGeometryRules, UpperLeftCorner, Counterclockwise, World;
Zone, Z1, 0, 0, 0, 0, 1, 1;
BuildingSurface:Detailed, S1, Wall, Brick, Z1, , Outdoors, , SunExposed, WindExposed, , 4,
  0, 0, 3,
  0, 0, 0,
  0, 0, 0,
  4, 0, 3;
`)
    const dup = report.issues.find((i) => i.code === 'surface-duplicate-vertices')
    expect(dup).toBeDefined()
    expect(dup?.severity).toBe('error')
    expect(dup?.fixDescription).toBeDefined()
  })

  it('flags non-planar surfaces exceeding tolerance', () => {
    // A warped quad where one corner is pushed 5 cm out of plane
    const report = validate(`
Version, 26.1;
GlobalGeometryRules, UpperLeftCorner, Counterclockwise, World;
Zone, Z1, 0, 0, 0, 0, 1, 1;
BuildingSurface:Detailed, S1, Wall, Brick, Z1, , Outdoors, , SunExposed, WindExposed, , 4,
  0, 0, 3,
  0, 0, 0,
  4, 0, 0,
  4, 0.05, 3;
`)
    const nonPlanar = report.issues.find((i) => i.code === 'surface-non-planar')
    expect(nonPlanar).toBeDefined()
    expect(nonPlanar?.severity).toBe('error')
  })

  it('passes a perfectly planar surface', () => {
    const report = validate(`
Version, 26.1;
GlobalGeometryRules, UpperLeftCorner, Counterclockwise, World;
Zone, Z1, 0, 0, 0, 0, 1, 1;
BuildingSurface:Detailed, S1, Wall, Brick, Z1, , Outdoors, , SunExposed, WindExposed, , 4,
  0, 0, 3,
  0, 0, 0,
  4, 0, 0,
  4, 0, 3;
`)
    expect(report.issues.some((i) => i.code === 'surface-non-planar')).toBe(false)
  })

  it('flags self-intersecting polygons (bowtie quad)', () => {
    // Bowtie quad: vertices cross diagonally
    const report = validate(`
Version, 26.1;
GlobalGeometryRules, UpperLeftCorner, Counterclockwise, World;
Zone, Z1, 0, 0, 0, 0, 1, 1;
BuildingSurface:Detailed, BOWTIE, Wall, Brick, Z1, , Outdoors, , SunExposed, WindExposed, , 4,
  0, 0, 3,
  4, 0, 0,
  0, 0, 0,
  4, 0, 3;
`)
    const selfInt = report.issues.find((i) => i.code === 'surface-self-intersecting')
    expect(selfInt).toBeDefined()
    expect(selfInt?.severity).toBe('error')
  })
})

describe('fenestration rules', () => {
  const BASE_WALL = `
Version, 26.1;
GlobalGeometryRules, UpperLeftCorner, Counterclockwise, World;
Zone, Z1, 0, 0, 0, 0, 1, 1;
BuildingSurface:Detailed, WALL1, Wall, Brick, Z1, , Outdoors, , SunExposed, WindExposed, , 4,
  0, 0, 3,
  0, 0, 0,
  5, 0, 0,
  5, 0, 3;
`

  it('flags fenestration surfaces with more than 4 vertices', () => {
    const report = validate(`
${BASE_WALL}
FenestrationSurface:Detailed, WIN5, Window, Glaz, WALL1, , , , 1, 5,
  1, 0, 2.5,
  1, 0, 0.5,
  2, 0, 0.5,
  3, 0, 1.5,
  3, 0, 2.5;
`)
    const issue = report.issues.find((i) => i.code === 'fenestration-vertex-count')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('error')
  })

  it('passes a 4-vertex window cleanly contained in its host wall', () => {
    const report = validate(`
${BASE_WALL}
FenestrationSurface:Detailed, WIN4, Window, Glaz, WALL1, , , , 1, 4,
  1, 0, 2.5,
  1, 0, 0.5,
  4, 0, 0.5,
  4, 0, 2.5;
`)
    expect(report.issues.filter((i) => i.objectId.includes('WIN4'))).toEqual([])
  })

  it('passes a door that touches the wall boundary / floor edge', () => {
    const report = validate(`
${BASE_WALL}
FenestrationSurface:Detailed, DOOR, Door, Glaz, WALL1, , , , 1, 4,
  1, 0, 2.1,
  1, 0, 0.0,
  2, 0, 0.0,
  2, 0, 2.1;
`)
    expect(report.issues.some((i) => i.code === 'fenestration-not-contained')).toBe(false)
  })

  it('flags a window extending outside its host wall', () => {
    const report = validate(`
${BASE_WALL}
FenestrationSurface:Detailed, WIN_OUT, Window, Glaz, WALL1, , , , 1, 4,
  1, 0, 3.5,
  1, 0, 0.5,
  6, 0, 0.5,
  6, 0, 3.5;
`)
    const issue = report.issues.find((i) => i.code === 'fenestration-not-contained')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('error')
  })

  it('flags tilted non-coplanar windows as errors', () => {
    const report = validate(`
${BASE_WALL}
FenestrationSurface:Detailed, WIN_TILT, Window, Glaz, WALL1, , , , 1, 4,
  1, 0.5, 2.5,
  1, 0, 0.5,
  4, 0, 0.5,
  4, 0.5, 2.5;
`)
    const issue = report.issues.find((i) => i.code === 'fenestration-not-coplanar')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('error')
  })

  it('warns on parallel reveal setbacks rather than failing', () => {
    // Window offset by 15 cm along wall normal
    const report = validate(`
${BASE_WALL}
FenestrationSurface:Detailed, WIN_REVEAL, Window, Glaz, WALL1, , , , 1, 4,
  1, 0.15, 2.5,
  1, 0.15, 0.5,
  4, 0.15, 0.5,
  4, 0.15, 2.5;
`)
    const issue = report.issues.find((i) => i.code === 'fenestration-reveal-setback')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('warning')
    expect(report.issues.some((i) => i.code === 'fenestration-not-coplanar')).toBe(false)
  })
})

describe('surface pairing and boundary conditions', () => {
  it('flags missing Outside Boundary Condition Object', () => {
    const report = validate(`
Version, 26.1;
GlobalGeometryRules, UpperLeftCorner, Counterclockwise, World;
Zone, Z1, 0, 0, 0, 0, 1, 1;
BuildingSurface:Detailed, S1, Wall, Brick, Z1, , Surface, , NoSun, NoWind, , 4,
  0, 0, 3,
  0, 0, 0,
  4, 0, 0,
  4, 0, 3;
`)
    const issue = report.issues.find((i) => i.code === 'boundary-missing-object')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('error')
  })

  it('flags an unresolvable target in Outside Boundary Condition Object', () => {
    const report = validate(`
Version, 26.1;
GlobalGeometryRules, UpperLeftCorner, Counterclockwise, World;
Zone, Z1, 0, 0, 0, 0, 1, 1;
BuildingSurface:Detailed, S1, Wall, Brick, Z1, , Surface, NON_EXISTENT, NoSun, NoWind, , 4,
  0, 0, 3,
  0, 0, 0,
  4, 0, 0,
  4, 0, 3;
`)
    const issue = report.issues.find((i) => i.code === 'boundary-missing-object')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('error')
  })

  it('flags asymmetric surface pairing', () => {
    const report = validate(`
Version, 26.1;
GlobalGeometryRules, UpperLeftCorner, Counterclockwise, World;
Zone, Z1, 0, 0, 0, 0, 1, 1;
Zone, Z2, 0, 0, 0, 0, 1, 1;
BuildingSurface:Detailed, S1, Wall, Brick, Z1, , Surface, S2, NoSun, NoWind, , 4,
  0, 0, 3, 0, 0, 0, 4, 0, 0, 4, 0, 3;
BuildingSurface:Detailed, S2, Wall, Brick, Z2, , Surface, OTHER_SURF, NoSun, NoWind, , 4,
  4, 0, 3, 4, 0, 0, 0, 0, 0, 0, 0, 3;
`)
    const issue = report.issues.find((i) => i.code === 'boundary-asymmetric')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('error')
    expect(issue?.fixDescription).toContain('S1')
  })

  it('flags paired surfaces with mismatched vertex counts', () => {
    const report = validate(`
Version, 26.1;
GlobalGeometryRules, UpperLeftCorner, Counterclockwise, World;
Zone, Z1, 0, 0, 0, 0, 1, 1;
Zone, Z2, 0, 0, 0, 0, 1, 1;
BuildingSurface:Detailed, S1, Wall, Brick, Z1, , Surface, S2, NoSun, NoWind, , 4,
  0, 0, 3, 0, 0, 0, 4, 0, 0, 4, 0, 3;
BuildingSurface:Detailed, S2, Wall, Brick, Z2, , Surface, S1, NoSun, NoWind, , 5,
  4, 0, 3, 4, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 3;
`)
    const issue = report.issues.find((i) => i.code === 'paired-vertex-count-mismatch')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('error')
    expect(issue?.fixDescription).toBeDefined()
  })

  it('warns on paired surfaces with differing constructions', () => {
    const report = validate(`
Version, 26.1;
GlobalGeometryRules, UpperLeftCorner, Counterclockwise, World;
Zone, Z1, 0, 0, 0, 0, 1, 1;
Zone, Z2, 0, 0, 0, 0, 1, 1;
BuildingSurface:Detailed, S1, Wall, Brick_A, Z1, , Surface, S2, NoSun, NoWind, , 4,
  0, 0, 3, 0, 0, 0, 4, 0, 0, 4, 0, 3;
BuildingSurface:Detailed, S2, Wall, Brick_B, Z2, , Surface, S1, NoSun, NoWind, , 4,
  4, 0, 3, 4, 0, 0, 0, 0, 0, 0, 0, 3;
`)
    const issue = report.issues.find((i) => i.code === 'paired-construction-mismatch')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('warning')
  })
})

describe('warnings: exposure, normal orientation, and zones', () => {
  it('warns when SunExposed is set on an interior surface', () => {
    const report = validate(`
Version, 26.1;
GlobalGeometryRules, UpperLeftCorner, Counterclockwise, World;
Zone, Z1, 0, 0, 0, 0, 1, 1;
Zone, Z2, 0, 0, 0, 0, 1, 1;
BuildingSurface:Detailed, S1, Wall, Brick, Z1, , Surface, S2, SunExposed, WindExposed, , 4,
  0, 0, 3, 0, 0, 0, 4, 0, 0, 4, 0, 3;
BuildingSurface:Detailed, S2, Wall, Brick, Z2, , Surface, S1, NoSun, NoWind, , 4,
  4, 0, 3, 4, 0, 0, 0, 0, 0, 0, 0, 3;
`)
    const issue = report.issues.find((i) => i.code === 'exposure-inconsistent')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('warning')
  })

  it('warns when an exterior roof has an inverted downward-facing normal', () => {
    // Counter-clockwise from below -> normal is -Z
    const report = validate(`
Version, 26.1;
GlobalGeometryRules, UpperLeftCorner, Counterclockwise, World;
Zone, Z1, 0, 0, 0, 0, 1, 1;
BuildingSurface:Detailed, ROOF_DOWN, Roof, Brick, Z1, , Outdoors, , SunExposed, WindExposed, , 4,
  0, 0, 3,
  0, 4, 3,
  4, 4, 3,
  4, 0, 3;
`)
    const issue = report.issues.find((i) => i.code === 'surface-inverted-normal')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('warning')
    expect(issue?.fixDescription).toContain('Reverse vertex order')
  })

  it('warns when a zone has walls but no floor surface', () => {
    const report = validate(`
Version, 26.1;
GlobalGeometryRules, UpperLeftCorner, Counterclockwise, World;
Zone, Z_NO_FLOOR, 0, 0, 0, 0, 1, 1;
BuildingSurface:Detailed, W1, Wall, Brick, Z_NO_FLOOR, , Outdoors, , SunExposed, WindExposed, , 4,
  0, 0, 3, 0, 0, 0, 4, 0, 0, 4, 0, 3;
`)
    const issue = report.issues.find((i) => i.code === 'zone-no-floor')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('warning')
  })

  it('flags dangling zone reference on a surface', () => {
    const report = validate(`
Version, 26.1;
GlobalGeometryRules, UpperLeftCorner, Counterclockwise, World;
BuildingSurface:Detailed, W1, Wall, Brick, MISSING_ZONE, , Outdoors, , SunExposed, WindExposed, , 4,
  0, 0, 3, 0, 0, 0, 4, 0, 0, 4, 0, 3;
`)
    const issue = report.issues.find((i) => i.code === 'dangling-reference')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('error')
  })
})
