import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emitIdf, parseIdf, type IdfDocument } from '../../src/parser/index.js'
import {
  applySurfaceDeletion,
  buildModel,
  buildReferenceIndex,
  EditHistory,
  planSurfaceDeletion,
  revertAll,
  setFieldValue,
  type Model,
} from '../../src/model/index.js'
import {
  applyZoneTranslation,
  deleteVertex,
  insertVertexWorld,
  moveVertices,
  planZoneTranslation,
  resolveModel,
  setVertexWorld,
  translateSurface,
} from '../../src/geometry/index.js'

/**
 * Undo and redo at the Document layer.
 *
 * The invariant that matters is textual: after undo, the emitted file is byte-for-byte what it
 * was before the step; after redo, byte-for-byte what it was after. Everything below asserts
 * that, and the corpus pass asserts it across long mixed sequences of every edit Phase 6 has.
 */

const SOURCE = `Version,26.1;
GlobalGeometryRules,UpperLeftCorner,Counterclockwise,World;
Zone,A;
Zone,B;
  BuildingSurface:Detailed,
    A-East,                  !- Name
    Wall,                    !- Surface Type
    C1,                      !- Construction Name
    A,                       !- Zone Name
    ,                        !- Space Name
    Surface,                 !- Outside Boundary Condition
    B-West,                  !- Outside Boundary Condition Object
    NoSun,                   !- Sun Exposure
    NoWind,                  !- Wind Exposure
    0.5,                     !- View Factor to Ground
    4,                       !- Number of Vertices
    4,0,3,  !- X,Y,Z ==> Vertex 1 {m}
    4,0,0,  !- X,Y,Z ==> Vertex 2 {m}
    4,4,0,  !- X,Y,Z ==> Vertex 3 {m}
    4,4,3;  !- X,Y,Z ==> Vertex 4 {m}

  FenestrationSurface:Detailed,
    A-Win,Window,G1,A-East,,0.5,,1,4,
    4,1,2, 4,1,1, 4,3,1, 4,3,2;

  BuildingSurface:Detailed,
    B-West,Wall,C1,B,,Surface,A-East,NoSun,NoWind,0.5,4,
    4,4,3, 4,4,0, 4,0,0, 4,0,3;
`

function setup(text = SOURCE): { doc: IdfDocument; model: Model; history: EditHistory } {
  const doc = parseIdf(text)
  const history = new EditHistory(doc)
  return { doc, model: buildModel(doc), history }
}

function idOf(model: Model, name: string): string {
  for (const [id, s] of model.surfaces) if (s.name === name) return id
  throw new Error(`no surface ${name}`)
}

describe('EditHistory', () => {
  it('undoes and redoes a field edit exactly', () => {
    const { doc, model, history } = setup()
    setFieldValue(doc, model, idOf(model, 'A-East'), 2, 'C2')
    const edited = emitIdf(doc)
    expect(history.undoLabel).toBe('Edit field')

    expect(history.undo()?.objectIds).toEqual([idOf(model, 'A-East')])
    expect(emitIdf(doc)).toBe(SOURCE)
    expect([...doc.objects.values()].some((o) => o.dirty)).toBe(false)

    history.redo()
    expect(emitIdf(doc)).toBe(edited)
  })

  it('records nothing for a write that changes nothing', () => {
    const { doc, model, history } = setup()
    setFieldValue(doc, model, idOf(model, 'A-East'), 2, 'C1')
    setFieldValue(doc, model, idOf(model, 'A-East'), 40, '')
    expect(history.canUndo).toBe(false)
  })

  it('makes a multi-field geometry operation one step', () => {
    const { doc, model, history } = setup()
    const id = idOf(model, 'B-West')
    translateSurface(doc, model, id, { x: 0.5, y: 0, z: 0 }, resolveModel(model).get(id)!.worldVertices)
    history.undo()
    expect(emitIdf(doc)).toBe(SOURCE)
    expect(history.canUndo).toBe(false)
  })

  it('makes a bracketed drag gesture one step, however many moves it made', () => {
    const { doc, model, history } = setup()
    const id = idOf(model, 'B-West')
    const start = resolveModel(model)
    history.begin('Drag')
    for (let k = 1; k <= 10; k++) {
      moveVertices(doc, model, start, [{ surfaceId: id, resolvedIndex: 0 }], { x: 0, y: k * 0.01, z: 0 })
    }
    // Undo is refused mid-gesture rather than tearing it in half.
    expect(history.undo()).toBeUndefined()
    history.end()

    expect(history.undoLabel).toBe('Drag')
    history.undo()
    expect(emitIdf(doc)).toBe(SOURCE)
    expect(history.canUndo).toBe(false)
  })

  it('undoes a mirrored vertex insertion on both sides of the pair at once', () => {
    const { doc, model, history } = setup()
    const r = insertVertexWorld(doc, model, idOf(model, 'A-East'), 1, { x: 4, y: 2, z: 0 })
    expect(r.twin?.mirrored).toBe(true)
    const edited = emitIdf(doc)

    const step = history.undo()!
    expect(step.label).toBe('Add vertex')
    expect(step.objectIds.sort()).toEqual([idOf(model, 'A-East'), idOf(model, 'B-West')].sort())
    expect(emitIdf(doc)).toBe(SOURCE)
    history.redo()
    expect(emitIdf(doc)).toBe(edited)
  })

  it('undoes a surface deletion, cascade and twin repair included', () => {
    const { doc, model, history } = setup()
    const plan = planSurfaceDeletion(doc, model, buildReferenceIndex(doc, model.version), idOf(model, 'A-East'))!
    applySurfaceDeletion(doc, model, plan, { twins: 'adiabatic' })
    const edited = emitIdf(doc)
    expect(edited).not.toContain('A-Win')

    history.undo()
    expect(emitIdf(doc)).toBe(SOURCE)
    // The restored Document is whole again, not just its text.
    const rebuilt = buildModel(doc)
    expect([...rebuilt.surfaces.values()].map((s) => s.name).sort()).toEqual(['A-East', 'A-Win', 'B-West'])

    history.redo()
    expect(emitIdf(doc)).toBe(edited)
  })

  it('keeps each step intact when editing continues after a redo', () => {
    const { doc, history } = setup()
    const del = (name: string): void => {
      const m = buildModel(doc)
      const plan = planSurfaceDeletion(doc, m, buildReferenceIndex(doc, m.version), idOf(m, name))!
      applySurfaceDeletion(doc, m, plan)
    }
    del('B-West')
    const afterFirst = emitIdf(doc)
    history.undo()
    history.redo()
    del('A-East')
    history.undo()
    expect(emitIdf(doc)).toBe(afterFirst)
    history.undo()
    expect(emitIdf(doc)).toBe(SOURCE)
    history.redo()
    expect(emitIdf(doc)).toBe(afterFirst)
  })

  it('clears redo when a new edit is made after an undo', () => {
    const { doc, model, history } = setup()
    setFieldValue(doc, model, idOf(model, 'A-East'), 2, 'C2')
    history.undo()
    expect(history.canRedo).toBe(true)
    setFieldValue(doc, model, idOf(model, 'A-East'), 2, 'C3')
    expect(history.canRedo).toBe(false)
  })

  it('undoes revert-all as one step', () => {
    const { doc, model, history } = setup()
    setFieldValue(doc, model, idOf(model, 'A-East'), 2, 'C2')
    setFieldValue(doc, model, idOf(model, 'B-West'), 2, 'C2')
    const edited = emitIdf(doc)
    revertAll(doc, model)
    expect(emitIdf(doc)).toBe(SOURCE)
    history.undo()
    expect(emitIdf(doc)).toBe(edited)
  })

  it('drops the oldest steps past its limit', () => {
    const doc = parseIdf(SOURCE)
    const history = new EditHistory(doc, 3)
    const model = buildModel(doc)
    for (const c of ['C2', 'C3', 'C4', 'C5']) setFieldValue(doc, model, idOf(model, 'A-East'), 2, c)
    let n = 0
    while (history.undo()) n++
    expect(n).toBe(3)
    expect(emitIdf(doc)).toContain('C2,')
  })

  it('stops recording when detached', () => {
    const { doc, model, history } = setup()
    history.detach()
    setFieldValue(doc, model, idOf(model, 'A-East'), 2, 'C2')
    expect(history.canUndo).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Breadth: long mixed sequences over the corpus
// ---------------------------------------------------------------------------

const BULK_DIR = join(import.meta.dirname, '../fixtures/testfiles')
const corpus = existsSync(BULK_DIR)
  ? readdirSync(BULK_DIR).filter((f) => f.endsWith('.idf')).sort()
  : []

/** Deterministic, so a failure reproduces. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

describe('EditHistory — corpus', () => {
  /**
   * For each file: apply a sequence of every kind of Phase 6 edit, rebuilding the Model after
   * deletions the way the UI must, and record the emitted text after each step. Then undo all
   * the way back, checking each intermediate text in reverse, and redo all the way forward.
   */
  it.skipIf(corpus.length === 0)('undo retraces every step exactly, and redo replays it', () => {
    let files = 0
    let steps = 0
    const kinds = new Map<string, number>()

    for (const file of corpus) {
      const source = readFileSync(join(BULK_DIR, file), 'utf8')
      const doc = parseIdf(source)
      const history = new EditHistory(doc)
      let model = buildModel(doc)
      if (model.surfaces.size === 0) continue
      const random = rng(files + 1)
      const texts = [source]

      for (let k = 0; k < 8; k++) {
        const ids = [...model.surfaces.keys()].filter((id) => model.surfaces.get(id)!.vertices.length >= 3)
        if (ids.length === 0) break
        const id = ids[Math.floor(random() * ids.length)]!
        const r = resolveModel(model).get(id)!
        const v0 = r.worldVertices[0]!
        const kind = ['move', 'insert', 'delete-vertex', 'zone', 'delete-surface'][k % 5]!
        const depthBefore = history.undoCount

        if (kind === 'move') {
          setVertexWorld(doc, model, id, 0, { x: v0.x + 0.05, y: v0.y, z: v0.z })
        } else if (kind === 'insert') {
          insertVertexWorld(doc, model, id, 0, { x: v0.x, y: v0.y, z: v0.z + 0.01 })
        } else if (kind === 'delete-vertex') {
          deleteVertex(doc, model, id, 0)
        } else if (kind === 'zone') {
          const zoneId = model.zoneOf.get(id) ?? [...model.zones.keys()][0]
          if (zoneId) applyZoneTranslation(doc, model, planZoneTranslation(doc, model, zoneId, { x: 1, y: 2, z: 0 })!)
        } else {
          const plan = planSurfaceDeletion(doc, model, buildReferenceIndex(doc, model.version), id)!
          applySurfaceDeletion(doc, model, plan, { twins: 'adiabatic' })
          model = buildModel(doc)
        }

        const text = emitIdf(doc)
        const changed = text !== texts[texts.length - 1]
        // One undo step per edit that changed the file, and none for an edit that did not.
        expect(history.undoCount - depthBefore, `${file}: ${kind}`).toBe(changed ? 1 : 0)
        if (changed) {
          texts.push(text)
          kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
        }
      }

      // Walk back.
      for (let i = texts.length - 2; i >= 0; i--) {
        expect(history.undo(), `${file}: ran out of undo at step ${i + 1}`).toBeDefined()
        expect(emitIdf(doc) === texts[i], `${file}: undo to step ${i} is not exact`).toBe(true)
      }
      expect(history.canUndo, `${file}: undo steps left over after returning to the source`).toBe(false)
      expect([...doc.objects.values()].some((o) => o.dirty), `${file}: dirty after full undo`).toBe(false)

      // And forward again.
      for (let i = 1; i < texts.length; i++) {
        expect(history.redo(), `${file}: ran out of redo at step ${i}`).toBeDefined()
        expect(emitIdf(doc) === texts[i], `${file}: redo to step ${i} is not exact`).toBe(true)
      }

      // The Document the history left behind is a working one.
      const rebuilt = buildModel(doc)
      expect(emitIdf(parseIdf(emitIdf(doc)))).toBe(emitIdf(doc))
      expect(rebuilt.surfaces.size).toBeGreaterThan(0)

      files++
      steps += texts.length - 1
    }

    expect(files).toBeGreaterThan(100)
    console.log(
      `history: ${steps} steps over ${files} files undone and redone byte-exactly ` +
        `(${[...kinds].map(([k, n]) => `${k} ${n}`).join(', ')})`,
    )
  })
})
