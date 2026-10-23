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
 * No MCP SDK dependency here and no disk access, so the same session runs in the browser:
 * `server.ts` adds files and the protocol on top; the in-app agent `attach`es it to the open
 * document instead.
 *
 * Classes beyond geometry are read through the full EnergyPlus schema (`src/schema/`), which
 * loads asynchronously: hosts call `prepare()` before each operation, and every operation stays
 * synchronous, so a tool call is still exactly one undo step.
 */
import { emitIdf, parseIdf, type IdfDocument, type IdfObject } from '../parser/index.js'
import {
  applySurfaceDeletion,
  buildModel,
  buildReferenceIndex,
  createObject,
  EditHistory,
  fieldNameAt,
  fieldSpecAt,
  getSchema,
  LATEST_IDD_VERSION,
  newModelSource,
  planSurfaceDeletion,
  removeObjects,
  setFieldValue,
  type Model,
} from '../model/index.js'
import {
  describeClass,
  displayName,
  findClasses,
  loadProse,
  loadSchema,
  schemaIssues,
  slotAt,
  slotIndex,
  valueProblem,
  type ClassDescription,
  type ClassMatch,
  type ProsePool,
  type Schema,
  type SlimType,
} from '../schema/index.js'
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
  /** False when attached: the history belongs to whoever attached it. */
  ownsHistory: boolean
}

/** A document someone else has open — the app's — for the session to work on in place. */
export interface AttachedDocument {
  name: string
  original: string
  doc: IdfDocument
  model: Model
  history: EditHistory
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

/** A field value as tools accept it: numbers are written as given. */
export type FieldInput = string | number

/** Field issues returned by `validate` beyond this many are counted, not listed. */
const MAX_FIELD_ISSUES = 150

/**
 * Internal loads and air flows, by class: the field holding the calculation method, and the
 * offset after it of the field each method reads. Offsets rather than names, because the names
 * changed across releases (`watts_per_zone_floor_area` became `watts_per_floor_area` in 22.x)
 * while the layout did not.
 */
const LOAD_CLASSES: Record<string, Record<string, number>> = {
  People: { people: 1, 'people/area': 2, 'area/person': 3 },
  Lights: { lightinglevel: 1, 'watts/area': 2, 'watts/person': 3 },
  ElectricEquipment: { equipmentlevel: 1, 'watts/area': 2, 'watts/person': 3 },
  GasEquipment: { equipmentlevel: 1, 'watts/area': 2, 'power/area': 2, 'watts/person': 3, 'power/person': 3 },
  HotWaterEquipment: { equipmentlevel: 1, 'watts/area': 2, 'power/area': 2, 'watts/person': 3, 'power/person': 3 },
  SteamEquipment: { equipmentlevel: 1, 'watts/area': 2, 'power/area': 2, 'watts/person': 3, 'power/person': 3 },
  OtherEquipment: { equipmentlevel: 1, 'watts/area': 2, 'power/area': 2, 'watts/person': 3, 'power/person': 3 },
  'ZoneInfiltration:DesignFlowRate': { 'flow/zone': 1, 'flow/area': 2, 'flow/exteriorarea': 3, 'flow/exteriorwallarea': 3, 'airchanges/hour': 4 },
  'ZoneVentilation:DesignFlowRate': { 'flow/zone': 1, 'flow/area': 2, 'flow/person': 3, 'airchanges/hour': 4 },
}

/** Methods whose value is a per-floor-area density, and those whose value is its inverse. */
const PER_AREA = new Set(['people/area', 'watts/area', 'power/area', 'flow/area'])
const ABSOLUTE = new Set(['people', 'lightinglevel', 'equipmentlevel', 'flow/zone'])

export interface LoadEntry {
  class: string
  name: string
  /** The zone, zone list or space it applies to. */
  target: string
  schedule: string
  method: string
  value: number | string
  units: string
  /** The load per m2 of the target's floor area, when it can be worked out. */
  perFloorArea?: { value: number; units: string }
}

interface Referrer {
  id: string
  className: string
  name: string
  index: number
  field: string
}

export class ModelSession {
  private open: Open | undefined
  /** The full schema for `version`, or undefined when the bundle has none (files before 8.9) or failed to load. */
  private full: { version: string; schema: Schema | undefined } | undefined
  private prose: ProsePool | undefined

  // --- opening and saving --------------------------------------------------

  openText(text: string, name = 'untitled.idf', path?: string): Summary {
    this.release()
    const doc = parseIdf(text)
    this.open = { name, original: text, doc, model: buildModel(doc), history: new EditHistory(doc), proposals: [], ownsHistory: true }
    if (path !== undefined) this.open.path = path
    return this.summary()
  }

  /**
   * Work on a document that is already open elsewhere, in place: edits land in its own undo
   * history. Call again whenever the owner's model may have changed; proposals survive only
   * while the document is the same one.
   */
  attach(d: AttachedDocument): void {
    const proposals = this.open?.doc === d.doc ? this.open.proposals : []
    if (this.open?.doc !== d.doc) this.release()
    this.open = { name: d.name, original: d.original, doc: d.doc, model: d.model, history: d.history, proposals, ownsHistory: false }
  }

  /** The model as last rebuilt, for whoever attached the document to pick up edits. */
  get model(): Model | undefined {
    return this.open?.model
  }

  /** Where the model was opened from, if from a file. */
  get path(): string | undefined {
    return this.open?.path
  }

  /**
   * Load the full schema for the open model's version (and the field notes, if asked). Cheap
   * once loaded. A failure is not an error: operations that need the schema say so.
   */
  async prepare(opts: { prose?: boolean } = {}): Promise<void> {
    const version = this.schemaVersionKey()
    if (this.full?.version !== version) {
      const schema = await loadSchema(version).catch(() => undefined)
      this.full = { version, schema }
    }
    if (opts.prose && !this.prose) this.prose = await loadProse().catch(() => undefined)
  }

  /** Run `fn` as one undo step — so a tool call is undone as a whole. */
  transact<T>(label: string, fn: () => T): T {
    return this.need().history.transact(label, fn)
  }

  newModel(): Summary {
    return this.openText(newModelSource(LATEST_IDD_VERSION), 'untitled.idf')
  }

  /** Objects changed since the file was opened. */
  changedObjects(): number {
    return [...this.need().doc.objects.values()].filter((x) => x.dirty).length
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

  /** Class counts, or — given a class — the names of its objects. */
  listObjects(
    className?: string,
    limit = 200,
  ): { classes: Array<{ class: string; count: number }> } | { class: string; count: number; names: string[]; truncated: boolean } {
    const o = this.need()
    if (className === undefined || className.trim() === '') {
      return {
        classes: [...o.doc.byClass]
          .filter(([, ids]) => ids.length > 0)
          .map(([, ids]) => ({ class: o.doc.objects.get(ids[0]!)!.className, count: ids.length }))
          .sort((a, b) => a.class.localeCompare(b.class)),
      }
    }
    const ids = o.doc.byClass.get(className.trim().toLowerCase()) ?? []
    const objs = ids.map((id) => o.doc.objects.get(id)).filter((x) => x !== undefined)
    if (objs.length === 0) throw new SessionError(`No ${className} objects; call list_objects without a class to see what the file has.`)
    return {
      class: objs[0]!.className,
      count: objs.length,
      names: objs.slice(0, limit).map((x) => x.fields[0]?.value ?? ''),
      truncated: objs.length > limit,
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
  inspect(
    name: string,
    className?: string,
  ): { class: string; fields: Array<{ index: number; name: string; value: string; units?: string }> } {
    const obj = this.objectNamed(name, className)
    return {
      class: obj.className,
      fields: obj.fields.map((f, i) => {
        const units = this.unitsAt(obj, i)
        return { index: i, name: this.fieldLabel(obj, i), value: f.value, ...(units ? { units } : {}) }
      }),
    }
  }

  /** Classes whose name or IDD group contains every word of `query`. Any class EnergyPlus has, not only those in the file. */
  findClasses(query: string, limit?: number): { matches: ClassMatch[]; total: number } {
    return findClasses(this.needSchema(), query, this.prose, limit)
  }

  /** A class's fields: positions, units, choices, bounds, defaults, references and notes. */
  describeClass(className: string): ClassDescription {
    const d = describeClass(this.needSchema(), className, this.prose)
    if (!d) throw new SessionError(`EnergyPlus ${this.full?.schema?.version ?? ''} has no class '${className}'; try find_classes.`)
    return d
  }

  /**
   * Geometry and reference checks as EnergyPlus raises them, then — when the full schema is
   * loaded — field checks over every class: choices, numbers, bounds, required fields,
   * dangling references and duplicate singletons.
   */
  validate(): Array<{ severity: string; code: string; object: string; class?: string; field?: string; message: string; fix?: string }> {
    const o = this.need()
    const out: Array<{ severity: string; code: string; object: string; class?: string; field?: string; message: string; fix?: string }> =
      validateModel(o.model, resolveModel(o.model), o.doc).issues.map((i) => ({
        severity: i.severity,
        code: i.code,
        object: i.objectName,
        message: i.message,
        ...(i.fixDescription ? { fix: i.fixDescription } : {}),
      }))
    const schema = this.schema()
    if (!schema) return out
    const issues = schemaIssues(emitIdf(o.doc), schema)
    for (const i of issues.slice(0, MAX_FIELD_ISSUES)) {
      out.push({
        severity: i.severity,
        code: i.code,
        object: i.objectName || i.className,
        class: i.className,
        ...(i.field ? { field: i.field } : {}),
        message: i.message,
      })
    }
    if (issues.length > MAX_FIELD_ISSUES) {
      out.push({ severity: 'info', code: 'more', object: '', message: `${issues.length - MAX_FIELD_ISSUES} more field issues not listed.` })
    }
    return out
  }

  // --- editing -------------------------------------------------------------

  /** Set one field of any object, by field name or index. Values the schema forbids are refused. */
  setField(object: string, field: string | number, value: FieldInput, className?: string): { changed: boolean } {
    const o = this.need()
    const obj = this.objectNamed(object, className)
    const index = this.fieldIndexOf(obj, field)
    this.checkValue(obj, index, value)
    const changed = setFieldValue(o.doc, o.model, obj.id, index, String(value))
    this.rebuild()
    return { changed }
  }

  /** Set several fields of one object, all or none, as one undo step. */
  updateObject(object: string, fields: Record<string, FieldInput>, className?: string): { object: string; changed: string[] } {
    const o = this.need()
    const obj = this.objectNamed(object, className)
    const writes = this.planWrites(obj, fields)
    const changed: string[] = []
    o.history.transact(`Update ${obj.className}`, () => {
      for (const w of writes) if (setFieldValue(o.doc, o.model, obj.id, w.index, w.value)) changed.push(this.fieldLabel(obj, w.index))
    })
    this.rebuild()
    return { object: this.describeObject(obj), changed }
  }

  /**
   * Add an object of any class. Fields are named in either spelling; a repeating tail
   * (vertices, schedule lines, list entries) is given as groups, each in the class's group order.
   */
  addObject(args: {
    className: string
    name?: string | undefined
    fields?: Record<string, FieldInput> | undefined
    extensible?: FieldInput[][] | undefined
    after?: string | undefined
  }): { created: string; fields: number } {
    const o = this.need()
    const schema = this.needSchema()
    const canonical = schema.resolve(args.className)
    const type = canonical ? schema.get(canonical) : undefined
    if (!canonical || !type) throw new SessionError(`EnergyPlus ${schema.version} has no class '${args.className}'; try find_classes.`)
    if (type.s && (o.doc.byClass.get(canonical.toLowerCase())?.length ?? 0) > 0) {
      throw new SessionError(`${canonical} can appear only once and the file already has one; change it with update_object.`)
    }

    const values: string[] = []
    const put = (i: number, v: FieldInput): void => {
      while (values.length <= i) values.push('')
      values[i] = String(v)
    }
    const problems: string[] = []
    if (!type.anon) {
      const name = args.name?.trim()
      if (name) {
        this.assertNameFree(canonical, type, name)
        put(0, name)
      } else if (type.nreq) {
        throw new SessionError(`${canonical} needs a name.`)
      }
    }
    for (const [field, value] of Object.entries(args.fields ?? {})) {
      const i = /^\d+$/.test(field) ? Number(field) : slotIndex(type, field)
      if (i === undefined || !slotAt(type, i)) throw new SessionError(`${canonical} has no field '${field}'; see describe_class.`)
      if (i === 0 && !type.anon) throw new SessionError('Give the name as `name`, not as a field.')
      const slot = slotAt(type, i)!
      const problem = valueProblem(slot.def, value)
      if (problem) problems.push(`${displayName(slot)} ${problem}`)
      put(i, value)
    }
    if (args.extensible?.length) {
      const x = type.x
      if (!x) throw new SessionError(`${canonical} has no repeating fields.`)
      args.extensible.forEach((group, g) => {
        if (group.length > x.fields.length) throw new SessionError(`Each ${canonical} group has ${x.fields.length} field(s): ${x.fields.join(', ')}.`)
        group.forEach((v, j) => {
          const i = type.f.length + g * x.fields.length + j
          const problem = valueProblem(x.p[x.fields[j]!], v)
          if (problem) problems.push(`${displayName(slotAt(type, i)!)} ${problem}`)
          put(i, v)
        })
      })
    }
    const missing = (type.r ?? []).filter((key) => {
      const i = type.f.indexOf(key)
      return i >= 0 && (values[i] ?? '').trim() === ''
    })
    if (missing.length) problems.push(`required field(s) missing: ${missing.join(', ')}`)
    if (problems.length) throw new SessionError(`Not added: ${problems.join('; ')}.`)
    while (values.length > 0 && values[values.length - 1] === '') values.pop()

    const after = args.after ? this.objectNamed(args.after).id : undefined
    const id = createObject(o.doc, canonical, values, after ? { after } : {})
    this.labelFields(id)
    this.rebuild()
    return { created: this.describeObject(o.doc.objects.get(id)!), fields: values.length }
  }

  // --- simulation settings, loads, outputs ------------------------------------------

  /** Time step, run periods, SimulationControl, location and design days, as the file has them. */
  simulationSettings(): {
    timestep: number | null
    runPeriods: Array<Record<string, string>>
    simulationControl: Record<string, string> | null
    location: Record<string, string> | null
    designDays: string[]
  } {
    const all = (cls: string): IdfObject[] =>
      (this.need().doc.byClass.get(cls.toLowerCase()) ?? []).map((id) => this.need().doc.objects.get(id)!).filter(Boolean)
    const ts = all('Timestep')[0]
    const control = all('SimulationControl')[0]
    const location = all('Site:Location')[0]
    return {
      timestep: ts ? Number(ts.fields[0]?.value ?? '') || null : null,
      runPeriods: all('RunPeriod').map((o) => this.fieldsByKey(o)),
      simulationControl: control ? this.fieldsByKey(control) : null,
      location: location ? this.fieldsByKey(location) : null,
      designDays: all('SizingPeriod:DesignDay').map((o) => o.fields[0]?.value ?? ''),
    }
  }

  /**
   * Change the time step, a run period's dates and SimulationControl flags, as one undo step.
   * A missing Timestep or RunPeriod is created.
   */
  setSimulationSettings(args: {
    timestep?: number | undefined
    runPeriod?:
      | { name?: string | undefined; beginMonth: number; beginDay: number; endMonth: number; endDay: number }
      | undefined
    simulationControl?: Record<string, FieldInput> | undefined
  }): { changed: string[] } {
    const o = this.need()
    const schema = this.needSchema()
    const changed: string[] = []
    if (args.timestep !== undefined && (!Number.isInteger(args.timestep) || args.timestep < 1 || 60 % args.timestep !== 0)) {
      throw new SessionError('The time step must be a whole number of steps per hour that divides 60 (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 or 60).')
    }
    const rp = args.runPeriod
    if (rp) {
      const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
      for (const [m, d] of [
        [rp.beginMonth, rp.beginDay],
        [rp.endMonth, rp.endDay],
      ] as const) {
        if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(d) || d < 1 || d > days[m - 1]!) {
          throw new SessionError(`${m}/${d} is not a date.`)
        }
      }
    }
    const one = (cls: string): IdfObject | undefined => {
      const id = o.doc.byClass.get(cls.toLowerCase())?.[0]
      return id ? o.doc.objects.get(id) : undefined
    }
    const control = args.simulationControl && Object.keys(args.simulationControl).length ? one('SimulationControl') : undefined
    if (args.simulationControl && Object.keys(args.simulationControl).length && !control) {
      throw new SessionError('The file has no SimulationControl; add one with add_object.')
    }
    const controlWrites = control ? this.planWrites(control, args.simulationControl!) : []
    let period: IdfObject | undefined
    if (rp) {
      const periods = (o.doc.byClass.get('runperiod') ?? []).map((id) => o.doc.objects.get(id)!)
      period = rp.name ? periods.find((p) => p.fields[0]?.value.trim().toLowerCase() === rp.name!.trim().toLowerCase()) : periods[0]
      if (rp.name && !period && periods.length) throw new SessionError(`No RunPeriod named '${rp.name}'.`)
      if (!rp.name && periods.length > 1) throw new SessionError(`The file has ${periods.length} run periods; name the one to change.`)
    }

    o.history.transact('Simulation settings', () => {
      if (args.timestep !== undefined) {
        const ts = one('Timestep')
        if (ts) {
          if (setFieldValue(o.doc, o.model, ts.id, 0, String(args.timestep))) changed.push(`Timestep ${args.timestep}`)
        } else {
          this.labelFields(createObject(o.doc, schema.resolve('Timestep') ?? 'Timestep', [String(args.timestep)]))
          changed.push(`Timestep ${args.timestep} (added)`)
        }
      }
      if (rp) {
        const type = schema.get('RunPeriod')!
        const at = (key: string): number => type.f.indexOf(key)
        const dates: Array<[string, number]> = [
          ['begin_month', rp.beginMonth],
          ['begin_day_of_month', rp.beginDay],
          ['end_month', rp.endMonth],
          ['end_day_of_month', rp.endDay],
        ]
        if (period) {
          for (const [key, v] of dates) setFieldValue(o.doc, o.model, period.id, at(key), String(v))
        } else {
          const values: string[] = [rp.name ?? 'Run Period 1']
          for (const [key, v] of dates) {
            while (values.length <= at(key)) values.push('')
            values[at(key)] = String(v)
          }
          this.labelFields(createObject(o.doc, 'RunPeriod', values))
        }
        changed.push(`RunPeriod ${rp.beginMonth}/${rp.beginDay}–${rp.endMonth}/${rp.endDay}${period ? '' : ' (added)'}`)
      }
      if (control) {
        for (const w of controlWrites) {
          if (setFieldValue(o.doc, o.model, control.id, w.index, w.value)) changed.push(`SimulationControl ${this.fieldLabel(control, w.index)} ${w.value}`)
        }
      }
    })
    this.rebuild()
    return { changed }
  }

  /**
   * People, lights, equipment, infiltration and ventilation: what each object sets, and the
   * per-floor-area equivalent where the target's floor area is known.
   */
  inspectLoads(zone?: string): { loads: LoadEntry[]; zoneFloorAreas: Record<string, number> } {
    const o = this.need()
    const schema = this.needSchema()
    const areas = new Map(this.listZones().map((z) => [z.name.toLowerCase(), z.floorArea]))
    const zoneLists = new Map<string, string[]>()
    for (const id of o.doc.byClass.get('zonelist') ?? []) {
      const zl = o.doc.objects.get(id)!
      zoneLists.set(zl.fields[0]?.value.trim().toLowerCase() ?? '', zl.fields.slice(1).map((f) => f.value.trim().toLowerCase()))
    }
    const zonesOf = (target: string): string[] => {
      const t = target.trim().toLowerCase()
      return zoneLists.get(t) ?? (areas.has(t) ? [t] : [])
    }
    const wanted = zone?.trim().toLowerCase()
    const loads: LoadEntry[] = []
    for (const [cls, methods] of Object.entries(LOAD_CLASSES)) {
      const type = schema.get(cls)
      if (!type) continue
      const m = type.f.findIndex((k) => k.endsWith('calculation_method'))
      const targetIndex = type.f.findIndex((k) => k.startsWith('zone_or_zonelist'))
      for (const id of o.doc.byClass.get(cls.toLowerCase()) ?? []) {
        const obj = o.doc.objects.get(id)!
        const target = obj.fields[targetIndex]?.value.trim() ?? ''
        const zones = zonesOf(target)
        if (wanted !== undefined && target.toLowerCase() !== wanted && !zones.includes(wanted)) continue
        const method = (obj.fields[m]?.value.trim() || String(type.p[type.f[m]!]?.d ?? '')).toLowerCase()
        const offset = methods[method]
        const valueIndex = offset === undefined ? -1 : m + offset
        const raw = valueIndex >= 0 ? (obj.fields[valueIndex]?.value.trim() ?? '') : ''
        const value = raw === '' ? '' : Number.isFinite(Number(raw)) ? Number(raw) : raw
        const def = valueIndex >= 0 ? type.p[type.f[valueIndex]!] : undefined
        const units = def?.u ?? (method === 'people' ? 'people' : '')
        const entry: LoadEntry = {
          class: cls,
          name: obj.fields[0]?.value ?? '',
          target,
          schedule: obj.fields[m - 1]?.value ?? '',
          method: obj.fields[m]?.value.trim() || String(type.p[type.f[m]!]?.d ?? ''),
          value,
          units,
        }
        // Each zone of a list gets the full value, so its density is the zone's own.
        const area = zones.length === 1 ? areas.get(zones[0]!) : undefined
        if (typeof value === 'number') {
          if (PER_AREA.has(method)) entry.perFloorArea = { value, units }
          else if (method === 'area/person' && value > 0) entry.perFloorArea = { value: round(1 / value, 4), units: 'person/m2' }
          else if (ABSOLUTE.has(method) && area) entry.perFloorArea = { value: round(value / area, 4), units: `${units}/m2` }
        }
        loads.push(entry)
      }
    }
    return { loads, zoneFloorAreas: Object.fromEntries(this.listZones().map((z) => [z.name, z.floorArea])) }
  }

  /**
   * Multiply the value each load object actually uses — whichever field its calculation method
   * reads — by `factor`, as one undo step. Area per person is divided, so the load still scales
   * by `factor`. Autosized and blank values are left alone.
   */
  scaleLoads(args: { className: string; factor: number; zone?: string | undefined; names?: string[] | undefined }): {
    changed: string[]
    skipped: string[]
  } {
    const o = this.need()
    const schema = this.needSchema()
    if (!(args.factor > 0) || !Number.isFinite(args.factor)) throw new SessionError('The factor must be a positive number.')
    const cls = Object.keys(LOAD_CLASSES).find((c) => c.toLowerCase() === args.className.trim().toLowerCase())
    if (!cls) throw new SessionError(`scale_loads works on ${Object.keys(LOAD_CLASSES).join(', ')}.`)
    const type = schema.get(cls)!
    const m = type.f.findIndex((k) => k.endsWith('calculation_method'))
    const names = args.names?.map((n) => n.trim().toLowerCase())
    const entries = this.inspectLoads(args.zone).loads.filter(
      (l) => l.class === cls && (!names || names.includes(l.name.trim().toLowerCase())),
    )
    if (entries.length === 0) throw new SessionError(`No ${cls} objects${args.zone ? ` for '${args.zone}'` : ''}${names ? ' with those names' : ''}.`)
    const changed: string[] = []
    const skipped: string[] = []
    o.history.transact(`Scale ${cls}`, () => {
      for (const e of entries) {
        const obj = this.objectNamed(e.name, cls)
        const method = e.method.toLowerCase()
        const offset = LOAD_CLASSES[cls]![method]
        if (typeof e.value !== 'number' || offset === undefined) {
          skipped.push(`${e.name}: ${e.value === '' ? 'no value' : e.value}`)
          continue
        }
        const next = method === 'area/person' ? e.value / args.factor : e.value * args.factor
        const text = String(Number(next.toPrecision(6)))
        setFieldValue(o.doc, o.model, obj.id, m + offset, text)
        changed.push(`${cls} '${e.name}': ${this.fieldLabel(obj, m + offset)} ${e.value} → ${text}`)
      }
    })
    this.rebuild()
    return { changed, skipped }
  }

  /** Request output variables and meters, skipping those already requested at that frequency. */
  addOutputs(args: { variables?: Array<{ name: string; key?: string | undefined }> | undefined; meters?: string[] | undefined; frequency: string }): {
    added: string[]
    alreadyRequested: string[]
  } {
    const o = this.need()
    const schema = this.needSchema()
    const varType = schema.get('Output:Variable')!
    const freqDef = varType.p.reporting_frequency
    const problem = valueProblem(freqDef, args.frequency)
    if (problem) throw new SessionError(`Reporting frequency ${problem}.`)
    const frequency = String(freqDef?.e?.find((c) => String(c).toLowerCase() === args.frequency.trim().toLowerCase()) ?? args.frequency)
    const existing = (cls: string): string[][] =>
      (o.doc.byClass.get(cls) ?? []).map((id) => o.doc.objects.get(id)!.fields.map((f) => f.value.trim().toLowerCase()))
    const vars = existing('output:variable')
    const meters = existing('output:meter')
    const added: string[] = []
    const already: string[] = []
    o.history.transact('Add outputs', () => {
      for (const v of args.variables ?? []) {
        const key = v.key?.trim() || '*'
        const label = `${v.name} (${key}, ${frequency})`
        const same = vars.some((f) => f[1] === v.name.trim().toLowerCase() && (f[0] === key.toLowerCase() || f[0] === '*') && (f[2] || 'hourly') === frequency.toLowerCase())
        if (same) {
          already.push(label)
          continue
        }
        this.labelFields(createObject(o.doc, 'Output:Variable', [key, v.name.trim(), frequency]))
        vars.push([key.toLowerCase(), v.name.trim().toLowerCase(), frequency.toLowerCase()])
        added.push(`Output:Variable ${label}`)
      }
      for (const name of args.meters ?? []) {
        const label = `${name} (${frequency})`
        if (meters.some((f) => f[0] === name.trim().toLowerCase() && (f[1] || 'hourly') === frequency.toLowerCase())) {
          already.push(label)
          continue
        }
        this.labelFields(createObject(o.doc, 'Output:Meter', [name.trim(), frequency]))
        meters.push([name.trim().toLowerCase(), frequency.toLowerCase()])
        added.push(`Output:Meter ${label}`)
      }
    })
    this.rebuild()
    return { added, alreadyRequested: already }
  }

  /**
   * Replace the design days with ones from a weather station's DDY file, and set Site:Location
   * from it, as one undo step. By default the annual 99.6% heating and 0.4% cooling (dry bulb)
   * conditions; `designDays` picks others by part of their name.
   */
  applyDesignConditions(
    ddy: string,
    opts: { designDays?: string[] | undefined; location?: boolean | undefined } = {},
  ): { removed: string[]; added: string[]; location: string | null } {
    const o = this.need()
    const source = parseIdf(ddy)
    const ofClass = (cls: string): IdfObject[] => (source.byClass.get(cls) ?? []).map((id) => source.objects.get(id)!)
    const days = ofClass('sizingperiod:designday')
    const patterns = opts.designDays?.length ? opts.designDays.map((p) => p.trim().toLowerCase()) : ['ann htg 99.6% condns db', 'ann clg .4% condns db=>mwb']
    const picked = patterns.map((p) => {
      const hit = days.find((d) => (d.fields[0]?.value ?? '').toLowerCase().includes(p))
      if (!hit) throw new SessionError(`The DDY has no design day matching '${p}'. It has: ${days.map((d) => d.fields[0]?.value).join('; ')}.`)
      return hit
    })
    const loc = opts.location === false ? undefined : ofClass('site:location')[0]
    const existing = (o.doc.byClass.get('sizingperiod:designday') ?? []).slice()
    const removed = existing.map((id) => o.doc.objects.get(id)!.fields[0]?.value ?? '')
    const added: string[] = []
    let location: string | null = null
    o.history.transact('Design conditions', () => {
      removeObjects(o.doc, existing)
      for (const d of picked) {
        this.labelFields(createObject(o.doc, 'SizingPeriod:DesignDay', d.fields.map((f) => f.value)))
        added.push(d.fields[0]?.value ?? '')
      }
      if (loc) {
        const values = loc.fields.map((f) => f.value)
        const siteId = o.doc.byClass.get('site:location')?.[0]
        if (siteId) values.forEach((v, i) => setFieldValue(o.doc, o.model, siteId, i, v))
        else this.labelFields(createObject(o.doc, 'Site:Location', values))
        location = `${values[0]} (${values[1]}, ${values[2]}; UTC${Number(values[3]) >= 0 ? '+' : ''}${values[3]}; ${values[4]} m)`
      }
    })
    this.rebuild()
    return { removed, added, location }
  }

  /** Rename an object and every field that refers to it by name. */
  renameObject(
    object: string,
    newName: string,
    className?: string,
  ): { renamed: string; updatedReferences: string[]; mentionsNotChanged: string[] } {
    const o = this.need()
    const schema = this.needSchema()
    const obj = this.objectNamed(object, className, { unique: true })
    const type = schema.get(obj.className)
    if (!type || type.anon) throw new SessionError(`${obj.className} objects have no name.`)
    const name = newName.trim()
    if (!name) throw new SessionError('The new name is empty.')
    const old = obj.fields[0]?.value ?? ''
    if (old.trim().toLowerCase() !== name.toLowerCase()) this.assertNameFree(obj.className, type, name)
    const { refs, mentions } = this.referrers(obj)
    o.history.transact(`Rename ${obj.className}`, () => {
      setFieldValue(o.doc, o.model, obj.id, 0, name)
      for (const r of refs) setFieldValue(o.doc, o.model, r.id, r.index, name)
    })
    this.rebuild()
    return {
      renamed: `${obj.className} '${old}' → '${name}'`,
      updatedReferences: refs.map(formatReferrer),
      mentionsNotChanged: mentions.map(formatReferrer),
    }
  }

  /** A copy of an object under a new name, placed after it. */
  duplicateObject(object: string, newName: string, className?: string): { created: string } {
    const o = this.need()
    const schema = this.needSchema()
    const obj = this.objectNamed(object, className, { unique: true })
    if (o.model.surfaces.has(obj.id)) {
      throw new SessionError('A copied surface would overlap its original; create geometry with extrude_zone or add_opening.')
    }
    const type = schema.get(obj.className)
    if (!type || type.anon || type.s) throw new SessionError(`${obj.className} objects cannot be duplicated by name.`)
    const name = newName.trim()
    if (!name) throw new SessionError('The new name is empty.')
    this.assertNameFree(obj.className, type, name)
    const values = obj.fields.map((f) => f.value)
    values[0] = name
    const id = createObject(o.doc, obj.className, values, { after: obj.id })
    this.labelFields(id)
    this.rebuild()
    return { created: this.describeObject(o.doc.objects.get(id)!) }
  }

  /**
   * Delete one object. Refused while other objects refer to it, unless `force` — then they are
   * left dangling and listed. Surfaces go through `deleteSurface`, which knows their cascade.
   */
  removeObject(object: string, className?: string, force = false): { deleted: string; danglingReferences: string[] } {
    const o = this.need()
    this.needSchema()
    const obj = this.objectNamed(object, className, { unique: true })
    if (o.model.surfaces.has(obj.id)) throw new SessionError('Use delete_surface for surfaces; it removes their windows and handles twins.')
    const { refs } = this.referrers(obj)
    if (refs.length && !force) {
      const shown = refs.slice(0, 15).map(formatReferrer)
      throw new SessionError(
        `Not deleted: ${refs.length} field(s) refer to ${this.describeObject(obj)}: ${shown.join('; ')}${refs.length > 15 ? '; …' : ''}. ` +
          'Change or remove them first, or pass force to delete anyway and leave them dangling.',
      )
    }
    const label = this.describeObject(obj)
    removeObjects(o.doc, [obj.id])
    this.rebuild()
    return { deleted: label, danglingReferences: refs.map(formatReferrer) }
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

  private schemaVersionKey(): string {
    const m = this.open?.model
    return m ? (m.versionResolution.declared ?? m.version) : LATEST_IDD_VERSION
  }

  private schema(): Schema | undefined {
    return this.full?.version === this.schemaVersionKey() ? this.full.schema : undefined
  }

  private needSchema(): Schema {
    const schema = this.schema()
    if (!schema) {
      throw new SessionError(
        this.full?.version === this.schemaVersionKey()
          ? `The full EnergyPlus schema is not available for version ${this.schemaVersionKey()} (it covers 8.9 and later).`
          : 'The full EnergyPlus schema is not loaded.',
      )
    }
    return schema
  }

  private typeOf(obj: IdfObject): SlimType | undefined {
    return this.schema()?.get(obj.className)
  }

  private isNamed(obj: IdfObject): boolean {
    const type = this.typeOf(obj)
    return type ? !type.anon : true
  }

  /** The IDD name where the model layer's table has the class, else the full schema's. */
  private fieldLabel(obj: IdfObject, i: number): string {
    const local = getSchema(obj.classKey, this.need().model.version)
    const name = local ? fieldNameAt(local, i) : undefined
    if (name) return name
    const type = this.typeOf(obj)
    const slot = type ? slotAt(type, i) : undefined
    return slot ? displayName(slot) : `Field ${i + 1}`
  }

  private unitsAt(obj: IdfObject, i: number): string | undefined {
    const local = getSchema(obj.classKey, this.need().model.version)
    const units = local ? fieldSpecAt(local, i)?.units : undefined
    if (units) return units
    const type = this.typeOf(obj)
    return type ? slotAt(type, i)?.def?.u : undefined
  }

  private fieldIndexOf(obj: IdfObject, field: string | number): number {
    if (typeof field === 'number') {
      const type = this.typeOf(obj)
      if (field < 0 || (type && !slotAt(type, field))) throw new SessionError(`${obj.className} has no field ${field}.`)
      return field
    }
    const local = getSchema(obj.classKey, this.need().model.version)
    const index = local?.index.get(field.toLowerCase())
    if (index !== undefined) return index
    const type = this.typeOf(obj)
    const full = type ? slotIndex(type, field) : undefined
    if (full !== undefined) return full
    throw new SessionError(`${obj.className} has no field '${field}'${type ? '; see describe_class' : ''}.`)
  }

  /** Resolve and check field writes; refuse all of them if any is wrong. */
  private planWrites(obj: IdfObject, fields: Record<string, FieldInput>): Array<{ index: number; value: string }> {
    const writes = Object.entries(fields).map(([field, value]) => {
      const index = this.fieldIndexOf(obj, /^\d+$/.test(field) ? Number(field) : field)
      if (index === 0 && this.isNamed(obj)) throw new SessionError('Use rename_object to change a name, so references follow it.')
      return { index, value: String(value), problem: this.valueProblemAt(obj, index, value) }
    })
    const problems = writes.filter((w) => w.problem).map((w) => `${this.fieldLabel(obj, w.index)} ${w.problem}`)
    if (problems.length) throw new SessionError(`Nothing changed: ${problems.join('; ')}.`)
    return writes
  }

  /** Every non-blank field by epJSON name (IDD name where the schema has none). */
  private fieldsByKey(obj: IdfObject): Record<string, string> {
    const type = this.typeOf(obj)
    const out: Record<string, string> = {}
    obj.fields.forEach((f, i) => {
      if (f.value.trim() === '') return
      const slot = type ? slotAt(type, i) : undefined
      out[slot ? (slot.group ? `${slot.key}_${slot.group}` : slot.key) : this.fieldLabel(obj, i)] = f.value.trim()
    })
    return out
  }

  private valueProblemAt(obj: IdfObject, i: number, value: FieldInput): string | undefined {
    const type = this.typeOf(obj)
    return type ? valueProblem(slotAt(type, i)?.def, value) : undefined
  }

  private checkValue(obj: IdfObject, i: number, value: FieldInput): void {
    const problem = this.valueProblemAt(obj, i, value)
    if (problem) throw new SessionError(`${this.fieldLabel(obj, i)} ${problem}.`)
  }

  /** `Class 'Name'`, or the class alone for unnamed objects. */
  private describeObject(obj: IdfObject): string {
    const name = this.isNamed(obj) ? obj.fields[0]?.value : undefined
    return name ? `${obj.className} '${name}'` : obj.className
  }

  /** Comment each field of a new object with its name, as EnergyPlus's own files are. */
  private labelFields(id: string): void {
    const obj = this.need().doc.objects.get(id)
    if (!obj) return
    obj.fields.forEach((f, i) => {
      if (!f.comment) f.comment = `- ${this.fieldLabel(obj, i)}`
    })
  }

  /** Refuse a name another object already uses where EnergyPlus would look it up. */
  private assertNameFree(className: string, type: SlimType, name: string): void {
    const lists = new Set(type.nref ?? [])
    const wanted = name.trim().toLowerCase()
    const o = this.need()
    for (const other of o.doc.objects.values()) {
      if ((other.fields[0]?.value ?? '').trim().toLowerCase() !== wanted) continue
      const t = this.typeOf(other)
      if (!t || t.anon) continue
      const sameClass = other.className.toLowerCase() === className.toLowerCase()
      if (sameClass || (t.nref ?? []).some((l) => lists.has(l))) {
        throw new SessionError(`${this.describeObject(other)} already has that name.`)
      }
    }
  }

  /**
   * Fields that refer to `target` by name: those whose reference lists include one its name
   * joins. `mentions` are plain-text fields that merely hold the same text — an
   * `Output:Variable` key, say — reported, never changed.
   */
  private referrers(target: IdfObject): { refs: Referrer[]; mentions: Referrer[] } {
    const o = this.need()
    const lists = new Set(this.typeOf(target)?.nref ?? [])
    const name = (target.fields[0]?.value ?? '').trim().toLowerCase()
    const refs: Referrer[] = []
    const mentions: Referrer[] = []
    if (!name) return { refs, mentions }
    for (const id of o.doc.order) {
      if (id === target.id) continue
      const obj = o.doc.objects.get(id)
      const type = obj ? this.typeOf(obj) : undefined
      if (!obj || !type) continue
      obj.fields.forEach((f, i) => {
        if (f.value.trim().toLowerCase() !== name) return
        const slot = slotAt(type, i)
        const r: Referrer = {
          id,
          className: obj.className,
          name: type.anon ? '' : (obj.fields[0]?.value ?? ''),
          index: i,
          field: slot ? displayName(slot) : `Field ${i + 1}`,
        }
        if (slot?.def?.ol?.some((l) => lists.has(l))) refs.push(r)
        else if (slot?.def && !slot.def.ol && !slot.def.e && slot.def.t === 'a') mentions.push(r)
      })
    }
    return { refs, mentions }
  }

  private release(): void {
    if (this.open?.ownsHistory) this.open.history.detach()
  }

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

  /**
   * The object with this name, optionally of one class. Unnamed objects (Output:Variable,
   * Version) are never matched by their first field. With `unique`, a name shared across
   * classes is refused rather than guessed.
   */
  private objectNamed(name: string, className?: string, opts: { unique?: boolean } = {}): IdfObject {
    const o = this.need()
    const wanted = name.trim().toLowerCase()
    const cls = className?.trim().toLowerCase()
    const matches = [...o.doc.objects.values()].filter(
      (x) => (cls === undefined || x.classKey === cls) && this.isNamed(x) && x.fields[0]?.value.trim().toLowerCase() === wanted,
    )
    if (matches.length > 1 && opts.unique) {
      throw new SessionError(
        `'${name}' names ${matches.length} objects (${[...new Set(matches.map((m) => m.className))].join(', ')}); give the class.`,
      )
    }
    if (matches.length === 0 && cls !== undefined) {
      const ofClass = (o.doc.byClass.get(cls) ?? []).map((id) => o.doc.objects.get(id)).filter((x) => x !== undefined)
      if (ofClass.length === 1 && (wanted === cls || !this.isNamed(ofClass[0]!))) return ofClass[0]!
      throw new SessionError(`No ${className} named '${name}'.`)
    }
    if (matches.length === 0) {
      // Unnamed singletons (Timestep, SimulationControl) are addressed by class.
      const ofClass = (o.doc.byClass.get(wanted) ?? []).map((id) => o.doc.objects.get(id)).filter((x) => x !== undefined)
      if (ofClass.length === 1) return ofClass[0]!
      throw new SessionError(
        ofClass.length > 1
          ? `'${name}' is a class with ${ofClass.length} objects; address one by its name.`
          : `No object named '${name}'.`,
      )
    }
    // Surfaces first: a zone and its floor can share a name in hand-written files.
    return matches.find((m) => o.model.surfaces.has(m.id)) ?? matches[0]!
  }

  private surfaceNamed(name: string): string {
    const wanted = name.trim().toLowerCase()
    for (const s of this.need().model.surfaces.values()) if (s.name.trim().toLowerCase() === wanted) return s.id
    throw new SessionError(`No surface named '${name}'.`)
  }
}

function formatReferrer(r: Referrer): string {
  return `${r.className}${r.name ? ` '${r.name}'` : ''}: ${r.field}`
}
