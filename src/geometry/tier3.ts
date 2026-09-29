/**
 * Tier-3 → detailed conversion — Phase 9 of docs/05-implementation-plan.md.
 *
 * EnergyPlus's "simple" geometry classes describe surfaces by azimuth, tilt, a starting corner,
 * length and height (`Wall:Exterior`, `Roof`, `Window`, …), or by offsets from a window
 * (`Shading:Overhang`, `Shading:Fin`, …), and generate the vertices on input. This file generates
 * the same vertices and writes them as `BuildingSurface:Detailed`, `FenestrationSurface:Detailed`
 * and the `Shading:*:Detailed` classes, so the surfaces can be seen, edited and matched like any
 * other.
 *
 * The algorithms are transcribed from EnergyPlus 26.1 `SurfaceGeometry.cc` — `GetRectSurfaces`,
 * `MakeRectangularVertices`, `GetRectSubSurfaces`, `MakeRelativeRectangularVertices`,
 * `GetRectDetShdSurfaceData`, `GetSimpleShdSurfaceData` — and `Vectors::DetermineAzimuthAndTilt`,
 * down to their quirks, because the only acceptable standard is that EnergyPlus reads the
 * converted file as the same building. Two of those quirks matter:
 *
 *   - The azimuth offset for building and zone north follows the *main* coordinate system
 *     (`GlobalGeometryRules` field 3), while the starting corner is placed in the *rectangular*
 *     coordinate system (field 5). A file may set them differently, and the two are honoured
 *     separately.
 *   - `Ceiling:Interzone` is read with the interzone flag off, so EnergyPlus ignores its
 *     `Outside Boundary Condition Object` and makes the ceiling reference itself, while the floor
 *     on the other side still names it — a one-sided pair it accepts silently. Written out
 *     explicitly that pair is fatal, so the conversion honours the object the file names and
 *     says so in `notes`: after conversion the ceiling really is coupled to the floor above.
 *
 * An explicit user action, never automatic: `planTier3Conversion` changes nothing and lists what
 * it would write and anything it cannot convert; `applyTier3Conversion` does it as one undo step.
 */
import type { IdfDocument, IdfObject } from '../parser/types.js'
import type { CoordinateSystem, Model, Vec3, Zone } from '../model/index.js'
import {
  createObject,
  getSchema,
  lookupInClass,
  readField,
  readNumber,
  removeObjects,
  transact,
  valuesByName,
  vertexLayout,
  type ClassSchema,
} from '../model/index.js'
import {
  newellNormal,
  resolveModel,
  resolveVertex,
  transformContext,
  type ResolvedSurface,
  type TransformContext,
} from './resolve.js'
import { formatCoordinate, unresolveVertex } from './unresolve.js'
import { toSourceOrder } from './create.js'

const DEG = Math.PI / 180

// ---------------------------------------------------------------------------
// The classes, and how EnergyPlus reads each
// ---------------------------------------------------------------------------

type BaseKind = 'Wall' | 'Roof' | 'Ceiling' | 'Floor'

interface BaseClass {
  surfaceType: BaseKind
  boundary: 'Outdoors' | 'Adiabatic' | 'Ground' | 'Interzone'
}

const BASE_CLASSES: Record<string, BaseClass> = {
  'wall:exterior': { surfaceType: 'Wall', boundary: 'Outdoors' },
  'wall:adiabatic': { surfaceType: 'Wall', boundary: 'Adiabatic' },
  'wall:underground': { surfaceType: 'Wall', boundary: 'Ground' },
  'wall:interzone': { surfaceType: 'Wall', boundary: 'Interzone' },
  roof: { surfaceType: 'Roof', boundary: 'Outdoors' },
  'ceiling:adiabatic': { surfaceType: 'Ceiling', boundary: 'Adiabatic' },
  'ceiling:interzone': { surfaceType: 'Ceiling', boundary: 'Interzone' },
  'floor:groundcontact': { surfaceType: 'Floor', boundary: 'Ground' },
  'floor:adiabatic': { surfaceType: 'Floor', boundary: 'Adiabatic' },
  'floor:interzone': { surfaceType: 'Floor', boundary: 'Interzone' },
}

const SUB_CLASSES: Record<string, { surfaceType: 'Window' | 'Door' | 'GlassDoor'; interzone: boolean }> = {
  window: { surfaceType: 'Window', interzone: false },
  door: { surfaceType: 'Door', interzone: false },
  glazeddoor: { surfaceType: 'GlassDoor', interzone: false },
  'window:interzone': { surfaceType: 'Window', interzone: true },
  'door:interzone': { surfaceType: 'Door', interzone: true },
  'glazeddoor:interzone': { surfaceType: 'GlassDoor', interzone: true },
}

const DETACHED = ['shading:site', 'shading:building']
const ATTACHED = ['shading:overhang', 'shading:overhang:projection', 'shading:fin', 'shading:fin:projection']

export const TIER3_CONVERTIBLE: readonly string[] = [
  ...Object.keys(BASE_CLASSES),
  ...Object.keys(SUB_CLASSES),
  ...DETACHED,
  ...ATTACHED,
]

// ---------------------------------------------------------------------------
// EnergyPlus's geometry, transcribed
// ---------------------------------------------------------------------------

/** What EnergyPlus holds for a surface that later surfaces are placed relative to. */
interface Frame {
  id: string
  name: string
  /** World vertices in EnergyPlus's order: upper-left, counter-clockwise from outside. */
  v: Vec3[]
  /** `Surface.Azimuth` / `Tilt`, as recomputed from the vertices. */
  azimuth: number
  tilt: number
  /** `Surface.CosAzim` etc. For simple surfaces these come from the *input* angles. */
  cosAz: number
  sinAz: number
  cosTilt: number
  sinTilt: number
  width: number
  height: number
  zone?: Zone
  /** For a window or door: the frame of the surface it sits on. */
  base?: Frame
}

/** `Vectors::DetermineAzimuthAndTilt`, with the Newell normal as EnergyPlus computes it. */
export function eplusAzimuthTilt(v: readonly Vec3[]): { azimuth: number; tilt: number } {
  const n = newellNormal(v)
  const d = { x: v[2]!.x - v[1]!.x, y: v[2]!.y - v[1]!.y, z: v[2]!.z - v[1]!.z }
  const len = Math.hypot(d.x, d.y, d.z)
  const lcsx = { x: d.x / len, y: d.y / len, z: d.z / len }
  let rot: number
  if (Math.abs(n.z) < 1 - 1.12e-16) {
    // cross(Z, n) = (-n.y, n.x, 0)
    rot = Math.atan2(n.x, -n.y)
  } else {
    rot = Math.atan2(lcsx.y, lcsx.x)
  }
  let tilt = Math.acos(Math.max(-1, Math.min(1, n.z))) / DEG
  let az = rot / DEG
  az = fmod(450 - az, 360)
  az += 90
  if (az < 0) az += 360
  az = fmod(az, 360)
  if (Math.abs(az - 360) < 1e-3) az = 0
  else if (Math.abs(az - 180) < 1e-6) az = 180
  if (Math.abs(tilt - 180) < 1e-6) tilt = 180
  return { azimuth: az, tilt }
}

/** Fortran `MOD`, which keeps the sign of the dividend — not JavaScript's `%`'s behaviour. */
function fmod(a: number, b: number): number {
  return a - Math.trunc(a / b) * b
}

/** The four corners `MakeRectangularVertices` / `MakeRelativeRectangularVertices` generate. */
function rectangle(llc: Vec3, azDeg: number, tiltDeg: number, length: number, height: number): Vec3[] {
  const cA = Math.cos(azDeg * DEG)
  const sA = Math.sin(azDeg * DEG)
  const cT = Math.cos(tiltDeg * DEG)
  const sT = Math.sin(tiltDeg * DEG)
  const xx = [0, 0, length, length]
  const yy = [height, 0, 0, height]
  return xx.map((x, n) => ({
    x: llc.x - x * cA - yy[n]! * cT * sA,
    y: llc.y + x * sA - yy[n]! * cT * cA,
    z: llc.z + yy[n]! * sT,
  }))
}

/** `MakeRelativeRectangularVertices`: a rectangle placed in its base surface's own frame. */
function relativeRectangle(
  base: Frame,
  azDeg: number,
  tiltDeg: number,
  x: number,
  z: number,
  length: number,
  height: number,
): Vec3[] {
  const v2 = base.v[1]!
  const llc = {
    x: v2.x - x * base.cosAz - z * base.cosTilt * base.sinAz,
    y: v2.y + x * base.sinAz - z * base.cosTilt * base.cosAz,
    z: v2.z + z * base.sinTilt,
  }
  return rectangle(llc, azDeg, tiltDeg, length, height)
}

function frameFromVertices(
  id: string,
  name: string,
  v: Vec3[],
  input: { azimuth: number; tilt: number } | undefined,
  size: { width: number; height: number } | undefined,
  zone: Zone | undefined,
): Frame {
  const computed = eplusAzimuthTilt(v)
  const angles = input ?? computed
  const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
  const frame: Frame = {
    id,
    name,
    v,
    azimuth: computed.azimuth,
    tilt: computed.tilt,
    cosAz: Math.cos(angles.azimuth * DEG),
    sinAz: Math.sin(angles.azimuth * DEG),
    cosTilt: Math.cos(angles.tilt * DEG),
    sinTilt: Math.sin(angles.tilt * DEG),
    // `GetVertices` measures a detailed surface's size from its first three corners.
    width: size?.width ?? dist(v[2]!, v[1]!),
    height: size?.height ?? dist(v[1]!, v[0]!),
  }
  if (zone) frame.zone = zone
  return frame
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export type OutputClass =
  | 'BuildingSurface:Detailed'
  | 'FenestrationSurface:Detailed'
  | 'Shading:Site:Detailed'
  | 'Shading:Building:Detailed'
  | 'Shading:Zone:Detailed'

export interface ConvertedObject {
  className: OutputClass
  name: string
  /** Non-vertex fields by IDD name. */
  fields: Record<string, string>
  /** World vertices in EnergyPlus's order. */
  world: Vec3[]
  zone?: Zone
  buildingShading?: boolean
}

export interface Tier3Conversion {
  sourceId: string
  sourceClass: string
  sourceName: string
  /** One object for most classes; two for a fin (left and right), as EnergyPlus makes them. */
  outputs: ConvertedObject[]
}

export interface Tier3Plan {
  conversions: Tier3Conversion[]
  /** Objects that cannot be converted, and why. Nothing is written for them. */
  refused: Array<{ id: string; name: string; className: string; reason: string }>
  /** Behaviour that will change, stated plainly. */
  notes: string[]
}

function zoneOf(model: Model, zoneName: string, spaceName: string): Zone | undefined {
  let id = lookupInClass(model.names, 'zone', zoneName)
  if (id === undefined && spaceName !== '') {
    const spaceId = lookupInClass(model.names, 'space', spaceName)
    const space = spaceId === undefined ? undefined : model.spaces.get(spaceId)
    if (space) id = lookupInClass(model.names, 'zone', space.zoneName)
  }
  return id === undefined ? undefined : model.zones.get(id)
}

/** The numeric fields EnergyPlus reads positionally, with IDD defaults for blanks. */
function numbers(obj: IdfObject, schema: ClassSchema): number[] {
  return schema.fields
    .filter((f) => f.type === 'N')
    .map((f) => readNumber(obj, schema, f.name) ?? 0)
}

function withSystem(ctx: TransformContext, system: CoordinateSystem): TransformContext {
  return { ...ctx, coordinateSystem: system }
}

/**
 * Work out every conversion without changing anything.
 *
 * Order matters and follows EnergyPlus's: base surfaces first (sub-surfaces are placed on them),
 * then windows and doors (overhangs and fins are placed on those), then shading.
 */
export function planTier3Conversion(doc: IdfDocument, model: Model): Tier3Plan {
  const plan: Tier3Plan = { conversions: [], refused: [], notes: [] }
  const refuse = (obj: IdfObject, reason: string): void => {
    plan.refused.push({ id: obj.id, name: obj.fields[0]?.value ?? '', className: obj.className, reason })
  }
  if ((doc.byClass.get('geometrytransform') ?? []).length > 0) {
    for (const k of TIER3_CONVERTIBLE) {
      for (const id of doc.byClass.get(k) ?? []) refuse(doc.objects.get(id)!, 'the file uses GeometryTransform, which this conversion does not reproduce')
    }
    return plan
  }

  const ctx = transformContext(model)
  const rectCtx = withSystem(ctx, model.rules.rectangularSurfaceCoordinateSystem)
  const relative = model.rules.coordinateSystem === 'Relative'
  const resolved = resolveModel(model)
  const detailedFrame = (id: string, name: string, r: ResolvedSurface, zone: Zone | undefined): Frame =>
    frameFromVertices(id, name, r.worldVertices, undefined, undefined, zone)

  // --- base surfaces -------------------------------------------------------
  const baseFrames = new Map<string, Frame>()
  for (const s of model.surfaces.values()) {
    if (s.kind !== 'base') continue
    const r = resolved.get(s.id)
    if (!r || r.worldVertices.length < 3) continue
    const zid = model.zoneOf.get(s.id)
    baseFrames.set(s.name.trim().toLowerCase(), detailedFrame(s.id, s.name, r, zid === undefined ? undefined : model.zones.get(zid)))
  }

  const zoneNames = new Set([...model.zones.values()].map((z) => z.name.trim().toLowerCase()))
  let ceilingInterzone = 0

  for (const [classKey, cls] of Object.entries(BASE_CLASSES)) {
    const schema = getSchema(classKey, model.version)
    for (const id of doc.byClass.get(classKey) ?? []) {
      const obj = doc.objects.get(id)!
      if (!schema) {
        refuse(obj, `no IDD schema for ${obj.className} at ${model.version}`)
        continue
      }
      const name = readField(obj, schema, 'Name')
      const zoneName = readField(obj, schema, 'Zone Name')
      const spaceName = readField(obj, schema, 'Space Name')
      const zone = zoneOf(model, zoneName, spaceName)
      if (!zone) {
        refuse(obj, `its zone '${zoneName || spaceName}' does not exist`)
        continue
      }
      const [azIn, tiltIn, x, y, z, length, height] = numbers(obj, schema) as [number, number, number, number, number, number, number]
      let az = azIn
      if (relative) az += model.site.northAxis + zone.directionOfRelativeNorth
      az += model.site.appendixGRotation
      const llc = resolveVertex({ x, y, z }, rectCtx, zone, false)
      const v = rectangle(llc, az, tiltIn, length, height)

      let boundary: string = cls.boundary
      let boundaryObject = ''
      if (cls.boundary === 'Interzone') {
        const target = readField(obj, schema, 'Outside Boundary Condition Object')
        boundary = zoneNames.has(target.trim().toLowerCase()) ? 'Zone' : 'Surface'
        boundaryObject = target
        if (classKey === 'ceiling:interzone') ceilingInterzone++
      }
      const exposed = boundary === 'Outdoors'
      const fields: Record<string, string> = {
        Name: name,
        'Surface Type': cls.surfaceType,
        'Construction Name': readField(obj, schema, 'Construction Name'),
        'Zone Name': zoneName,
        'Outside Boundary Condition': boundary,
        'Outside Boundary Condition Object': boundaryObject,
        'Sun Exposure': exposed ? 'SunExposed' : 'NoSun',
        'Wind Exposure': exposed ? 'WindExposed' : 'NoWind',
        'Number of Vertices': '4',
      }
      if (spaceName !== '') fields['Space Name'] = spaceName
      plan.conversions.push({
        sourceId: id,
        sourceClass: obj.className,
        sourceName: name,
        outputs: [{ className: 'BuildingSurface:Detailed', name, fields, world: v, zone }],
      })
      baseFrames.set(
        name.trim().toLowerCase(),
        frameFromVertices(id, name, v, { azimuth: az, tilt: tiltIn }, { width: length, height }, zone),
      )
    }
  }
  if (ceilingInterzone > 0) {
    plan.notes.push(
      `${ceilingInterzone} Ceiling:Interzone surface${ceilingInterzone === 1 ? '' : 's'}: EnergyPlus 26.1 ignores ` +
        'this class’s Outside Boundary Condition Object and treats the ceiling as adiabatic, while the floor above ' +
        'still names it. The converted surface honours the object the file names, so after conversion the ceiling ' +
        'is coupled to the floor above — as the class is documented to behave — and results for those zones will change.',
    )
  }

  // --- windows and doors ---------------------------------------------------
  const subFrames = new Map<string, Frame>()
  for (const s of model.surfaces.values()) {
    if (s.kind !== 'sub') continue
    const r = resolved.get(s.id)
    const base = baseFrames.get(s.baseSurfaceName.trim().toLowerCase())
    if (!r || r.worldVertices.length < 3 || !base) continue
    const f = detailedFrame(s.id, s.name, r, base.zone)
    f.base = base
    subFrames.set(s.name.trim().toLowerCase(), f)
  }

  for (const [classKey, cls] of Object.entries(SUB_CLASSES)) {
    const schema = getSchema(classKey, model.version)
    for (const id of doc.byClass.get(classKey) ?? []) {
      const obj = doc.objects.get(id)!
      if (!schema) {
        refuse(obj, `no IDD schema for ${obj.className} at ${model.version}`)
        continue
      }
      const name = readField(obj, schema, 'Name')
      const baseName = readField(obj, schema, 'Building Surface Name')
      const base = baseFrames.get(baseName.trim().toLowerCase())
      if (!base) {
        refuse(obj, `its base surface '${baseName}' cannot be found`)
        continue
      }
      const nums = numbers(obj, schema)
      const [multiplier, x, z, length, height] = nums as [number, number, number, number, number]
      const v = relativeRectangle(base, base.azimuth, base.tilt, x, z, length, height)
      let boundaryObject = ''
      if (cls.interzone) {
        const target = readField(obj, schema, 'Outside Boundary Condition Object')
        // Naming a zone, or blank on a base that names one: EnergyPlus creates the twin itself.
        boundaryObject = zoneNames.has(target.trim().toLowerCase()) ? '' : target
      }
      const fields: Record<string, string> = {
        Name: name,
        'Surface Type': cls.surfaceType,
        'Construction Name': readField(obj, schema, 'Construction Name'),
        'Building Surface Name': baseName,
        'Outside Boundary Condition Object': boundaryObject,
        Multiplier: readField(obj, schema, 'Multiplier') || String(multiplier),
        'Number of Vertices': '4',
      }
      if (schema.index.has('frame and divider name')) {
        const fd = readField(obj, schema, 'Frame and Divider Name')
        if (fd !== '') fields['Frame and Divider Name'] = fd
      }
      plan.conversions.push({
        sourceId: id,
        sourceClass: obj.className,
        sourceName: name,
        outputs: [{ className: 'FenestrationSurface:Detailed', name, fields, world: v, ...(base.zone ? { zone: base.zone } : {}) }],
      })
      const f = frameFromVertices(id, name, v, { azimuth: base.azimuth, tilt: base.tilt }, { width: length, height }, base.zone)
      f.base = base
      subFrames.set(name.trim().toLowerCase(), f)
    }
  }

  // --- detached shading ----------------------------------------------------
  for (const classKey of DETACHED) {
    const schema = getSchema(classKey, model.version)
    const building = classKey === 'shading:building'
    for (const id of doc.byClass.get(classKey) ?? []) {
      const obj = doc.objects.get(id)!
      if (!schema) {
        refuse(obj, `no IDD schema for ${obj.className} at ${model.version}`)
        continue
      }
      const name = readField(obj, schema, 'Name')
      const [azIn, tilt, x, y, z, length, height] = numbers(obj, schema) as [number, number, number, number, number, number, number]
      let az = azIn
      if (building) {
        if (relative) az += model.site.northAxis
        az += model.site.appendixGRotation
      }
      const llc = resolveVertex({ x, y, z }, rectCtx, undefined, building)
      plan.conversions.push({
        sourceId: id,
        sourceClass: obj.className,
        sourceName: name,
        outputs: [
          {
            className: building ? 'Shading:Building:Detailed' : 'Shading:Site:Detailed',
            name,
            fields: { Name: name, 'Number of Vertices': '4' },
            world: rectangle(llc, az, tilt, length, height),
            ...(building ? { buildingShading: true } : {}),
          },
        ],
      })
    }
  }

  // --- overhangs and fins --------------------------------------------------
  for (const classKey of ATTACHED) {
    const schema = getSchema(classKey, model.version)
    const projection = classKey.endsWith(':projection')
    const fin = classKey.startsWith('shading:fin')
    for (const id of doc.byClass.get(classKey) ?? []) {
      const obj = doc.objects.get(id)!
      if (!schema) {
        refuse(obj, `no IDD schema for ${obj.className} at ${model.version}`)
        continue
      }
      const name = readField(obj, schema, 'Name')
      const hostName = readField(obj, schema, 'Window or Door Name')
      const w = subFrames.get(hostName.trim().toLowerCase())
      const b = w?.base
      if (!w || !b) {
        refuse(obj, `its window or door '${hostName}' cannot be found`)
        continue
      }
      const n = numbers(obj, schema)
      // The window's lower-left corner in its base surface's frame.
      const p = { x: w.v[1]!.x - b.v[1]!.x, y: w.v[1]!.y - b.v[1]!.y, z: w.v[1]!.z - b.v[1]!.z }
      const xllc = -p.x * b.cosAz + p.y * b.sinAz
      const yllc = -p.x * b.sinAz * b.cosTilt - p.y * b.cosAz * b.cosTilt + p.z * b.sinTilt
      const shade = (suffix: string, world: Vec3[]): ConvertedObject => ({
        className: 'Shading:Zone:Detailed',
        name: name + suffix,
        fields: { Name: name + suffix, 'Base Surface Name': b.name, 'Number of Vertices': '4' },
        world,
        ...(b.zone ? { zone: b.zone } : {}),
      })
      const outputs: ConvertedObject[] = []
      if (!fin) {
        const [above, tiltFrom, left, right, depthIn] = n as [number, number, number, number, number]
        const length = left + right + w.width
        const depth = projection ? depthIn * w.height : depthIn
        if (length * depth <= 0) {
          refuse(obj, 'its length × depth is not positive, so EnergyPlus makes no surface for it')
          continue
        }
        outputs.push(shade('', relativeRectangle(b, w.azimuth, w.tilt + tiltFrom, xllc - left, yllc + w.height + above, length, depth)))
      } else {
        const [lExt, lAbove, lBelow, lTilt, lDepthIn, rExt, rAbove, rBelow, rTilt, rDepthIn] = n as number[] as [
          number, number, number, number, number, number, number, number, number, number,
        ]
        const lLength = lAbove + lBelow + w.height
        const lDepth = projection ? lDepthIn * w.width : lDepthIn
        if (lLength * lDepth > 0) {
          outputs.push(
            shade(' Left', relativeRectangle(b, w.azimuth - (180 - lTilt), w.tilt, xllc - lExt, yllc - lBelow, -lDepth, lLength)),
          )
        }
        const rLength = rAbove + rBelow + w.height
        const rDepth = projection ? rDepthIn * w.width : rDepthIn
        if (rLength * rDepth > 0) {
          outputs.push(
            shade(
              ' Right',
              relativeRectangle(b, w.azimuth - (180 - rTilt), w.tilt, xllc + w.width + rExt, yllc - rBelow, -rDepth, rLength),
            ),
          )
        }
        if (outputs.length === 0) {
          refuse(obj, 'neither fin has a positive length × depth, so EnergyPlus makes no surface for it')
          continue
        }
      }
      plan.conversions.push({ sourceId: id, sourceClass: obj.className, sourceName: name, outputs })
    }
  }

  return plan
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

function vertexValues(model: Model, o: ConvertedObject, ctx: TransformContext): string[] {
  return toSourceOrder(o.world, model).flatMap((w) => {
    const v = unresolveVertex(w, ctx, o.zone, o.buildingShading === true)
    return [formatCoordinate(v.x), formatCoordinate(v.y), formatCoordinate(v.z)]
  })
}

export interface Tier3Result {
  created: string[]
  removed: string[]
}

/**
 * Write the planned conversions: each new object goes where the old one was, and the old one is
 * removed. Names are kept, so every reference to a converted surface still resolves. One undo
 * step. The Model must be rebuilt afterwards.
 */
export function applyTier3Conversion(doc: IdfDocument, model: Model, plan: Tier3Plan): Tier3Result {
  const ctx = transformContext(model)
  return transact(doc, `Convert ${plan.conversions.length} simplified surface${plan.conversions.length === 1 ? '' : 's'}`, () => {
    const created: string[] = []
    for (const c of plan.conversions) {
      let after = c.sourceId
      for (const o of c.outputs) {
        const classKey = o.className.toLowerCase()
        const schema = getSchema(classKey, model.version)!
        const head = valuesByName(classKey, model.version, o.fields)
        const begin = vertexLayout(schema)!.beginIndex
        while (head.length < begin) head.push('')
        after = createObject(doc, o.className, [...head, ...vertexValues(model, o, ctx)], { after, version: model.version })
        created.push(after)
      }
    }
    const removed = removeObjects(doc, plan.conversions.map((c) => c.sourceId))
    return { created, removed }
  })
}
