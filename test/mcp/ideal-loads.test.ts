import { beforeEach, describe, expect, it } from 'vitest'
import { localBundle } from '@idfkit/schemas/node'
import { ModelSession } from '../../src/mcp/session.js'
import { setSchemaBundle } from '../../src/schema/index.js'
import { canRun, exe } from '../harness/gate-fixtures.js'
import { runEnergyPlus } from '../harness/energyplus.js'

setSchemaBundle(localBundle())

describe('ideal loads authoring', () => {
  let session: ModelSession

  beforeEach(async () => {
    session = new ModelSession()
    session.newModel()
    await session.prepare()
    session.extrudeZone({ name: 'Office', footprint: [[0, 0], [6, 0], [6, 4], [0, 4]], height: 3 })
  })

  const count = (className: string): number => {
    const listed = session.listObjects()
    return 'classes' in listed ? (listed.classes.find((entry) => entry.class.toLowerCase() === className.toLowerCase())?.count ?? 0) : 0
  }

  it('creates a complete constant-setpoint system in one undo step', () => {
    const result = session.addIdealLoads({ zone: 'office' })
    expect(result.zone).toBe('Office')
    expect(result.created).toHaveLength(9)
    expect(result.created).toContain("ZoneHVAC:IdealLoadsAirSystem 'Cartes Office Ideal Loads'")
    expect(count('ZoneHVAC:EquipmentConnections')).toBe(1)
    expect(count('ZoneControl:Thermostat')).toBe(1)
    expect(session.inspect('Cartes Office Heating Setpoint').fields.at(-1)?.value).toBe('20')
    expect(session.inspect('Cartes Office Cooling Setpoint').fields.at(-1)?.value).toBe('24')
    expect(session.validate().filter((issue) => issue.severity === 'error')).toEqual([])

    expect(session.undo()).toEqual({ undid: 'Add ideal loads' })
    for (const className of [
      'ZoneHVAC:EquipmentConnections',
      'ZoneHVAC:EquipmentList',
      'ZoneHVAC:IdealLoadsAirSystem',
      'ZoneControl:Thermostat',
      'ThermostatSetpoint:DualSetpoint',
    ]) {
      expect(count(className)).toBe(0)
    }
    expect(session.redo()).toEqual({ redid: 'Add ideal loads' })
    expect(session.validate().filter((issue) => issue.severity === 'error')).toEqual([])
  })

  it('refuses unknown zones, invalid setpoint order, or zones already equipped without partial edits', () => {
    expect(() => session.addIdealLoads({ zone: 'Nowhere' })).toThrow(/No zone named/)
    expect(() => session.addIdealLoads({ zone: 'Office', heatingSetpoint: 24, coolingSetpoint: 20 })).toThrow(/must be a finite temperature below/)
    expect(count('ZoneHVAC:IdealLoadsAirSystem')).toBe(0)

    session.addIdealLoads({ zone: 'Office' })
    expect(() => session.addIdealLoads({ zone: 'Office' })).toThrow(/already has HVAC equipment connections/)
    expect(count('ZoneHVAC:IdealLoadsAirSystem')).toBe(1)
  })

  it.skipIf(!canRun)('runs in EnergyPlus without severe or fatal errors', () => {
    session.addIdealLoads({ zone: 'Office' })
    const run = runEnergyPlus(exe!, session.text(), { workdir: 'hvac/ideal-loads' })
    expect(run.completed, run.err).toBe(true)
    expect(run.severes, run.err).toEqual([])
    expect(run.fatals, run.err).toEqual([])
  }, 180_000)
})
