/**
 * Project the document's geometry classes into typed entities.
 *
 * Everything here is read-only over the document: the model is a view, and the document
 * stays the source of truth. Behaviour is matched against `SurfaceGeometry.cc` rather than
 * against the IDD alone wherever the two differ — several EnergyPlus defaults and synonyms
 * are not expressible in the IDD, and the IDD is silent on what happens when a field is
 * wrong rather than missing.
 */
import type { IdfDocument, IdfObject } from '../parser/types.js'
import {
  getSchema,
  readField,
  readFieldOrDefault,
  readNumber,
  resolveIddVersion,
  vertexLayout,
  type ClassSchema,
  type VersionResolution,
} from './idd.js'
import { buildNameIndex, lookupIn, lookupInClass, type NameIndex } from './names.js'
import type {
  BuildingSurface,
  CoordinateSystem,
  GeometryRules,
  ModelDiagnostic,
  ShadingKind,
  ShadingSurface,
  SiteRules,
  Space,
  StartingVertexPosition,
  SubSurface,
  Surface,
  Vec3,
  VertexEntryDirection,
  Zone,
} from './entities.js'

/** Classes that carry explicit vertices and belong to a zone. Tier 1 plus Tier 2. */
export const BASE_SURFACE_CLASSES: readonly string[] = [
  'buildingsurface:detailed',
  'wall:detailed',
  'roofceiling:detailed',
  'floor:detailed',
]

export const SUB_SURFACE_CLASSES: readonly string[] = ['fenestrationsurface:detailed']

export const SHADING_CLASSES: readonly string[] = [
  'shading:site:detailed',
  'shading:building:detailed',
  'shading:zone:detailed',
]

/** Surface type implied by the Tier 2 class name, which has no `Surface Type` field. */
const IMPLIED_SURFACE_TYPE: Record<string, string> = {
  'wall:detailed': 'Wall',
  'roofceiling:detailed': 'Roof',
  'floor:detailed': 'Floor',
}

const SHADING_KIND: Record<string, ShadingKind> = {
  'shading:site:detailed': 'site',
  'shading:building:detailed': 'building',
  'shading:zone:detailed': 'zone',
}

/** Everything we draw. */
const RENDERED_CLASSES = new Set([
  ...BASE_SURFACE_CLASSES,
  ...SUB_SURFACE_CLASSES,
  ...SHADING_CLASSES,
])

/**
 * Tier 3: surfaces EnergyPlus draws that we preserve but do not yet render. Feeding
 * `Model.unrendered`, which drives the "N surfaces not shown" banner — a file must never
 * appear emptier than it is.
 *
 * Two shapes, both parametric rather than vertex-bearing: the rectangular family, which the
 * IDD marks with a `Starting X Coordinate` field, and the overhang/fin family, which is
 * dimensioned off its host window instead. `test/model/model.test.ts` asserts that every
 * geometry class carrying a `Starting X Coordinate`, at every one of the 27 covered releases,
 * is either rendered or listed here — so a class added in a future release fails a test
 * rather than silently disappearing from the banner. The overhang/fin half has no such
 * marker and is pinned by name in the same file.
 */
const TIER3_SURFACE_CLASSES: readonly string[] = [
  // Rectangular — `Starting X Coordinate`.
  'wall:exterior',
  'wall:adiabatic',
  'wall:underground',
  'wall:interzone',
  'roof',
  'ceiling:adiabatic',
  'ceiling:interzone',
  'floor:groundcontact',
  'floor:adiabatic',
  'floor:interzone',
  'window',
  'door',
  'glazeddoor',
  'window:interzone',
  'door:interzone',
  'glazeddoor:interzone',
  'shading:site',
  'shading:building',
  // Dimensioned off a host window or door.
  'shading:overhang',
  'shading:overhang:projection',
  'shading:fin',
  'shading:fin:projection',
]

const TIER3_CLASS_SET = new Set(TIER3_SURFACE_CLASSES)

export { RENDERED_CLASSES, TIER3_SURFACE_CLASSES }

export interface Model {
  doc: IdfDocument
  /** The IDD release every schema in this model was read at. */
  version: string
  versionResolution: VersionResolution
  names: NameIndex
  rules: GeometryRules
  site: SiteRules
  zones: Map<string, Zone>
  spaces: Map<string, Space>
  surfaces: Map<string, Surface>
  /** Surface ids in document order. */
  surfaceOrder: string[]
  /**
   * Surface id → owning zone id, following inheritance: a sub-surface takes its base
   * surface's zone, attached shading takes its base surface's zone. Absent for detached
   * shading, which has no zone by construction.
   */
  zoneOf: Map<string, string>
  diagnostics: ModelDiagnostic[]
  /**
   * Geometry classes present in the file that we preserve but do not render — the Tier 3
   * parametric set. Drives the "N objects not rendered" banner; never a silent drop.
   */
  unrendered: Map<string, number>
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

class Reporter {
  readonly diagnostics: ModelDiagnostic[] = []

  add(severity: ModelDiagnostic['severity'], code: string, message: string, objectId?: string): void {
    const d: ModelDiagnostic = { severity, code, message }
    if (objectId !== undefined) d.objectId = objectId
    this.diagnostics.push(d)
  }
}

/**
 * A numeric field, defaulted per the IDD, reporting anything that is neither a number nor a
 * recognised placeholder. `autocalculate` and `autosize` are legitimate; `=$appGAngle` is a
 * parametric-preprocessor placeholder that only EPMacro/ParametricPreprocessor can resolve.
 */
function num(
  obj: IdfObject,
  schema: ClassSchema,
  name: string,
  fallback: number,
  report: Reporter,
): number {
  const parsed = readNumber(obj, schema, name)
  if (parsed !== undefined) return parsed

  const raw = readFieldOrDefault(obj, schema, name)
  const lowered = raw.toLowerCase()
  if (raw !== '' && lowered !== 'autocalculate' && lowered !== 'autosize') {
    report.add(
      'warning',
      'non-numeric-field',
      `${obj.className} '${obj.fields[0]?.value ?? ''}': ${name} is '${raw}', which is not a number — ` +
        `treating it as ${fallback}. Preprocessor placeholders must be expanded first.`,
      obj.id,
    )
  }
  return fallback
}

/** Optional numeric: undefined when blank or `autocalculate`, with no diagnostic. */
function optionalNum(obj: IdfObject, schema: ClassSchema, name: string): number | undefined {
  return readNumber(obj, schema, name)
}

/**
 * Read the vertex triples.
 *
 * `Number of Vertices` is advisory: it defaults to `autocalculate`, and EnergyPlus derives
 * the true count from how many numbers were supplied. We do the same, and report a
 * disagreement rather than trusting either side silently.
 */
function readVertices(obj: IdfObject, schema: ClassSchema, report: Reporter): Vec3[] {
  const layout = vertexLayout(schema)
  if (!layout) return []

  const { beginIndex, stride, max } = layout
  let available = Math.max(0, Math.floor((obj.fields.length - beginIndex) / stride))

  // Trailing `,,,;` padding is common in hand-edited files and must not become a vertex.
  while (available > 0) {
    const base = beginIndex + (available - 1) * stride
    const blank = obj.fields.slice(base, base + stride).every((f) => (f?.value ?? '') === '')
    if (!blank) break
    available--
  }

  if (available > max) {
    report.add(
      'error',
      'too-many-vertices',
      `${obj.className} '${obj.fields[0]?.value ?? ''}' supplies ${available} vertices but the ` +
        `class allows at most ${max}. EnergyPlus will reject this object.`,
      obj.id,
    )
    available = max
  }

  const declaredRaw = readField(obj, schema, 'Number of Vertices')
  const declared = Number(declaredRaw)
  let count = available
  if (declaredRaw !== '' && Number.isInteger(declared) && declared > 0) {
    if (declared <= available) {
      count = declared
    } else {
      report.add(
        'warning',
        'vertex-count-mismatch',
        `${obj.className} '${obj.fields[0]?.value ?? ''}' declares ${declared} vertices but supplies ` +
          `${available}. Using ${available}.`,
        obj.id,
      )
    }
  }

  const out: Vec3[] = []
  for (let v = 0; v < count; v++) {
    const base = beginIndex + v * stride
    out.push({
      x: coord(obj, base, v, 'X', report),
      y: coord(obj, base + 1, v, 'Y', report),
      z: coord(obj, base + 2, v, 'Z', report),
    })
  }
  return out
}

function coord(
  obj: IdfObject,
  fieldIdx: number,
  vertex: number,
  axis: string,
  report: Reporter,
): number {
  const raw = obj.fields[fieldIdx]?.value ?? ''
  const n = Number(raw)
  if (raw !== '' && Number.isFinite(n)) return n
  report.add(
    'error',
    'bad-coordinate',
    `${obj.className} '${obj.fields[0]?.value ?? ''}': vertex ${vertex + 1} ${axis} is ` +
      `${raw === '' ? 'blank' : `'${raw}'`} — treating it as 0.`,
    obj.id,
  )
  return 0
}

// ---------------------------------------------------------------------------
// GlobalGeometryRules / Building / Compliance:Building
// ---------------------------------------------------------------------------

const CORNERS: readonly StartingVertexPosition[] = [
  'UpperLeftCorner',
  'LowerLeftCorner',
  'LowerRightCorner',
  'UpperRightCorner',
]

/**
 * Coordinate-system parsing, bug-compatible with EnergyPlus.
 *
 * `Absolute` is an accepted synonym for `World` that the IDD's `\key` list does not mention,
 * and an unrecognised value falls back to **World**, not to the IDD default — the choice
 * EnergyPlus makes at `SurfaceGeometry.cc`'s "defaults to WorldCoordinateSystem" warning.
 */
function coordinateSystem(raw: string, fallback: CoordinateSystem): CoordinateSystem {
  const v = raw.trim().toLowerCase()
  if (v === 'world' || v === 'absolute') return 'World'
  if (v === 'relative') return 'Relative'
  return fallback
}

function readGeometryRules(doc: IdfDocument, version: string, report: Reporter): GeometryRules {
  const ids = doc.byClass.get('globalgeometryrules') ?? []
  const rules: GeometryRules = {
    startingVertexPosition: 'UpperLeftCorner',
    vertexEntryDirection: 'Counterclockwise',
    coordinateSystem: 'World',
    daylightingReferencePointCoordinateSystem: 'Relative',
    rectangularSurfaceCoordinateSystem: 'Relative',
  }

  if (ids.length === 0) {
    report.add(
      'error',
      'missing-global-geometry-rules',
      'No GlobalGeometryRules object. EnergyPlus treats this as a severe error and will not run ' +
        'the file; vertices are shown as World coordinates.',
    )
    return rules
  }
  if (ids.length > 1) {
    report.add(
      'error',
      'duplicate-global-geometry-rules',
      `${ids.length} GlobalGeometryRules objects; EnergyPlus allows one. Using the first.`,
      ids[0]!,
    )
  }

  const obj = doc.objects.get(ids[0]!)
  const schema = getSchema('globalgeometryrules', version)
  if (!obj || !schema) return rules
  rules.id = obj.id

  const cornerRaw = readField(obj, schema, 'Starting Vertex Position')
  const corner = CORNERS.find((c) => c.toLowerCase() === cornerRaw.trim().toLowerCase())
  if (corner) {
    rules.startingVertexPosition = corner
  } else {
    report.add(
      'error',
      'invalid-starting-vertex',
      `GlobalGeometryRules: Starting Vertex Position '${cornerRaw}' is not one of ` +
        `${CORNERS.join(', ')}. Using UpperLeftCorner.`,
      obj.id,
    )
  }

  const dirRaw = readField(obj, schema, 'Vertex Entry Direction').trim().toLowerCase()
  let direction: VertexEntryDirection | undefined
  if (dirRaw === 'counterclockwise' || dirRaw === 'ccw') direction = 'Counterclockwise'
  else if (dirRaw === 'clockwise' || dirRaw === 'cw') direction = 'Clockwise'
  if (direction) {
    rules.vertexEntryDirection = direction
  } else {
    report.add(
      'error',
      'invalid-vertex-entry-direction',
      `GlobalGeometryRules: Vertex Entry Direction '${dirRaw}' is not Counterclockwise or ` +
        'Clockwise. Using Counterclockwise.',
      obj.id,
    )
  }

  const coordRaw = readField(obj, schema, 'Coordinate System')
  rules.coordinateSystem = coordinateSystem(coordRaw, 'World')
  if (coordRaw.trim() === '') {
    report.add(
      'warning',
      'blank-coordinate-system',
      'GlobalGeometryRules: Coordinate System is blank. EnergyPlus falls back to World.',
      obj.id,
    )
  }

  rules.daylightingReferencePointCoordinateSystem = coordinateSystem(
    readFieldOrDefault(obj, schema, 'Daylighting Reference Point Coordinate System'),
    'Relative',
  )
  rules.rectangularSurfaceCoordinateSystem = coordinateSystem(
    readFieldOrDefault(obj, schema, 'Rectangular Surface Coordinate System'),
    'Relative',
  )
  return rules
}

function readSiteRules(doc: IdfDocument, version: string, report: Reporter): SiteRules {
  const site: SiteRules = { northAxis: 0, appendixGRotation: 0 }

  const buildingId = (doc.byClass.get('building') ?? [])[0]
  const building = buildingId ? doc.objects.get(buildingId) : undefined
  const buildingSchema = getSchema('building', version)
  if (building && buildingSchema) {
    site.buildingId = building.id
    site.northAxis = num(building, buildingSchema, 'North Axis', 0, report)
  }

  const complianceId = (doc.byClass.get('compliance:building') ?? [])[0]
  const compliance = complianceId ? doc.objects.get(complianceId) : undefined
  const complianceSchema = getSchema('compliance:building', version)
  if (compliance && complianceSchema) {
    site.complianceId = compliance.id
    site.appendixGRotation = num(
      compliance,
      complianceSchema,
      'Building Rotation for Appendix G',
      0,
      report,
    )
  }
  return site
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

function readBaseSurface(obj: IdfObject, schema: ClassSchema, report: Reporter): BuildingSurface {
  return {
    kind: 'base',
    id: obj.id,
    name: obj.fields[0]?.value ?? '',
    className: obj.className,
    classKey: obj.classKey,
    surfaceType:
      IMPLIED_SURFACE_TYPE[obj.classKey] ?? readField(obj, schema, 'Surface Type'),
    constructionName: readField(obj, schema, 'Construction Name'),
    zoneName: readField(obj, schema, 'Zone Name'),
    spaceName: readField(obj, schema, 'Space Name'),
    outsideBoundaryCondition: readField(obj, schema, 'Outside Boundary Condition'),
    outsideBoundaryConditionObject: readField(obj, schema, 'Outside Boundary Condition Object'),
    sunExposure: readFieldOrDefault(obj, schema, 'Sun Exposure'),
    windExposure: readFieldOrDefault(obj, schema, 'Wind Exposure'),
    declaredVertexCount: readField(obj, schema, 'Number of Vertices'),
    vertices: readVertices(obj, schema, report),
    subSurfaces: [],
    attachedShading: [],
  }
}

function readSubSurface(obj: IdfObject, schema: ClassSchema, report: Reporter): SubSurface {
  return {
    kind: 'sub',
    id: obj.id,
    name: obj.fields[0]?.value ?? '',
    className: obj.className,
    classKey: obj.classKey,
    surfaceType: readField(obj, schema, 'Surface Type'),
    constructionName: readField(obj, schema, 'Construction Name'),
    baseSurfaceName: readField(obj, schema, 'Building Surface Name'),
    outsideBoundaryConditionObject: readField(obj, schema, 'Outside Boundary Condition Object'),
    frameAndDividerName: readField(obj, schema, 'Frame and Divider Name'),
    multiplier: num(obj, schema, 'Multiplier', 1, report),
    declaredVertexCount: readField(obj, schema, 'Number of Vertices'),
    vertices: readVertices(obj, schema, report),
    attachedShading: [],
  }
}

function readShadingSurface(
  obj: IdfObject,
  schema: ClassSchema,
  report: Reporter,
): ShadingSurface {
  return {
    kind: 'shading',
    id: obj.id,
    name: obj.fields[0]?.value ?? '',
    className: obj.className,
    classKey: obj.classKey,
    shadingKind: SHADING_KIND[obj.classKey] ?? 'site',
    baseSurfaceName: readField(obj, schema, 'Base Surface Name'),
    transmittanceScheduleName: readField(obj, schema, 'Transmittance Schedule Name'),
    declaredVertexCount: readField(obj, schema, 'Number of Vertices'),
    vertices: readVertices(obj, schema, report),
  }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build the typed model. Never throws: anything unreadable becomes a diagnostic, because a
 * file we cannot fully understand must still round-trip and still show whatever geometry it
 * does contain.
 */
export function buildModel(doc: IdfDocument): Model {
  const report = new Reporter()
  const versionResolution = resolveIddVersion(doc.version)
  const version = versionResolution.version

  if (doc.version === undefined) {
    report.add(
      'warning',
      'no-version',
      `File declares no Version object; reading field layouts as EnergyPlus ${version}.`,
    )
  } else if (!versionResolution.exact) {
    report.add(
      'info',
      'version-not-covered',
      `File declares version ${doc.version}; the IDD table covers up to ${version}. ` +
        'Reading field layouts as the closest covered release.',
    )
  }

  const names = buildNameIndex(doc, version)
  for (const dup of names.duplicates) {
    report.add(
      'error',
      'duplicate-name',
      `${dup.ids.length} objects of class ${dup.classKey} are named '${dup.name}'. ` +
        'EnergyPlus requires names to be unique within a class; references resolve to the first.',
      dup.ids[1],
    )
  }

  const rules = readGeometryRules(doc, version, report)
  const site = readSiteRules(doc, version, report)

  // --- zones and spaces ---------------------------------------------------
  const zones = new Map<string, Zone>()
  const zoneSchema = getSchema('zone', version)
  if (zoneSchema) {
    for (const id of doc.byClass.get('zone') ?? []) {
      const obj = doc.objects.get(id)
      if (!obj) continue
      const zone: Zone = {
        id,
        name: obj.fields[0]?.value ?? '',
        directionOfRelativeNorth: num(obj, zoneSchema, 'Direction of Relative North', 0, report),
        origin: {
          x: num(obj, zoneSchema, 'X Origin', 0, report),
          y: num(obj, zoneSchema, 'Y Origin', 0, report),
          z: num(obj, zoneSchema, 'Z Origin', 0, report),
        },
        multiplier: num(obj, zoneSchema, 'Multiplier', 1, report),
        type: readFieldOrDefault(obj, zoneSchema, 'Type'),
      }
      const ceilingHeight = optionalNum(obj, zoneSchema, 'Ceiling Height')
      if (ceilingHeight !== undefined) zone.ceilingHeight = ceilingHeight
      const volume = optionalNum(obj, zoneSchema, 'Volume')
      if (volume !== undefined) zone.volume = volume
      const floorArea = optionalNum(obj, zoneSchema, 'Floor Area')
      if (floorArea !== undefined) zone.floorArea = floorArea
      zones.set(id, zone)
    }
  }

  const spaces = new Map<string, Space>()
  const spaceSchema = getSchema('space', version)
  if (spaceSchema) {
    for (const id of doc.byClass.get('space') ?? []) {
      const obj = doc.objects.get(id)
      if (!obj) continue
      spaces.set(id, {
        id,
        name: obj.fields[0]?.value ?? '',
        zoneName: readField(obj, spaceSchema, 'Zone Name'),
      })
    }
  }

  // --- surfaces, in document order ----------------------------------------
  const surfaces = new Map<string, Surface>()
  const surfaceOrder: string[] = []

  for (const id of doc.order) {
    const obj = doc.objects.get(id)
    if (!obj) continue
    const schema = getSchema(obj.classKey, version)
    if (!schema) continue

    let surface: Surface | undefined
    if (BASE_SURFACE_CLASSES.includes(obj.classKey)) surface = readBaseSurface(obj, schema, report)
    else if (SUB_SURFACE_CLASSES.includes(obj.classKey)) surface = readSubSurface(obj, schema, report)
    else if (SHADING_CLASSES.includes(obj.classKey)) surface = readShadingSurface(obj, schema, report)
    if (!surface) continue

    surfaces.set(id, surface)
    surfaceOrder.push(id)
  }

  // --- parent/child links and zone inheritance ----------------------------
  const zoneOf = new Map<string, string>()

  for (const id of surfaceOrder) {
    const surface = surfaces.get(id)!
    if (surface.kind !== 'base') continue

    let zoneId = lookupInClass(names, 'zone', surface.zoneName)
    if (zoneId === undefined && surface.spaceName !== '') {
      // 9.6+ lets a surface name a Space instead of a Zone; the zone is then the space's.
      const spaceId = lookupInClass(names, 'space', surface.spaceName)
      const space = spaceId ? spaces.get(spaceId) : undefined
      if (space) zoneId = lookupInClass(names, 'zone', space.zoneName)
    }

    if (zoneId === undefined) {
      report.add(
        'error',
        'unresolved-zone',
        `${surface.className} '${surface.name}' references ` +
          `${surface.zoneName !== '' ? `Zone '${surface.zoneName}'` : `Space '${surface.spaceName}'`}, ` +
          'which does not exist. Its vertices cannot be resolved to world coordinates.',
        id,
      )
      continue
    }
    zoneOf.set(id, zoneId)
  }

  for (const id of surfaceOrder) {
    const surface = surfaces.get(id)!
    if (surface.kind !== 'sub') continue
    const baseId = lookupIn(names, BASE_SURFACE_CLASSES, surface.baseSurfaceName)
    const base = baseId ? surfaces.get(baseId) : undefined
    if (!base || base.kind !== 'base') {
      report.add(
        'error',
        'unresolved-base-surface',
        `${surface.className} '${surface.name}' references Building Surface Name ` +
          `'${surface.baseSurfaceName}', which is not a detailed base surface.`,
        id,
      )
      continue
    }
    base.subSurfaces.push(id)
    const zoneId = zoneOf.get(baseId!)
    if (zoneId !== undefined) zoneOf.set(id, zoneId)
  }

  // Attached shading inherits its zone from the base surface, which is what makes its
  // relative coordinates resolve at all (`SurfaceGeometry.cc`: "Necessary to do relative
  // coordinates in GetVertices below"). Its base may be a window as well as a wall.
  for (const id of surfaceOrder) {
    const surface = surfaces.get(id)!
    if (surface.kind !== 'shading' || surface.shadingKind !== 'zone') continue
    const hostId = lookupIn(
      names,
      [...BASE_SURFACE_CLASSES, ...SUB_SURFACE_CLASSES],
      surface.baseSurfaceName,
    )
    const host = hostId ? surfaces.get(hostId) : undefined
    if (!host || host.kind === 'shading') {
      report.add(
        'error',
        'unresolved-base-surface',
        `${surface.className} '${surface.name}' references Base Surface Name ` +
          `'${surface.baseSurfaceName}', which is not a surface.`,
        id,
      )
      continue
    }
    host.attachedShading.push(id)
    const zoneId = zoneOf.get(hostId!)
    if (zoneId !== undefined) zoneOf.set(id, zoneId)
  }

  // --- surfaces we preserve but do not draw -------------------------------
  const unrendered = new Map<string, number>()
  for (const [classKey, ids] of doc.byClass) {
    if (TIER3_CLASS_SET.has(classKey)) unrendered.set(classKey, ids.length)
  }

  return {
    doc,
    version,
    versionResolution,
    names,
    rules,
    site,
    zones,
    spaces,
    surfaces,
    surfaceOrder,
    zoneOf,
    diagnostics: report.diagnostics,
    unrendered,
  }
}
