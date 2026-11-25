import { expect, it } from 'vitest'
import { localBundle } from '@idfkit/schemas/node'
import { setSchemaBundle } from '../../src/schema/index.js'
import { ModelSession } from '../../src/mcp/session.js'

setSchemaBundle(localBundle())

async function open() {
  const s = new ModelSession()
  s.openText(`
Version, 26.1;
ScheduleTypeLimits, Fraction, 0, 1, Continuous;
Schedule:Constant, Shared, Fraction, 0.5;
Schedule:Compact, Daily, Fraction, Through: 12/31, For: AllDays, Until: 08:00, 0.4, Until: 24:00, 0.8;
Lights, Lights A, Zone A, Shared, LightingLevel, 100;
Lights, Lights B, Zone B, Shared, LightingLevel, 100;
ElectricEquipment, Equip, Zone A, Daily, EquipmentLevel, 100;
WindowMaterial:SimpleGlazingSystem, Glazing, 2.5, 0.4;
Construction, Window Construction, Glazing;
`)
  await s.prepare()
  return s
}

it('refuses unsafe constant-schedule changes and supports an undoable acknowledged edit', async () => {
  const s = await open()
  expect(s.inspectSchedule('Shared').referencedBy).toHaveLength(2)
  expect(() => s.setConstantSchedule('Shared', 0.8)).toThrow(/acknowledge/)
  expect(() => s.setConstantSchedule('Shared', 1.1, true)).toThrow(/at most 1/)
  s.transact('Set schedule', () => s.setConstantSchedule('Shared', 0.8, true))
  expect(s.inspect('Shared', 'Schedule:Constant').fields[2]!.value).toBe('0.8')
  s.undo()
  expect(s.inspect('Shared', 'Schedule:Constant').fields[2]!.value).toBe('0.5')
})

it('scales compact schedules atomically and refuses bounds violations or unacknowledged references', async () => {
  const s = await open()
  expect(s.inspectSchedule('Daily').referencedBy).toHaveLength(1)
  expect(() => s.scaleCompactSchedule('Daily', 0.5)).toThrow(/acknowledge/)
  const before = s.text()
  expect(() => s.scaleCompactSchedule('Daily', 2, true)).toThrow(/at most 1/)
  expect(s.text()).toBe(before)
  expect(s.scaleCompactSchedule('Daily', 0.5, true).changed).toBe(2)
  const fields = s.inspect('Daily', 'Schedule:Compact').fields.map((f) => f.value)
  expect(fields).toEqual(expect.arrayContaining(['0.2', '0.4']))
  s.undo()
  expect(s.text()).toBe(before)
})

it('validates semantic parameters, reports uses, and undoes changes', async () => {
  const s = await open()
  expect(s.inspectParameter('window_u_factor', 'Glazing')).toMatchObject({
    value: '2.5', units: 'W/m2-K', referencedBy: expect.arrayContaining([expect.stringContaining('Window Construction')]),
  })
  expect(() => s.setParameter('window_shgc', 'Glazing', 1)).toThrow()
  expect(() => s.setParameter('cooling_cop', 'Glazing', 3)).toThrow(/supports Coil/)
  s.transact('Set parameter', () => s.setParameter('window_u_factor', 'Glazing', 1.5))
  expect(s.inspectParameter('window_u_factor', 'Glazing').value).toBe('1.5')
  s.undo()
  expect(s.inspectParameter('window_u_factor', 'Glazing').value).toBe('2.5')
})

it('edits hourly day schedules atomically and respects shared references and limits', async () => {
  const s = await open()
  s.openText(`Version,26.1;
ScheduleTypeLimits,Fraction,0,1,Continuous;
Schedule:Day:Hourly,Day,Fraction,${Array(24).fill('0.5').join(',')};
Schedule:Week:Daily,Week,Day;`)
  await s.prepare()
  const before = s.text()
  expect(s.inspectSchedule('Day').referencedBy).toHaveLength(1)
  expect(() => s.setHourlySchedule('Day', Array(24).fill(0.7))).toThrow(/acknowledge/)
  expect(() => s.setHourlySchedule('Day', [...Array(23).fill(0.7), 2], true)).toThrow(/at most/)
  expect(() => s.setHourlySchedule('Day', [0.5], true)).toThrow(/24/)
  expect(s.text()).toBe(before)
  expect(s.setHourlySchedule('Day', Array(24).fill(0.7), true).changed).toBe(24)
  s.undo()
  expect(s.text()).toBe(before)
})

it('changes dual constant setpoints together only after validating both schedules', async () => {
  const s = await open()
  s.openText(`Version,26.1;
ScheduleTypeLimits,Temperature,0,40,Continuous,Temperature;
Schedule:Constant,Heat,Temperature,20;
Schedule:Constant,Cool,Temperature,24;
ThermostatSetpoint:DualSetpoint,Thermostat,Heat,Cool;`)
  await s.prepare()
  const before = s.text()
  expect(() => s.setDualSetpoints('Thermostat', 21, 25)).toThrow(/acknowledge/)
  expect(() => s.setDualSetpoints('Thermostat', 25, 21, true)).toThrow(/lower than/)
  expect(() => s.setDualSetpoints('Thermostat', 21, 41, true)).toThrow(/at most/)
  expect(s.text()).toBe(before)
  expect(s.setDualSetpoints('Thermostat', 21, 25, true).changed).toBe(2)
  expect(s.inspectSchedule('Heat').fields[2]!.value).toBe('21')
  expect(s.inspectSchedule('Cool').fields[2]!.value).toBe('25')
  s.undo()
  expect(s.text()).toBe(before)
})

it('refuses shared setpoint schedules and non-temperature limits', async () => {
  const s = await open()
  s.openText(`Version,26.1;
ScheduleTypeLimits,Fraction,0,1,Continuous,Dimensionless;
Schedule:Constant,Same,Fraction,0.5;
ThermostatSetpoint:DualSetpoint,Thermostat,Same,Same;`)
  await s.prepare()
  expect(() => s.setDualSetpoints('Thermostat', 0.2, 0.8, true)).toThrow(/non-temperature/)
  s.openText(`Version,26.1; Schedule:Constant,Same,,20;
ThermostatSetpoint:DualSetpoint,Thermostat,Same,Same;`)
  expect(() => s.setDualSetpoints('Thermostat', 20, 24, true)).toThrow(/same constant schedule/)
  s.openText(`Version,26.1; Schedule:Constant,Heat,,20; Schedule:Compact,Heat,,Through: 12/31,For: AllDays,Until: 24:00,20;
Schedule:Constant,Cool,,24; ThermostatSetpoint:DualSetpoint,Thermostat,Heat,Cool;`)
  expect(() => s.setDualSetpoints('Thermostat', 20, 24, true)).toThrow(/ambiguous name/)
})

it('supports water heater and outdoor-air parameters with nonnegative bounds', async () => {
  const s = await open()
  s.openText(`Version,26.1;
WaterHeater:Mixed,Heater;
DesignSpecification:OutdoorAir,Outside,Flow/Person,0.01;`)
  await s.prepare()
  expect(s.inspectParameter('outdoor_air_per_person', 'Outside').value).toBe('0.01')
  expect(() => s.setParameter('water_heater_efficiency', 'Heater', 0)).toThrow(/greater than/)
  expect(() => s.setParameter('water_heater_on_parasitic', 'Heater', -1)).toThrow(/at least/)
  s.transact('Set water heater', () => s.setParameter('water_heater_on_parasitic', 'Heater', 0))
  expect(s.inspectParameter('water_heater_on_parasitic', 'Heater').value).toBe('0')
  s.undo()
  expect(s.inspectParameter('water_heater_on_parasitic', 'Heater').source).toBe('schema default')
  s.transact('Set outdoor air', () => s.setParameter('outdoor_air_per_person', 'Outside', 0))
  expect(s.inspectParameter('outdoor_air_per_person', 'Outside').value).toBe('0')
  s.undo()
  expect(s.inspectParameter('outdoor_air_per_person', 'Outside').value).toBe('0.01')
})

it('sets effective glazing optics atomically only on acknowledged spectral-average materials', async () => {
  const s = await open()
  s.openText(`Version,26.1;
WindowMaterial:Glazing,Pane,SpectralAverage,,0.006,0.7,0.1,0.1,0.8,0.1,0.1;
WindowMaterial:Glazing,Other,Spectral,,0.006;
Construction,Window,Pane;`)
  await s.prepare()
  const optics = { solarTransmittance: 0.5, solarFrontReflectance: 0.2, solarBackReflectance: 0.3,
    visibleTransmittance: 0.6, visibleFrontReflectance: 0.2, visibleBackReflectance: 0.2 }
  const before = s.text()
  expect(() => s.setGlazingOptics('Pane', optics)).toThrow(/acknowledge/)
  expect(() => s.setGlazingOptics('Other', optics, true)).toThrow(/SpectralAverage/)
  expect(() => s.setGlazingOptics('Pane', { ...optics, solarFrontReflectance: 0.7 }, true)).toThrow(/must not exceed/)
  expect(() => s.setGlazingOptics('Pane', { ...optics, visibleTransmittance: -0.1 }, true)).toThrow(/between 0 and 1/)
  expect(s.text()).toBe(before)
  expect(s.setGlazingOptics('Pane', optics, true).changed).toBe(6)
  expect(s.inspect('Pane', 'WindowMaterial:Glazing').fields[4]!.value).toBe('0.5')
  s.undo()
  expect(s.text()).toBe(before)
})
