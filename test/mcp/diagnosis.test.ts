import { expect, it } from 'vitest'
import { diagnoseEnergyPlusErrors } from '../../src/mcp/skills.js'

it('groups severe and fatal records with their own continuation lines', () => {
  const result = diagnoseEnergyPlusErrors(`Program Version
 ** Severe  ** Missing node
 **   ~~~   ** Details of the node
 ** Warning ** An unrelated schedule warning
 **   ~~~   ** Its continuation
 ** Fatal  ** Simulation terminated`)
  expect(result.total).toBe(2)
  expect(result.records[0]).toMatchObject({
    severity: 'severe', message: 'Missing node\nDetails of the node',
    suggestions: expect.arrayContaining([expect.stringContaining('node')]),
  })
  expect(result.records[0]!.message).not.toContain('schedule')
  expect(result.records[1]).toMatchObject({ severity: 'fatal', suggestions: [] })
  expect(result.note).toMatch(/not diagnoses/)
})

it('limits returned records and messages while counting the full input', () => {
  const result = diagnoseEnergyPlusErrors(Array(21).fill(` ** Severe ** ${'x'.repeat(3100)}`).join('\n'))
  expect(result.total).toBe(21)
  expect(result.truncated).toBe(true)
  expect(result.records).toHaveLength(20)
  expect(result.records[0]).toMatchObject({ messageTruncated: true, suggestions: [] })
  expect(result.records[0]!.message).toHaveLength(3000)
})
