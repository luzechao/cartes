/**
 * Surface auto-matching — Phase 7 of docs/05-implementation-plan.md.
 *
 * Finds surfaces that are coincident and opposed — two zones' sides of one partition — and
 * compares that against what the file declares. Per docs/04-architecture.md §Surface
 * auto-matching:
 *
 *   1. Bucket surfaces by plane (quantized normal), and look for each surface's partners in
 *      the bucket of its *reversed* normal.
 *   2. Keep candidates whose planes coincide and whose 2D projections overlap.
 *   3. Classify the overlap: full → a clean `Surface` pair; partial → needs splitting, flagged.
 *   4. Propose, never impose.
 *
 * The fourth point is where most of the design lives, because the corpus says geometry alone
 * cannot be trusted to overrule a file. Of 1,354 interzone pairs declared across the 182 shipped
 * example files, 1,303 are exactly coincident; the other 51 are not, and EnergyPlus accepts every
 * one of them, because it matches interzone surfaces by name and area rather than position.
 * `ChangeoverBypassVAV.idf` pairs walls drawn 6.1 m apart; the large-office reference buildings
 * pair basement ceilings 0.2 m below the floors above them, at 99.07 % overlap; `Plenum.idf`
 * draws each zone at its inside face, 36 mm from its twin. So:
 *
 *   - A declared pair that is consistent (each side names the other) is **never** proposed for
 *     change, whatever the geometry says. If geometry cannot confirm it, that is reported as
 *     information and nothing else.
 *   - A surface with a deliberate non-`Outdoors` boundary — `Adiabatic`, `Ground`, `Zone`,
 *     `OtherSideCoefficients` and the rest — is a modelling decision, not an error. A coincident
 *     partner is reported; nothing is proposed.
 *   - Proposals are made only to repair something that is actually wrong: two `Outdoors`
 *     surfaces pressed face to face (heat lost "outside" through an internal wall), a pair
 *     declared on one side only, or a reference that dangles or points at the wrong surface —
 *     and only when the geometry names exactly one partner.
 */
import polygonClipping, { type MultiPolygon, type Ring } from 'polygon-clipping'
import type { IdfDocument } from '../parser/types.js'
import type { Model, Surface, SubSurface, BuildingSurface, Vec3 } from '../model/index.js'
import { getSchema, setFieldValue, transact } from '../model/index.js'
import { resolveModel, type ResolvedSurface } from './resolve.js'
import { planeBasis } from './triangulate.js'

// ---------------------------------------------------------------------------
// Geometric matching
// ---------------------------------------------------------------------------

export interface MatchSettings {
  /** Largest distance between the two planes for surfaces to count as coincident, in metres. */
  planeTolerance: number
  /** How far from exactly opposed two normals may be, as `1 + dot` (0 is exact). */
  normalTolerance: number
  /**
   * The share of each surface the overlap must cover to be "full", as `1 - fraction`.
   * 1e-3 means 99.9 % of both. The large-office basement ceilings, at 99.07 %, are partial.
   */
  fullTolerance: number
  /** Overlaps smaller than this, in m², are touching rather than overlapping. */
  minOverlapArea: number
}

export const DEFAULT_MATCH_SETTINGS: MatchSettings = {
  planeTolerance: 1e-3,
  normalTolerance: 1e-4,
  fullTolerance: 1e-3,
  minOverlapArea: 1e-4,
}

export type OverlapKind = 'full' | 'partial'

/** Two surfaces found to be coincident and opposed. `a` precedes `b` in the file. */
export interface GeometricPair {
  a: string
  b: string
  kind: OverlapKind
  /** Intersection area, m². */
  overlapArea: number
  /** Overlap as a share of each surface's own area. */
  fractionA: number
  fractionB: number
  /** Distance between the two planes, m. */
  gap: number
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

/** Bucket key for a unit normal. Neighbouring keys are also searched, so rounding cannot split a match. */
const NORMAL_QUANTUM = 1e-2
function normalKey(n: Vec3): [number, number, number] {
  return [Math.round(n.x / NORMAL_QUANTUM), Math.round(n.y / NORMAL_QUANTUM), Math.round(n.z / NORMAL_QUANTUM)]
}

function bounds(vs: readonly Vec3[]): { min: Vec3; max: Vec3 } {
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const v of vs) {
    min.x = Math.min(min.x, v.x)
    min.y = Math.min(min.y, v.y)
    min.z = Math.min(min.z, v.z)
    max.x = Math.max(max.x, v.x)
    max.y = Math.max(max.y, v.y)
    max.z = Math.max(max.z, v.z)
  }
  return { min, max }
}

function boxesMeet(a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }, pad: number): boolean {
  return (
    a.min.x <= b.max.x + pad && b.min.x <= a.max.x + pad &&
    a.min.y <= b.max.y + pad && b.min.y <= a.max.y + pad &&
    a.min.z <= b.max.z + pad && b.min.z <= a.max.z + pad
  )
}

function ringArea(r: Ring): number {
  let s = 0
  for (let i = 0; i < r.length - 1; i++) s += r[i]![0] * r[i + 1]![1] - r[i + 1]![0] * r[i]![1]
  return Math.abs(s) / 2
}

function multiPolygonArea(mp: MultiPolygon): number {
  let a = 0
  for (const poly of mp) poly.forEach((ring, k) => (a += (k === 0 ? 1 : -1) * ringArea(ring)))
  return a
}

/**
 * Area of overlap between two coplanar polygons, measured in `a`'s plane.
 *
 * Both are projected into one shared 2D basis — `projectToPlane` in `triangulate.ts` uses each
 * polygon's own first vertex as origin, which is right for tessellation and wrong for comparing
 * two polygons. `polygon-clipping` handles the concave floors and L-shaped walls the corpus is
 * full of; a convex-only clipper would not.
 */
export function overlapArea(a: ResolvedSurface, b: ResolvedSurface): number {
  const { u, v } = planeBasis(a.normal)
  const o = a.worldVertices[0]
  if (!o || (u.x === 0 && u.y === 0 && u.z === 0)) return 0
  const project = (vs: readonly Vec3[]): Ring =>
    vs.map((p) => {
      const d = { x: p.x - o.x, y: p.y - o.y, z: p.z - o.z }
      return [dot(d, u), dot(d, v)] as [number, number]
    })
  try {
    return multiPolygonArea(polygonClipping.intersection([project(a.worldVertices)], [project(b.worldVertices)]))
  } catch {
    // A self-intersecting polygon can defeat the sweep. The validator already reports those, and
    // an unmatched surface is the safe outcome.
    return 0
  }
}

/** Surfaces that can take part in a match: base surfaces with a plane and an area. */
function matchable(model: Model, resolved: ReadonlyMap<string, ResolvedSurface>): string[] {
  const out: string[] = []
  for (const id of model.surfaceOrder) {
    const s = model.surfaces.get(id)
    const r = resolved.get(id)
    if (!s || s.kind !== 'base' || !r || r.worldVertices.length < 3 || !(r.area > 0)) continue
    if (r.normal.x === 0 && r.normal.y === 0 && r.normal.z === 0) continue
    out.push(id)
  }
  return out
}

/**
 * Every coincident, opposed, overlapping pair of base surfaces in the model.
 *
 * Normal buckets make the search proportional to the surfaces that could plausibly match, not
 * to the square of the file; the plane, bounding-box and polygon tests then run only on those.
 */
export function findCoincidentPairs(
  model: Model,
  resolved: ReadonlyMap<string, ResolvedSurface> = resolveModel(model),
  settings: MatchSettings = DEFAULT_MATCH_SETTINGS,
  ids: readonly string[] = matchable(model, resolved),
): GeometricPair[] {
  const order = new Map(model.surfaceOrder.map((id, i) => [id, i]))
  const buckets = new Map<string, string[]>()
  for (const id of ids) {
    const key = normalKey(resolved.get(id)!.normal).join(',')
    const list = buckets.get(key)
    if (list) list.push(id)
    else buckets.set(key, [id])
  }

  const boxes = new Map(ids.map((id) => [id, bounds(resolved.get(id)!.worldVertices)]))
  const pairs: GeometricPair[] = []
  const seen = new Set<string>()

  for (const idA of ids) {
    const a = resolved.get(idA)!
    const [kx, ky, kz] = normalKey({ x: -a.normal.x, y: -a.normal.y, z: -a.normal.z })
    const offsetA = dot(a.normal, a.centroid)

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const idB of buckets.get(`${kx + dx},${ky + dy},${kz + dz}`) ?? []) {
            if (idB === idA) continue
            const key = order.get(idA)! < order.get(idB)! ? `${idA}|${idB}` : `${idB}|${idA}`
            if (seen.has(key)) continue
            const b = resolved.get(idB)!
            if (1 + dot(a.normal, b.normal) > settings.normalTolerance) continue
            const gap = Math.abs(dot(a.normal, b.centroid) - offsetA)
            if (gap > settings.planeTolerance) continue
            if (!boxesMeet(boxes.get(idA)!, boxes.get(idB)!, settings.planeTolerance)) continue
            seen.add(key)

            const area = overlapArea(a, b)
            if (area < settings.minOverlapArea) continue
            const [first, second] = order.get(idA)! < order.get(idB)! ? [idA, idB] : [idB, idA]
            const fractionA = area / resolved.get(first)!.area
            const fractionB = area / resolved.get(second)!.area
            const full =
              fractionA >= 1 - settings.fullTolerance && fractionB >= 1 - settings.fullTolerance
            pairs.push({
              a: first,
              b: second,
              kind: full ? 'full' : 'partial',
              overlapArea: area,
              fractionA,
              fractionB,
              gap,
            })
          }
        }
      }
    }
  }

  pairs.sort((p, q) => order.get(p.a)! - order.get(q.a)! || order.get(p.b)! - order.get(q.b)!)
  return pairs
}

// ---------------------------------------------------------------------------
// Comparing geometry with what the file declares
// ---------------------------------------------------------------------------

export interface FieldChange {
  objectId: string
  objectName: string
  fieldIndex: number
  fieldName: string
  from: string
  to: string
}

export type ProposalKind =
  /** Both surfaces are `Outdoors`: an internal partition modelled as two exterior walls. */
  | 'pair-exposed'
  /** One side already names the other; the other side does not name it back. */
  | 'complete-pair'
  /** A `Surface` reference that dangles, or names a surface that does not name it back. */
  | 'repair-reference'

export interface MatchProposal {
  /** Stable within one report, for accept/reject bookkeeping in the UI. */
  id: string
  kind: ProposalKind
  a: string
  b: string
  /** Human-readable reason, naming both surfaces. */
  reason: string
  changes: FieldChange[]
}

export interface MatchNote {
  a: string
  b?: string
  reason: string
}

export interface MatchReport {
  pairs: GeometricPair[]
  /** Declared pairs the geometry confirms. */
  confirmed: Array<{ a: string; b: string }>
  /** Declared, consistent pairs the geometry cannot confirm. Information only. */
  unconfirmed: MatchNote[]
  /** Coincident surfaces whose boundary condition is a deliberate choice. Left alone. */
  intentional: MatchNote[]
  /** Partial overlaps between surfaces not already paired: they need splitting to pair. */
  partial: GeometricPair[]
  /** Full matches that could be repaired but are not proposed, and why. */
  blocked: MatchNote[]
  proposals: MatchProposal[]
}

const DELIBERATE = new Set([
  'adiabatic',
  'ground',
  'foundation',
  'zone',
  'space',
  'othersidecoefficients',
  'othersideconditionsmodel',
  'groundfcfactormethod',
  'groundslabpreprocessoraverage',
  'groundslabpreprocessorcore',
  'groundslabpreprocessorperimeter',
  'groundbasementpreprocessoraveragewall',
  'groundbasementpreprocessoraveragefloor',
  'groundbasementpreprocessorupperwall',
  'groundbasementpreprocessorlowerwall',
])

function lower(s: string): string {
  return s.trim().toLowerCase()
}

type Base = BuildingSurface

function surfaceByName(model: Model): Map<string, Surface> {
  const out = new Map<string, Surface>()
  for (const s of model.surfaces.values()) {
    const k = lower(s.name)
    if (!out.has(k)) out.set(k, s)
  }
  return out
}

/** What a base surface's boundary condition says, reduced to what matching cares about. */
type Boundary =
  | { kind: 'exposed' }
  | { kind: 'deliberate'; value: string }
  | { kind: 'self' }
  | { kind: 'paired'; twin: Surface }
  | { kind: 'one-sided'; twin: Surface }
  | { kind: 'dangling'; name: string }
  | { kind: 'other'; value: string }

function boundaryOf(s: Base, names: Map<string, Surface>): Boundary {
  const bc = lower(s.outsideBoundaryCondition)
  if (bc === 'outdoors') return { kind: 'exposed' }
  if (bc === 'surface') {
    const twin = names.get(lower(s.outsideBoundaryConditionObject))
    if (!twin) return { kind: 'dangling', name: s.outsideBoundaryConditionObject }
    if (twin.id === s.id) return { kind: 'self' }
    const back = twin.kind === 'base' && lower(twin.outsideBoundaryCondition) === 'surface'
      ? names.get(lower(twin.outsideBoundaryConditionObject))
      : undefined
    return back?.id === s.id ? { kind: 'paired', twin } : { kind: 'one-sided', twin }
  }
  if (DELIBERATE.has(bc)) return { kind: 'deliberate', value: s.outsideBoundaryCondition }
  return { kind: 'other', value: s.outsideBoundaryCondition }
}

/**
 * The field writes that make `s` one half of a `Surface` pair with `twin`.
 *
 * Sun and wind exposure go to `NoSun` / `NoWind` alongside, because an interzone surface that
 * claims to see the sun is its own error; values already right are not rewritten.
 */
function pairingChanges(model: Model, doc: IdfDocument, s: Surface, twin: Surface): FieldChange[] {
  const obj = doc.objects.get(s.id)
  const schema = obj && getSchema(obj.classKey, model.version)
  if (!obj || !schema) return []
  const wanted: Array<[string, string]> =
    s.kind === 'base'
      ? [
          ['Outside Boundary Condition', 'Surface'],
          ['Outside Boundary Condition Object', twin.name],
          ['Sun Exposure', 'NoSun'],
          ['Wind Exposure', 'NoWind'],
        ]
      : [['Outside Boundary Condition Object', twin.name]]
  const out: FieldChange[] = []
  for (const [fieldName, to] of wanted) {
    const fieldIndex = schema.index.get(fieldName.toLowerCase())
    if (fieldIndex === undefined) continue
    const from = obj.fields[fieldIndex]?.value ?? ''
    if (lower(from) === lower(to)) continue
    out.push({ objectId: s.id, objectName: s.name, fieldIndex, fieldName, from, to })
  }
  return out
}

/**
 * Pair the windows and doors of two walls being paired.
 *
 * EnergyPlus requires the sub-surfaces of an interzone wall to be interzone too, each naming its
 * opposite number. So a wall pair is only proposed when every sub-surface on each side has
 * exactly one coincident, opposed partner on the other — otherwise it is blocked, with the
 * reason, rather than proposed half-done.
 */
function subSurfaceChanges(
  model: Model,
  doc: IdfDocument,
  resolved: ReadonlyMap<string, ResolvedSurface>,
  a: Base,
  b: Base,
  settings: MatchSettings,
): FieldChange[] | string {
  if (a.subSurfaces.length === 0 && b.subSurfaces.length === 0) return []
  if (a.subSurfaces.length !== b.subSurfaces.length) {
    return `${a.name} has ${a.subSurfaces.length} window/door(s) and ${b.name} has ${b.subSurfaces.length}`
  }
  const ids = [...a.subSurfaces, ...b.subSurfaces].filter((id) => resolved.has(id))
  const pairs = findCoincidentPairs(model, resolved, settings, ids).filter((p) => p.kind === 'full')
  const changes: FieldChange[] = []
  const inA = new Set(a.subSurfaces)
  for (const subId of a.subSurfaces) {
    const partners = pairs.filter((p) => (p.a === subId || p.b === subId) && inA.has(p.a) !== inA.has(p.b))
    if (partners.length !== 1) {
      return `window/door ${model.surfaces.get(subId)?.name ?? subId} has no single opposite number on ${b.name}`
    }
    const p = partners[0]!
    const other = model.surfaces.get(p.a === subId ? p.b : p.a) as SubSurface
    const mine = model.surfaces.get(subId) as SubSurface
    changes.push(...pairingChanges(model, doc, mine, other), ...pairingChanges(model, doc, other, mine))
  }
  return changes
}

export interface InteriorConstructions {
  wall?: string
  /** For the floor side of a floor/ceiling pair. */
  floor?: string
  /** For the ceiling (or roof) side of a floor/ceiling pair. */
  ceiling?: string
}

export interface ProposeOptions {
  /**
   * Constructions for faces that were exterior until paired.
   *
   * Two exterior walls pressed together each carry an *exterior* construction — brick outside,
   * gypsum inside — and EnergyPlus expects the two sides of an interzone surface to be each
   * other's reverse; it warns when they are not, and the partition's heat transfer is then that
   * of two exterior walls. When given, a `pair-exposed` proposal also switches both sides to
   * these, but only where the current constructions are not already reverses of each other and
   * the replacements are. Never applied to the other proposal kinds: there, the constructions
   * were already chosen for an interzone surface by whoever wrote the file.
   */
  interiorConstructions?: InteriorConstructions
}

/** A construction's layers, outside first, lowercased. Undefined when it is not declared. */
function constructionLayers(doc: IdfDocument, name: string): string[] | undefined {
  const wanted = lower(name)
  for (const id of doc.byClass.get('construction') ?? []) {
    const obj = doc.objects.get(id)
    if (obj && lower(obj.fields[0]?.value ?? '') === wanted) {
      return obj.fields.slice(1).map((f) => lower(f.value)).filter((v) => v !== '')
    }
  }
  return undefined
}

function areReverses(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false
  return a.every((layer, i) => layer === b[b.length - 1 - i])
}

function interiorFor(s: Base, c: InteriorConstructions): string | undefined {
  const t = lower(s.surfaceType)
  if (t === 'wall') return c.wall
  if (t === 'floor') return c.floor
  if (t === 'roof' || t === 'ceiling') return c.ceiling
  return undefined
}

/** The construction changes a newly paired, formerly exterior pair needs. See `ProposeOptions`. */
function constructionChanges(
  doc: IdfDocument,
  model: Model,
  a: Base,
  b: Base,
  c: InteriorConstructions,
): FieldChange[] {
  if (areReverses(constructionLayers(doc, a.constructionName), constructionLayers(doc, b.constructionName))) return []
  const ca = interiorFor(a, c)
  const cb = interiorFor(b, c)
  if (!ca || !cb || !areReverses(constructionLayers(doc, ca), constructionLayers(doc, cb))) return []
  const out: FieldChange[] = []
  for (const [s, to] of [[a, ca], [b, cb]] as const) {
    if (lower(s.constructionName) === lower(to)) continue
    const obj = doc.objects.get(s.id)
    const index = obj && getSchema(obj.classKey, model.version)?.index.get('construction name')
    if (index === undefined) continue
    out.push({ objectId: s.id, objectName: s.name, fieldIndex: index, fieldName: 'Construction Name', from: s.constructionName, to })
  }
  return out
}

/**
 * Compare coincident geometry with declared boundary conditions, and propose repairs.
 *
 * Changes nothing. See the header for exactly what is and is not proposed, and why.
 */
export function proposeMatches(
  doc: IdfDocument,
  model: Model,
  resolved: ReadonlyMap<string, ResolvedSurface> = resolveModel(model),
  settings: MatchSettings = DEFAULT_MATCH_SETTINGS,
  options: ProposeOptions = {},
): MatchReport {
  const pairs = findCoincidentPairs(model, resolved, settings)
  const names = surfaceByName(model)
  const report: MatchReport = {
    pairs,
    confirmed: [],
    unconfirmed: [],
    intentional: [],
    partial: [],
    blocked: [],
    proposals: [],
  }

  // Full partners per surface, for the uniqueness rule.
  const fullPartners = new Map<string, string[]>()
  for (const p of pairs) {
    if (p.kind !== 'full') continue
    for (const [x, y] of [[p.a, p.b], [p.b, p.a]] as const) {
      const list = fullPartners.get(x)
      if (list) list.push(y)
      else fullPartners.set(x, [y])
    }
  }
  const pairedGeometrically = new Set(pairs.filter((p) => p.kind === 'full').map((p) => `${p.a}|${p.b}`))
  const order = new Map(model.surfaceOrder.map((id, i) => [id, i]))
  const key = (x: string, y: string): string => (order.get(x)! < order.get(y)! ? `${x}|${y}` : `${y}|${x}`)

  // Declared, consistent pairs: confirmed by geometry, or reported as unconfirmed. Never proposed.
  const declared = new Set<string>()
  for (const s of model.surfaces.values()) {
    if (s.kind !== 'base') continue
    const bnd = boundaryOf(s, names)
    if (bnd.kind !== 'paired') continue
    const k = key(s.id, bnd.twin.id)
    if (declared.has(k)) continue
    declared.add(k)
    const [a, b] = k.split('|') as [string, string]
    if (pairedGeometrically.has(k)) {
      report.confirmed.push({ a, b })
    } else {
      const g = pairs.find((p) => `${p.a}|${p.b}` === k)
      report.unconfirmed.push({
        a,
        b,
        reason: g
          ? `declared pair overlaps only ${(Math.min(g.fractionA, g.fractionB) * 100).toFixed(2)} %`
          : 'declared pair is not coincident; EnergyPlus pairs by name and area, so it may be intended',
      })
    }
  }

  let serial = 0
  for (const p of pairs) {
    const k = `${p.a}|${p.b}`
    if (declared.has(k)) continue
    const a = model.surfaces.get(p.a) as Base
    const b = model.surfaces.get(p.b) as Base
    const ba = boundaryOf(a, names)
    const bb = boundaryOf(b, names)
    const label = `${a.name} / ${b.name}`

    if (p.kind === 'partial') {
      // Only worth flagging where a pair could plausibly have been intended: neither side
      // already paired, self-referencing, or given a deliberate boundary. Measured on the
      // corpus, without this rule 325 partial overlaps are reported, almost all between
      // `Adiabatic` surfaces of models that chose adiabatic partitions on purpose.
      const open = (x: Boundary): boolean => x.kind === 'exposed' || x.kind === 'dangling' || x.kind === 'one-sided'
      if (open(ba) && open(bb)) report.partial.push(p)
      continue
    }

    // A side already in a consistent pair with someone else is not ours to break.
    if (ba.kind === 'paired' || bb.kind === 'paired') {
      const which = ba.kind === 'paired' ? a : b
      const twin = (ba.kind === 'paired' ? ba : bb) as { twin: Surface }
      report.blocked.push({ a: p.a, b: p.b, reason: `${which.name} is already paired with ${twin.twin.name}` })
      continue
    }
    if (ba.kind === 'self' || bb.kind === 'self') {
      report.intentional.push({ a: p.a, b: p.b, reason: `${label}: one side is a self-referencing slab` })
      continue
    }
    if (ba.kind === 'deliberate' || bb.kind === 'deliberate' || ba.kind === 'other' || bb.kind === 'other') {
      const which = ba.kind === 'deliberate' || ba.kind === 'other' ? a : b
      report.intentional.push({
        a: p.a,
        b: p.b,
        reason: `${label}: ${which.name} is ${which.outsideBoundaryCondition}, a deliberate boundary`,
      })
      continue
    }

    // Both sides are now exposed, one-sided or dangling. Require the geometry to be unambiguous.
    const ambiguous = [a, b].find((s) => (fullPartners.get(s.id)?.length ?? 0) !== 1)
    if (ambiguous) {
      report.blocked.push({
        a: p.a,
        b: p.b,
        reason: `${ambiguous.name} coincides with ${fullPartners.get(ambiguous.id)!.length} surfaces; which is its twin is not clear`,
      })
      continue
    }
    // Two faces of one zone pressed together are a modelling oddity, not a partition to wire up.
    const zoneA = model.zoneOf.get(a.id)
    if (zoneA !== undefined && zoneA === model.zoneOf.get(b.id)) {
      report.blocked.push({ a: p.a, b: p.b, reason: `${label} are both in zone ${model.zones.get(zoneA)?.name ?? zoneA}` })
      continue
    }

    const sub = subSurfaceChanges(model, doc, resolved, a, b, settings)
    if (typeof sub === 'string') {
      report.blocked.push({ a: p.a, b: p.b, reason: sub })
      continue
    }

    const changes = [...pairingChanges(model, doc, a, b), ...pairingChanges(model, doc, b, a), ...sub]
    if (changes.length === 0) continue

    let kind: ProposalKind
    let reason: string
    if (ba.kind === 'exposed' && bb.kind === 'exposed') {
      kind = 'pair-exposed'
      reason = `${a.name} and ${b.name} are face to face but both open to the outdoors`
      if (options.interiorConstructions) {
        const cons = constructionChanges(doc, model, a, b, options.interiorConstructions)
        if (cons.length > 0) {
          changes.push(...cons)
          reason += `; their constructions are not each other's reverse, so both take interior ones`
        }
      }
    } else if ((ba.kind === 'one-sided' && ba.twin.id === b.id) || (bb.kind === 'one-sided' && bb.twin.id === a.id)) {
      const [from, to] = ba.kind === 'one-sided' && ba.twin.id === b.id ? [a, b] : [b, a]
      kind = 'complete-pair'
      reason = `${from.name} names ${to.name} as its twin, but ${to.name} does not name it back`
    } else {
      kind = 'repair-reference'
      const broken = [
        [a, ba, b],
        [b, bb, a],
      ].flatMap(([s, x, other]) => {
        const me = s as Base
        const bx = x as Boundary
        const them = other as Base
        if (bx.kind === 'dangling') return [`${me.name} names '${bx.name}', which does not exist, but coincides with ${them.name}`]
        if (bx.kind === 'one-sided') return [`${me.name} names ${bx.twin.name}, which does not name it back, but coincides with ${them.name}`]
        return []
      })
      reason = broken.join('; ')
    }
    report.proposals.push({ id: `m${serial++}`, kind, a: p.a, b: p.b, reason, changes })
  }

  return report
}

/**
 * Apply accepted proposals, as one undo step. Returns the ids of the objects written.
 *
 * The typed Model is kept in step for boundary conditions by `setFieldValue`; call `buildModel`
 * afterwards anyway if sub-surfaces were paired, as with any edit the UI does not track itself.
 */
export function applyMatchProposals(
  doc: IdfDocument,
  model: Model,
  proposals: readonly MatchProposal[],
): string[] {
  return transact(doc, proposals.length === 1 ? 'Pair surfaces' : `Pair ${proposals.length} surface pairs`, () => {
    const dirtied = new Set<string>()
    for (const p of proposals) {
      for (const c of p.changes) {
        if (setFieldValue(doc, model, c.objectId, c.fieldIndex, c.to)) dirtied.add(c.objectId)
      }
    }
    return [...dirtied]
  })
}
