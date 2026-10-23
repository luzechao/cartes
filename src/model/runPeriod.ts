/**
 * Run periods: the `RunPeriod` objects that make a weather-file simulation, listed on their own in the object
 * tree. Fields are read by name because their positions moved when begin/end years were added in 9.0.
 */
import { objectsOfClass, type IdfDocument, type IdfObject } from '../parser/index.js'
import { getSchema, readField } from './idd.js'

/** The document's RunPeriod objects, in file order. */
export function runPeriods(doc: IdfDocument): IdfObject[] {
  return objectsOfClass(doc, 'RunPeriod')
}

/**
 * The dates a run period covers, e.g. `1/1 – 12/31`, or `1/1/2013 – 12/31/2013` when years are given.
 * `undefined` when the version's layout is unknown or the months and days are missing.
 */
export function runPeriodSummary(obj: IdfObject, version: string): string | undefined {
  const schema = getSchema('runperiod', version)
  if (!schema) return undefined
  const date = (prefix: 'Begin' | 'End'): string | undefined => {
    const month = readField(obj, schema, `${prefix} Month`)
    const day = readField(obj, schema, `${prefix} Day of Month`)
    if (!month || !day) return undefined
    const year = readField(obj, schema, `${prefix} Year`)
    return year ? `${month}/${day}/${year}` : `${month}/${day}`
  }
  const begin = date('Begin')
  const end = date('End')
  return begin && end ? `${begin} – ${end}` : undefined
}
