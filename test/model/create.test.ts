import { describe, expect, it } from 'vitest'
import { emitIdf, parseIdf } from '../../src/parser/index.js'
import { createObject, EditHistory, valuesByName } from '../../src/model/index.js'

/**
 * Creating objects. The emitter must put a new object on lines of its own, after the last
 * object of its class, and change no other byte; undo must take it away again.
 */

const SOURCE = `Version,26.1;

Zone,
    A;                       !- Name

  Zone,B;  ! trailing comment

Material,M,Rough,0.1,1,1000,1000;
`

describe('createObject', () => {
  it('places a new object after the last of its class, on its own lines, touching nothing else', () => {
    const doc = parseIdf(SOURCE)
    createObject(doc, 'Zone', ['C'], { version: '26.1' })
    expect(emitIdf(doc)).toBe(`Version,26.1;

Zone,
    A;                       !- Name

  Zone,B;  ! trailing comment

Zone,
    C;                       !- Name

Material,M,Rough,0.1,1,1000,1000;
`)
  })

  it('appends a class the file does not have yet at the end', () => {
    const doc = parseIdf(SOURCE)
    createObject(doc, 'Building', ['X'], { version: '26.1' })
    expect(emitIdf(doc)).toBe(`${SOURCE}
Building,
    X;                       !- Name
`)
  })

  it('writes into an empty document without a leading blank line', () => {
    const doc = parseIdf('')
    createObject(doc, 'Version', ['26.1'])
    createObject(doc, 'Zone', ['A'], { version: '26.1' })
    expect(emitIdf(doc)).toBe(`Version,
    26.1;                    !- Version Identifier

Zone,
    A;                       !- Name
`)
  })

  it('handles a file whose last object has no newline after it', () => {
    const doc = parseIdf('Version,26.1;')
    createObject(doc, 'Zone', ['A'], { version: '26.1' })
    const text = emitIdf(doc)
    expect(text).toBe('Version,26.1;\n\nZone,\n    A;                       !- Name\n')
    expect([...parseIdf(text).objects.values()].map((o) => o.className)).toEqual(['Version', 'Zone'])
  })

  it('keeps byClass in document order', () => {
    const doc = parseIdf(SOURCE)
    const c = createObject(doc, 'Zone', ['C'], { version: '26.1' })
    const d = createObject(doc, 'Zone', ['D'], { after: doc.byClass.get('zone')![0]!, version: '26.1' })
    expect(doc.byClass.get('zone')!.map((id) => doc.objects.get(id)!.fields[0]!.value)).toEqual(['A', 'D', 'B', 'C'])
    expect(doc.objects.get(c)!.dirty && doc.objects.get(d)!.dirty).toBe(true)
  })

  it('is undone and redone like any other edit', () => {
    const doc = parseIdf(SOURCE)
    const history = new EditHistory(doc)
    const id = createObject(doc, 'Zone', ['C'], { version: '26.1' })
    const created = emitIdf(doc)
    history.undo()
    expect(emitIdf(doc)).toBe(SOURCE)
    expect(doc.objects.has(id)).toBe(false)
    expect(doc.byClass.get('zone')).toHaveLength(2)
    history.redo()
    expect(emitIdf(doc)).toBe(created)
  })

  it('round-trips: the emitted text parses back to the same objects', () => {
    const doc = parseIdf(SOURCE)
    createObject(doc, 'Zone', valuesByName('zone', '26.1', { Name: 'C', 'X Origin': '5', 'Z Origin': '3' }), {
      version: '26.1',
    })
    const again = parseIdf(emitIdf(doc))
    const zone = [...again.objects.values()].filter((o) => o.classKey === 'zone')[2]!
    expect(zone.fields.map((f) => f.value)).toEqual(['C', '', '5', '', '3'])
    expect(emitIdf(again)).toBe(emitIdf(doc))
  })
})

describe('valuesByName', () => {
  it('fills by IDD field name, blank between, and refuses a field the class does not have', () => {
    expect(valuesByName('zone', '26.1', { Name: 'Z', 'Y Origin': '2' })).toEqual(['Z', '', '', '2'])
    expect(() => valuesByName('zone', '26.1', { Colour: 'red' })).toThrow(/no field 'Colour'/)
  })
})
