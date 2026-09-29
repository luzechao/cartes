import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emitIdf, parseIdf } from '../../src/parser/index.js'
import type { IdfDocument } from '../../src/parser/index.js'
import {
  applySurfaceDeletion,
  buildModel,
  buildReferenceIndex,
  getSchema,
  mentionsOf,
  planSurfaceDeletion,
  referencesTo,
  type Model,
} from '../../src/model/index.js'
import { resolveModel, validateModel } from '../../src/geometry/index.js'

const FIXTURES = join(import.meta.dirname, '../fixtures/testfiles')
const SAMPLE = join(FIXTURES, '5ZoneAirCooled.idf')
const haveFixtures = existsSync(SAMPLE)

function load(path: string): { source: string; doc: IdfDocument; model: Model } {
  const source = readFileSync(path, 'utf8')
  const doc = parseIdf(source)
  return { source, doc, model: buildModel(doc) }
}

function errorCount(doc: IdfDocument, model: Model): number {
  return validateModel(model, resolveModel(model), doc).issues.filter(
    (i) => i.severity === 'error',
  ).length
}

describe.skipIf(!haveFixtures)('reverse-reference index', () => {
  it('finds references the geometry model does not track', () => {
    const { doc, model } = load(SAMPLE)
    const refs = buildReferenceIndex(doc, model.version)

    // The Model tracks three surface relationships: twins, child fenestration, attached
    // shading. The IDD-derived index must find those *and* the ones nothing in the model
    // layer knows about, which is the whole reason it is derived from the IDD.
    const classesNamingSurfaces = new Set<string>()
    for (const surface of model.surfaces.values()) {
      for (const ref of referencesTo(refs, surface.name, surface.id)) {
        classesNamingSurfaces.add(ref.fromClassKey)
      }
    }

    expect(classesNamingSurfaces.size).toBeGreaterThan(0)
    // At minimum, windows naming their base surface must show up.
    expect([...classesNamingSurfaces]).toContain('fenestrationsurface:detailed')
  })

  it('does not report an object as referencing itself', () => {
    const { doc, model } = load(SAMPLE)
    const refs = buildReferenceIndex(doc, model.version)
    for (const surface of model.surfaces.values()) {
      for (const ref of referencesTo(refs, surface.name, surface.id)) {
        expect(ref.fromId).not.toBe(surface.id)
      }
    }
  })

  /**
   * The index once skipped every object whose class was absent from the schema subset the
   * model layer loads, which is most of a real file. `Meter:Custom` is one of them, and it
   * names surfaces in its `Key Name` fields — so deleting a surface reported clean and then
   * raised a severe error in the simulation. See `ReferenceIndex.byText`.
   */
  it('sweeps classes it has no schema for, rather than skipping them', () => {
    const AIR_BOUNDARIES = join(FIXTURES, '5ZoneAirCooled_AirBoundaries.idf')
    if (!existsSync(AIR_BOUNDARIES)) return

    const { doc, model } = load(AIR_BOUNDARIES)
    // The premise: this class really is outside the loaded schema, so the declared half of
    // the index cannot see it. If that ever changes, this test is measuring nothing.
    expect(getSchema('meter:custom', model.version)).toBeUndefined()

    const refs = buildReferenceIndex(doc, model.version)
    const mentions = mentionsOf(refs, 'C1-1P')
    expect(mentions.map((m) => m.fromClassKey)).toContain('meter:custom')
  })

  it('keeps declared references and textual mentions apart', () => {
    const { doc, model } = load(SAMPLE)
    const refs = buildReferenceIndex(doc, model.version)

    for (const surface of model.surfaces.values()) {
      for (const ref of referencesTo(refs, surface.name)) expect(ref.declared).toBe(true)
      for (const ref of mentionsOf(refs, surface.name)) expect(ref.declared).toBe(false)
    }
  })

  it('does not sweep numeric fields, which cannot be naming anything', () => {
    const { doc, model } = load(SAMPLE)
    const refs = buildReferenceIndex(doc, model.version)
    // `0.5` is a View Factor to Ground in every surface in the file. A surface called `0.5`
    // would otherwise appear to be referenced hundreds of times.
    expect(mentionsOf(refs, '0.5')).toEqual([])
  })
})

describe.skipIf(!haveFixtures)('surface deletion — planning', () => {
  it('cascades child fenestration and reports the paired twin separately', () => {
    const { doc, model } = load(SAMPLE)
    const refs = buildReferenceIndex(doc, model.version)

    const withWindows = [...model.surfaces.values()].find(
      (s) => s.kind === 'base' && s.subSurfaces.length > 0,
    )
    expect(withWindows, 'fixture has no surface carrying fenestration').toBeTruthy()

    const plan = planSurfaceDeletion(doc, model, refs, withWindows!.id)!
    expect(plan.surfaceName).toBe(withWindows!.name)

    // Everything that cannot outlive the surface: its windows, shading attached to it, and
    // shading attached to those windows.
    const base = withWindows as unknown as { subSurfaces: string[]; attachedShading: string[] }
    const expected = new Set<string>([...base.subSurfaces, ...base.attachedShading])
    for (const childId of base.subSurfaces) {
      const child = model.surfaces.get(childId)
      if (child && child.kind !== 'shading') {
        for (const id of child.attachedShading) expected.add(id)
      }
    }

    expect(plan.cascade.map((c) => c.id).sort()).toEqual([...expected].sort())
    expect(plan.cascade.length).toBeGreaterThanOrEqual(base.subSurfaces.length)
    for (const entry of plan.cascade) {
      expect(entry.reason).toBeTruthy()
      expect(entry.className).toBeTruthy()
    }
    // A cascaded child must not also be listed as an unrelated reference.
    const cascadeIds = new Set(plan.cascade.map((c) => c.id))
    expect(plan.otherReferences.some((r) => cascadeIds.has(r.fromId))).toBe(false)
  })

  it('identifies the surface pointing back through Outside Boundary Condition Object', () => {
    const { doc, model } = load(SAMPLE)
    const refs = buildReferenceIndex(doc, model.version)

    const paired = [...model.surfaces.values()].find(
      (s) => s.kind === 'base' && s.outsideBoundaryConditionObject.trim() !== '',
    )
    expect(paired, 'fixture has no paired surface').toBeTruthy()

    const twinName = (paired as { outsideBoundaryConditionObject: string })
      .outsideBoundaryConditionObject
    const twin = [...model.surfaces.values()].find(
      (s) => s.name.toLowerCase() === twinName.toLowerCase(),
    )!

    const plan = planSurfaceDeletion(doc, model, refs, twin.id)!
    expect(plan.twins.map((t) => t.id)).toContain(paired!.id)
    for (const t of plan.twins) {
      expect(t.fieldName.toLowerCase()).toContain('outside boundary condition object')
    }
  })

  it('returns undefined for an object that is not a modelled surface', () => {
    const { doc, model } = load(SAMPLE)
    const refs = buildReferenceIndex(doc, model.version)
    expect(planSurfaceDeletion(doc, model, refs, 'no-such-object')).toBeUndefined()
  })
})

describe.skipIf(!haveFixtures)('surface deletion — applying', () => {
  it('removes exactly the planned objects and leaves every other byte alone', () => {
    const { source, doc, model } = load(SAMPLE)
    const refs = buildReferenceIndex(doc, model.version)

    const target = [...model.surfaces.values()].find(
      (s) => s.kind === 'base' && s.subSurfaces.length > 0,
    )!
    const plan = planSurfaceDeletion(doc, model, refs, target.id)!

    const deletedSlices = [plan.surfaceId, ...plan.cascade.map((c) => c.id)].map((id) => {
      const o = doc.objects.get(id)!
      return source.slice(o.start!, o.end!)
    })
    const survivorSlices = [...doc.objects.values()]
      .filter((o) => o.id !== plan.surfaceId && !plan.cascade.some((c) => c.id === o.id))
      .slice(0, 50)
      .map((o) => source.slice(o.start!, o.end!))

    const before = doc.objects.size
    const result = applySurfaceDeletion(doc, model, plan)
    expect(result.deleted).toHaveLength(1 + plan.cascade.length)
    expect(result.repairedTwins).toEqual([])
    expect(doc.objects.size).toBe(before - result.deleted.length)

    const emitted = emitIdf(doc)
    for (const slice of deletedSlices) {
      expect(emitted.includes(slice), 'deleted object text survived into the output').toBe(false)
    }
    for (const slice of survivorSlices) {
      expect(emitted.includes(slice), 'a surviving object was altered').toBe(true)
    }

    // The output must still parse, and must have lost exactly the deleted objects.
    const reparsed = parseIdf(emitted)
    expect(reparsed.objects.size).toBe(before - result.deleted.length)
    expect(reparsed.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
  })

  it('leaves an orphaned twin dangling by default, and the validator says so', () => {
    const { doc, model } = load(SAMPLE)
    const refs = buildReferenceIndex(doc, model.version)
    const baselineErrors = errorCount(doc, model)

    const paired = [...model.surfaces.values()].find(
      (s) => s.kind === 'base' && s.outsideBoundaryConditionObject.trim() !== '',
    )!
    const twinName = (paired as { outsideBoundaryConditionObject: string })
      .outsideBoundaryConditionObject
    const twin = [...model.surfaces.values()].find(
      (s) => s.name.toLowerCase() === twinName.toLowerCase(),
    )!

    const plan = planSurfaceDeletion(doc, model, refs, twin.id)!
    expect(plan.twins.length).toBeGreaterThan(0)
    applySurfaceDeletion(doc, model, plan)

    // Deliberately *not* silently repaired. The break is visible rather than hidden, which is
    // the opposite of VI-Suite's silent downgrade to Adiabatic.
    const rebuiltDoc = parseIdf(emitIdf(doc))
    const rebuilt = buildModel(rebuiltDoc)
    const survivor = [...rebuilt.surfaces.values()].find((s) => s.name === paired.name)!
    expect(
      (survivor as { outsideBoundaryConditionObject: string }).outsideBoundaryConditionObject,
    ).toBe(twinName)
    expect(errorCount(rebuiltDoc, rebuilt)).toBeGreaterThan(baselineErrors)
  })

  it('repairs the twin to Adiabatic only when explicitly asked', () => {
    const { doc, model } = load(SAMPLE)
    const refs = buildReferenceIndex(doc, model.version)

    const paired = [...model.surfaces.values()].find(
      (s) => s.kind === 'base' && s.outsideBoundaryConditionObject.trim() !== '',
    )!
    const twinName = (paired as { outsideBoundaryConditionObject: string })
      .outsideBoundaryConditionObject
    const twin = [...model.surfaces.values()].find(
      (s) => s.name.toLowerCase() === twinName.toLowerCase(),
    )!

    const plan = planSurfaceDeletion(doc, model, refs, twin.id)!
    const result = applySurfaceDeletion(doc, model, plan, { twins: 'adiabatic' })
    expect(result.repairedTwins).toContain(paired.id)

    const rebuilt = buildModel(parseIdf(emitIdf(doc)))
    const survivor = [...rebuilt.surfaces.values()].find((s) => s.name === paired.name)!
    expect((survivor as { outsideBoundaryCondition: string }).outsideBoundaryCondition).toBe(
      'Adiabatic',
    )
    expect(
      (survivor as { outsideBoundaryConditionObject: string }).outsideBoundaryConditionObject,
    ).toBe('')
  })
})
