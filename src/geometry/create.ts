/**
 * Creation tools — Phase 8 of docs/05-implementation-plan.md.
 *
 * Draw a surface, extrude a footprint into a zone, place a window or door. Every vertex is
 * given in world coordinates — what the viewport shows — and written back in whatever frame
 * and vertex order the file's `GlobalGeometryRules` declare, through the same `unresolve` path
 * the Phase 6 editors use. So a zone drawn in a `Relative`, `Clockwise`, `LowerLeftCorner`
 * file comes out in that file's conventions, not ours.
 *
 * Creation refuses rather than repairs: a window outside its wall, a fifth vertex on a
 * sub-surface, a footprint that crosses itself — each is refused with the reason and nothing is
 * written. The validator and EnergyPlus would both reject them anyway; refusing at the point of
 * creation puts the message where the mistake was made.
 *
 * Interzone pairing is not done here. An extruded zone's walls are created exposed, and the
 * Phase 7 matcher proposes pairing any that turn out to be face to face with a neighbour. One
 * mechanism, reviewed by the user, rather than two that could disagree.
 */
import type { IdfDocument } from '../parser/types.js'
import type { Model, Surface, Vec3, Zone } from '../model/index.js'
import {
  createObject,
  getSchema,
  lookupInClass,
  transact,
  valuesByName,
  vertexLayout,
} from '../model/index.js'
import {
  newellNormal,
  orderVertices,
  resolveSurface,
  transformContext,
  type ResolvedSurface,
  type TransformContext,
} from './resolve.js'
import { formatCoordinate, unresolveVertex } from './unresolve.js'
import { isPolygonSelfIntersecting, pointInPolygonWithBoundary } from './validate.js'
import { overlapArea } from './match.js'
import { surfaceNamed } from './edit-geometry.js'

export interface CreateResult {
  /** Ids of every object created, zone first when there is one. */
  created: string[]
  /** Why nothing was created, when nothing was. */
  refused?: string
}

function refuse(reason: string): CreateResult {
  return { created: [], refused: reason }
}

const EPS = 1e-6

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}
function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
}
function scale(a: Vec3, k: number): Vec3 {
  return { x: a.x * k, y: a.y * k, z: a.z * k }
}
function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}
function unit(a: Vec3): Vec3 {
  const l = Math.hypot(a.x, a.y, a.z)
  return l > 0 ? scale(a, 1 / l) : { x: 0, y: 0, z: 0 }
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const SURFACE_CLASSES = [
  'buildingsurface:detailed',
  'wall:detailed',
  'roofceiling:detailed',
  'floor:detailed',
  'fenestrationsurface:detailed',
  'shading:site:detailed',
  'shading:building:detailed',
  'shading:zone:detailed',
]

function namesIn(doc: IdfDocument, classKeys: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const k of classKeys) {
    for (const id of doc.byClass.get(k) ?? []) {
      const name = doc.objects.get(id)?.fields[0]?.value
      if (name) out.add(name.trim().toLowerCase())
    }
  }
  return out
}

/** `base`, or `base 2`, `base 3`, … — the first not already taken among surfaces. */
export function uniqueSurfaceName(doc: IdfDocument, base: string): string {
  const taken = namesIn(doc, SURFACE_CLASSES)
  if (!taken.has(base.toLowerCase())) return base
  for (let k = 2; ; k++) {
    const name = `${base} ${k}`
    if (!taken.has(name.toLowerCase())) return name
  }
}

// ---------------------------------------------------------------------------
// Constructions
// ---------------------------------------------------------------------------

export type ConstructionRole = 'exterior-wall' | 'roof' | 'ground-floor' | 'window' | 'door'

const TEMPLATE_NAMES: Record<ConstructionRole, string> = {
  'exterior-wall': 'Exterior Wall',
  roof: 'Roof',
  'ground-floor': 'Ground Floor',
  window: 'Exterior Window',
  door: 'Exterior Door',
}

/**
 * A construction name for a new surface of the given role: the file's own habit where it has
 * one (the construction most used by surfaces of that kind), else the template's, else none.
 * Never invents a construction that does not exist in the file.
 */
export function suggestConstruction(doc: IdfDocument, model: Model, role: ConstructionRole): string | undefined {
  const counts = new Map<string, number>()
  for (const s of model.surfaces.values()) {
    const type = s.kind === 'shading' ? '' : s.surfaceType.trim().toLowerCase()
    const fits =
      s.kind === 'base'
        ? (role === 'exterior-wall' && type === 'wall' && s.outsideBoundaryCondition.toLowerCase() === 'outdoors') ||
          (role === 'roof' && type === 'roof') ||
          (role === 'ground-floor' && type === 'floor' && s.outsideBoundaryCondition.toLowerCase().startsWith('ground'))
        : s.kind === 'sub'
          ? (role === 'window' && type === 'window') || (role === 'door' && type === 'door')
          : false
    if (fits && s.kind !== 'shading' && s.constructionName) {
      counts.set(s.constructionName, (counts.get(s.constructionName) ?? 0) + 1)
    }
  }
  const habitual = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (habitual) return habitual
  const declared = namesIn(doc, ['construction'])
  return declared.has(TEMPLATE_NAMES[role].toLowerCase()) ? TEMPLATE_NAMES[role] : undefined
}

/**
 * Interior constructions for faces the matcher pairs: the file's habit for interzone walls,
 * floors and ceilings where it has one, else the template's symmetric ones where they exist.
 */
export function suggestInteriorConstructions(
  doc: IdfDocument,
  model: Model,
): { wall?: string; floor?: string; ceiling?: string } {
  const habit = (types: string[]): string | undefined => {
    const counts = new Map<string, number>()
    for (const s of model.surfaces.values()) {
      if (s.kind !== 'base' || s.outsideBoundaryCondition.trim().toLowerCase() !== 'surface') continue
      if (!types.includes(s.surfaceType.trim().toLowerCase()) || !s.constructionName) continue
      counts.set(s.constructionName, (counts.get(s.constructionName) ?? 0) + 1)
    }
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
  }
  const declared = namesIn(doc, ['construction'])
  const template = (name: string): string | undefined => (declared.has(name.toLowerCase()) ? name : undefined)
  const out: { wall?: string; floor?: string; ceiling?: string } = {}
  const wall = habit(['wall']) ?? template('Interior Wall')
  const floor = habit(['floor']) ?? template('Interior Slab')
  const ceiling = habit(['ceiling', 'roof']) ?? template('Interior Slab')
  if (wall) out.wall = wall
  if (floor) out.floor = floor
  if (ceiling) out.ceiling = ceiling
  return out
}

// ---------------------------------------------------------------------------
// Writing vertices in the file's conventions
// ---------------------------------------------------------------------------

/**
 * The as-written order that `orderVertices` turns into `ring`.
 *
 * `ring` is in the canonical resolved order — starting upper-left, counter-clockwise seen from
 * outside. The file may want a different start and direction; this is the inverse permutation.
 */
export function toSourceOrder(ring: readonly Vec3[], model: Model): Vec3[] {
  const { sourceIndex } = orderVertices(ring, model.rules.startingVertexPosition, model.rules.vertexEntryDirection)
  const out: Vec3[] = new Array(ring.length)
  sourceIndex.forEach((src, i) => (out[src] = ring[i]!))
  return out
}

function vertexValues(
  model: Model,
  ring: readonly Vec3[],
  zone: Zone | undefined,
  ctx: TransformContext,
): string[] {
  return toSourceOrder(ring, model).flatMap((w) => {
    const v = unresolveVertex(w, ctx, zone, false)
    return [formatCoordinate(v.x), formatCoordinate(v.y), formatCoordinate(v.z)]
  })
}

function zoneNamed(model: Model, name: string): Zone | undefined {
  const id = lookupInClass(model.names, 'zone', name)
  return id === undefined ? undefined : model.zones.get(id)
}

// ---------------------------------------------------------------------------
// Base surfaces
// ---------------------------------------------------------------------------

export interface BaseSurfaceSpec {
  name: string
  surfaceType: 'Wall' | 'Floor' | 'Roof' | 'Ceiling'
  construction: string
  zoneName: string
  boundary: string
  boundaryObject?: string
  /**
   * World vertices in canonical order: starting upper-left and counter-clockwise *seen from
   * outside the zone*. The normal points out of the zone.
   */
  world: readonly Vec3[]
}

function exposureFor(boundary: string): [string, string] {
  return boundary.toLowerCase() === 'outdoors' ? ['SunExposed', 'WindExposed'] : ['NoSun', 'NoWind']
}

function writeBaseSurface(
  doc: IdfDocument,
  model: Model,
  spec: BaseSurfaceSpec,
  zone: Zone | undefined,
  ctx: TransformContext,
): string {
  const classKey = 'buildingsurface:detailed'
  const schema = getSchema(classKey, model.version)!
  const [sun, wind] = exposureFor(spec.boundary)
  const head = valuesByName(classKey, model.version, {
    Name: spec.name,
    'Surface Type': spec.surfaceType,
    'Construction Name': spec.construction,
    'Zone Name': spec.zoneName,
    'Outside Boundary Condition': spec.boundary,
    'Outside Boundary Condition Object': spec.boundaryObject ?? '',
    'Sun Exposure': sun,
    'Wind Exposure': wind,
    'Number of Vertices': String(spec.world.length),
  })
  const begin = vertexLayout(schema)!.beginIndex
  while (head.length < begin) head.push('')
  return createObject(doc, 'BuildingSurface:Detailed', [...head, ...vertexValues(model, spec.world, zone, ctx)], {
    version: model.version,
  })
}

/** Create one base surface. Refused unless it is planar, simple, and its zone exists. */
export function createBaseSurface(
  doc: IdfDocument,
  model: Model,
  spec: BaseSurfaceSpec,
  ctx: TransformContext = transformContext(model),
): CreateResult {
  const zone = zoneNamed(model, spec.zoneName)
  if (!zone) return refuse(`zone '${spec.zoneName}' does not exist`)
  const problem = polygonProblem(spec.world)
  if (problem) return refuse(problem)
  const name = uniqueSurfaceName(doc, spec.name)
  return { created: [transact(doc, 'Create surface', () => writeBaseSurface(doc, model, { ...spec, name }, zone, ctx))] }
}

/** Why a world polygon cannot be a surface, or undefined when it can. */
function polygonProblem(world: readonly Vec3[]): string | undefined {
  if (world.length < 3) return 'a surface needs at least three vertices'
  const n = newellNormal(world)
  if (n.x === 0 && n.y === 0 && n.z === 0) return 'the vertices are collinear or coincident'
  const c = world.reduce((s, p) => add(s, p), { x: 0, y: 0, z: 0 })
  const centroid = scale(c, 1 / world.length)
  const off = Math.max(...world.map((p) => Math.abs(dot(sub(p, centroid), n))))
  if (off > 1e-3) return `the vertices are not coplanar (${(off * 1000).toFixed(1)} mm out of plane)`
  const flat = project2d(world, n)
  if (isPolygonSelfIntersecting(flat)) return 'the outline crosses itself'
  return undefined
}

function project2d(world: readonly Vec3[], normal: Vec3): number[] {
  const helper = Math.abs(normal.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 }
  const u = unit(cross(helper, normal))
  const v = cross(normal, u)
  const o = world[0]!
  return world.flatMap((p) => [dot(sub(p, o), u), dot(sub(p, o), v)])
}

// ---------------------------------------------------------------------------
// Extruding a footprint into a zone
// ---------------------------------------------------------------------------

export interface ExtrudeSpec {
  zoneName: string
  /** Plan outline in world x/y, either winding; consecutive duplicates and collinear points are dropped. */
  footprint: ReadonlyArray<{ x: number; y: number }>
  /** Floor elevation, world z. */
  baseZ?: number
  height: number
  constructions: { wall: string; floor: string; roof: string }
  /**
   * Floor boundary. Defaults to `Ground` at z = 0 and `Outdoors` above it — a raised floor is
   * usually someone else's ceiling, which the matcher will then offer to pair.
   */
  floorBoundary?: string
  roofBoundary?: string
}

export interface ExtrudeResult extends CreateResult {
  zoneId?: string
  floorId?: string
  roofId?: string
  wallIds?: string[]
}

/** Clean a plan outline: drop repeats and collinear points, and wind it counter-clockwise. */
export function normalizeFootprint(points: ReadonlyArray<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  let pts = points.map((p) => ({ x: p.x, y: p.y }))
  pts = pts.filter((p, i) => {
    const q = pts[(i + 1) % pts.length]!
    return Math.hypot(p.x - q.x, p.y - q.y) > EPS
  })
  let changed = true
  while (changed && pts.length >= 3) {
    changed = false
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length]!
      const b = pts[i]!
      const c = pts[(i + 1) % pts.length]!
      const crossZ = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
      const len = Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y)
      if (len === 0 || Math.abs(crossZ) <= EPS * len) {
        pts.splice(i, 1)
        changed = true
        break
      }
    }
  }
  let area2 = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!
    const q = pts[(i + 1) % pts.length]!
    area2 += p.x * q.y - q.x * p.y
  }
  return area2 < 0 ? pts.reverse() : pts
}

/**
 * Create a zone and its enclosure from a plan outline: one floor, one roof, one wall per edge.
 *
 * Walls start upper-left and run counter-clockwise seen from outside; the floor faces down and
 * the roof up — the orientation EnergyPlus's volume and enclosure checks assume.
 */
export function extrudeZone(doc: IdfDocument, model: Model, spec: ExtrudeSpec): ExtrudeResult {
  const name = spec.zoneName.trim()
  if (name === '') return refuse('the zone needs a name')
  if (namesIn(doc, ['zone']).has(name.toLowerCase())) return refuse(`a zone named '${name}' already exists`)
  if (!(spec.height > 0)) return refuse('the height must be greater than zero')
  const footprint = normalizeFootprint(spec.footprint)
  if (footprint.length < 3) return refuse('the footprint needs at least three distinct, non-collinear corners')
  if (isPolygonSelfIntersecting(footprint.flatMap((p) => [p.x, p.y]))) return refuse('the footprint crosses itself')
  for (const [role, c] of Object.entries(spec.constructions)) {
    if (!namesIn(doc, ['construction']).has(c.toLowerCase())) return refuse(`${role} construction '${c}' does not exist`)
  }

  const z0 = spec.baseZ ?? 0
  const z1 = z0 + spec.height
  const floorBoundary = spec.floorBoundary ?? (Math.abs(z0) < EPS ? 'Ground' : 'Outdoors')
  const roofBoundary = spec.roofBoundary ?? 'Outdoors'

  return transact(doc, `Create zone ${name}`, () => {
    const zoneId = createObject(
      doc,
      'Zone',
      valuesByName('zone', model.version, {
        Name: name,
        'Direction of Relative North': '0',
        'X Origin': '0',
        'Y Origin': '0',
        'Z Origin': '0',
      }),
      { version: model.version },
    )
    // Not in the Model yet; enough of one for `unresolve` to write into its frame.
    const zone: Zone = { id: zoneId, name, directionOfRelativeNorth: 0, origin: { x: 0, y: 0, z: 0 }, multiplier: 1, type: '' }
    const ctx = transformContext(model)
    const at = (p: { x: number; y: number }, z: number): Vec3 => ({ x: p.x, y: p.y, z })

    const wallIds: string[] = []
    footprint.forEach((p, i) => {
      const q = footprint[(i + 1) % footprint.length]!
      wallIds.push(
        writeBaseSurface(
          doc,
          model,
          {
            name: uniqueSurfaceName(doc, `${name} Wall ${i + 1}`),
            surfaceType: 'Wall',
            construction: spec.constructions.wall,
            zoneName: name,
            boundary: 'Outdoors',
            world: [at(p, z1), at(p, z0), at(q, z0), at(q, z1)],
          },
          zone,
          ctx,
        ),
      )
    })
    const floorId = writeBaseSurface(
      doc,
      model,
      {
        name: uniqueSurfaceName(doc, `${name} Floor`),
        surfaceType: 'Floor',
        construction: spec.constructions.floor,
        zoneName: name,
        boundary: floorBoundary,
        world: [...footprint].reverse().map((p) => at(p, z0)),
      },
      zone,
      ctx,
    )
    const roofId = writeBaseSurface(
      doc,
      model,
      {
        name: uniqueSurfaceName(doc, `${name} Roof`),
        surfaceType: 'Roof',
        construction: spec.constructions.roof,
        zoneName: name,
        boundary: roofBoundary,
        world: footprint.map((p) => at(p, z1)),
      },
      zone,
      ctx,
    )
    return { created: [zoneId, ...wallIds, floorId, roofId], zoneId, floorId, roofId, wallIds }
  })
}

// ---------------------------------------------------------------------------
// Windows and doors
// ---------------------------------------------------------------------------

export interface SubSurfaceSpec {
  name: string
  surfaceType: 'Window' | 'Door' | 'GlassDoor'
  construction: string
  baseId: string
  /** World vertices, canonical order (upper-left, counter-clockwise seen from outside). At most 4. */
  world: readonly Vec3[]
}

export interface SubSurfaceResult extends CreateResult {
  /** The window created on the interzone twin's side, when the base has one. */
  twinId?: string
}

/** Tolerances the checks below share with the validator's own. */
const COPLANAR = 1e-3
const CONTAIN = 1e-4

function pseudoResolved(world: readonly Vec3[], normal: Vec3): ResolvedSurface {
  return {
    id: '',
    worldVertices: [...world],
    sourceIndex: world.map((_, i) => i),
    normal,
    planarityError: 0,
    triangles: new Uint32Array(0),
    area: 0,
    centroid: world[0]!,
  }
}

/** Polygon area by Newell's method, which is exact for any planar polygon, convex or not. */
function polygonArea(world: readonly Vec3[]): number {
  let x = 0
  let y = 0
  let z = 0
  for (let i = 0; i < world.length; i++) {
    const a = world[i]!
    const b = world[(i + 1) % world.length]!
    x += (a.y - b.y) * (a.z + b.z)
    y += (a.z - b.z) * (a.x + b.x)
    z += (a.x - b.x) * (a.y + b.y)
  }
  return Math.hypot(x, y, z) / 2
}

/**
 * Why a sub-surface cannot go on its base, or undefined when it can.
 *
 * The three rules EnergyPlus enforces, checked before anything is written: at most four
 * vertices (the IDD stops at four), coplanar with the base and facing the same way, and wholly
 * inside it — tested as area, not just corners, so a window cannot straddle a notch in an
 * L-shaped wall with all four corners inside. It must also not overlap a sibling.
 */
function subSurfaceProblem(
  model: Model,
  base: Surface,
  baseGeo: ResolvedSurface,
  world: readonly Vec3[],
  resolved: (id: string) => ResolvedSurface | undefined,
): string | undefined {
  const schema = getSchema('fenestrationsurface:detailed', model.version)
  const max = schema ? vertexLayout(schema)!.max : 4
  if (world.length > max) return `a window or door has at most ${max} vertices; this has ${world.length}`
  const problem = polygonProblem(world)
  if (problem) return problem
  const n = baseGeo.normal
  const c = baseGeo.centroid
  const off = Math.max(...world.map((p) => Math.abs(dot(sub(p, c), n))))
  if (off > COPLANAR) return `it is ${(off * 1000).toFixed(1)} mm off the plane of ${base.name}`
  if (dot(unit(newellNormal(world)), n) < 0.999) return `it faces the other way from ${base.name}`
  const flatBase = project2d(baseGeo.worldVertices, n)
  const o = baseGeo.worldVertices[0]!
  const u = unit(cross(Math.abs(n.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 }, n))
  const v = cross(n, u)
  for (const p of world) {
    if (!pointInPolygonWithBoundary(dot(sub(p, o), u), dot(sub(p, o), v), flatBase, CONTAIN)) {
      return `it extends outside ${base.name}`
    }
  }
  const candidate = pseudoResolved(world, n)
  if (overlapArea(baseGeo, candidate) < polygonArea(world) * (1 - 1e-6) - 1e-9) {
    return `it extends outside ${base.name}`
  }
  if (base.kind === 'base') {
    for (const siblingId of base.subSurfaces) {
      const sibling = resolved(siblingId)
      if (sibling && overlapArea(sibling, candidate) > 1e-6) {
        return `it overlaps ${model.surfaces.get(siblingId)?.name ?? siblingId}`
      }
    }
  }
  return undefined
}

function writeSubSurface(
  doc: IdfDocument,
  model: Model,
  spec: SubSurfaceSpec & { baseName: string; boundaryObject?: string },
  zone: Zone | undefined,
  ctx: TransformContext,
): string {
  const classKey = 'fenestrationsurface:detailed'
  const schema = getSchema(classKey, model.version)!
  const head = valuesByName(classKey, model.version, {
    Name: spec.name,
    'Surface Type': spec.surfaceType,
    'Construction Name': spec.construction,
    'Building Surface Name': spec.baseName,
    'Outside Boundary Condition Object': spec.boundaryObject ?? '',
    'Number of Vertices': String(spec.world.length),
  })
  const begin = vertexLayout(schema)!.beginIndex
  while (head.length < begin) head.push('')
  return createObject(doc, 'FenestrationSurface:Detailed', [...head, ...vertexValues(model, spec.world, zone, ctx)], {
    version: model.version,
  })
}

/**
 * Create a window or door on a base surface.
 *
 * When the base is one side of an interzone pair, EnergyPlus requires the opening on both sides,
 * each naming the other; the twin's copy is created with it, wound to face the twin's way. A
 * twin drawn offset from its base cannot be given a matching opening, so that is refused.
 */
export function createSubSurface(
  doc: IdfDocument,
  model: Model,
  spec: SubSurfaceSpec,
  ctx: TransformContext = transformContext(model),
): SubSurfaceResult {
  const base = model.surfaces.get(spec.baseId)
  if (!base || base.kind !== 'base') return refuse('windows and doors go on walls, roofs and floors')
  const bc = base.outsideBoundaryCondition.trim().toLowerCase()
  if (bc !== 'outdoors' && bc !== 'surface') {
    return refuse(`${base.name} has a ${base.outsideBoundaryCondition} boundary; openings need Outdoors or an interzone twin`)
  }
  if (!namesIn(doc, ['construction']).has(spec.construction.toLowerCase())) {
    return refuse(`construction '${spec.construction}' does not exist`)
  }
  const geo = (id: string): ResolvedSurface | undefined => {
    const s = model.surfaces.get(id)
    return s ? resolveSurface(model, s, ctx) : undefined
  }
  const baseGeo = geo(base.id)!
  const problem = subSurfaceProblem(model, base, baseGeo, spec.world, geo)
  if (problem) return refuse(`cannot place it: ${problem}`)

  let twin: Surface | undefined
  if (bc === 'surface') {
    twin = surfaceNamed(model, base.outsideBoundaryConditionObject)
    if (!twin || twin.kind !== 'base' || twin.id === base.id) {
      return refuse(`${base.name} names an interzone twin that cannot be found`)
    }
    const twinGeo = geo(twin.id)!
    const mirrored = [...spec.world].reverse()
    const twinProblem = subSurfaceProblem(model, twin, twinGeo, [mirrored[mirrored.length - 1]!, ...mirrored.slice(0, -1)], geo)
    if (twinProblem) return refuse(`cannot mirror it onto the twin ${twin.name}: ${twinProblem}`)
  }

  const zoneOf = (s: Surface): Zone | undefined => {
    const id = model.zoneOf.get(s.id)
    return id === undefined ? undefined : model.zones.get(id)
  }

  return transact(doc, `Create ${spec.surfaceType.toLowerCase()}`, () => {
    const name = uniqueSurfaceName(doc, spec.name)
    const twinName = twin ? uniqueSurfaceName(doc, `${spec.name} ${twin.name}`) : undefined
    const id = writeSubSurface(
      doc,
      model,
      { ...spec, name, baseName: base.name, ...(twinName ? { boundaryObject: twinName } : {}) },
      zoneOf(base),
      ctx,
    )
    if (!twin || !twinName) return { created: [id] }
    // Seen from the twin's side, the upper-right corner becomes the upper-left.
    const r = [...spec.world].reverse()
    const twinWorld = [r[r.length - 1]!, ...r.slice(0, -1)]
    const twinId = writeSubSurface(
      doc,
      model,
      { ...spec, name: twinName, world: twinWorld, baseName: twin.name, boundaryObject: name, baseId: twin.id },
      zoneOf(twin),
      ctx,
    )
    return { created: [id, twinId], twinId }
  })
}

export interface OpeningSpec {
  surfaceType?: 'Window' | 'Door' | 'GlassDoor'
  construction: string
  name?: string
  width: number
  height: number
  /** Height of the bottom edge above the lowest point of the base. Doors: 0. */
  sill: number
  /** Distance of the left edge from the base's leftmost point, seen from outside. Default: centred. */
  offset?: number
}

/**
 * The in-plane frame of a surface seen from outside: `right` and `up`, with `up` as close to
 * world up as the plane allows (north for a horizontal surface).
 */
export function surfaceFrame(normal: Vec3): { right: Vec3; up: Vec3 } {
  const n = unit(normal)
  const ref = Math.abs(n.z) < 0.999 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 }
  const up = unit(sub(ref, scale(n, dot(ref, n))))
  return { right: cross(up, n), up }
}

/** Width and height of a surface in its own frame — the space available for an opening. */
export function surfaceExtent(geo: ResolvedSurface): { width: number; height: number } {
  const { right, up } = surfaceFrame(geo.normal)
  const xs = geo.worldVertices.map((p) => dot(p, right))
  const ys = geo.worldVertices.map((p) => dot(p, up))
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
}

/** Place a rectangular window or door by size and position on its base. */
export function placeOpening(
  doc: IdfDocument,
  model: Model,
  baseId: string,
  spec: OpeningSpec,
  ctx: TransformContext = transformContext(model),
): SubSurfaceResult {
  const base = model.surfaces.get(baseId)
  if (!base || base.kind !== 'base') return refuse('select a wall, roof or floor')
  if (!(spec.width > 0 && spec.height > 0)) return refuse('width and height must be greater than zero')
  const geo = resolveSurface(model, base, ctx)
  const { right, up } = surfaceFrame(geo.normal)
  const xs = geo.worldVertices.map((p) => dot(p, right))
  const ys = geo.worldVertices.map((p) => dot(p, up))
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const extentX = Math.max(...xs) - minX
  const left = minX + (spec.offset ?? (extentX - spec.width) / 2)
  const bottom = minY + spec.sill
  // Any point of the plane; the rectangle is then built from in-plane directions only.
  const planePoint = sub(geo.centroid, add(scale(right, dot(geo.centroid, right)), scale(up, dot(geo.centroid, up))))
  const at = (x: number, y: number): Vec3 => add(planePoint, add(scale(right, x), scale(up, y)))
  const world = [
    at(left, bottom + spec.height),
    at(left, bottom),
    at(left + spec.width, bottom),
    at(left + spec.width, bottom + spec.height),
  ]
  const type = spec.surfaceType ?? 'Window'
  return createSubSurface(
    doc,
    model,
    {
      name: spec.name ?? `${base.name} ${type}`,
      surfaceType: type,
      construction: spec.construction,
      baseId,
      world,
    },
    ctx,
  )
}
