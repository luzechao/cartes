import { describe, expect, it } from 'vitest'
import { emitIdf, parseIdf } from '../../src/parser/index.js'
import { buildModel, LATEST_IDD_VERSION, newModelSource, TEMPLATE_CONSTRUCTIONS as C } from '../../src/model/index.js'
import { extrudeZone, resolveModel } from '../../src/geometry/index.js'
import { applyStoreyDisplay, buildScene, computeStoreys, explodeGap } from '../../src/render/index.js'
import { decodeViewState, encodeViewState } from '../../src/ui/viewState.js'

/** Two storeys: two zones on the ground, one split-level 0.3 m up, and one on top. */
function building() {
  let doc = parseIdf(newModelSource(LATEST_IDD_VERSION))
  let model = buildModel(doc)
  const cons = { wall: C.exteriorWall, floor: C.groundFloor, roof: C.roof }
  const add = (name: string, x: number, z: number, h = 3): void => {
    const r = extrudeZone(doc, model, {
      zoneName: name,
      footprint: [
        { x, y: 0 },
        { x: x + 5, y: 0 },
        { x: x + 5, y: 5 },
        { x, y: 5 },
      ],
      baseZ: z,
      height: h,
      constructions: cons,
    })
    if (r.refused) throw new Error(r.refused)
    doc = parseIdf(emitIdf(doc))
    model = buildModel(doc)
  }
  add('A', 0, 0)
  add('B', 5, 0)
  add('Split', 10, 0.3, 2.7)
  add('Up', 0, 3.5)
  return { model, resolved: resolveModel(model) }
}

function zoneNamed(model: ReturnType<typeof building>['model'], name: string): string {
  for (const [id, z] of model.zones) if (z.name === name) return id
  throw new Error(name)
}

describe('computeStoreys', () => {
  it('groups zones by floor elevation, with a tolerance for split levels', () => {
    const { model, resolved } = building()
    const map = computeStoreys(model, resolved)
    expect(map.storeys.map((s) => [s.z, s.zoneIds.map((id) => model.zones.get(id)!.name).sort()])).toEqual([
      [0, ['A', 'B', 'Split']],
      [3.5, ['Up']],
    ])
    expect(explodeGap(map)).toBe(3.5)
  })
})

describe('applyStoreyDisplay', () => {
  it('lifts each storey by its index × the gap, leaves detached shading alone, and restores', () => {
    const { model, resolved } = building()
    const map = computeStoreys(model, resolved)
    const build = buildScene(model, resolved)
    const up = zoneNamed(model, 'Up')

    applyStoreyDisplay(build, map, { mode: 'exploded', gap: 4 })
    for (const e of build.registry) {
      expect(e.object.position.z, e.name).toBe(e.zoneId === up ? 4 : 0)
      expect(e.object.visible).toBe(true)
    }

    applyStoreyDisplay(build, map, { mode: 'solo', storey: 1 })
    for (const e of build.registry) {
      expect(e.object.visible, e.name).toBe(e.zoneId === up)
      expect(e.object.position.z).toBe(0)
    }

    applyStoreyDisplay(build, map, { mode: 'stacked' })
    for (const e of build.registry) {
      expect(e.object.visible).toBe(true)
      expect(e.object.position.z).toBe(0)
    }
  })
})

describe('view state', () => {
  it('round-trips everything it carries', () => {
    const state = {
      camera: { position: [12.3456, -7, 30] as [number, number, number], target: [1, 2, 3] as [number, number, number] },
      selected: 'Zn001:Wall 1 & co',
      colorBy: 'construction' as const,
      display: { mode: 'solo' as const, storey: 2 },
    }
    const decoded = decodeViewState('#' + encodeViewState(state))
    expect(decoded).toEqual({ ...state, camera: { position: [12.346, -7, 30], target: [1, 2, 3] } })
  })

  it('leaves out defaults, so an ordinary view makes a short link', () => {
    expect(encodeViewState({ colorBy: 'type', display: { mode: 'stacked' } })).toBe('v=1')
  })

  it('drops malformed fields rather than failing', () => {
    expect(decodeViewState('#v=1&cam=1,2,x,4,5,6&color=purple&display=solo:-1&sel=W')).toEqual({ selected: 'W' })
    expect(decodeViewState('#v=9&sel=W')).toEqual({})
    expect(decodeViewState('')).toEqual({})
  })
})
