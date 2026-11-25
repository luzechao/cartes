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

export interface DatasetImportObject {
  class: string
  name: string
  fields: Array<{ index: number; value: string }>
}

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

const SEMANTIC_PARAMETERS: Record<string, Array<{ className: string; field: string; units: string; minimum: number; inclusiveMinimum?: boolean; maximum?: number }>> = {
  window_u_factor: [{ className: 'WindowMaterial:SimpleGlazingSystem', field: 'u_factor', units: 'W/m2-K', minimum: 0 }],
  window_shgc: [{ className: 'WindowMaterial:SimpleGlazingSystem', field: 'solar_heat_gain_coefficient', units: 'dimensionless', minimum: 0, maximum: 1 }],
  cooling_cop: [{ className: 'Coil:Cooling:DX:SingleSpeed', field: 'gross_rated_cooling_cop', units: 'W/W', minimum: 0 }],
  heating_cop: [{ className: 'Coil:Heating:DX:SingleSpeed', field: 'gross_rated_heating_cop', units: 'W/W', minimum: 0 }],
  heating_efficiency: [
    { className: 'Coil:Heating:Fuel', field: 'burner_efficiency', units: 'dimensionless', minimum: 0, maximum: 1 },
    { className: 'Coil:Heating:Electric', field: 'efficiency', units: 'dimensionless', minimum: 0, maximum: 1 },
    { className: 'Boiler:HotWater', field: 'nominal_thermal_efficiency', units: 'dimensionless', minimum: 0 },
  ],
  fan_efficiency: ['Fan:ConstantVolume', 'Fan:VariableVolume', 'Fan:OnOff'].map((className) =>
    ({ className, field: 'fan_total_efficiency', units: 'dimensionless', minimum: 0, maximum: 1 })),
  water_heater_efficiency: ['WaterHeater:Mixed', 'WaterHeater:Stratified'].map((className) =>
    ({ className, field: 'heater_thermal_efficiency', units: 'dimensionless', minimum: 0 })),
  water_heater_on_parasitic: ['WaterHeater:Mixed', 'WaterHeater:Stratified'].map((className) =>
    ({ className, field: 'on_cycle_parasitic_fuel_consumption_rate', units: 'W', minimum: 0, inclusiveMinimum: true })),
  water_heater_off_parasitic: ['WaterHeater:Mixed', 'WaterHeater:Stratified'].map((className) =>
    ({ className, field: 'off_cycle_parasitic_fuel_consumption_rate', units: 'W', minimum: 0, inclusiveMinimum: true })),
  water_heater_on_loss: [{ className: 'WaterHeater:Mixed', field: 'on_cycle_loss_coefficient_to_ambient_temperature', units: 'W/K', minimum: 0, inclusiveMinimum: true }],
  water_heater_off_loss: [{ className: 'WaterHeater:Mixed', field: 'off_cycle_loss_coefficient_to_ambient_temperature', units: 'W/K', minimum: 0, inclusiveMinimum: true }],
  water_use_peak_flow: [{ className: 'WaterUse:Equipment', field: 'peak_flow_rate', units: 'm3/s', minimum: 0, inclusiveMinimum: true }],
  outdoor_air_per_person: [{ className: 'DesignSpecification:OutdoorAir', field: 'outdoor_air_flow_per_person', units: 'm3/s-person', minimum: 0, inclusiveMinimum: true }],
  outdoor_air_per_area: [{ className: 'DesignSpecification:OutdoorAir', field: 'outdoor_air_flow_per_zone_floor_area', units: 'm3/s-m2', minimum: 0, inclusiveMinimum: true }],
  outdoor_air_per_zone: [{ className: 'DesignSpecification:OutdoorAir', field: 'outdoor_air_flow_per_zone', units: 'm3/s', minimum: 0, inclusiveMinimum: true }],
}

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

  /** A compact pre-simulation snapshot; weather selection is owned by the host, not the IDF. */
  checkReadiness(): {
    model: { name: string; version: string; zones: number; surfaces: number }
    validation: { errors: number; warnings: number; issues: ReturnType<ModelSession['validate']>; omitted: number }
    checks: {
      siteLocation: { present: boolean }
      designDays: { count: number; names: string[] }
      runPeriods: { count: number; names: string[] }
      zones: { count: number; withoutFloorArea: string[] }
      internalLoads: { count: number; byClass: Record<string, number> }
      weatherFile: { status: 'host-managed'; note: string }
    }
  } {
    const summary = this.summary()
    const issues = this.validate()
    const settings = this.simulationSettings()
    const zones = this.listZones()
    const loads = this.inspectLoads().loads
    const byClass: Record<string, number> = {}
    for (const load of loads) byClass[load.class] = (byClass[load.class] ?? 0) + 1
    const shownIssues = issues.slice(0, 20)
    return {
      model: { name: summary.name, version: summary.version, zones: summary.zones, surfaces: summary.surfaces },
      validation: {
        errors: issues.filter((i) => i.severity === 'error').length,
        warnings: issues.filter((i) => i.severity === 'warning').length,
        issues: shownIssues,
        omitted: issues.length - shownIssues.length,
      },
      checks: {
        siteLocation: { present: settings.location !== null },
        designDays: { count: settings.designDays.length, names: settings.designDays },
        runPeriods: {
          count: settings.runPeriods.length,
          names: settings.runPeriods.map((period) => period.name ?? ''),
        },
        zones: { count: zones.length, withoutFloorArea: zones.filter((zone) => zone.floorArea <= 0).map((zone) => zone.name) },
        internalLoads: { count: loads.length, byClass },
        weatherFile: {
          status: 'host-managed',
          note: 'Weather selection is not stored in the IDF; check the simulation host or the app’s Simulate tab.',
        },
      },
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

  /** Find whole-field matches, including objects connected through a NodeList. */
  findObjects(args: { classPattern?: string | undefined; name?: string | undefined; nameContains?: string | undefined; limit?: number | undefined }) {
    const o = this.need()
    this.needSchema()
    const pattern = args.classPattern?.trim().toLowerCase()
    const parts = pattern?.split('*')
    const matchesClass = (cls: string): boolean => {
      if (!parts) return true
      const escaped = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
      return new RegExp(`^${escaped}$`, 'i').test(cls)
    }
    const wanted = args.name?.trim().toLowerCase()
    if (args.name !== undefined && !wanted) throw new SessionError('The name must not be blank.')
    const via = new Map<string, string>()
    if (wanted) {
      for (const id of o.doc.byClass.get('nodelist') ?? []) {
        const obj = o.doc.objects.get(id)!
        if (obj.fields.slice(1).some((f) => f.value.trim().toLowerCase() === wanted)) {
          const list = obj.fields[0]?.value.trim()
          if (list) via.set(list.toLowerCase(), list)
        }
      }
    }
    const results = []
    for (const id of o.doc.order) {
      const obj = o.doc.objects.get(id)!
      const type = this.typeOf(obj)
      const name = type?.anon ? '' : (obj.fields[0]?.value ?? '')
      if (!matchesClass(obj.className) || (args.nameContains && !name.toLowerCase().includes(args.nameContains.toLowerCase()))) continue
      const fields = obj.fields.flatMap((f, index) => {
        const value = f.value.trim().toLowerCase()
        if (!wanted || !value || (value !== wanted && !via.has(value))) return []
        return [{ index, field: this.fieldLabel(obj, index), value: f.value, relation: index === 0 && !type?.anon ? 'defines' : 'references', ...(value !== wanted ? { via: via.get(value) } : {}) }]
      })
      if (wanted && !fields.length) continue
      results.push({ class: obj.className, name, matches: fields })
    }
    const limit = args.limit ?? 100
    return { total: results.length, results: results.slice(0, limit), truncated: results.length > limit }
  }

  /** Report node connections and candidate directions derived from inlet/outlet field names. */
  inspectHvacTopology(args: { loop?: string | undefined; limit?: number | undefined } = {}) {
    const o = this.need()
    this.needSchema()
    const loops = [...o.doc.objects.values()].filter((obj) => /^(airloophvac|plantloop|condenserloop)$/i.test(obj.className))
    const selected = args.loop
      ? loops.filter((obj) => obj.fields[0]?.value.trim().toLowerCase() === args.loop!.trim().toLowerCase())
      : loops
    if (args.loop && !selected.length) throw new SessionError(`No air, plant or condenser loop named '${args.loop}'.`)
    const components = [...o.doc.objects.values()].flatMap((obj) => {
      const type = this.typeOf(obj)
      if (!type) return []
      const nodes = obj.fields.flatMap((f, index) => {
        const slot = slotAt(type, index)
        if (!slot || !/(^|_)node(_|$)/i.test(slot.key) || !f.value.trim()) return []
        return [{ field: displayName(slot), value: f.value, acceptsNodeList: /nodelist|_node_names$/.test(slot.key) }]
      })
      return nodes.length ? [{ id: obj.id, class: obj.className, name: type.anon ? '' : (obj.fields[0]?.value ?? ''), nodes }] : []
    })
    const nodeLists = new Map<string, string[]>()
    const ambiguousNodeLists = new Set<string>()
    for (const id of o.doc.byClass.get('nodelist') ?? []) {
      const obj = o.doc.objects.get(id)!
      const name = obj.fields[0]?.value.trim().toLowerCase()
      if (!name) continue
      if (nodeLists.has(name) || ambiguousNodeLists.has(name)) {
        nodeLists.delete(name)
        ambiguousNodeLists.add(name)
      } else {
        nodeLists.set(name, obj.fields.slice(1).map((f) => f.value.trim()).filter(Boolean))
      }
    }
    type Endpoint = { class: string; name: string; field: string; direction: 'inlet' | 'outlet' | 'unknown'; via?: string }
    type IndexedEndpoint = Endpoint & { objectId: string }
    const nodes = new Map<string, { node: string; endpoints: IndexedEndpoint[] }>()
    const emptyNodeLists = new Set<string>()
    for (const component of components) {
      for (const field of component.nodes) {
        const fieldKey = field.value.trim().toLowerCase()
        const listed = field.acceptsNodeList ? nodeLists.get(fieldKey) : undefined
        if (listed?.length === 0) emptyNodeLists.add(fieldKey)
        const expanded = listed?.length ? [...new Set(listed)] : undefined
        const unresolvedList = field.acceptsNodeList && (ambiguousNodeLists.has(fieldKey) || listed?.length === 0)
        const isLoop = /^(airloophvac|plantloop|condenserloop)$/i.test(component.class)
        const direction = isLoop || unresolvedList || ['branch', 'nodelist'].includes(component.class.toLowerCase())
          ? 'unknown'
          : /\binlet\b/i.test(field.field)
            ? 'inlet'
            : /\boutlet\b/i.test(field.field)
              ? 'outlet'
              : 'unknown'
        for (const node of expanded ?? [field.value.trim()]) {
          const key = node.toLowerCase()
          const entry = nodes.get(key) ?? { node, endpoints: [] }
          entry.endpoints.push({ objectId: component.id, class: component.class, name: component.name, field: field.field, direction, ...(expanded ? { via: field.value } : {}) })
          nodes.set(key, entry)
        }
      }
    }
    const connections = [...nodes.values()].filter((entry) => entry.endpoints.length > 1)
    const limit = args.limit ?? 200
    const directedConnections: Array<{ node: string; from: Endpoint; to: Endpoint }> = []
    let totalDirectedConnections = 0
    const publicEndpoint = ({ objectId: _objectId, ...endpoint }: IndexedEndpoint): Endpoint => endpoint
    for (const connection of connections) {
      const outlets = connection.endpoints.filter((endpoint) => endpoint.direction === 'outlet')
      const inlets = connection.endpoints.filter((endpoint) => endpoint.direction === 'inlet')
      const inletsByObject = new Map<string, number>()
      for (const inlet of inlets) inletsByObject.set(inlet.objectId, (inletsByObject.get(inlet.objectId) ?? 0) + 1)
      for (const outlet of outlets) {
        totalDirectedConnections += inlets.length - (inletsByObject.get(outlet.objectId) ?? 0)
        if (directedConnections.length >= limit) continue
        for (const inlet of inlets) {
          if (outlet.objectId === inlet.objectId) continue
          directedConnections.push({ node: connection.node, from: publicEndpoint(outlet), to: publicEndpoint(inlet) })
          if (directedConnections.length >= limit) break
        }
      }
    }
    return {
      loops: selected.map((obj) => ({ class: obj.className, name: obj.fields[0]?.value ?? '', fields: this.inspect(obj.fields[0]?.value ?? '', obj.className).fields })),
      components: components.slice(0, limit).map(({ id: _id, ...component }) => component),
      connections: connections.slice(0, limit).map((connection) => ({ node: connection.node, endpoints: connection.endpoints.map(publicEndpoint) })),
      directedConnections,
      totalComponents: components.length,
      totalConnections: connections.length,
      totalDirectedConnections,
      truncated: components.length > limit || connections.length > limit || totalDirectedConnections > limit,
      ambiguousNodeLists: [...ambiguousNodeLists],
      emptyNodeLists: [...emptyNodeLists],
      note: 'Directed connections are candidates from matching outlet and inlet field names, not validated flow paths. Loop boundaries, branch declarations and other ambiguous fields have unknown direction; no paths through components are inferred. Components and connections are model-wide, even when a loop is selected.',
    }
  }

  inspectLoopStructure(name: string, className: 'AirLoopHVAC' | 'PlantLoop' | 'CondenserLoop') {
    const o = this.need()
    this.needSchema()
    const loop = this.objectNamed(name, className, { unique: true })
    const fields = (obj: IdfObject, field: string) => obj.fields[this.fieldIndexOf(obj, field)]?.value.trim() ?? ''
    const sides = className === 'AirLoopHVAC'
      ? [{ name: 'supply', branches: 'branch_list_name', connectors: 'connector_list_name' }]
      : className === 'PlantLoop'
        ? [{ name: 'plant', branches: 'plant_side_branch_list_name', connectors: 'plant_side_connector_list_name' },
          { name: 'demand', branches: 'demand_side_branch_list_name', connectors: 'demand_side_connector_list_name' }]
        : [{ name: 'condenser', branches: 'condenser_side_branch_list_name', connectors: 'condenser_side_connector_list_name' },
          { name: 'demand', branches: 'condenser_demand_side_branch_list_name', connectors: 'condenser_demand_side_connector_list_name' }]
    const result = sides.map((side) => {
      const warnings: string[] = []
      const lookup = (cls: string, objectName: string) => {
        const objects = (o.doc.byClass.get(cls.toLowerCase()) ?? [])
          .map((id) => o.doc.objects.get(id)!)
          .filter((obj) => obj.fields[0]?.value.trim().toLowerCase() === objectName.toLowerCase())
        if (objects.length !== 1) {
          warnings.push(`${cls} '${objectName}' is ${objects.length ? 'ambiguous' : 'missing'}.`)
          return undefined
        }
        return objects[0]
      }
      const validateBranchNodes = (obj: IdfObject | undefined, inlet: string, outlet: string) => {
        if (!obj) return { status: 'unavailable' as const, actual: [] as Array<{ field: string; direction: 'inlet' | 'outlet'; node: string }> }
        const type = this.typeOf(obj)
        if (!type) return { status: 'unavailable' as const, actual: [] as Array<{ field: string; direction: 'inlet' | 'outlet'; node: string }> }
        const actual = type.f.flatMap((key, index) => {
          const match = /(?:^|_)(inlet|outlet)_node(?:_name)?$/i.exec(key)
          const node = obj.fields[index]?.value.trim() ?? ''
          return match ? [{ field: key, direction: match[1]!.toLowerCase() as 'inlet' | 'outlet', node }] : []
        })
        if (!actual.some((field) => field.direction === 'inlet') || !actual.some((field) => field.direction === 'outlet')) {
          return { status: 'unavailable' as const, actual }
        }
        const matchesInlet = actual.some((field) => field.direction === 'inlet' && field.node.toLowerCase() === inlet.toLowerCase())
        const matchesOutlet = actual.some((field) => field.direction === 'outlet' && field.node.toLowerCase() === outlet.toLowerCase())
        return { status: matchesInlet && matchesOutlet ? 'matched' as const : 'mismatch' as const, actual }
      }
      const branchListName = fields(loop, side.branches)
      const list = branchListName ? lookup('BranchList', branchListName) : undefined
      if (!branchListName) warnings.push(`No ${side.branches} is specified.`)
      const names = list?.fields.slice(1).map((f) => f.value.trim()).filter(Boolean) ?? []
      if (list && !names.length) warnings.push(`BranchList '${branchListName}' is empty.`)
      if (names.length > 200) throw new SessionError(`BranchList '${branchListName}' exceeds the 200-branch inspection limit.`)
      const seen = new Set<string>()
      const branches = names.map((branchName) => {
        const key = branchName.toLowerCase()
        if (seen.has(key)) warnings.push(`Branch '${branchName}' is listed more than once.`)
        seen.add(key)
        const branch = lookup('Branch', branchName)
        const components: Array<{
          class: string; name: string; inlet: string; outlet: string
          nodeValidation: ReturnType<typeof validateBranchNodes>
        }> = []
        if (branch) {
          if (branch.fields.length > 4002) throw new SessionError(`Branch '${branchName}' exceeds the 1000-component inspection limit.`)
          for (let i = 2; i < branch.fields.length; i += 4) {
            const [cls, componentName, inlet, outlet] = [0, 1, 2, 3].map((offset) => branch.fields[i + offset]?.value.trim() ?? '')
            if (![cls, componentName, inlet, outlet].some(Boolean)) continue
            if (!cls || !componentName || !inlet || !outlet) warnings.push(`Branch '${branchName}' has an incomplete component declaration.`)
            const component = cls && componentName ? lookup(cls, componentName) : undefined
            const nodeValidation = validateBranchNodes(component, inlet!, outlet!)
            if (nodeValidation.status === 'mismatch') {
              const actual = nodeValidation.actual
                .map((field) => `${field.direction} '${field.node || '<blank>'}' (${field.field})`).join(', ')
              warnings.push(`Branch '${branchName}' declares '${componentName}' nodes '${inlet}' → '${outlet}', but its object fields are ${actual}.`)
            }
            if (components.length && inlet && components[components.length - 1]!.outlet &&
              inlet.toLowerCase() !== components[components.length - 1]!.outlet.toLowerCase()) {
              warnings.push(`Adjacent components on branch '${branchName}' have different connecting nodes.`)
            }
            components.push({ class: cls!, name: componentName!, inlet: inlet!, outlet: outlet!, nodeValidation })
          }
          if (!components.length) warnings.push(`Branch '${branchName}' has no components.`)
        }
        return { name: branchName, resolved: !!branch, components }
      })
      const edges: Array<{ from: string; to: string; connector: string }> = []
      const connectorListName = fields(loop, side.connectors)
      const connectorList = connectorListName ? lookup('ConnectorList', connectorListName) : undefined
      if (connectorList) {
        for (const i of [1, 3]) {
          const cls = connectorList.fields[i]?.value.trim() ?? ''
          const connectorName = connectorList.fields[i + 1]?.value.trim() ?? ''
          if (!cls && !connectorName) continue
          if (!connectorName || !['connector:splitter', 'connector:mixer'].includes(cls.toLowerCase())) {
            warnings.push(`ConnectorList '${connectorListName}' has an incomplete or unsupported connector.`)
            continue
          }
          const connector = lookup(cls, connectorName)
          if (!connector) continue
          if (connector.fields.length > 202) throw new SessionError(`Connector '${connectorName}' exceeds the 200-branch inspection limit.`)
          const single = connector.fields[1]?.value.trim() ?? ''
          const multiple = connector.fields.slice(2).map((f) => f.value.trim()).filter(Boolean)
          if (!single || !multiple.length) warnings.push(`${cls} '${connectorName}' has incomplete branch connections.`)
          for (const other of multiple) {
            const from = cls.toLowerCase() === 'connector:splitter' ? single : other
            const to = cls.toLowerCase() === 'connector:splitter' ? other : single
            if (!from || !seen.has(from.toLowerCase()) || !seen.has(to.toLowerCase())) {
              warnings.push(`${cls} '${connectorName}' refers to a branch outside the selected BranchList.`)
            } else {
              edges.push({ from, to, connector: connectorName })
            }
          }
        }
      }
      const ids = new Map<string, number>()
      branches.forEach((branch, i) => { if (!ids.has(branch.name.toLowerCase())) ids.set(branch.name.toLowerCase(), i) })
      const label = (text: string) => text.replace(/&/g, '#amp;').replace(/"/g, '#quot;').replace(/[\r\n]/g, ' ')
      const diagram = ['flowchart LR', ...branches.map((branch, i) => `  b${i}["${label(branch.name)}"]`),
        ...edges.map((edge) => `  b${ids.get(edge.from.toLowerCase())} --> b${ids.get(edge.to.toLowerCase())}`)].join('\n')
      return { side: side.name, branchList: branchListName, connectorList: connectorListName, branches, edges, warnings, diagram }
    })
    return {
      loop: { class: loop.className, name: loop.fields[0]?.value ?? '' }, sides: result,
      note: 'Branch component node checks compare declared inlet/outlet nodes with the named object fields in the loaded IDD; unavailable means the object or node fields could not be checked. These checks do not validate EnergyPlus flow or a complete loop diagram. Connector arrows reflect declarations only, and air-loop demand-side equipment is not shown.',
    }
  }

  inspectSchedule(name: string, className?: string) {
    this.needSchema()
    const matches = [...this.need().doc.objects.values()].filter((candidate) =>
      candidate.classKey.startsWith('schedule:') &&
      (!className || candidate.classKey === className.trim().toLowerCase()) &&
      candidate.fields[0]?.value.trim().toLowerCase() === name.trim().toLowerCase(),
    )
    if (!matches.length) throw new SessionError(`No schedule named '${name}'.`)
    if (matches.length > 1) throw new SessionError(`Multiple schedules are named '${name}'; give the class.`)
    const obj = matches[0]!
    const refs = this.referrers(obj)
    const queue = [obj]
    const visited = new Set([obj.id])
    const edges: Array<{ schedule: string; referrer: string }> = []
    while (queue.length && edges.length < 200) {
      const current = queue.shift()!
      for (const ref of this.referrers(current).refs) {
        if (edges.length >= 200) break
        edges.push({ schedule: this.describeObject(current), referrer: formatReferrer(ref) })
        const next = this.need().doc.objects.get(ref.id)
        if (next?.classKey.startsWith('schedule:') && !visited.has(next.id)) {
          visited.add(next.id)
          queue.push(next)
        }
      }
    }
    return {
      ...this.inspect(name, obj.className),
      referencedBy: refs.refs.map(formatReferrer),
      otherMentions: refs.mentions.map(formatReferrer),
      referenceGraph: edges,
      graphMayBeTruncated: edges.length >= 200,
      note: 'The graph follows IDD-declared references through schedules only; textual mentions and unmodeled dependencies may also be affected.',
    }
  }

  setConstantSchedule(name: string, value: number, acknowledgeShared = false) {
    const o = this.need()
    this.needSchema()
    const obj = this.objectNamed(name, 'Schedule:Constant', { unique: true })
    const refs = this.referrers(obj)
    if ((refs.refs.length || refs.mentions.length) && !acknowledgeShared) {
      throw new SessionError(`Schedule '${name}' has ${refs.refs.length} declared references and ${refs.mentions.length} textual mentions. Inspect it and explicitly acknowledge its uses before editing.`)
    }
    if (!Number.isFinite(value)) throw new SessionError('Schedule value must be finite.')
    this.validateScheduleValue(obj, value)
    const index = this.fieldIndexOf(obj, 'hourly_value')
    this.checkValue(obj, index, value)
    const changed = setFieldValue(o.doc, o.model, obj.id, index, String(value))
    this.rebuild()
    return { schedule: name, value, changed, referencedBy: refs.refs.map(formatReferrer) }
  }

  scaleCompactSchedule(name: string, factor: number, acknowledgeShared = false) {
    const o = this.need()
    this.needSchema()
    if (!Number.isFinite(factor) || factor <= 0) throw new SessionError('The factor must be a positive finite number.')
    const obj = this.objectNamed(name, 'Schedule:Compact', { unique: true })
    const refs = this.referrers(obj)
    if ((refs.refs.length || refs.mentions.length) && !acknowledgeShared) {
      throw new SessionError(`Schedule '${name}' has ${refs.refs.length} declared references and ${refs.mentions.length} textual mentions. Inspect it and explicitly acknowledge its uses before editing.`)
    }

    if (!obj.fields[1]?.value.trim()) throw new SessionError('Scaling requires explicit ScheduleTypeLimits.')
    const writes: Array<{ index: number; value: string }> = []
    let expectingValue = false
    for (let index = 2; index < obj.fields.length; index++) {
      const text = obj.fields[index]!.value.trim()
      if (expectingValue) {
        if (!text || !Number.isFinite(Number(text))) throw new SessionError(`Expected a numeric value after Until in field ${index + 1}.`)
        const value = Number((Number(text) * factor).toPrecision(12))
        this.validateScheduleValue(obj, value)
        writes.push({ index, value: String(Number(value.toPrecision(12))) })
        expectingValue = false
      } else if (/^until\s*:\s*\S/i.test(text)) {
        expectingValue = true
      } else if (!/^(through|for|interpolate)\s*:\s*\S/i.test(text)) {
        throw new SessionError(`Unsupported Schedule:Compact field ${index + 1}: '${text}'. No values were changed.`)
      }
    }
    if (expectingValue || !writes.length) throw new SessionError('Schedule:Compact has an incomplete Until or no values.')
    let changed = 0
    o.history.transact('Scale compact schedule', () => {
      for (const write of writes) if (setFieldValue(o.doc, o.model, obj.id, write.index, write.value)) changed++
    })
    this.rebuild()
    return { schedule: name, factor, changed, referencedBy: refs.refs.map(formatReferrer) }
  }

  setHourlySchedule(name: string, values: number[], acknowledgeShared = false) {
    const o = this.need()
    this.needSchema()
    const obj = this.objectNamed(name, 'Schedule:Day:Hourly', { unique: true })
    const refs = this.referrers(obj)
    if ((refs.refs.length || refs.mentions.length) && !acknowledgeShared) {
      throw new SessionError(`Schedule '${name}' has ${refs.refs.length} declared references and ${refs.mentions.length} textual mentions. Inspect it and explicitly acknowledge its uses before editing.`)
    }
    if (values.length !== 24) throw new SessionError('A day schedule requires exactly 24 hourly values.')
    const writes = values.map((value, i) => {
      this.validateScheduleValue(obj, value)
      const index = this.fieldIndexOf(obj, `hour_${i + 1}`)
      this.checkValue(obj, index, value)
      return { index, value: String(value) }
    })
    let changed = 0
    o.history.transact('Set hourly schedule', () => {
      for (const write of writes) if (setFieldValue(o.doc, o.model, obj.id, write.index, write.value)) changed++
    })
    this.rebuild()
    return { schedule: name, changed, referencedBy: refs.refs.map(formatReferrer), otherMentions: refs.mentions.map(formatReferrer) }
  }

  setDualSetpoints(name: string, heating: number, cooling: number, acknowledgeShared = false) {
    const o = this.need()
    this.needSchema()
    if (!Number.isFinite(heating) || !Number.isFinite(cooling) || heating >= cooling) {
      throw new SessionError('Heating and cooling must be finite temperatures in °C, with heating lower than cooling.')
    }
    const thermostat = this.objectNamed(name, 'ThermostatSetpoint:DualSetpoint', { unique: true })
    const target = (field: string, value: number) => {
      const scheduleName = thermostat.fields[this.fieldIndexOf(thermostat, field)]?.value.trim()
      if (!scheduleName) throw new SessionError(`Thermostat '${name}' has no ${field}.`)
      const obj = this.objectNamed(scheduleName, 'Schedule:Constant', { unique: true })
      const lists = new Set(this.typeOf(obj)?.nref ?? [])
      const matches = [...o.doc.objects.values()].filter((candidate) =>
        candidate.fields[0]?.value.trim().toLowerCase() === scheduleName.toLowerCase() &&
        this.typeOf(candidate)?.nref?.some((list) => lists.has(list)),
      )
      if (matches.length !== 1) throw new SessionError(`Schedule '${scheduleName}' has an ambiguous name across schedule classes.`)
      const refs = this.referrers(obj)
      if ((refs.refs.length || refs.mentions.length) && !acknowledgeShared) {
        throw new SessionError(`Schedule '${scheduleName}' has ${refs.refs.length} declared references and ${refs.mentions.length} textual mentions. Inspect it and explicitly acknowledge its uses before editing.`)
      }
      const limitsName = obj.fields[this.fieldIndexOf(obj, 'schedule_type_limits_name')]?.value.trim()
      if (limitsName) {
        const limits = this.objectNamed(limitsName, 'ScheduleTypeLimits', { unique: true })
        const unit = limits.fields[this.fieldIndexOf(limits, 'unit_type')]?.value.trim()
        if (unit && unit.toLowerCase() !== 'temperature') throw new SessionError(`Schedule '${scheduleName}' has non-temperature unit type '${unit}'.`)
      }
      this.validateScheduleValue(obj, value)
      const index = this.fieldIndexOf(obj, 'hourly_value')
      this.checkValue(obj, index, value)
      return { obj, name: scheduleName, index, value, refs }
    }
    const heat = target('heating_setpoint_temperature_schedule_name', heating)
    const cool = target('cooling_setpoint_temperature_schedule_name', cooling)
    if (heat.obj.id === cool.obj.id) throw new SessionError('Heating and cooling cannot use the same constant schedule.')
    let changed = 0
    o.history.transact('Set thermostat setpoints', () => {
      for (const write of [heat, cool]) if (setFieldValue(o.doc, o.model, write.obj.id, write.index, String(write.value))) changed++
    })
    this.rebuild()
    return { thermostat: name, changed, schedules: [heat, cool].map((write) => ({
      name: write.name, value: write.value, referencedBy: write.refs.refs.map(formatReferrer), otherMentions: write.refs.mentions.map(formatReferrer),
    })) }
  }

  setGlazingOptics(name: string, optics: {
    solarTransmittance: number; solarFrontReflectance: number; solarBackReflectance: number
    visibleTransmittance: number; visibleFrontReflectance: number; visibleBackReflectance: number
  }, acknowledgeShared = false) {
    const o = this.need()
    this.needSchema()
    const obj = this.objectNamed(name, 'WindowMaterial:Glazing', { unique: true })
    const mode = obj.fields[this.fieldIndexOf(obj, 'optical_data_type')]?.value.trim()
    if (mode?.toLowerCase() !== 'spectralaverage') {
      throw new SessionError(`Glazing '${name}' must explicitly use SpectralAverage optical data; other optical models are not supported.`)
    }
    const refs = this.referrers(obj)
    if ((refs.refs.length || refs.mentions.length) && !acknowledgeShared) {
      throw new SessionError(`Glazing '${name}' has ${refs.refs.length} declared references and ${refs.mentions.length} textual mentions. Inspect it and explicitly acknowledge its uses before editing.`)
    }
    const pairs = [
      ['solar_transmittance_at_normal_incidence', optics.solarTransmittance],
      ['front_side_solar_reflectance_at_normal_incidence', optics.solarFrontReflectance],
      ['back_side_solar_reflectance_at_normal_incidence', optics.solarBackReflectance],
      ['visible_transmittance_at_normal_incidence', optics.visibleTransmittance],
      ['front_side_visible_reflectance_at_normal_incidence', optics.visibleFrontReflectance],
      ['back_side_visible_reflectance_at_normal_incidence', optics.visibleBackReflectance],
    ] as const
    for (const [field, value] of pairs) {
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new SessionError(`${field} must be between 0 and 1.`)
      this.checkValue(obj, this.fieldIndexOf(obj, field), value)
    }
    if (optics.solarTransmittance + optics.solarFrontReflectance > 1 ||
      optics.solarTransmittance + optics.solarBackReflectance > 1 ||
      optics.visibleTransmittance + optics.visibleFrontReflectance > 1 ||
      optics.visibleTransmittance + optics.visibleBackReflectance > 1) {
      throw new SessionError('Transmittance plus reflectance must not exceed 1 on either side in either band.')
    }
    let changed = 0
    o.history.transact('Set glazing optics', () => {
      for (const [field, value] of pairs) {
        if (setFieldValue(o.doc, o.model, obj.id, this.fieldIndexOf(obj, field), String(value))) changed++
      }
    })
    this.rebuild()
    return {
      glazing: name, changed, referencedBy: refs.refs.map(formatReferrer), otherMentions: refs.mentions.map(formatReferrer),
      note: 'These are user-supplied normal-incidence effective properties, not an automatic film or coating calculation. Every use of this material is affected.',
    }
  }

  private validateScheduleValue(obj: IdfObject, value: number): void {
    if (!Number.isFinite(value)) throw new SessionError('Schedule value must be finite.')
    const typeIndex = this.fieldIndexOf(obj, 'schedule_type_limits_name')
    const typeName = obj.fields[typeIndex]?.value.trim()
    if (typeName) {
      const limits = this.objectNamed(typeName, 'ScheduleTypeLimits', { unique: true })
      const get = (field: string) => limits.fields[this.fieldIndexOf(limits, field)]?.value.trim() ?? ''
      const lower = get('lower_limit_value')
      const upper = get('upper_limit_value')
      const numericType = get('numeric_type')
      if ((lower && !Number.isFinite(Number(lower))) || (upper && !Number.isFinite(Number(upper)))) {
        throw new SessionError(`ScheduleTypeLimits '${typeName}' has invalid bounds.`)
      }
      if (lower && value < Number(lower)) throw new SessionError(`Schedule value must be at least ${lower}.`)
      if (upper && value > Number(upper)) throw new SessionError(`Schedule value must be at most ${upper}.`)
      if (numericType.toLowerCase() === 'discrete' && !Number.isInteger(value)) throw new SessionError('This schedule requires an integer value.')
      if (numericType && !['continuous', 'discrete'].includes(numericType.toLowerCase())) {
        throw new SessionError(`Unknown schedule numeric type '${numericType}'.`)
      }
    }
  }

  inspectParameter(parameter: string, name: string, className?: string) {
    const { obj, spec } = this.semanticTarget(parameter, name, className)
    const index = this.fieldIndexOf(obj, spec.field)
    const raw = obj.fields[index]?.value.trim() ?? ''
    const type = this.typeOf(obj)
    const slot = type ? slotAt(type, index) : undefined
    const value = raw || (slot?.def?.d !== undefined ? String(slot.def.d) : '')
    return {
      parameter, class: spec.className, name, field: spec.field, value, units: spec.units,
      source: raw ? 'explicit' : value ? 'schema default' : 'unspecified',
      referencedBy: this.referrers(obj).refs.map(formatReferrer),
    }
  }

  setParameter(parameter: string, name: string, value: number, className?: string) {
    const o = this.need()
    this.needSchema()
    const { obj, spec } = this.semanticTarget(parameter, name, className)
    if (!Number.isFinite(value) || (spec.inclusiveMinimum ? value < spec.minimum : value <= spec.minimum) || (spec.maximum !== undefined && value > spec.maximum)) {
      throw new SessionError(`${parameter} must be ${spec.inclusiveMinimum ? 'at least' : 'greater than'} ${spec.minimum}${spec.maximum === undefined ? '' : ` and at most ${spec.maximum}`}.`)
    }
    const index = this.fieldIndexOf(obj, spec.field)
    this.checkValue(obj, index, value)
    const references = this.referrers(obj).refs.map(formatReferrer)
    const changed = setFieldValue(o.doc, o.model, obj.id, index, String(value))
    this.rebuild()
    return { parameter, class: spec.className, name, field: spec.field, value, units: spec.units, changed, referencedBy: references }
  }

  private semanticTarget(parameter: string, name: string, className?: string) {
    this.needSchema()
    const specs = SEMANTIC_PARAMETERS[parameter]
    if (!specs) throw new SessionError(`Unsupported parameter '${parameter}'. Supported: ${Object.keys(SEMANTIC_PARAMETERS).join(', ')}.`)
    const obj = this.objectNamed(name, className, { unique: true })
    const spec = specs.find((item) => item.className.toLowerCase() === obj.classKey)
    if (!spec) throw new SessionError(`${parameter} supports ${specs.map((item) => item.className).join(', ')}, not ${obj.className}.`)
    return { obj, spec }
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

  searchReference(query: string, limit = 30, offset = 0) {
    const schema = this.needSchema()
    if (!this.prose) throw new SessionError('The EnergyPlus IDD notes are not available.')
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) throw new SessionError('Enter words to search for.')
    const matches: Array<{ class: string; field?: string; text: string; docs?: string }> = []
    for (const className of schema.typeNames) {
      const type = schema.get(className)!
      const docs = describeClass(schema, className)?.docs
      const add = (field: string | undefined, text: string) => {
        const searchable = `${className} ${field ?? ''} ${text}`.toLowerCase()
        if (words.every((word) => searchable.includes(word))) {
          matches.push({ class: className, ...(field ? { field } : {}), text, ...(docs ? { docs } : {}) })
        }
      }
      add(undefined, type.m === undefined ? '' : (this.prose[type.m] ?? ''))
      for (const key of type.f) {
        const def = type.p[key]
        add(key, def?.n === undefined ? '' : (this.prose[def.n] ?? ''))
      }
      if (type.x) for (const key of type.x.fields) {
        const def = type.x.p[key]
        add(key, def?.n === undefined ? '' : (this.prose[def.n] ?? ''))
      }
    }
    return {
      source: `EnergyPlus ${schema.version} IDD names and notes, not full manuals`,
      total: matches.length,
      offset,
      results: matches.slice(offset, offset + limit),
    }
  }

  fieldReference(className: string, field: string) {
    const schema = this.needSchema()
    if (!this.prose) throw new SessionError('The EnergyPlus IDD notes are not available.')
    const description = this.describeClass(className)
    const type = schema.get(description.class)!
    const index = slotIndex(type, field)
    if (index === undefined) throw new SessionError(`No field '${field}' in ${description.class}.`)
    const slot = slotAt(type, index)!
    const metadata = [...description.fields, ...(description.extensible?.fields ?? [])].find((item) => item.name === slot.key)
    const note = slot.def?.n === undefined ? undefined : this.prose[slot.def.n]
    return {
      source: `EnergyPlus ${schema.version} IDD, not the full manual`,
      class: description.class,
      field: { ...metadata, index, ...(note ? { note } : {}) },
      ...(description.docs ? { manualUrl: description.docs } : {}),
    }
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

  /** Import a bounded DataSet dependency closure as one undoable edit after all checks pass. */
  importDatasetObjects(
    sourceVersion: string,
    objects: readonly DatasetImportObject[],
    undoLabel = 'Import DataSet objects',
  ) {
    const o = this.need()
    const schema = this.needSchema()
    const versionParts = (value: string) => value.trim().split('.').slice(0, 2).join('.')
    const modelVersion = o.model.versionResolution.declared ?? o.model.version
    if (versionParts(sourceVersion) !== versionParts(modelVersion)) {
      throw new SessionError(`DataSet objects are for EnergyPlus ${sourceVersion}; the open model is ${modelVersion}. Open a ${sourceVersion} model or use a compatible source.`)
    }
    if (!objects.length) throw new SessionError('The DataSet import plan contains no objects.')
    if (objects.length > 50) throw new SessionError('A single DataSet import is limited to 50 objects; create a smaller plan.')

    const normalValues = (values: readonly string[]) => {
      const trimmed = [...values]
      while (trimmed.at(-1) === '') trimmed.pop()
      return trimmed.map((value) => value.trim())
    }
    const sameValues = (left: readonly string[], right: readonly string[], named = true) => {
      const a = normalValues(left)
      const b = normalValues(right)
      return a.length === b.length && a.every((value, i) =>
        named && i === 0 ? value.toLowerCase() === b[i]!.toLowerCase() : value === b[i],
      )
    }
    const prepared: Array<{ className: string; name: string; type: SlimType; values: string[] }> = []
    const alreadyPresent: string[] = []
    const seenIncoming = new Map<string, string[]>()

    for (const source of objects) {
      const canonical = schema.resolve(source.class)
      const type = canonical ? schema.get(canonical) : undefined
      if (!canonical || !type) throw new SessionError(`EnergyPlus ${schema.version} has no class '${source.class}'.`)
      const name = type.anon ? '' : source.name.trim()
      if (!type.anon && type.nreq && !name) throw new SessionError(`${canonical} needs a name.`)
      const values: string[] = []
      if (!type.anon && name) values[0] = name
      const indices = new Set<number>()
      for (const field of source.fields) {
        if (!Number.isInteger(field.index) || field.index < 0 || !slotAt(type, field.index)) {
          throw new SessionError(`${canonical} has no field at index ${field.index}.`)
        }
        if (indices.has(field.index)) throw new SessionError(`${canonical} import contains field ${field.index} more than once.`)
        indices.add(field.index)
        if (field.index === 0 && !type.anon) {
          if (field.value.trim().toLowerCase() !== name.toLowerCase()) {
            throw new SessionError(`${canonical} import name does not match its first field.`)
          }
          continue
        }
        const slot = slotAt(type, field.index)!
        const problem = valueProblem(slot.def, field.value)
        if (problem) throw new SessionError(`${canonical} ${displayName(slot)} ${problem}.`)
        while (values.length <= field.index) values.push('')
        values[field.index] = field.value
      }
      const missing = (type.r ?? []).filter((key) => {
        const index = type.f.indexOf(key)
        return index >= 0 && !(values[index] ?? '').trim()
      })
      if (missing.length) throw new SessionError(`${canonical} import is missing required fields: ${missing.join(', ')}.`)
      while (values.at(-1) === '') values.pop()

      const classObjects = (o.doc.byClass.get(canonical.toLowerCase()) ?? [])
        .map((id) => o.doc.objects.get(id)!)
      const existing = type.s
        ? classObjects
        : !type.anon && name
          ? classObjects.filter((obj) => obj.fields[0]?.value.trim().toLowerCase() === name.toLowerCase())
          : []
      if (existing.length > 1) throw new SessionError(`${canonical}${name ? ` '${name}'` : ''} is ambiguous in the open model.`)
      if (existing.length === 1) {
        const currentValues = existing[0]!.fields.map((field) => field.value)
        if (!sameValues(values, currentValues, !type.anon)) {
          throw new SessionError(`${canonical}${name ? ` '${name}'` : ''} already exists with different fields; nothing was imported.`)
        }
        alreadyPresent.push(`${canonical}${name ? ` '${name}'` : ''}`)
        continue
      }
      if (name) this.assertNameFree(canonical, type, name)
      const identity = `${canonical.toLowerCase()}\0${name.toLowerCase()}`
      if (name) {
        const previous = seenIncoming.get(identity)
        if (previous) {
          if (!sameValues(values, previous)) throw new SessionError(`${canonical} '${name}' occurs with conflicting definitions in the import plan.`)
          alreadyPresent.push(`${canonical} '${name}'`)
          continue
        }
        seenIncoming.set(identity, values)
      }
      prepared.push({ className: canonical, name, type, values })
    }

    for (let i = 0; i < prepared.length; i++) {
      const current = prepared[i]!
      if (!current.name) continue
      const currentLists = new Set(current.type.nref ?? [])
      for (let j = 0; j < i; j++) {
        const previous = prepared[j]!
        if (previous.name.toLowerCase() !== current.name.toLowerCase()) continue
        if (previous.className.toLowerCase() === current.className.toLowerCase() ||
          (previous.type.nref ?? []).some((list) => currentLists.has(list))) {
          throw new SessionError(`DataSet objects ${previous.className} and ${current.className} share the name '${current.name}' in EnergyPlus reference lists; nothing was imported.`)
        }
      }
    }

    const classesByReference = new Map<string, Set<string>>()
    for (const className of schema.typeNames) {
      const type = schema.get(className)
      for (const list of type?.nref ?? []) {
        const classes = classesByReference.get(list.toLowerCase()) ?? new Set<string>()
        classes.add(className.toLowerCase())
        classesByReference.set(list.toLowerCase(), classes)
      }
    }
    const unresolved: string[] = []
    for (const source of prepared) {
      for (let index = 0; index < source.values.length; index++) {
        const slot = slotAt(source.type, index)
        const name = source.values[index]?.trim() ?? ''
        if (!name || !slot?.def?.ol?.length) continue
        const allowed = new Set(slot.def.ol.flatMap((list) => [...(classesByReference.get(list.toLowerCase()) ?? [])]))
        const matches = new Set<string>()
        for (const existing of o.doc.objects.values()) {
          if (allowed.has(existing.className.toLowerCase()) &&
            existing.fields[0]?.value.trim().toLowerCase() === name.toLowerCase()) matches.add(`existing:${existing.id}`)
        }
        for (let i = 0; i < prepared.length; i++) {
          const target = prepared[i]!
          if (allowed.has(target.className.toLowerCase()) && target.name.toLowerCase() === name.toLowerCase()) {
            matches.add(`incoming:${i}`)
          }
        }
        if (matches.size !== 1) {
          unresolved.push(`${source.className} '${source.name}' field '${slot.key}' -> '${name}' (${matches.size ? 'ambiguous' : 'not found in the open model or import plan'})`)
        }
      }
    }
    if (unresolved.length) {
      throw new SessionError(`Cannot import: resolve these IDD references first: ${unresolved.slice(0, 12).join('; ')}${unresolved.length > 12 ? `; and ${unresolved.length - 12} more` : ''}. Nothing was imported.`)
    }
    if (!prepared.length) return { imported: [], alreadyPresent, note: 'All planned objects already exist with matching fields.' }

    const imported: string[] = []
    o.history.transact(undoLabel, () => {
      for (const item of prepared) {
        const id = createObject(o.doc, item.className, item.values)
        this.labelFields(id)
        imported.push(`${item.className}${item.name ? ` '${item.name}'` : ''}`)
      }
    })
    this.rebuild()
    return { imported, alreadyPresent, count: imported.length, undoLabel: o.history.undoLabel }
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

  /** Add a complete, idealized zone HVAC configuration as one undoable edit. */
  addIdealLoads(args: { zone: string; heatingSetpoint?: number; coolingSetpoint?: number }): { zone: string; created: string[] } {
    const o = this.need()
    const schema = this.needSchema()
    const zone = this.listZones().find((z) => z.name.trim().toLowerCase() === args.zone.trim().toLowerCase())
    if (!zone) throw new SessionError(`No zone named '${args.zone}'. Call list_zones to see the zone names.`)
    const heatingSetpoint = args.heatingSetpoint ?? 20
    const coolingSetpoint = args.coolingSetpoint ?? 24
    if (!Number.isFinite(heatingSetpoint) || !Number.isFinite(coolingSetpoint) || heatingSetpoint >= coolingSetpoint) {
      throw new SessionError('Heating setpoint must be a finite temperature below the finite cooling setpoint.')
    }

    const objects = (className: string): IdfObject[] =>
      (o.doc.byClass.get(className.toLowerCase()) ?? []).map((id) => o.doc.objects.get(id)!)
    const target = zone.name.trim().toLowerCase()
    const connections = objects('ZoneHVAC:EquipmentConnections')
    if (connections.some((obj) => obj.fields[0]?.value.trim().toLowerCase() === target)) {
      throw new SessionError(`Zone '${zone.name}' already has HVAC equipment connections; this helper only adds ideal loads to an unequipped zone.`)
    }
    const zoneLists = new Map(
      objects('ZoneList').map((obj) => [
        obj.fields[0]?.value.trim().toLowerCase() ?? '',
        new Set(obj.fields.slice(1).map((field) => field.value.trim().toLowerCase()).filter(Boolean)),
      ]),
    )
    const thermostatType = schema.get('ZoneControl:Thermostat')
    const controlledZoneIndex = thermostatType?.f.indexOf('zone_or_zonelist_name') ?? -1
    if (
      objects('ZoneControl:Thermostat').some((obj) => {
        const controlled = obj.fields[controlledZoneIndex]?.value.trim().toLowerCase() ?? ''
        return controlled === target || zoneLists.get(controlled)?.has(target) === true
      })
    ) {
      throw new SessionError(`Zone '${zone.name}' already has a thermostat; this helper does not replace existing controls.`)
    }

    const usedNames = new Set(
      [...o.doc.objects.values()].map((obj) => obj.fields[0]?.value.trim().toLowerCase()).filter(Boolean),
    )
    const name = (base: string): string => {
      let candidate = base
      let suffix = 2
      while (usedNames.has(candidate.toLowerCase())) candidate = `${base} ${suffix++}`
      usedNames.add(candidate.toLowerCase())
      return candidate
    }
    const prefix = `Cartes ${zone.name}`
    const names = {
      availability: name(`${prefix} Ideal Loads Availability`),
      controlSchedule: name(`${prefix} Thermostat Control`),
      heatingSchedule: name(`${prefix} Heating Setpoint`),
      coolingSchedule: name(`${prefix} Cooling Setpoint`),
      dualSetpoint: name(`${prefix} Dual Setpoint`),
      thermostat: name(`${prefix} Thermostat`),
      equipment: name(`${prefix} Equipment`),
      idealLoads: name(`${prefix} Ideal Loads`),
      supplyNode: name(`${prefix} Supply Node`),
      airNode: name(`${prefix} Zone Air Node`),
      returnNode: name(`${prefix} Return Node`),
    }
    const planned: Array<{ className: string; values: string[]; objectName?: string | undefined }> = []
    const add = (className: string, fields: Record<string, string>, groups: Array<Record<string, string>> = []): void => {
      const canonical = schema.resolve(className)
      const type = canonical ? schema.get(canonical) : undefined
      if (!canonical || !type) throw new SessionError(`EnergyPlus ${schema.version} has no class '${className}'.`)
      const values = Array(type.f.length).fill('') as string[]
      for (const [field, value] of Object.entries(fields)) {
        const index = type.f.findIndex((key) => key.toLowerCase() === field.toLowerCase())
        if (index < 0) throw new SessionError(`${canonical} has no field '${field}'.`)
        const problem = valueProblem(type.p[type.f[index]!], value)
        if (problem) throw new SessionError(`${canonical} ${field} ${problem}.`)
        values[index] = value
      }
      for (const required of type.r ?? []) {
        const index = type.f.indexOf(required)
        if (index >= 0 && !values[index]?.trim()) throw new SessionError(`${canonical} requires '${required}'.`)
      }
      if (groups.length && !type.x) throw new SessionError(`${canonical} has no repeating fields.`)
      for (const group of groups) {
        for (const field of type.x!.fields) {
          const value = group[field] ?? ''
          const problem = valueProblem(type.x!.p[field], value)
          if (problem) throw new SessionError(`${canonical} ${field} ${problem}.`)
          values.push(value)
        }
      }
      while (values.length > type.f.length && values[values.length - 1] === '') values.pop()
      while (values.length > 0 && values[values.length - 1] === '') values.pop()
      planned.push({ className: canonical, values, ...(fields.name ? { objectName: fields.name } : {}) })
    }

    add('Schedule:Constant', { name: names.availability, hourly_value: '1' })
    add('Schedule:Constant', { name: names.controlSchedule, hourly_value: '4' })
    add('Schedule:Constant', { name: names.heatingSchedule, hourly_value: String(heatingSetpoint) })
    add('Schedule:Constant', { name: names.coolingSchedule, hourly_value: String(coolingSetpoint) })
    add('ThermostatSetpoint:DualSetpoint', {
      name: names.dualSetpoint,
      heating_setpoint_temperature_schedule_name: names.heatingSchedule,
      cooling_setpoint_temperature_schedule_name: names.coolingSchedule,
    })
    add('ZoneControl:Thermostat', {
      name: names.thermostat,
      zone_or_zonelist_name: zone.name,
      control_type_schedule_name: names.controlSchedule,
      control_1_object_type: 'ThermostatSetpoint:DualSetpoint',
      control_1_name: names.dualSetpoint,
    })
    add('ZoneHVAC:IdealLoadsAirSystem', {
      name: names.idealLoads,
      availability_schedule_name: names.availability,
      zone_supply_air_node_name: names.supplyNode,
    })
    add(
      'ZoneHVAC:EquipmentList',
      { name: names.equipment, load_distribution_scheme: 'SequentialLoad' },
      [
        {
          zone_equipment_object_type: 'ZoneHVAC:IdealLoadsAirSystem',
          zone_equipment_name: names.idealLoads,
          zone_equipment_cooling_sequence: '1',
          zone_equipment_heating_or_no_load_sequence: '1',
        },
      ],
    )
    add('ZoneHVAC:EquipmentConnections', {
      zone_name: zone.name,
      zone_conditioning_equipment_list_name: names.equipment,
      zone_air_inlet_node_or_nodelist_name: names.supplyNode,
      zone_air_node_name: names.airNode,
      zone_return_air_node_or_nodelist_name: names.returnNode,
    })

    const created: string[] = []
    o.history.transact('Add ideal loads', () => {
      for (const item of planned) {
        const id = createObject(o.doc, item.className, item.values)
        this.labelFields(id)
        created.push(item.objectName ? `${item.className} '${item.objectName}'` : `${item.className} for '${zone.name}'`)
      }
    })
    this.rebuild()
    return { zone: zone.name, created }
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
