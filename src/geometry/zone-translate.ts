/**
 * Whole-zone translate — Phase 6 of docs/05-implementation-plan.md.
 *
 * Three different things are positioned in a zone's frame, each under its own
 * `GlobalGeometryRules` field: surface vertices (field 3), daylighting reference points and
 * illuminance maps (field 4), and the Tier 3 rectangular classes (field 5). Each is either
 * `Relative` — carried by the `Zone` origin — or `World`, carrying its own absolute
 * coordinates. A file may mix them; `PurchAirWithDaylighting.idf` is World throughout, the
 * `5ZoneAirCooled` pair are Relative surfaces with no daylighting at all.
 *
 * So the operation is: move the origin if anything that rides on it belongs to the zone, then
 * rewrite explicitly whatever does not ride on it. In a Relative file that is one field-level
 * edit on one object for the entire zone, which is the cheapest possible diff; in a World file
 * it is every vertex, which is the only correct one.
 *
 * Propose-then-apply, like `planCornerMove` and `planSurfaceDeletion`: the plan says what will
 * move, what will be left behind and why, and which interzone pairs the move pulls apart.
 */
import type { IdfDocument, IdfObject } from '../parser/types.js'
import type { CoordinateSystem, Model, Vec3, Zone } from '../model/index.js'
import {
  getSchema,
  lookupInClass,
  readField,
  readNumber,
  setFieldValue,
  TIER3_SURFACE_CLASSES,
  transact,
  type ClassSchema,
} from '../model/index.js'
import { resolveModel, resolveVertex, transformContext, type TransformContext } from './resolve.js'
import { formatCoordinate, unresolveVertex } from './unresolve.js'
import { setVertexWorld, surfaceNamed, type GeometryEditResult, type SplitPair } from './edit-geometry.js'

export interface LeftBehind {
  objectId: string
  name: string
  reason: string
}

export interface ZoneTranslationPlan {
  zoneId: string
  delta: Vec3
  /** The zone origin before and after, when the origin carries anything in this zone. */
  origin?: { from: Vec3; to: Vec3 }
  /** Surfaces whose vertices are rewritten, because they are in World coordinates. */
  surfaces: string[]
  /** `Daylighting:ReferencePoint` / `Output:IlluminanceMap` objects rewritten explicitly. */
  daylighting: string[]
  /** Objects in the zone that will not move, and why. Never silently. */
  leftBehind: LeftBehind[]
  /**
   * Interzone pairs with one side in the zone and the other outside it.
   *
   * A translated zone keeps every surface's area, and EnergyPlus matches interzone surfaces by
   * name and area, so this is not fatal to the simulation — but the two sides no longer
   * coincide, which is almost never what a user dragging a zone wants. Reported so the UI can
   * say so; the caller decides.
   */
  splitPairs: SplitPair[]
}

const DAYLIGHTING_POINT = 'daylighting:referencepoint'
const ILLUMINANCE_MAP = 'output:illuminancemap'
const TIER3_SET = new Set(TIER3_SURFACE_CLASSES)

/** `Zone Name` until 9.6 renamed it `Zone or Space Name`. Read whichever the schema has. */
function zoneOrSpaceField(obj: IdfObject, schema: ClassSchema): string {
  return readField(obj, schema, 'Zone or Space Name') || readField(obj, schema, 'Zone Name')
}

/** The zone an object names, directly or through a Space. */
function zoneNamedBy(model: Model, name: string): string | undefined {
  if (name.trim() === '') return undefined
  const direct = lookupInClass(model.names, 'zone', name)
  if (direct !== undefined) return direct
  const spaceId = lookupInClass(model.names, 'space', name)
  const space = spaceId ? model.spaces.get(spaceId) : undefined
  return space ? lookupInClass(model.names, 'zone', space.zoneName) : undefined
}

function objectsInZone(
  doc: IdfDocument,
  model: Model,
  zoneId: string,
  classKeys: Iterable<string>,
): Array<{ obj: IdfObject; schema: ClassSchema }> {
  const out: Array<{ obj: IdfObject; schema: ClassSchema }> = []
  for (const classKey of classKeys) {
    for (const id of doc.byClass.get(classKey) ?? []) {
      const obj = doc.objects.get(id)
      const schema = obj && getSchema(classKey, model.version)
      if (!obj || !schema || !doc.order.includes(id)) continue
      const named = zoneOrSpaceField(obj, schema) || readField(obj, schema, 'Space Name')
      if (zoneNamedBy(model, named) === zoneId) out.push({ obj, schema })
    }
  }
  return out
}

/**
 * The zone origin change that moves everything relative to it by `delta` in world space.
 *
 * Relative resolution is `world = R_building (origin + R_zone local)` in plan, and
 * `z = local.z + origin.z`. The zone rotation acts on `local` only, so the origin moves by the
 * building rotation's inverse applied to `delta`, and z by `delta.z` unchanged.
 */
function originDelta(delta: Vec3, ctx: TransformContext): Vec3 {
  const b = ctx.buildingRelNorth
  return { x: delta.x * b.cos + delta.y * b.sin, y: -delta.x * b.sin + delta.y * b.cos, z: delta.z }
}

function withSystem(ctx: TransformContext, system: CoordinateSystem): TransformContext {
  return { ...ctx, coordinateSystem: system }
}

export function planZoneTranslation(
  doc: IdfDocument,
  model: Model,
  zoneId: string,
  delta: Vec3,
  ctx: TransformContext = transformContext(model),
): ZoneTranslationPlan | undefined {
  const zone = model.zones.get(zoneId)
  if (!zone) return undefined
  const rules = model.rules

  const memberSurfaces = [...model.zoneOf].filter(([, z]) => z === zoneId).map(([id]) => id)
  const daylightingObjects = objectsInZone(doc, model, zoneId, [DAYLIGHTING_POINT, ILLUMINANCE_MAP])
  const tier3 = objectsInZone(doc, model, zoneId, TIER3_SET)

  const ridesOnOrigin =
    (rules.coordinateSystem === 'Relative' && memberSurfaces.length > 0) ||
    (rules.daylightingReferencePointCoordinateSystem === 'Relative' && daylightingObjects.length > 0) ||
    (rules.rectangularSurfaceCoordinateSystem === 'Relative' && tier3.length > 0)

  const plan: ZoneTranslationPlan = {
    zoneId,
    delta,
    surfaces: rules.coordinateSystem === 'World' ? memberSurfaces : [],
    daylighting:
      rules.daylightingReferencePointCoordinateSystem === 'World'
        ? daylightingObjects.map((d) => d.obj.id)
        : [],
    leftBehind: [],
    splitPairs: [],
  }

  if (ridesOnOrigin) {
    const d = originDelta(delta, ctx)
    plan.origin = {
      from: { ...zone.origin },
      to: { x: zone.origin.x + d.x, y: zone.origin.y + d.y, z: zone.origin.z + d.z },
    }
  }

  // Rectangular surfaces written in World coordinates carry absolute `Starting X/Y/Z` fields
  // that we do not model yet (see Phase 9). Moving the zone without them would split the zone
  // in two; say so rather than pretend.
  if (rules.rectangularSurfaceCoordinateSystem === 'World') {
    for (const { obj } of tier3) {
      plan.leftBehind.push({
        objectId: obj.id,
        name: obj.fields[0]?.value ?? '',
        reason: `${obj.className} is positioned in World coordinates, which are not yet editable`,
      })
    }
  }

  const inZone = new Set(memberSurfaces)
  for (const id of memberSurfaces) {
    const s = model.surfaces.get(id)
    if (!s || s.kind === 'shading') continue
    if (s.kind === 'base' && s.outsideBoundaryCondition.trim().toLowerCase() !== 'surface') continue
    const twin = surfaceNamed(model, s.outsideBoundaryConditionObject)
    if (!twin || twin.id === id || inZone.has(twin.id)) continue
    plan.splitPairs.push({ surfaceId: id, surfaceName: s.name, twinId: twin.id, twinName: twin.name })
  }

  return plan
}

/** Write a numeric field only when its value actually changes — numerically, not textually. */
function writeNumber(doc: IdfDocument, model: Model, obj: IdfObject, schema: ClassSchema, name: string, value: number): boolean {
  const index = schema.index.get(name.toLowerCase())
  if (index === undefined) return false
  const text = formatCoordinate(value)
  const current = obj.fields[index]?.value.trim() ?? ''
  if (current !== '' && Number(current) === Number(text)) return false
  return setFieldValue(doc, model, obj.id, index, text)
}

function moveDaylighting(
  doc: IdfDocument,
  model: Model,
  obj: IdfObject,
  schema: ClassSchema,
  zone: Zone,
  delta: Vec3,
  ctx: TransformContext,
): boolean {
  // Daylighting objects resolve exactly as a zone surface's vertex does, under their own
  // coordinate-system field. A translation is affine, so the local change is the difference
  // of two unresolved points — valid under any rotation either branch applies.
  const dctx = withSystem(ctx, model.rules.daylightingReferencePointCoordinateSystem)
  const local = (p: Vec3): Vec3 => unresolveVertex(p, dctx, zone, false)
  const toWorld = (p: Vec3): Vec3 => resolveVertex(p, dctx, zone, false)

  let changed = false
  if (obj.classKey === DAYLIGHTING_POINT) {
    const p = {
      x: readNumber(obj, schema, 'X-Coordinate of Reference Point') ?? 0,
      y: readNumber(obj, schema, 'Y-Coordinate of Reference Point') ?? 0,
      z: readNumber(obj, schema, 'Z-Coordinate of Reference Point') ?? 0,
    }
    const w = toWorld(p)
    const moved = local({ x: w.x + delta.x, y: w.y + delta.y, z: w.z + delta.z })
    if (writeNumber(doc, model, obj, schema, 'X-Coordinate of Reference Point', moved.x)) changed = true
    if (writeNumber(doc, model, obj, schema, 'Y-Coordinate of Reference Point', moved.y)) changed = true
    if (writeNumber(doc, model, obj, schema, 'Z-Coordinate of Reference Point', moved.z)) changed = true
  } else {
    // An illuminance map is an axis-aligned grid in its own frame. Shift it there.
    const w0 = toWorld({ x: 0, y: 0, z: 0 })
    const o = local(w0)
    const d = local({ x: w0.x + delta.x, y: w0.y + delta.y, z: w0.z + delta.z })
    const shift = { x: d.x - o.x, y: d.y - o.y, z: d.z - o.z }
    const fields: Array<[string, number]> = [
      ['X Minimum Coordinate', shift.x],
      ['X Maximum Coordinate', shift.x],
      ['Y Minimum Coordinate', shift.y],
      ['Y Maximum Coordinate', shift.y],
      ['Z height', shift.z],
    ]
    for (const [name, by] of fields) {
      const current = readNumber(obj, schema, name)
      if (current === undefined) continue
      if (writeNumber(doc, model, obj, schema, name, current + by)) changed = true
    }
  }
  return changed
}

/**
 * Apply a plan from {@link planZoneTranslation}.
 *
 * Surfaces are moved from positions resolved *before* the origin changes, so the two halves of
 * the operation cannot see each other's work. In practice at most one of them has anything to
 * do for surfaces, but the ordering makes that a guarantee rather than an observation.
 */
export function applyZoneTranslation(
  doc: IdfDocument,
  model: Model,
  plan: ZoneTranslationPlan,
  ctx: TransformContext = transformContext(model),
): GeometryEditResult {
  return transact(doc, 'Move zone', () => {
    const zone = model.zones.get(plan.zoneId)
    if (!zone) return { changed: false, dirtied: [] }
    const { delta } = plan
    const dirtied = new Set<string>()

    const resolved = plan.surfaces.length > 0 ? resolveModel(model) : undefined
    for (const id of plan.surfaces) {
      const r = resolved!.get(id)
      if (!r) continue
      r.worldVertices.forEach((v, i) => {
        const result = setVertexWorld(doc, model, id, i, { x: v.x + delta.x, y: v.y + delta.y, z: v.z + delta.z }, ctx)
        for (const d of result.dirtied) dirtied.add(d)
      })
    }

    for (const id of plan.daylighting) {
      const obj = doc.objects.get(id)
      const schema = obj && getSchema(obj.classKey, model.version)
      if (obj && schema && moveDaylighting(doc, model, obj, schema, zone, delta, ctx)) dirtied.add(id)
    }

    if (plan.origin) {
      const obj = doc.objects.get(zone.id)
      const schema = obj && getSchema(obj.classKey, model.version)
      if (obj && schema) {
        const to = plan.origin.to
        let changed = false
        if (writeNumber(doc, model, obj, schema, 'X Origin', to.x)) changed = true
        if (writeNumber(doc, model, obj, schema, 'Y Origin', to.y)) changed = true
        if (writeNumber(doc, model, obj, schema, 'Z Origin', to.z)) changed = true
        if (changed) {
          dirtied.add(zone.id)
          // Hold what the file now says, as `writeVertex` does for vertices.
          zone.origin = { x: Number(formatCoordinate(to.x)), y: Number(formatCoordinate(to.y)), z: Number(formatCoordinate(to.z)) }
        }
      }
    }

    return { changed: dirtied.size > 0, dirtied: [...dirtied] }
  })
}
