/**
 * A headless editing session for driving cartes programmatically — the core of the MCP server
 * (Phase 9 of docs/05-implementation-plan.md).
 *
 * Every operation here is one the UI performs, through the same functions and with the same
 * undo history, so an LLM driving this gets exactly the guarantees a person clicking does:
 * surgical field-level writes, byte-identical round trips for everything untouched, twins kept
 * in step, proposals rather than silent rewrites. Objects are addressed by name, never by the
 * positional ids the Document uses internally, and every result is plain JSON.
 *
 * No MCP SDK dependency here; `server.ts` is the thin protocol layer on top.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { emitIdf, parseIdf, type IdfDocument } from '../parser/index.js'
import {
  applySurfaceDeletion,
  buildModel,
  buildReferenceIndex,
  EditHistory,
  fieldNameAt,
  getSchema,
  LATEST_IDD_VERSION,
  newModelSource,
  planSurfaceDeletion,
  setFieldValue,
  type Model,
} from '../model/index.js'
import {
  applyMatchProposals,
  applyTier3Conversion,
  applyZoneTranslation,
  extrudeZone,
  placeOpening,
  planTier3Conversion,
  planZoneTranslation,
  proposeMatches,
  resolveModel,
  suggestConstruction,
  suggestInteriorConstructions,
  validateModel,
  type MatchProposal,
} from '../geometry/index.js'
import { computeLineDiff } from '../diff/index.js'

export class SessionError extends Error {}

interface Open {
  name: string
  path?: string
  original: string
  doc: IdfDocument
  model: Model
  history: EditHistory
  /** The last proposals returned, so `apply_matches` can refer to them by id. */
  proposals: MatchProposal[]
}

function round(n: number, places = 3): number {
  const k = 10 ** places
  return Math.round(n * k) / k
}

export interface Summary {
  name: string
  version: string
  coordinateSystem: string
  zones: number
  surfaces: number
  simplifiedNotDrawn: Record<string, number>
  errors: number
  warnings: number
  canUndo: string | null
}

export class ModelSession {
  private open: Open | undefined

  // --- opening and saving --------------------------------------------------

  openFile(path: string): Summary {
    if (extname(path).toLowerCase() !== '.idf') throw new SessionError('Only .idf files can be opened.')
    return this.openText(readFileSync(path, 'utf8'), basename(path), path)
  }

  openText(text: string, name = 'untitled.idf', path?: string): Summary {
    this.open?.history.detach()
    const doc = parseIdf(text)
    this.open = { name, original: text, doc, model: buildModel(doc), history: new EditHistory(doc), proposals: [] }
    if (path !== undefined) this.open.path = path
    return this.summary()
  }

  newModel(): Summary {
    return this.openText(newModelSource(LATEST_IDD_VERSION), 'untitled.idf')
  }

  /** Write the file. Nothing is written anywhere unless this is called. */
  save(path?: string): { path: string; bytes: number; changedObjects: number } {
    const o = this.need()
    const target = path ?? o.path
    if (!target) throw new SessionError('This model has no file yet; give a path ending in .idf.')
    if (extname(target).toLowerCase() !== '.idf') throw new SessionError('The path must end in .idf.')
    const text = emitIdf(o.doc)
    writeFileSync(target, text, 'utf8')
    return { path: target, bytes: Buffer.byteLength(text), changedObjects: [...o.doc.objects.values()].filter((x) => x.dirty).length }
  }

  text(): string {
    return emitIdf(this.need().doc)
  }

  /** A unified diff of everything changed since the file was opened. */
  diff(): { added: number; deleted: number; unified: string } {
    const o = this.need()
    const d = computeLineDiff(o.original, emitIdf(o.doc))
    return { added: d.addedLines, deleted: d.deletedLines, unified: d.unifiedText }
  }

  // --- reading -------------------------------------------------------------

  summary(): Summary {
    const o = this.need()
    const v = validateModel(o.model, resolveModel(o.model), o.doc)
    return {
      name: o.name,
      version: o.model.version,
      coordinateSystem: o.model.rules.coordinateSystem,
      zones: o.model.zones.size,
      surfaces: o.model.surfaces.size,
      simplifiedNotDrawn: Object.fromEntries(o.model.unrendered),
      errors: v.errorCount,
      warnings: v.warningCount,
      canUndo: o.history.undoLabel ?? null,
    }
  }

  listZones(): Array<{ name: string; surfaces: number; floorArea: number; origin: number[] }> {
    const o = this.need()
    const resolved = resolveModel(o.model)
    return [...o.model.zones.values()].map((z) => {
      const ids = [...o.model.zoneOf].filter(([, zid]) => zid === z.id).map(([id]) => id)
      const floorArea = ids
        .filter((id) => {
          const s = o.model.surfaces.get(id)
          return s?.kind === 'base' && s.surfaceType.toLowerCase() === 'floor'
        })
        .reduce((a, id) => a + (resolved.get(id)?.area ?? 0), 0)
      return { name: z.name, surfaces: ids.length, floorArea: round(floorArea), origin: [z.origin.x, z.origin.y, z.origin.z] }
    })
  }

  listSurfaces(zone?: string): Array<{
    name: string
    class: string
    type: string
    zone: string | null
    construction: string | null
    boundary: string | null
    area: number
    vertices: number[][]
  }> {
    const o = this.need()
    const resolved = resolveModel(o.model)
    const wanted = zone?.trim().toLowerCase()
    const out = []
    for (const id of o.model.surfaceOrder) {
      const s = o.model.surfaces.get(id)!
      const zid = o.model.zoneOf.get(id)
      const zoneName = zid === undefined ? null : (o.model.zones.get(zid)?.name ?? null)
      if (wanted !== undefined && zoneName?.toLowerCase() !== wanted) continue
      const r = resolved.get(id)
      out.push({
        name: s.name,
        class: s.className,
        type: s.kind === 'shading' ? 'Shading' : s.surfaceType,
        zone: zoneName,
        construction: s.kind === 'shading' ? null : s.constructionName,
        boundary:
          s.kind === 'base'
            ? s.outsideBoundaryCondition + (s.outsideBoundaryConditionObject ? `: ${s.outsideBoundaryConditionObject}` : '')
            : s.kind === 'sub'
              ? s.outsideBoundaryConditionObject || null
              : null,
        area: round(r?.area ?? 0),
        vertices: (r?.worldVertices ?? []).map((v) => [round(v.x), round(v.y), round(v.z)]),
      })
    }
    return out
  }

  /** Every field of one object, by IDD field name. Any class, not just geometry. */
  inspect(name: string): { class: string; fields: Array<{ index: number; name: string; value: string }> } {
    const o = this.need()
    const obj = this.objectNamed(name)
    const schema = getSchema(obj.classKey, o.model.version)
    return {
      class: obj.className,
      fields: obj.fields.map((f, i) => ({ index: i, name: (schema && fieldNameAt(schema, i)) ?? `Field ${i + 1}`, value: f.value })),
    }
  }

  validate(): Array<{ severity: string; code: string; object: string; message: string; fix?: string }> {
    const o = this.need()
    return validateModel(o.model, resolveModel(o.model), o.doc).issues.map((i) => ({
      severity: i.severity,
      code: i.code,
      object: i.objectName,
      message: i.message,
      ...(i.fixDescription ? { fix: i.fixDescription } : {}),
    }))
  }

  // --- editing -------------------------------------------------------------

  /** Set one field of any object, by field name or index. */
  setField(object: string, field: string | number, value: string): { changed: boolean } {
    const o = this.need()
    const obj = this.objectNamed(object)
    let index = typeof field === 'number' ? field : undefined
    if (index === undefined) {
      const schema = getSchema(obj.classKey, o.model.version)
      index = schema?.index.get(String(field).toLowerCase())
      if (index === undefined) throw new SessionError(`${obj.className} has no field '${field}'.`)
    }
    const changed = setFieldValue(o.doc, o.model, obj.id, index, value)
    this.rebuild()
    return { changed }
  }

  extrudeZone(args: {
    name: string
    footprint: Array<[number, number]>
    height: number
    baseZ?: number
    constructions?: { wall?: string | undefined; floor?: string | undefined; roof?: string | undefined }
  }): { zone: string; surfaces: string[] } {
    const o = this.need()
    const wall = args.constructions?.wall ?? suggestConstruction(o.doc, o.model, 'exterior-wall')
    const floor = args.constructions?.floor ?? suggestConstruction(o.doc, o.model, 'ground-floor')
    const roof = args.constructions?.roof ?? suggestConstruction(o.doc, o.model, 'roof')
    if (!wall || !floor || !roof) {
      throw new SessionError('No construction found for walls, floor or roof; name them in `constructions`, or start from new_model.')
    }
    const r = extrudeZone(o.doc, o.model, {
      zoneName: args.name,
      footprint: args.footprint.map(([x, y]) => ({ x, y })),
      height: args.height,
      ...(args.baseZ !== undefined ? { baseZ: args.baseZ } : {}),
      constructions: { wall, floor, roof },
    })
    if (r.refused) throw new SessionError(r.refused)
    const surfaces = r.created.slice(1).map((id) => this.nameOf(id))
    this.rebuild()
    return { zone: args.name, surfaces }
  }

  addOpening(args: {
    surface: string
    type?: 'Window' | 'Door' | 'GlassDoor'
    width: number
    height: number
    sill: number
    offset?: number
    construction?: string
  }): { created: string[] } {
    const o = this.need()
    const base = this.surfaceNamed(args.surface)
    const type = args.type ?? 'Window'
    const construction = args.construction ?? suggestConstruction(o.doc, o.model, type === 'Door' ? 'door' : 'window')
    if (!construction) throw new SessionError(`No ${type.toLowerCase()} construction found; name one in \`construction\`.`)
    const r = placeOpening(o.doc, o.model, base, {
      surfaceType: type,
      construction,
      width: args.width,
      height: args.height,
      sill: args.sill,
      ...(args.offset !== undefined ? { offset: args.offset } : {}),
    })
    if (r.refused) throw new SessionError(r.refused)
    const created = r.created.map((id) => this.nameOf(id))
    this.rebuild()
    return { created }
  }

  moveZone(zone: string, dx: number, dy: number, dz: number): { changedObjects: number; splitPairs: string[]; leftBehind: string[] } {
    const o = this.need()
    const z = [...o.model.zones.values()].find((x) => x.name.toLowerCase() === zone.trim().toLowerCase())
    if (!z) throw new SessionError(`No zone named '${zone}'.`)
    const plan = planZoneTranslation(o.doc, o.model, z.id, { x: dx, y: dy, z: dz })!
    const r = applyZoneTranslation(o.doc, o.model, plan)
    this.rebuild()
    return {
      changedObjects: r.dirtied.length,
      splitPairs: plan.splitPairs.map((p) => `${p.surfaceName} / ${p.twinName}`),
      leftBehind: plan.leftBehind.map((l) => `${l.name}: ${l.reason}`),
    }
  }

  /**
   * Delete a surface and anything that cannot exist without it. An interzone twin is left
   * dangling unless `twin` is `adiabatic` — the same explicit choice the UI asks for.
   */
  deleteSurface(name: string, twin: 'leave' | 'adiabatic' = 'leave'): { deleted: string[]; twinsRepaired: string[]; danglingReferences: number } {
    const o = this.need()
    const id = this.surfaceNamed(name)
    const plan = planSurfaceDeletion(o.doc, o.model, buildReferenceIndex(o.doc, o.model.version), id)!
    const r = applySurfaceDeletion(o.doc, o.model, plan, { twins: twin })
    const deleted = [plan.surfaceName, ...plan.cascade.map((c) => c.name)].slice(0, r.deleted.length)
    this.rebuild()
    return {
      deleted,
      twinsRepaired: twin === 'adiabatic' ? plan.twins.map((t) => t.name) : [],
      danglingReferences: plan.otherReferences.length + plan.undeclaredMentions.length + (twin === 'leave' ? plan.twins.length : 0),
    }
  }

  /** Propose interzone pairings. Changes nothing. */
  proposeMatches(): Array<{ id: string; kind: string; surfaces: [string, string]; reason: string; changes: string[] }> {
    const o = this.need()
    const report = proposeMatches(o.doc, o.model, resolveModel(o.model), undefined, {
      interiorConstructions: suggestInteriorConstructions(o.doc, o.model),
    })
    o.proposals = report.proposals
    return report.proposals.map((p) => ({
      id: p.id,
      kind: p.kind,
      surfaces: [this.nameOf(p.a), this.nameOf(p.b)],
      reason: p.reason,
      changes: p.changes.map((c) => `${c.objectName}.${c.fieldName}: '${c.from}' → '${c.to}'`),
    }))
  }

  /** Apply proposals from the last `proposeMatches`, all or those named. */
  applyMatches(ids?: string[]): { applied: number; changedObjects: number } {
    const o = this.need()
    const chosen = ids ? o.proposals.filter((p) => ids.includes(p.id)) : o.proposals
    if (ids && chosen.length !== ids.length) {
      throw new SessionError('Unknown proposal id; call propose_matches again, since ids refer to the last proposals only.')
    }
    const dirtied = applyMatchProposals(o.doc, o.model, chosen)
    o.proposals = []
    this.rebuild()
    return { applied: chosen.length, changedObjects: dirtied.length }
  }

  /** Rewrite EnergyPlus's simplified surface classes with explicit vertices. */
  convertSimplified(): { converted: number; created: number; refused: string[]; notes: string[] } {
    const o = this.need()
    const plan = planTier3Conversion(o.doc, o.model)
    const r = applyTier3Conversion(o.doc, o.model, plan)
    this.rebuild()
    return {
      converted: r.removed.length,
      created: r.created.length,
      refused: plan.refused.map((x) => `${x.name}: ${x.reason}`),
      notes: plan.notes,
    }
  }

  undo(): { undid: string | null } {
    const step = this.need().history.undo()
    this.rebuild()
    return { undid: step?.label ?? null }
  }

  redo(): { redid: string | null } {
    const step = this.need().history.redo()
    this.rebuild()
    return { redid: step?.label ?? null }
  }

  // --- helpers ---------------------------------------------------------------

  private need(): Open {
    if (!this.open) throw new SessionError('No model is open; call open_idf or new_model first.')
    return this.open
  }

  private rebuild(): void {
    const o = this.need()
    o.model = buildModel(o.doc)
  }

  private nameOf(id: string): string {
    return this.need().doc.objects.get(id)?.fields[0]?.value ?? id
  }

  private objectNamed(name: string): { id: string; classKey: string; className: string; fields: Array<{ value: string }> } {
    const o = this.need()
    const wanted = name.trim().toLowerCase()
    const matches = [...o.doc.objects.values()].filter((x) => x.fields[0]?.value.trim().toLowerCase() === wanted)
    if (matches.length === 0) throw new SessionError(`No object named '${name}'.`)
    // Surfaces first: a zone and its floor can share a name in hand-written files.
    return matches.find((m) => o.model.surfaces.has(m.id)) ?? matches[0]!
  }

  private surfaceNamed(name: string): string {
    const wanted = name.trim().toLowerCase()
    for (const s of this.need().model.surfaces.values()) if (s.name.trim().toLowerCase() === wanted) return s.id
    throw new SessionError(`No surface named '${name}'.`)
  }
}
