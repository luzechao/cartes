import { describe, expect, it } from 'vitest'
import { parseIdf } from '../../src/parser/index.js'
import { runPeriods, runPeriodSummary } from '../../src/model/index.js'

describe('run periods', () => {
  it('lists RunPeriod objects and summarizes their dates, years included when given (9.0+ layout)', () => {
    const doc = parseIdf(
      [
        'Version,26.1;',
        'RunPeriod, Annual, 1, 1, , 12, 31, , Sunday, No, No, No, Yes, Yes;',
        'RunPeriod, Summer 2013, 6, 1, 2013, 8, 31, 2013;',
        'Zone, Z;',
      ].join('\n'),
    )
    const periods = runPeriods(doc)
    expect(periods.map((p) => p.fields[0]?.value)).toEqual(['Annual', 'Summer 2013'])
    expect(periods.map((p) => runPeriodSummary(p, '26.1'))).toEqual(['1/1 – 12/31', '6/1/2013 – 8/31/2013'])
  })

  it('reads the pre-9.0 layout, which has no year fields', () => {
    const doc = parseIdf('Version,8.9;\nRunPeriod, Winter, 12, 1, 2, 28, Monday;')
    expect(runPeriodSummary(runPeriods(doc)[0]!, '8.9')).toBe('12/1 – 2/28')
  })

  it('gives no summary when the dates are missing', () => {
    const doc = parseIdf('Version,26.1;\nRunPeriod, Empty;')
    expect(runPeriodSummary(runPeriods(doc)[0]!, '26.1')).toBeUndefined()
  })
})
