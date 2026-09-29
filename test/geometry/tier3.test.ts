import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emitIdf, parseIdf, type IdfDocument } from '../../src/parser/index.js'
import { buildModel, EditHistory, TIER3_SURFACE_CLASSES, type Model } from '../../src/model/index.js'
import {
  applyTier3Conversion,
  eplusAzimuthTilt,
  planTier3Conversion,
  resolveModel,
  validateModel,
} from '../../src/geometry/index.js'

/**
 * Tier-3 conversion on geometry small enough to derive by hand. The EnergyPlus gate
 * (`eplus-tier3.test.ts`) establishes that the transcription agrees with EnergyPlus; these pin
 * the arithmetic and the bookkeeping so a regression names the rule that broke.
 */

function header(system = 'World', rect = 'World', north = 0): string {
  return `Version,26.1;
Building,B,${north};
GlobalGeometryRules,UpperLeftCorner,Counterclockwise,${system},,${rect};
Construction,C,M;
Construction,G,M;
Material,M,Rough,0.1,1,1000,1000;
`
}

function load(text: string): { doc: IdfDocument; model: Model } {
  const doc = parseIdf(text)
  return { doc, model: buildModel(doc) }
}

const r = (v: { x: number; y: number; z: number }): number[] => [v.x, v.y, v.z].map((n) => +n.toFixed(9) + 0)

describe('eplusAzimuthTilt', () => {
  it('reads walls, roofs and floors as EnergyPlus does', () => {
    const south = [
      { x: 0, y: 0, z: 3 },
      { x: 0, y: 0, z: 0 },
      { x: 4, y: 0, z: 0 },
      { x: 4, y: 0, z: 3 },
    ]
    expect(eplusAzimuthTilt(south)).toEqual({ azimuth: 180, tilt: 90 })
    const east = south.map((p) => ({ x: 4, y: p.x, z: p.z }))
    expect(eplusAzimuthTilt(east).azimuth).toBeCloseTo(90, 9)
    const roof = [
      { x: 0, y: 4, z: 3 },
      { x: 0, y: 0, z: 3 },
      { x: 4, y: 0, z: 3 },
      { x: 4, y: 4, z: 3 },
    ]
    expect(eplusAzimuthTilt(roof).tilt).toBe(0)
    expect(eplusAzimuthTilt([...roof].reverse()).tilt).toBe(180)
  })
})

describe('planTier3Conversion — geometry by hand', () => {
  const zone = 'Zone,Z,0,5,7,1;\n'
  const wall = 'Wall:Exterior,W,C,Z,,180,90,0,0,0,10,3;\n'
  const win = 'Window,Win,G,W,,1,2,1,2,1.5;\n'

  it('places a south wall and a window on it', () => {
    const { doc, model } = load(header() + zone + wall + win)
    const plan = planTier3Conversion(doc, model)
    expect(plan.refused).toEqual([])
    const [w, g] = plan.conversions
    expect(w!.outputs[0]!.world.map(r)).toEqual([
      [0, 0, 3],
      [0, 0, 0],
      [10, 0, 0],
      [10, 0, 3],
    ])
    // Starting X 2 along the wall, Z 1 up, from its lower-left corner.
    expect(g!.outputs[0]!.world.map(r)).toEqual([
      [2, 0, 2.5],
      [2, 0, 1],
      [4, 0, 1],
      [4, 0, 2.5],
    ])
  })

  it('in Relative coordinates, carries the zone origin and the north axis', () => {
    const { doc, model } = load(header('Relative', 'Relative', 90) + zone + wall)
    const [w] = planTier3Conversion(doc, model).conversions
    // Origin (5, 7, 1); a 90° north axis turns the building clockwise: (x, y) → (y, −x).
    expect(w!.outputs[0]!.world.map(r)).toEqual([
      [7, -5, 4],
      [7, -5, 1],
      [7, -15, 1],
      [7, -15, 4],
    ])
  })

  it('places an overhang and a pair of fins off a window', () => {
    const shades =
      'Shading:Overhang,O,Win,0.2,90,0.3,0.3,0.6;\n' + 'Shading:Fin,F,Win,0.1,0.2,0.2,90,0.4,0.1,0.2,0.2,90,0.4;\n'
    const { doc, model } = load(header() + zone + wall + win + shades)
    const plan = planTier3Conversion(doc, model)
    const byName = new Map(plan.conversions.flatMap((c) => c.outputs.map((o) => [o.name, o.world.map(r)])))
    // Overhang: 0.2 above the window head, 0.3 beyond each side, 0.6 deep, horizontal.
    expect(byName.get('O')).toEqual([
      [1.7, -0.6, 2.7],
      [1.7, 0, 2.7],
      [4.3, 0, 2.7],
      [4.3, -0.6, 2.7],
    ])
    // Fins: 0.1 out from each jamb, from 0.2 below the sill to 0.2 above the head, 0.4 deep.
    expect(byName.get('F Left')).toEqual([
      [1.9, 0, 2.7],
      [1.9, 0, 0.8],
      [1.9, -0.4, 0.8],
      [1.9, -0.4, 2.7],
    ])
    expect(byName.get('F Right')).toEqual([
      [4.1, 0, 2.7],
      [4.1, 0, 0.8],
      [4.1, -0.4, 0.8],
      [4.1, -0.4, 2.7],
    ])
  })

  it('maps boundaries: adiabatic, ground, and an interzone wall naming a zone or a surface', () => {
    const text =
      header() +
      zone +
      'Zone,Y;\n' +
      'Wall:Adiabatic,A,C,Z,,0,90,0,5,0,10,3;\n' +
      // A floor's length runs toward −x (azimuth 0, tilt 180), so it starts at the far corner.
    'Floor:GroundContact,F,C,Z,,0,180,10,0,0,10,5;\n' +
      'Wall:Interzone,IZ1,C,Z,,Y,90,90,10,0,0,5,3;\n' +
      'Wall:Interzone,IZ2,C,Z,,IZ1,270,90,0,5,0,5,3;\n'
    const { doc, model } = load(text)
    const out = new Map(planTier3Conversion(doc, model).conversions.map((c) => [c.sourceName, c.outputs[0]!.fields]))
    expect(out.get('A')!['Outside Boundary Condition']).toBe('Adiabatic')
    expect(out.get('F')!['Outside Boundary Condition']).toBe('Ground')
    expect([out.get('IZ1')!['Outside Boundary Condition'], out.get('IZ1')!['Outside Boundary Condition Object']]).toEqual(['Zone', 'Y'])
    expect([out.get('IZ2')!['Outside Boundary Condition'], out.get('IZ2')!['Outside Boundary Condition Object']]).toEqual(['Surface', 'IZ1'])
    expect(out.get('F')!['Sun Exposure']).toBe('NoSun')
  })

  it('says plainly what changes for Ceiling:Interzone', () => {
    const text = header() + zone + 'Zone,Y;\nCeiling:Interzone,CI,C,Z,,Up,0,0,0,0,3,10,5;\nFloor:Interzone,Up,C,Y,,CI,0,180,0,5,3,10,5;\n'
    const { doc, model } = load(text)
    const plan = planTier3Conversion(doc, model)
    expect(plan.notes).toHaveLength(1)
    expect(plan.notes[0]).toMatch(/ignores this class’s Outside Boundary Condition Object/)
  })

  it('refuses what it cannot place, and everything when GeometryTransform is present', () => {
    const { doc, model } = load(header() + zone + 'Wall:Exterior,Lost,C,Nowhere,,0,90,0,0,0,1,1;\nWindow,Orphan,G,NoWall,,1,0,0,1,1;\n')
    expect(planTier3Conversion(doc, model).refused.map((x) => x.reason)).toEqual([
      "its zone 'Nowhere' does not exist",
      "its base surface 'NoWall' cannot be found",
    ])
    const t = load(header() + zone + wall + 'GeometryTransform,XY,1;\n')
    expect(planTier3Conversion(t.doc, t.model).refused[0]!.reason).toMatch(/GeometryTransform/)
  })
})

describe('applyTier3Conversion', () => {
  const box =
    header('Relative', 'Relative', 25) +
    'Zone,Z,15,2,3,0;\n' +
    'Wall:Exterior,S,C,Z,,180,90,0,0,0,10,3;\n' +
    'Wall:Exterior,E,C,Z,,90,90,10,0,0,5,3;\n' +
    'Wall:Exterior,N,C,Z,,0,90,10,5,0,10,3;\n' +
    'Wall:Exterior,Wst,C,Z,,270,90,0,5,0,5,3;\n' +
    'Roof,R,C,Z,,180,0,0,0,3,10,5;\n' +
    // A floor's length runs toward −x (azimuth 0, tilt 180), so it starts at the far corner.
    'Floor:GroundContact,F,C,Z,,0,180,10,0,0,10,5;\n' +
    'Window,Win,G,S,,1,2,1,2,1.5;\n' +
    'Shading:Overhang,O,Win,0.2,90,0.3,0.3,0.6;\n'

  it('replaces each object in place, keeps names, and resolves back to the planned vertices', () => {
    const { doc, model } = load(box)
    const plan = planTier3Conversion(doc, model)
    const planned = new Map(plan.conversions.flatMap((c) => c.outputs.map((o) => [o.name, o.world.map(r)])))
    const result = applyTier3Conversion(doc, model, plan)
    expect(result.removed).toHaveLength(8)
    expect(result.created).toHaveLength(8)

    const again = buildModel(parseIdf(emitIdf(doc)))
    for (const k of TIER3_SURFACE_CLASSES) expect(again.unrendered.get(k) ?? 0).toBe(0)
    const resolved = resolveModel(again)
    for (const s of again.surfaces.values()) {
      expect(resolved.get(s.id)!.worldVertices.map(r), s.name).toEqual(planned.get(s.name))
    }
    // A closed, outward-facing box: the converted file validates clean.
    expect(validateModel(again, resolved, again.doc).issues).toEqual([])
  })

  it('is one undo step', () => {
    const { doc, model } = load(box)
    const history = new EditHistory(doc)
    applyTier3Conversion(doc, model, planTier3Conversion(doc, model))
    expect(history.undoCount).toBe(1)
    history.undo()
    expect(emitIdf(doc)).toBe(box)
  })
})

// ---------------------------------------------------------------------------
// Breadth
// ---------------------------------------------------------------------------

const DIRS = [join(import.meta.dirname, '../fixtures/testfiles'), join(import.meta.dirname, '../fixtures/versions')]
function corpus(): string[] {
  const out: string[] = []
  for (const d of DIRS) {
    if (!existsSync(d)) continue
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.idf')) out.push(join(d, e.name))
      else if (e.isDirectory()) for (const f of readdirSync(join(d, e.name))) if (f.endsWith('.idf')) out.push(join(d, e.name, f))
    }
  }
  return out
}

describe('applyTier3Conversion — corpus', () => {
  const files = corpus()
  it.skipIf(files.length === 0)('converts every simplified object in the corpus, refusing none, adding no validation error', () => {
    let converted = 0
    let fileCount = 0
    for (const path of files) {
      const doc = parseIdf(readFileSync(path, 'utf8'))
      const model = buildModel(doc)
      const plan = planTier3Conversion(doc, model)
      if (plan.conversions.length === 0 && plan.refused.length === 0) continue
      expect(plan.refused, path).toEqual([])
      const errorsBefore = new Set(
        validateModel(model, resolveModel(model), doc)
          .issues.filter((i) => i.severity === 'error')
          .map((i) => `${i.code}:${i.objectName}`),
      )
      applyTier3Conversion(doc, model, plan)
      const after = buildModel(parseIdf(emitIdf(doc)))
      for (const k of TIER3_SURFACE_CLASSES) expect(after.unrendered.get(k) ?? 0, `${path}: ${k}`).toBe(0)
      const newErrors = validateModel(after, resolveModel(after), after.doc)
        .issues.filter((i) => i.severity === 'error')
        .map((i) => `${i.code}:${i.objectName}`)
        .filter((e) => !errorsBefore.has(e))
      // Converting makes a shipped defect visible, and nothing else: in this file the floors above
      // name `Ceiling:Adiabatic` roofs as their twins. EnergyPlus accepts the one-sided pair
      // silently; the validator could not see it while the surfaces had no vertices.
      const revealed = path.endsWith('4ZoneWithShading_Simple_2.idf') && !path.includes('/versions/')
        ? ['boundary-asymmetric:Zn003:Flr001', 'boundary-asymmetric:Zn004:Flr001']
        : []
      expect(newErrors.sort(), path).toEqual(revealed)
      converted += plan.conversions.length
      fileCount++
    }
    expect(fileCount).toBeGreaterThanOrEqual(3)
    console.log(`tier-3: converted ${converted} simplified objects across ${fileCount} corpus files, none refused`)
  })
})
