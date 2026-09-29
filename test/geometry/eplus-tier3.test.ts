import { describe, expect, it } from 'vitest'
import { emitIdf, parseIdf } from '../../src/parser/index.js'
import { buildModel } from '../../src/model/index.js'
import { applyTier3Conversion, planTier3Conversion, TIER3_CONVERTIBLE } from '../../src/geometry/index.js'
import { runEnergyPlus, severeDiff, warningDiff, zoneInfo } from '../harness/energyplus.js'
import { canRun, exe, FIXTURES, readFixture } from '../harness/gate-fixtures.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * PHASE 9 GATE — Tier-3 → detailed conversion, with EnergyPlus as the oracle.
 *
 * `Output:Surfaces:List, DetailsWithVertices` makes EnergyPlus report every surface it built:
 * world vertices, azimuth, tilt, areas, boundary condition. Two claims are checked against it:
 *
 *   1. The vertices we compute from each simplified object are the vertices EnergyPlus computes
 *      from it — to the report's two decimals.
 *   2. After conversion, EnergyPlus reports the same building: every surface present, every field
 *      the same, the same warnings, the same zones. The one intended exception is the
 *      `Ceiling:Interzone` boundary EnergyPlus ignores (see `tier3.ts`), asserted explicitly.
 *
 * The two shipped files that run between them use all 22 simplified classes, but with no rotation
 * at all and with matching coordinate-system fields. So each is also run with a building north
 * axis, zone relative north, an Appendix G rotation, and the rectangular coordinate system set
 * opposite to the main one — each of which exercises a branch the shipped files leave untouched.
 */

const FILES = ['4ZoneWithShading_Simple_1.idf', '4ZoneWithShading_Simple_2.idf'].filter((f) => existsSync(join(FIXTURES, f)))

const VARIANTS: Record<string, (s: string) => string> = {
  shipped: (s) => s,
  'north axis 30°': (s) => s.replace(/(Building,[^;]*?\n[^\n]*?\n\s*)[-0-9.E+]+(,\s*!- North Axis)/i, '$130$2'),
  'zone north 20°, building −15°': (s) =>
    s
      .replace(/[-0-9.E+]+(,\s*!- Direction of Relative North)/gi, '20$1')
      .replace(/(Building,[^;]*?\n[^\n]*?\n\s*)[-0-9.E+]+(,\s*!- North Axis)/i, '$1-15$2'),
  'Appendix G 17°': (s) => `${s}\nCompliance:Building,17;\n`,
  'rectangular system flipped': (s) => flipRectangular(s),
  // Without a rotation, which coordinate-system field drives the azimuth offset makes no
  // difference; this is the variant that tells the two apart.
  'rectangular system flipped, north 30°, zone north 20°': (s) =>
    flipRectangular(s)
      .replace(/[-0-9.E+]+(,\s*!- Direction of Relative North)/gi, '20$1')
      .replace(/(Building,[^;]*?\n[^\n]*?\n\s*)[-0-9.E+]+(,\s*!- North Axis)/i, '$130$2'),
}

function flipRectangular(s: string): string {
  return s.replace(/(Coordinate System\s*\n\s*,[^\n]*\n\s*)(World|Relative)(;\s*!- Rectangular)/i, (_a, p: string, v: string, q: string) =>
    p + (v === 'World' ? 'Relative' : 'World') + q,
  )
}

interface Row {
  fields: string[]
  verts: number[][]
}

/** Every surface row of an `.eio`, by upper-cased name. */
function surfaces(eio: string): Map<string, Row> {
  const out = new Map<string, Row>()
  for (const line of eio.split('\n')) {
    if (!/^(HeatTransfer Surface|Shading Surface),/.test(line)) continue
    const f = line.split(',').map((s) => s.trim())
    const sides = Number(f[26])
    const verts = Array.from({ length: sides }, (_, i) => [Number(f[27 + 3 * i]), Number(f[28 + 3 * i]), Number(f[29 + 3 * i])])
    out.set(f[1]!.toUpperCase(), { fields: f.slice(2, 26), verts })
  }
  return out
}

/** Equal as text, or as numbers within the report's rounding. */
function same(a: string, b: string): boolean {
  if (a === b) return true
  const x = Number(a)
  const y = Number(b)
  return a !== '' && b !== '' && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= 0.011
}

/** Index of `ExtBoundCondition` within `Row.fields`. */
const EXT_BC = 15

describe.skipIf(!canRun || FILES.length === 0)('Phase 9 gate — Tier-3 conversion, checked by EnergyPlus', () => {
  for (const file of FILES) {
    for (const [variant, mutate] of Object.entries(VARIANTS)) {
      it(
        `${file} — ${variant}`,
        () => {
          let src = mutate(readFixture(file))
          if (variant !== 'shipped') expect(src, 'the variant did not change the file').not.toBe(readFixture(file))
          if (!/Output:Surfaces:List\s*,\s*DetailsWithVertices/i.test(src)) src += '\nOutput:Surfaces:List,DetailsWithVertices;\n'
          const doc = parseIdf(src)
          const model = buildModel(doc)
          const before = runEnergyPlus(exe!, src, { workdir: `tier3/${file}/${variant}/before` })
          expect(before.completed, before.err).toBe(true)
          const theirs = surfaces(before.eio)

          // --- 1. Our vertices are EnergyPlus's -----------------------------------------------
          const plan = planTier3Conversion(doc, model)
          expect(plan.refused).toEqual([])
          let compared = 0
          let worst = 0
          for (const c of plan.conversions) {
            for (const o of c.outputs) {
              const t = theirs.get(o.name.toUpperCase())
              expect(t, `${o.name}: EnergyPlus reports no such surface`).toBeDefined()
              o.world.forEach((v, i) => {
                const e = t!.verts[i]!
                worst = Math.max(worst, Math.abs(v.x - e[0]!), Math.abs(v.y - e[1]!), Math.abs(v.z - e[2]!))
              })
              compared++
            }
          }
          expect(worst, 'our vertices differ from EnergyPlus’s by more than its reporting precision').toBeLessThanOrEqual(0.0051)

          // --- 2. EnergyPlus reads the converted file as the same building --------------------
          const ceilingInterzone = new Set(
            (doc.byClass.get('ceiling:interzone') ?? []).map((id) => doc.objects.get(id)!.fields[0]!.value.toUpperCase()),
          )
          applyTier3Conversion(doc, model, plan)
          const text = emitIdf(doc)
          const converted = buildModel(parseIdf(text))
          for (const k of TIER3_CONVERTIBLE) expect(converted.unrendered.get(k) ?? 0, `${k} left unconverted`).toBe(0)

          const after = runEnergyPlus(exe!, text, { workdir: `tier3/${file}/${variant}/after` })
          expect(after.completed, after.err).toBe(true)
          expect(severeDiff(before, after).added).toEqual([])
          expect(warningDiff(before, after)).toEqual({ added: [], removed: [] })
          expect(zoneInfo(after.eio)).toEqual(zoneInfo(before.eio))

          const rows = surfaces(after.eio)
          expect([...rows.keys()].sort()).toEqual([...theirs.keys()].sort())
          const changedBoundaries: string[] = []
          for (const [name, a] of theirs) {
            const b = rows.get(name)!
            a.fields.forEach((x, i) => {
              if (same(x, b.fields[i]!)) return
              if (i === EXT_BC && ceilingInterzone.has(name)) {
                changedBoundaries.push(name)
                return
              }
              expect.fail(`${name}: field ${i} was '${x}', is '${b.fields[i]}'`)
            })
            a.verts.forEach((v, i) => v.forEach((c, k) => expect(Math.abs(c - b.verts[i]![k]!), `${name} vertex ${i + 1}`).toBeLessThanOrEqual(0.011)))
          }
          // The intended change, and only it: each Ceiling:Interzone now names what the file said.
          expect(changedBoundaries.sort()).toEqual([...ceilingInterzone].sort())
          for (const name of changedBoundaries) expect(rows.get(name)!.fields[EXT_BC]).not.toBe(name)
          expect(plan.notes.length).toBe(ceilingInterzone.size > 0 ? 1 : 0)

          console.log(
            `${file} — ${variant}: ${compared} converted surfaces, worst vertex error vs EnergyPlus ${worst.toExponential(1)} m; ` +
              `after conversion EnergyPlus reports ${rows.size} surfaces identical, same warnings, same zones` +
              (changedBoundaries.length ? `; ${changedBoundaries.length} Ceiling:Interzone now coupled as declared` : ''),
          )
        },
        240_000,
      )
    }
  }
})
