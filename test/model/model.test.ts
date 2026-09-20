/**
 * Model layer — Layer 2 of docs/04-architecture.md.
 *
 * Two kinds of test here. Most are ordinary behaviour checks written against small inline
 * IDF snippets. The first group is different: those are *guards*, and they exist to fail
 * when the IDD table is regenerated against a newer EnergyPlus release that adds a class we
 * have never seen. A surface class we do not know about would otherwise be silently dropped
 * from the unrendered banner, and the file would look emptier than it is.
 */
import { describe, expect, it } from 'vitest'
import { parseIdf } from '../../src/parser/index.js'
import { GEOMETRY_CLASSES, IDD_VERSIONS } from '../../src/parser/idd-table.generated.js'
import {
  RENDERED_CLASSES,
  TIER3_SURFACE_CLASSES,
  buildModel,
  getSchema,
  LATEST_IDD_VERSION,
} from '../../src/model/index.js'

// ---------------------------------------------------------------------------
// Guards against a future IDD release
// ---------------------------------------------------------------------------

describe('surface-class coverage guards', () => {
  const KNOWN = new Set([...RENDERED_CLASSES, ...TIER3_SURFACE_CLASSES])

  /**
   * `Starting X Coordinate` is the IDD's own marker for the rectangular surface family: a
   * class that has one describes a surface by a corner plus width and height rather than by
   * vertices. Every such class must be accounted for, in one bucket or the other.
   *
   * Checked at every covered release, not just the latest, because a class can appear and
   * later be deprecated — `Wall:Underground` and friends have moved around before.
   */
  it('accounts for every geometry class with a Starting X Coordinate', () => {
    const missing = new Set<string>()
    let found = 0
    for (const version of IDD_VERSIONS) {
      for (const classKey of GEOMETRY_CLASSES) {
        const schema = getSchema(classKey, version)
        if (!schema) continue
        if (!schema.index.has('starting x coordinate')) continue
        found++
        if (!KNOWN.has(classKey)) missing.add(`${classKey} (at ${version})`)
      }
    }
    expect(found).toBeGreaterThan(100)
    expect([...missing].sort()).toEqual([])
  })

  /**
   * The other direction. `TIER3_SURFACE_CLASSES` is hand-written, so a typo in it would be a
   * class that matches nothing — the banner would undercount and no other test would notice.
   */
  it('lists only class keys the IDD actually has', () => {
    const unknown = TIER3_SURFACE_CLASSES.filter(
      (k) => !IDD_VERSIONS.some((v) => getSchema(k, v) !== undefined),
    )
    expect(unknown).toEqual([])
  })

  it('keeps the rendered and unrendered sets disjoint', () => {
    expect(TIER3_SURFACE_CLASSES.filter((k) => RENDERED_CLASSES.has(k))).toEqual([])
  })

  /**
   * The overhang and fin classes carry no `Starting X Coordinate` — they are dimensioned off
   * a host window — so the guard above cannot see them. Pinned separately, or removing one
   * from the list would go unnoticed.
   */
  it('covers the overhang and fin family, which the Starting X guard cannot see', () => {
    for (const k of [
      'shading:overhang',
      'shading:overhang:projection',
      'shading:fin',
      'shading:fin:projection',
    ]) {
      expect(getSchema(k, LATEST_IDD_VERSION)?.index.has('starting x coordinate'), k).toBe(false)
      expect(TIER3_SURFACE_CLASSES, k).toContain(k)
    }
  })
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VERSION = 'Version, 24.1;\n'

/** A minimal one-zone file. `extra` is appended verbatim. */
function idf(extra: string, rules = 'UpperLeftCorner, Counterclockwise, Relative'): string {
  return `${VERSION}
GlobalGeometryRules, ${rules};
Zone, Zone One, 30, 1, 2, 3;
${extra}
`
}

function surfaceNamed(model: ReturnType<typeof buildModel>, name: string) {
  for (const s of model.surfaces.values()) if (s.name === name) return s
  return undefined
}

const FLOOR = `
BuildingSurface:Detailed,
  Floor, Floor, Slab, Zone One, , Ground, , NoSun, NoWind, , 4,
  0,0,0,  0,4,0,  6,4,0,  6,0,0;
`

// ---------------------------------------------------------------------------
// Name index
// ---------------------------------------------------------------------------

describe('name index', () => {
  it('looks up case-insensitively but preserves the casing as written', () => {
    const model = buildModel(parseIdf(idf(FLOOR)))
    const id = model.names.byClass.get('zone')?.get('zone one')
    expect(id).toBeDefined()
    expect(model.zones.get(id!)?.name).toBe('Zone One')
    expect(model.names.byClass.get('zone')?.get('ZONE ONE')).toBeUndefined()
  })

  it('reports a same-class duplicate and keeps the first', () => {
    const model = buildModel(parseIdf(idf(`Zone, ZONE ONE, 90, 9, 9, 9;`)))
    expect(model.names.duplicates.map((d) => d.classKey)).toContain('zone')
    const id = model.names.byClass.get('zone')!.get('zone one')!
    // First declaration wins, so the origin is the original (1, 2, 3).
    expect(model.zones.get(id)!.origin).toEqual({ x: 1, y: 2, z: 3 })
    expect(model.diagnostics.some((d) => d.code === 'duplicate-name')).toBe(true)
  })

  it('allows the same name in two different classes', () => {
    const model = buildModel(parseIdf(idf(FLOOR)))
    // `Floor` is both the surface name and its surface type; the index is per class.
    expect(model.names.byClass.get('buildingsurface:detailed')?.get('floor')).toBeDefined()
    expect(model.names.byClass.get('zone')?.get('floor')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// GlobalGeometryRules
// ---------------------------------------------------------------------------

describe('GlobalGeometryRules', () => {
  it('reads the three fields', () => {
    const model = buildModel(parseIdf(idf(FLOOR, 'LowerLeftCorner, Clockwise, World')))
    expect(model.rules.startingVertexPosition).toBe('LowerLeftCorner')
    expect(model.rules.vertexEntryDirection).toBe('Clockwise')
    expect(model.rules.coordinateSystem).toBe('World')
  })

  it('accepts the CCW and CW abbreviations', () => {
    const model = buildModel(parseIdf(idf(FLOOR, 'UpperLeftCorner, CW, Relative')))
    expect(model.rules.vertexEntryDirection).toBe('Clockwise')
  })

  /**
   * `Absolute` is not in the IDD's `\key` list for this field, but EnergyPlus accepts it as
   * a synonym for `World` and real files use it. Being stricter than the simulator would
   * mean showing a different building than the one that will be simulated.
   */
  it('accepts Absolute as a synonym for World', () => {
    const model = buildModel(parseIdf(idf(FLOOR, 'UpperLeftCorner, Counterclockwise, Absolute')))
    expect(model.rules.coordinateSystem).toBe('World')
  })

  it('falls back to World on an unrecognised coordinate system, as EnergyPlus does', () => {
    const model = buildModel(parseIdf(idf(FLOOR, 'UpperLeftCorner, Counterclockwise, Sideways')))
    expect(model.rules.coordinateSystem).toBe('World')
  })

  it('reports a file with no GlobalGeometryRules at all', () => {
    const model = buildModel(parseIdf(`${VERSION}Zone, Zone One, 0, 0, 0, 0;\n`))
    expect(model.diagnostics.some((d) => d.code === 'missing-global-geometry-rules')).toBe(true)
  })

  it('reports a second GlobalGeometryRules rather than silently taking one', () => {
    const model = buildModel(
      parseIdf(idf(`GlobalGeometryRules, LowerLeftCorner, Clockwise, World;`)),
    )
    expect(model.diagnostics.some((d) => d.code === 'duplicate-global-geometry-rules')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Zone resolution
// ---------------------------------------------------------------------------

describe('zone resolution', () => {
  it('links a base surface to its zone', () => {
    const model = buildModel(parseIdf(idf(FLOOR)))
    const floor = surfaceNamed(model, 'Floor')!
    const zoneId = model.zoneOf.get(floor.id)!
    expect(model.zones.get(zoneId)!.name).toBe('Zone One')
  })

  it('inherits the zone onto a sub-surface through its base surface', () => {
    const model = buildModel(
      parseIdf(
        idf(`${FLOOR}
FenestrationSurface:Detailed,
  Hatch, Window, Glazing, Floor, , , , , 4,
  1,1,0,  1,3,0,  5,3,0,  5,1,0;
`),
      ),
    )
    const hatch = surfaceNamed(model, 'Hatch')!
    expect(hatch.kind).toBe('sub')
    expect(model.zones.get(model.zoneOf.get(hatch.id)!)!.name).toBe('Zone One')
  })

  /**
   * Attached shading gets its zone from the surface it names — which is how relative
   * coordinates work for it at all. EnergyPlus copies the zone onto it for the same reason.
   */
  it('inherits the zone onto attached shading through its base surface', () => {
    const model = buildModel(
      parseIdf(
        idf(`${FLOOR}
Shading:Zone:Detailed,
  Awning, Floor, , 3,
  0,0,1,  1,0,1,  1,1,1;
`),
      ),
    )
    const awning = surfaceNamed(model, 'Awning')!
    expect(awning.kind).toBe('shading')
    expect(model.zones.get(model.zoneOf.get(awning.id)!)!.name).toBe('Zone One')
  })

  it('gives detached shading no zone at all', () => {
    const model = buildModel(
      parseIdf(
        idf(`
Shading:Site:Detailed, Hill, , 3, 0,0,0, 1,0,0, 1,1,0;
Shading:Building:Detailed, Shed, , 3, 0,0,2, 1,0,2, 1,1,2;
`),
      ),
    )
    for (const name of ['Hill', 'Shed']) {
      expect(model.zoneOf.get(surfaceNamed(model, name)!.id), name).toBeUndefined()
    }
  })

  it('reports a surface naming a zone that does not exist', () => {
    const model = buildModel(
      parseIdf(
        idf(`
BuildingSurface:Detailed, Orphan, Floor, Slab, Nowhere, , Ground, , NoSun, NoWind, , 3,
  0,0,0, 1,0,0, 1,1,0;
`),
      ),
    )
    expect(model.diagnostics.some((d) => d.code === 'unresolved-zone')).toBe(true)
  })

  it('reports a sub-surface naming a base surface that does not exist', () => {
    const model = buildModel(
      parseIdf(
        idf(`
FenestrationSurface:Detailed, Ghost, Window, Glazing, Nowhere, , , , , 3,
  0,0,0, 1,0,0, 1,1,0;
`),
      ),
    )
    expect(model.diagnostics.some((d) => d.code === 'unresolved-base-surface')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Space, added in 9.6
// ---------------------------------------------------------------------------

describe('Space', () => {
  /**
   * 9.6 inserted `Space Name` at index 4 of `BuildingSurface:Detailed`, shifting every later
   * field. Reading by name rather than by position is what makes this work; the test is here
   * because reading by position would still *look* right on a 24.1 file.
   */
  it('resolves a surface that names a space instead of a zone', () => {
    const model = buildModel(
      parseIdf(`${VERSION}
GlobalGeometryRules, UpperLeftCorner, Counterclockwise, Relative;
Zone, Zone One, 0, 1, 2, 3;
Space, Office, Zone One;
BuildingSurface:Detailed,
  Floor, Floor, Slab, , Office, Ground, , NoSun, NoWind, , 4,
  0,0,0,  0,4,0,  6,4,0,  6,0,0;
`),
    )
    const floor = surfaceNamed(model, 'Floor')!
    expect(model.spaces.size).toBe(1)
    expect(model.zones.get(model.zoneOf.get(floor.id)!)!.name).toBe('Zone One')
    // And the field shift really was honoured: this is field 6, not field 5.
    expect(floor.kind === 'base' && floor.outsideBoundaryCondition).toBe('Ground')
  })
})

// ---------------------------------------------------------------------------
// Vertices
// ---------------------------------------------------------------------------

describe('vertex reading', () => {
  it('reads vertices as written, without resolving coordinates', () => {
    const model = buildModel(parseIdf(idf(FLOOR)))
    // Zone origin is (1, 2, 3) and the file is Relative, but Layer 2 must not apply it.
    expect(surfaceNamed(model, 'Floor')!.vertices[0]).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('drops the trailing blank triples a `,,,;` tail leaves behind', () => {
    const model = buildModel(
      parseIdf(
        idf(`
BuildingSurface:Detailed, Wall, Wall, Brick, Zone One, , Outdoors, , SunExposed, WindExposed, , 3,
  0,0,0, 1,0,0, 1,0,1, , , , , , ;
`),
      ),
    )
    expect(surfaceNamed(model, 'Wall')!.vertices).toHaveLength(3)
  })

  /**
   * `Number of Vertices` is advisory: files routinely say `autocalculate`, and files that
   * name a count larger than the coordinates they supply are common enough that EnergyPlus
   * tolerates them. Trusting the count over the data would invent vertices at the origin.
   */
  it('ignores a Number of Vertices larger than the coordinates supplied', () => {
    const model = buildModel(
      parseIdf(
        idf(`
BuildingSurface:Detailed, Wall, Wall, Brick, Zone One, , Outdoors, , SunExposed, WindExposed, , 8,
  0,0,0, 1,0,0, 1,0,1;
`),
      ),
    )
    expect(surfaceNamed(model, 'Wall')!.vertices).toHaveLength(3)
    expect(model.diagnostics.some((d) => d.code === 'vertex-count-mismatch')).toBe(true)
  })

  it('honours autocalculate', () => {
    const model = buildModel(
      parseIdf(
        idf(`
BuildingSurface:Detailed, Wall, Wall, Brick, Zone One, , Outdoors, , SunExposed, WindExposed, , autocalculate,
  0,0,0, 1,0,0, 1,0,1;
`),
      ),
    )
    expect(surfaceNamed(model, 'Wall')!.vertices).toHaveLength(3)
  })

  it('reports a non-numeric coordinate instead of producing NaN', () => {
    const model = buildModel(
      parseIdf(
        idf(`
BuildingSurface:Detailed, Wall, Wall, Brick, Zone One, , Outdoors, , SunExposed, WindExposed, , 3,
  0,0,0, one,0,0, 1,0,1;
`),
      ),
    )
    const wall = surfaceNamed(model, 'Wall')!
    for (const v of wall.vertices) {
      expect(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)).toBe(true)
    }
    expect(model.diagnostics.some((d) => d.code === 'bad-coordinate')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The unrendered banner
// ---------------------------------------------------------------------------

describe('unrendered surfaces', () => {
  it('counts Tier 3 surfaces by class', () => {
    const model = buildModel(
      parseIdf(
        idf(`
Wall:Exterior, W1, Brick, Zone One, , 90, 90, 0, 0, 0, 3, 4;
Wall:Exterior, W2, Brick, Zone One, , 90, 90, 3, 0, 0, 3, 4;
Roof, R1, Deck, Zone One, , 0, 0, 0, 0, 3, 6, 4;
`),
      ),
    )
    expect(model.unrendered.get('wall:exterior')).toBe(2)
    expect(model.unrendered.get('roof')).toBe(1)
  })

  it('does not count the classes it renders, nor non-surfaces', () => {
    const model = buildModel(parseIdf(idf(FLOOR)))
    expect(model.unrendered.get('buildingsurface:detailed')).toBeUndefined()
    expect(model.unrendered.get('zone')).toBeUndefined()
    expect(model.unrendered.get('globalgeometryrules')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Version handling and robustness
// ---------------------------------------------------------------------------

describe('version resolution', () => {
  it('reports a file with no Version object', () => {
    const model = buildModel(parseIdf('GlobalGeometryRules, UpperLeftCorner, Counterclockwise, World;\n'))
    expect(model.diagnostics.some((d) => d.code === 'no-version')).toBe(true)
  })

  it('falls back to the nearest covered release and says so', () => {
    const model = buildModel(parseIdf('Version, 8.0.1;\nZone, Z, 0, 0, 0, 0;\n'))
    expect(model.version).toBe('8.0')
    expect(model.versionResolution.exact).toBe(true)
  })

  it('reports a version past the end of the table', () => {
    const model = buildModel(parseIdf('Version, 99.9;\nZone, Z, 0, 0, 0, 0;\n'))
    expect(model.versionResolution.exact).toBe(false)
    expect(model.diagnostics.some((d) => d.code === 'version-not-covered')).toBe(true)
  })
})

describe('robustness', () => {
  /**
   * `buildModel` is a projection, not a validator: anything it cannot read becomes a
   * diagnostic. A file that throws here is a file the editor cannot open at all, which is a
   * worse outcome than a file that opens with a warning.
   */
  it('never throws, however truncated the input', () => {
    const cases = [
      '',
      'Version',
      'Version;',
      'GlobalGeometryRules;',
      'Zone;',
      `${VERSION}BuildingSurface:Detailed;`,
      `${VERSION}BuildingSurface:Detailed, , , , , , , , , , 0,0;`,
      `${VERSION}FenestrationSurface:Detailed, W, , , , , , , , 4, 0,0,0;`,
      `${VERSION}Shading:Zone:Detailed, S;`,
    ]
    for (const source of cases) {
      expect(() => buildModel(parseIdf(source)), JSON.stringify(source)).not.toThrow()
    }
  })

  it('leaves the document clean, so the Phase 1 round-trip survives', () => {
    const source = idf(FLOOR)
    const doc = parseIdf(source)
    buildModel(doc)
    expect([...doc.objects.values()].some((o) => o.dirty)).toBe(false)
  })
})
