import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emitIdf, parseIdf, renderObject } from '../../src/parser/index.js'
import { buildModel, getSchema, revertObject, vertexLayout, type Model } from '../../src/model/index.js'
import {
  deleteVertex,
  insertVertexWorld,
  resolveModel,
  resolveSurface,
  transformContext,
  validateModel,
} from '../../src/geometry/index.js'
import type { IdfDocument } from '../../src/parser/index.js'

/**
 * Adding and deleting vertices.
 *
 * Two things can go wrong, and they are tested separately. The *geometry* — does the new vertex
 * land between the two it was meant to, in a file whose vertex order is permuted by
 * `GlobalGeometryRules`? And the *text* — the emitter can no longer patch values in place,
 * because the field count moved, so does the output still look like the file it came from?
 * The text tests assert exact output, because "roughly the same" is how a formatter quietly
 * rewrites a user's file.
 */

function load(text: string): { doc: IdfDocument; model: Model } {
  const doc = parseIdf(text)
  return { doc, model: buildModel(doc) }
}

function idOf(model: Model, name: string): string {
  for (const [id, s] of model.surfaces) if (s.name === name) return id
  throw new Error(`no surface ${name}`)
}

/** World vertices after a full re-parse of the emitted text — i.e. what EnergyPlus will read. */
function reread(doc: IdfDocument, name: string): Array<[number, number, number]> {
  const again = buildModel(parseIdf(emitIdf(doc)))
  const r = resolveModel(again).get(idOf(again, name))!
  return r.worldVertices.map((v) => [round(v.x), round(v.y), round(v.z)])
}

function round(n: number): number {
  return Math.round(n * 1e9) / 1e9 + 0
}

const HEADER = `Version,26.1;
GlobalGeometryRules,UpperLeftCorner,Counterclockwise,World;
Zone,Z1;
Zone,Z2;
`

// The shipped-corpus style: header fields one per line, vertices three per line.
const WALL = `  BuildingSurface:Detailed,
    South,                   !- Name
    Wall,                    !- Surface Type
    C1,                      !- Construction Name
    Z1,                      !- Zone Name
    ,                        !- Space Name
    Outdoors,                !- Outside Boundary Condition
    ,                        !- Outside Boundary Condition Object
    SunExposed,              !- Sun Exposure
    WindExposed,             !- Wind Exposure
    0.5,                     !- View Factor to Ground
    4,                       !- Number of Vertices
    0,0,3,  !- X,Y,Z ==> Vertex 1 {m}
    0,0,0,  !- X,Y,Z ==> Vertex 2 {m}
    4,0,0,  !- X,Y,Z ==> Vertex 3 {m}
    4,0,3;  !- X,Y,Z ==> Vertex 4 {m}
`

const HEAD_LINES = WALL.split('\n').slice(0, 12).join('\n') + '\n'

describe('insertVertexWorld — text', () => {
  it('writes the new vertex on its own line, in the file’s style, and renumbers what follows', () => {
    const { doc, model } = load(HEADER + WALL)
    const r = insertVertexWorld(doc, model, idOf(model, 'South'), 1, { x: 2, y: 0, z: 0 })
    expect(r).toEqual({ changed: true, dirtied: [idOf(model, 'South')] })

    expect(emitIdf(doc)).toBe(
      HEADER +
        HEAD_LINES.replace('    4,                       !- Number of Vertices', '    5,                       !- Number of Vertices') +
        `    0,0,3,  !- X,Y,Z ==> Vertex 1 {m}
    0,0,0,  !- X,Y,Z ==> Vertex 2 {m}
    2,0,0,  !- X,Y,Z ==> Vertex 3 {m}
    4,0,0,  !- X,Y,Z ==> Vertex 4 {m}
    4,0,3;  !- X,Y,Z ==> Vertex 5 {m}
`,
    )
  })

  it('appends across the closing edge without disturbing vertex 1', () => {
    const { doc, model } = load(HEADER + WALL)
    // Resolved edge 3 is 4,0,3 -> 0,0,3: the seam between the last and first as written.
    insertVertexWorld(doc, model, idOf(model, 'South'), 3, { x: 2, y: 0, z: 3 })

    expect(emitIdf(doc)).toBe(
      HEADER +
        HEAD_LINES.replace('    4,                       !- Number of Vertices', '    5,                       !- Number of Vertices') +
        `    0,0,3,  !- X,Y,Z ==> Vertex 1 {m}
    0,0,0,  !- X,Y,Z ==> Vertex 2 {m}
    4,0,0,  !- X,Y,Z ==> Vertex 3 {m}
    4,0,3,  !- X,Y,Z ==> Vertex 4 {m}
    2,0,3;  !- X,Y,Z ==> Vertex 5 {m}
`,
    )
  })

  it('keeps a one-field-per-line file one field per line', () => {
    const onePerLine = `  BuildingSurface:Detailed,
    South,                   !- Name
    Wall,                    !- Surface Type
    C1,                      !- Construction Name
    Z1,                      !- Zone Name
    ,                        !- Space Name
    Outdoors,                !- Outside Boundary Condition
    ,                        !- Outside Boundary Condition Object
    SunExposed,              !- Sun Exposure
    WindExposed,             !- Wind Exposure
    0.5,                     !- View Factor to Ground
    autocalculate,           !- Number of Vertices
    0,                       !- Vertex 1 X-coordinate {m}
    0,                       !- Vertex 1 Y-coordinate {m}
    3,                       !- Vertex 1 Z-coordinate {m}
    0,                       !- Vertex 2 X-coordinate {m}
    0,                       !- Vertex 2 Y-coordinate {m}
    0,                       !- Vertex 2 Z-coordinate {m}
    4,                       !- Vertex 3 X-coordinate {m}
    0,                       !- Vertex 3 Y-coordinate {m}
    0;                       !- Vertex 3 Z-coordinate {m}
`
    const { doc, model } = load(HEADER + onePerLine)
    insertVertexWorld(doc, model, idOf(model, 'South'), 2, { x: 2, y: 0, z: 1.5 })

    // `autocalculate` is left alone: it already means "count them".
    expect(emitIdf(doc)).toBe(
      HEADER +
        onePerLine.replace(
          `    0;                       !- Vertex 3 Z-coordinate {m}
`,
          `    0,                       !- Vertex 3 Z-coordinate {m}
    2,                       !- Vertex 4 X-coordinate {m}
    0,                       !- Vertex 4 Y-coordinate {m}
    1.5;                     !- Vertex 4 Z-coordinate {m}
`,
        ),
    )
  })

  it('changes nothing outside the edited object', () => {
    const { doc, model } = load(HEADER + WALL + WALL.replace('South', 'Other'))
    const before = emitIdf(doc)
    insertVertexWorld(doc, model, idOf(model, 'South'), 0, { x: 0, y: 0, z: 1.5 })
    const after = emitIdf(doc)
    const otherAt = (s: string): string => s.slice(s.indexOf('    Other,'))
    expect(otherAt(after)).toBe(otherAt(before))
    expect([...doc.objects.values()].filter((o) => o.dirty).map((o) => o.id)).toEqual([
      idOf(model, 'South'),
    ])
  })
})

describe('deleteVertex — text', () => {
  it('removes a middle vertex and renumbers what follows', () => {
    const { doc, model } = load(HEADER + WALL)
    const r = deleteVertex(doc, model, idOf(model, 'South'), 1)
    expect(r.changed).toBe(true)
    expect(emitIdf(doc)).toBe(
      HEADER +
        HEAD_LINES.replace('    4,                       !- Number of Vertices', '    3,                       !- Number of Vertices') +
        `    0,0,3,  !- X,Y,Z ==> Vertex 1 {m}
    4,0,0,  !- X,Y,Z ==> Vertex 2 {m}
    4,0,3;  !- X,Y,Z ==> Vertex 3 {m}
`,
    )
  })

  it('removes the last vertex, moving the terminator and its comment up', () => {
    const { doc, model } = load(HEADER + WALL)
    deleteVertex(doc, model, idOf(model, 'South'), 3)
    expect(emitIdf(doc)).toBe(
      HEADER +
        HEAD_LINES.replace('    4,                       !- Number of Vertices', '    3,                       !- Number of Vertices') +
        `    0,0,3,  !- X,Y,Z ==> Vertex 1 {m}
    0,0,0,  !- X,Y,Z ==> Vertex 2 {m}
    4,0,0;  !- X,Y,Z ==> Vertex 3 {m}
`,
    )
  })

  it('insert then delete of the same vertex is byte-identical to the original', () => {
    const source = HEADER + WALL
    const { doc, model } = load(source)
    const id = idOf(model, 'South')
    insertVertexWorld(doc, model, id, 2, { x: 4, y: 0, z: 1.5 })
    expect(emitIdf(doc)).not.toBe(source)
    deleteVertex(doc, model, id, 3)
    expect(emitIdf(doc)).toBe(source)
  })

  it('revert restores both the text and the typed vertices', () => {
    const source = HEADER + WALL
    const { doc, model } = load(source)
    const id = idOf(model, 'South')
    deleteVertex(doc, model, id, 0)
    expect(model.surfaces.get(id)!.vertices).toHaveLength(3)
    revertObject(doc, model, id)
    expect(emitIdf(doc)).toBe(source)
    expect(model.surfaces.get(id)!.vertices).toHaveLength(4)
    expect(model.surfaces.get(id)!.declaredVertexCount).toBe('4')
  })
})

describe('vertex count edits — geometry', () => {
  it('refuses to take a surface below three vertices', () => {
    const tri = WALL.replace('    4,0,3;  !- X,Y,Z ==> Vertex 4 {m}\n', '').replace(
      '    4,0,0,  !- X,Y,Z ==> Vertex 3 {m}',
      '    4,0,0;  !- X,Y,Z ==> Vertex 3 {m}',
    ).replace('    4,                       !- Number', '    3,                       !- Number')
    const source = HEADER + tri
    const { doc, model } = load(source)
    const r = deleteVertex(doc, model, idOf(model, 'South'), 0)
    expect(r.changed).toBe(false)
    expect(r.refused).toMatch(/at least 3/)
    expect(emitIdf(doc)).toBe(source)
  })

  it('refuses a fifth vertex on a window — the IDD stops at four', () => {
    const source =
      HEADER +
      WALL +
      `  FenestrationSurface:Detailed,
    Win,Window,G1,South,,0.5,,1,4,
    1,0,2, 1,0,1, 2,0,1, 2,0,2;
`
    const { doc, model } = load(source)
    const r = insertVertexWorld(doc, model, idOf(model, 'Win'), 0, { x: 1, y: 0, z: 1.5 })
    expect(r.changed).toBe(false)
    expect(r.refused).toMatch(/at most 4/)
    expect(emitIdf(doc)).toBe(source)
  })

  // Clockwise entry reverses all but vertex 1, and LowerLeftCorner rotates the ring; together
  // they make resolved order and file order disagree on every edge but one.
  it.each([
    ['UpperLeftCorner', 'Counterclockwise'],
    ['LowerLeftCorner', 'Counterclockwise'],
    ['UpperLeftCorner', 'Clockwise'],
    ['LowerRightCorner', 'Clockwise'],
  ])('lands between the two vertices it was asked for (%s, %s)', (corner, direction) => {
    const header = HEADER.replace('UpperLeftCorner,Counterclockwise', `${corner},${direction}`)
    for (let edge = 0; edge < 4; edge++) {
      const { doc, model } = load(header + WALL)
      const id = idOf(model, 'South')
      const before = resolveSurface(model, model.surfaces.get(id)!, transformContext(model)).worldVertices
      const a = before[edge]!
      const b = before[(edge + 1) % 4]!
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }

      insertVertexWorld(doc, model, id, edge, mid)

      const ring = reread(doc, 'South')
      expect(ring).toHaveLength(5)
      const at = ring.findIndex((v) => v[0] === mid.x && v[1] === mid.y && v[2] === mid.z)
      expect(at, `edge ${edge}: new vertex missing`).not.toBe(-1)
      const neighbours = [ring[(at + 4) % 5]!, ring[(at + 1) % 5]!]
      expect(neighbours).toContainEqual([a.x, a.y, a.z])
      expect(neighbours).toContainEqual([b.x, b.y, b.z])
      // The typed Model agrees with what a fresh parse sees, without a rebuild.
      const live = resolveSurface(model, model.surfaces.get(id)!, transformContext(model))
      expect(live.worldVertices.map((v) => [round(v.x), round(v.y), round(v.z)])).toEqual(ring)
    }
  })

  it('writes relative coordinates in the zone’s frame, rotated and offset', () => {
    const header = `Version,26.1;
Building,B,30;
GlobalGeometryRules,UpperLeftCorner,Counterclockwise,Relative;
Zone,Z1,37,10,5,1;
`
    const { doc, model } = load(header + WALL)
    const id = idOf(model, 'South')
    const before = resolveSurface(model, model.surfaces.get(id)!, transformContext(model)).worldVertices
    const a = before[1]!
    const b = before[2]!
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }
    insertVertexWorld(doc, model, id, 1, mid)

    const ring = reread(doc, 'South')
    const hit = ring.find(
      (v) => Math.abs(v[0] - mid.x) < 1e-9 && Math.abs(v[1] - mid.y) < 1e-9 && Math.abs(v[2] - mid.z) < 1e-9,
    )
    expect(hit, 'inserted point did not resolve back to where it was placed').toBeTruthy()
    // And in the file it is the zone-local midpoint, not the world one.
    expect(emitIdf(doc)).toContain('    2,0,0,  !- X,Y,Z ==> Vertex 3 {m}')
  })
})

describe('vertex count edits — interzone twins', () => {
  const pair = (twinOffset: number): string =>
    HEADER +
    WALL.replace('Outdoors,', 'Surface,')
      .replace('    ,                        !- Outside Boundary Condition Object', '    North,                   !- Outside Boundary Condition Object')
      .replace('SunExposed', 'NoSun')
      .replace('WindExposed', 'NoWind') +
    `  BuildingSurface:Detailed,
    North,Wall,C1,Z2,,Surface,South,NoSun,NoWind,0.5,4,
    4,${twinOffset},3, 4,${twinOffset},0, 0,${twinOffset},0, 0,${twinOffset},3;
`

  function errors(doc: IdfDocument): string[] {
    const m = buildModel(parseIdf(emitIdf(doc)))
    return validateModel(m, resolveModel(m))
      .issues.filter((i) => i.severity === 'error')
      .map((i) => i.code)
  }

  it('mirrors an insertion onto a coincident twin, keeping the pair valid', () => {
    const { doc, model } = load(pair(0))
    expect(errors(doc)).toEqual([])
    const r = insertVertexWorld(doc, model, idOf(model, 'South'), 1, { x: 2, y: 0, z: 0 })
    expect(r.twin).toEqual({ id: idOf(model, 'North'), name: 'North', mirrored: true })
    expect(r.dirtied.sort()).toEqual([idOf(model, 'North'), idOf(model, 'South')].sort())
    expect(reread(doc, 'North')).toContainEqual([2, 0, 0])
    expect(errors(doc)).toEqual([])
  })

  it('mirrors a deletion onto a coincident twin', () => {
    const { doc, model } = load(pair(0))
    const south = idOf(model, 'South')
    insertVertexWorld(doc, model, south, 1, { x: 2, y: 0, z: 0 })
    const r = deleteVertex(doc, model, south, 2)
    expect(r.twin?.mirrored).toBe(true)
    expect(reread(doc, 'North')).not.toContainEqual([2, 0, 0])
    expect(errors(doc)).toEqual([])
  })

  it('reports, rather than guesses, when the twin is drawn offset', () => {
    const { doc, model } = load(pair(0.2))
    const r = insertVertexWorld(doc, model, idOf(model, 'South'), 1, { x: 2, y: 0, z: 0 })
    expect(r.changed).toBe(true)
    expect(r.twin?.mirrored).toBe(false)
    expect(r.twin?.reason).toMatch(/offset/)
    expect(r.dirtied).toEqual([idOf(model, 'South')])
    // Left alone, the pair is now inconsistent — and the validator says so.
    expect(errors(doc)).toContain('paired-vertex-count-mismatch')
  })

  it('leaves the twin when asked, and the validator flags the break', () => {
    const { doc, model } = load(pair(0))
    const r = insertVertexWorld(doc, model, idOf(model, 'South'), 1, { x: 2, y: 0, z: 0 }, { twin: 'leave' })
    expect(r.twin?.mirrored).toBe(false)
    expect(errors(doc)).toContain('paired-vertex-count-mismatch')
  })
})

// ---------------------------------------------------------------------------
// Breadth: every surface in the corpus
// ---------------------------------------------------------------------------

const BULK_DIR = join(import.meta.dirname, '../fixtures/testfiles')
const VERSIONS_DIR = join(import.meta.dirname, '../fixtures/versions')

function listCorpus(): Array<{ label: string; path: string }> {
  const out: Array<{ label: string; path: string }> = []
  if (existsSync(BULK_DIR)) {
    for (const f of readdirSync(BULK_DIR).filter((x) => x.endsWith('.idf')).sort()) {
      out.push({ label: f, path: join(BULK_DIR, f) })
    }
  }
  if (existsSync(VERSIONS_DIR)) {
    for (const dir of readdirSync(VERSIONS_DIR).sort()) {
      const full = join(VERSIONS_DIR, dir)
      for (const f of readdirSync(full).filter((x) => x.endsWith('.idf')).sort()) {
        out.push({ label: `${dir}/${f}`, path: join(full, f) })
      }
    }
  }
  return out
}

const corpus = listCorpus()

describe('vertex count edits — corpus', () => {
  /**
   * For every surface in every file: split edge 0 at its midpoint, check what the emitter wrote
   * for that one object, then delete the new vertex and require the object's original bytes
   * back. The text checks are on the rendered object alone; the unit tests above establish that
   * the live Model and a fresh parse agree, so re-parsing whole files 8,000 times buys nothing.
   */
  it.skipIf(corpus.length === 0)('split-then-rejoin is exact on every corpus surface', () => {
    let split = 0
    let capped = 0
    let spliced = 0
    let renumbered = 0

    for (const { label, path } of corpus) {
      const source = readFileSync(path, 'utf8')
      const doc = parseIdf(source)
      const model = buildModel(doc)
      const ctx = transformContext(model)

      for (const surface of model.surfaces.values()) {
        const obj = doc.objects.get(surface.id)!
        const schema = getSchema(surface.classKey, model.version)!
        const layout = vertexLayout(schema)
        const n = surface.vertices.length
        if (!layout || n < 3 || obj.start === null || obj.end === null) continue
        const where = `${label}: ${surface.name}`
        const original = source.slice(obj.start, obj.end)
        const fieldsBefore = obj.fields.map((f) => f.value)

        const ring = resolveSurface(model, surface, ctx).worldVertices
        const a = ring[0]!
        const b = ring[1]!
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }

        const r = insertVertexWorld(doc, model, surface.id, 0, mid, { twin: 'leave', ctx })
        if (n + 1 > layout.max) {
          expect(r.changed, `${where}: exceeded the class cap`).toBe(false)
          capped++
          continue
        }
        expect(r.changed, `${where}: ${r.refused}`).toBe(true)
        split++

        // What a fresh parse of the rendered object sees.
        const rendered = renderObject(obj, {}, source)
        const reparsed = [...parseIdf(rendered).objects.values()]
        expect(reparsed, `${where}: rendered text is not one object`).toHaveLength(1)
        expect(reparsed[0]!.fields.map((f) => f.value)).toEqual(obj.fields.map((f) => f.value))
        expect(obj.fields.length).toBe(fieldsBefore.length + layout.stride)

        // `Vertex N` comments name the vertex they now sit beside — where the file numbered
        // them correctly to begin with, which a few hand-edited files do not.
        const misnumbered = (fields: ReadonlyArray<{ comment?: string }>): number[] =>
          fields.flatMap((f, i) => {
            if (i < layout.beginIndex) return []
            const m = /vertex\s+(\d+)/i.exec(f.comment ?? '')
            const group = Math.floor((i - layout.beginIndex) / layout.stride) + 1
            return m && Number(m[1]) !== group ? [i] : []
          })
        const originalFields = parseIdf(original).objects.values().next().value!.fields
        const hasVertexComments = originalFields.some((f) => /vertex\s+\d+/i.test(f.comment ?? ''))
        if (hasVertexComments && misnumbered(originalFields).length === 0) {
          expect(misnumbered(reparsed[0]!.fields), `${where}: stale vertex comment\n${rendered}`).toEqual([])
          renumbered++
        }

        // Rendered by splicing, not regenerated: the head of the object is the file's own.
        const countIdx = schema.index.get('number of vertices')!
        const headEnd = obj.fields[countIdx]!.valueStart!
        if (rendered.startsWith(source.slice(obj.start, headEnd))) spliced++
        else throw new Error(`${where}: object was regenerated rather than spliced:\n${rendered}`)

        // The new vertex is where it was put, and between the two it was put between.
        const after = resolveSurface(model, surface, ctx).worldVertices
        expect(after).toHaveLength(n + 1)
        const at = after.findIndex((v) => Math.hypot(v.x - mid.x, v.y - mid.y, v.z - mid.z) < 1e-6)
        expect(at, `${where}: inserted vertex not found`).not.toBe(-1)
        const nb = [after[(at + n) % (n + 1)]!, after[(at + 1) % (n + 1)]!]
        for (const end of [a, b]) {
          expect(
            nb.some((v) => Math.hypot(v.x - end.x, v.y - end.y, v.z - end.z) < 1e-6),
            `${where}: inserted vertex is not adjacent to both ends of its edge`,
          ).toBe(true)
        }

        // Rejoin, and demand the original bytes.
        const d = deleteVertex(doc, model, surface.id, at, { twin: 'leave', ctx })
        expect(d.changed).toBe(true)
        expect(obj.fields.map((f) => f.value), where).toEqual(fieldsBefore)
        expect(renderObject(obj, {}, source), where).toBe(original)
      }

      // Every surface edited and restored: the file as a whole must be the file again.
      expect(emitIdf(doc), `${label}: whole-file round trip`).toBe(source)
    }

    expect(split).toBeGreaterThan(5_000)
    console.log(
      `vertex split/rejoin: ${split} surfaces across ${corpus.length} files, all spliced, ` +
        `all byte-identical after rejoin; ${renumbered} with vertex comments checked for renumbering; ` +
        `${capped} refused at the class vertex cap`,
    )
  })
})
