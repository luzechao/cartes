/**
 * Diff engine and Phase 5 Gate tests — docs/05-implementation-plan.md.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseIdf, emitIdf } from '../src/parser/index.js'
import { buildModel, setFieldValue, revertObject, getDirtyObjects, type BuildingSurface } from '../src/model/index.js'
import { computeLineDiff } from '../src/diff/index.js'

describe('line diff engine', () => {
  it('reports zero differences for identical text', () => {
    const text = 'Line 1\nLine 2\nLine 3\n'
    const diff = computeLineDiff(text, text)
    expect(diff.addedLines).toBe(0)
    expect(diff.deletedLines).toBe(0)
    expect(diff.hunks).toHaveLength(0)
  })

  it('accurately identifies edited lines with line numbers and context', () => {
    const oldText = 'A\nB\nC\nD\nE\n'
    const newText = 'A\nB\nMODIFIED\nD\nE\n'
    const diff = computeLineDiff(oldText, newText, 1)

    expect(diff.addedLines).toBe(1)
    expect(diff.deletedLines).toBe(1)
    expect(diff.hunks).toHaveLength(1)
    const hunk = diff.hunks[0]!
    expect(hunk.lines.some((l) => l.type === 'del' && l.content === 'C')).toBe(true)
    expect(hunk.lines.some((l) => l.type === 'add' && l.content === 'MODIFIED')).toBe(true)
  })
})

describe('editing and revert', () => {
  const SOURCE = `
Version, 26.1;
Zone, ZONE_1, 0, 0, 0, 0, 1, 1;
BuildingSurface:Detailed,
    WALL_1,                  !- Name
    Wall,                    !- Surface Type
    OLD_CONSTRUCTION,        !- Construction Name
    ZONE_1,                  !- Zone Name
    Outdoors,                !- Outside Boundary Condition
    ,                        !- Outside Boundary Condition Object
    SunExposed,              !- Sun Exposure
    WindExposed,             !- Wind Exposure
    0.5,                     !- View Factor to Ground
    4,                       !- Number of Vertices
    0, 0, 3,
    0, 0, 0,
    4, 0, 0,
    4, 0, 3;
`

  it('fills a blank field on its own line, not inside the previous field’s comment', () => {
    // Regression: an empty field's span used to start at the end of the preceding comment, so
    // the value was written into `!- Outside Boundary Condition` and the field stayed blank.
    const doc = parseIdf(SOURCE)
    const model = buildModel(doc)
    const wall = [...doc.objects.values()].find((o) => o.className === 'BuildingSurface:Detailed')!
    const obcObject = 5
    expect(wall.fields[obcObject]!.value).toBe('')
    setFieldValue(doc, model, wall.id, obcObject, 'WALL_2')

    const emitted = emitIdf(doc)
    const diff = computeLineDiff(SOURCE, emitted)
    expect(diff.addedLines).toBe(1)
    expect(diff.deletedLines).toBe(1)
    expect(emitted).toContain('    Outdoors,                !- Outside Boundary Condition\n')
    expect(emitted).toContain('    WALL_2,                        !- Outside Boundary Condition Object\n')
    const reparsed = [...parseIdf(emitted).objects.values()].find((o) => o.className === 'BuildingSurface:Detailed')!
    expect(reparsed.fields[obcObject]!.value).toBe('WALL_2')
    expect(reparsed.fields[obcObject - 1]!.comment).toBe('- Outside Boundary Condition')
  })

  it('updates a field, marks object dirty, and updates model', () => {
    const doc = parseIdf(SOURCE)
    const model = buildModel(doc)

    const wallId = doc.byClass.get('buildingsurface:detailed')![0]!
    const changed = setFieldValue(doc, model, wallId, 2, 'NEW_CONSTRUCTION')

    expect(changed).toBe(true)
    expect(getDirtyObjects(doc)).toHaveLength(1)
    expect((model.surfaces.get(wallId) as BuildingSurface)?.constructionName).toBe('NEW_CONSTRUCTION')

    const emitted = emitIdf(doc)
    expect(emitted).toContain('NEW_CONSTRUCTION')
    expect(emitted).not.toContain('OLD_CONSTRUCTION')
  })

  it('reverts a modified object back to original', () => {
    const doc = parseIdf(SOURCE)
    const model = buildModel(doc)

    const wallId = doc.byClass.get('buildingsurface:detailed')![0]!
    setFieldValue(doc, model, wallId, 2, 'NEW_CONSTRUCTION')
    expect(getDirtyObjects(doc)).toHaveLength(1)

    const reverted = revertObject(doc, model, wallId)
    expect(reverted).toBe(true)
    expect(getDirtyObjects(doc)).toHaveLength(0)
    expect((model.surfaces.get(wallId) as BuildingSurface)?.constructionName).toBe('OLD_CONSTRUCTION')

    const emitted = emitIdf(doc)
    expect(emitted).toBe(SOURCE)
  })
})

describe('PHASE 5 GATE — Surgical single-object diff fidelity', () => {
  /**
   * PHASE 5 GATE (docs/05-implementation-plan.md)
   *
   *   Edit a construction name -> save -> diff against original shows exactly one changed
   *   object, and that object's non-edited fields are textually unchanged.
   */
  it('fulfills the gate on an actual EnergyPlus corpus file', () => {
    const fixturePath = join(
      import.meta.dirname,
      'fixtures',
      'testfiles',
      'ZoneCoupledKivaBasement.idf',
    )
    const originalText = readFileSync(fixturePath, 'utf8')
    const doc = parseIdf(originalText)
    const model = buildModel(doc)

    // Pick first surface
    const surfaceId = doc.byClass.get('buildingsurface:detailed')![0]!
    const surfaceObj = doc.objects.get(surfaceId)!
    const originalConstruction = surfaceObj.fields[2]!.value

    // Edit construction name
    const NEW_NAME = 'CUSTOM_R20_INSULATION'
    setFieldValue(doc, model, surfaceId, 2, NEW_NAME)

    // Only this object is dirty
    const dirty = getDirtyObjects(doc)
    expect(dirty).toHaveLength(1)
    expect(dirty[0]!.id).toBe(surfaceId)

    // Emit back to text
    const emitted = emitIdf(doc)

    // Compute diff
    const diff = computeLineDiff(originalText, emitted, 2)

    // Diff shows exactly one changed line (+1, -1)
    expect(diff.addedLines).toBe(1)
    expect(diff.deletedLines).toBe(1)

    // The single changed hunk contains only the construction name change
    const hunk = diff.hunks[0]!
    const delLine = hunk.lines.find((l) => l.type === 'del')!
    const addLine = hunk.lines.find((l) => l.type === 'add')!

    expect(delLine.content).toContain(originalConstruction)
    expect(addLine.content).toContain(NEW_NAME)

    // Every other field in this object is unchanged in indentation and comment
    const originalSlice = originalText.slice(surfaceObj.start!, surfaceObj.end!)
    const origLines = originalSlice.split(/\r?\n/)

    for (let i = 0; i < origLines.length; i++) {
      if (i === 3) {
        // Field 2 (Construction Name) is on line index 3 (0=className, 1=Name, 2=Type, 3=Construction)
        continue
      }
      const line = origLines[i]!.trimEnd()
      if (line) {
        expect(emitted).toContain(line)
      }
    }
  })
})
