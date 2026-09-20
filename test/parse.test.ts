import { describe, expect, it } from 'vitest'
import { emitIdf, parseIdf, renderObject } from '../src/parser/index.js'

/** Parse then emit; the result must equal the input exactly. */
function roundTrip(text: string): string {
  return emitIdf(parseIdf(text))
}

describe('parseIdf — structure', () => {
  it('parses class name and positional fields', () => {
    const doc = parseIdf('Version,9.0;\n')
    expect(doc.order).toHaveLength(1)
    const obj = doc.objects.get(doc.order[0]!)!
    expect(obj.className).toBe('Version')
    expect(obj.fields.map((f) => f.value)).toEqual(['9.0'])
    expect(doc.version).toBe('9.0')
  })

  it('captures trailing same-line comments as field comments', () => {
    const doc = parseIdf('Zone,\n  ZONE 1,   !- Name\n  0.0;      !- North Axis\n')
    const obj = doc.objects.get(doc.order[0]!)!
    expect(obj.fields[0]!.value).toBe('ZONE 1')
    expect(obj.fields[0]!.comment).toBe('- Name')
    expect(obj.fields[1]!.comment).toBe('- North Axis')
  })

  it('does not attribute a standalone comment line to the preceding field', () => {
    const doc = parseIdf('Zone,\n  ZONE 1,\n  ! freestanding note\n  0.0;\n')
    const obj = doc.objects.get(doc.order[0]!)!
    expect(obj.fields[0]!.comment).toBeUndefined()
  })

  it('preserves empty fields', () => {
    const doc = parseIdf('Zone,A,,,B;\n')
    const obj = doc.objects.get(doc.order[0]!)!
    expect(obj.fields.map((f) => f.value)).toEqual(['A', '', '', 'B'])
  })

  it('keeps internal spaces in values but trims the edges', () => {
    const doc = parseIdf('Zone,   ZONE 1 EAST   ;\n')
    expect(doc.objects.get(doc.order[0]!)!.fields[0]!.value).toBe('ZONE 1 EAST')
  })

  it('excludes comment text from a field value split across lines', () => {
    const doc = parseIdf('Zone,\n  4,   !- Number of Vertices\n  0.0;\n')
    const obj = doc.objects.get(doc.order[0]!)!
    expect(obj.fields.map((f) => f.value)).toEqual(['4', '0.0'])
  })

  it('indexes objects by lowercased class name', () => {
    const doc = parseIdf('Zone,A;\nZONE,B;\nzone,C;\n')
    expect(doc.byClass.get('zone')).toHaveLength(3)
  })

  it('records a diagnostic for an unterminated object without throwing', () => {
    const doc = parseIdf('Zone,\n  ZONE 1,\n  0.0\n')
    expect(doc.diagnostics.some((d) => d.message.includes("terminated"))).toBe(true)
    expect(doc.objects.get(doc.order[0]!)!.unterminated).toBe(true)
  })

  it('handles a class with no fields', () => {
    const doc = parseIdf('Foo;\n')
    const obj = doc.objects.get(doc.order[0]!)!
    expect(obj.className).toBe('Foo')
    expect(obj.fields).toEqual([])
  })
})

describe('parseIdf — EPMacro directives', () => {
  const imf = [
    'Version,26.1;',
    '##set1 year[] "2009"',
    '##ifdef year[]',
    'Zone,',
    '  ZONE 1;',
    '##else',
    'Zone,',
    '  ZONE 2;',
    '##endif',
    '',
  ].join('\n')

  it('does not absorb a directive into the following class name', () => {
    const doc = parseIdf(imf)
    const names = doc.order.map((id) => doc.objects.get(id)!.className)
    expect(names).toEqual(['Version', 'Zone', 'Zone'])
  })

  it('warns that macros were seen but not expanded', () => {
    const doc = parseIdf(imf)
    const warn = doc.diagnostics.find((d) => d.message.includes('EPMacro'))
    expect(warn).toBeDefined()
    expect(warn!.severity).toBe('warning')
    expect(warn!.message).toContain('4 EPMacro directive(s)')
  })

  it('still round-trips a macro file byte-identically', () => {
    expect(roundTrip(imf)).toBe(imf)
  })

  it('leaves a mid-value # alone — only line-leading # is a directive', () => {
    // `#` is not special in IDF, and a value may legitimately contain one.
    const doc = parseIdf('Zone,\n  Unit #3,   !- Name\n  0.0;\n')
    expect(doc.objects.get(doc.order[0]!)!.fields[0]!.value).toBe('Unit #3')
    expect(doc.diagnostics).toEqual([])
  })

  it('reports no macro warning for ordinary files', () => {
    const doc = parseIdf('Version,9.0;\nZone,A;\n')
    expect(doc.diagnostics).toEqual([])
  })
})

describe('emitIdf — round-trip fidelity', () => {
  const cases: Record<string, string> = {
    'simple object': 'Version,9.0;\n',
    'leading comments': '! header line\n! another\n\nVersion,9.0;\n',
    'trailing content after last object': 'Version,9.0;\n\n! trailing note\n\n',
    'no trailing newline': 'Version,9.0;',
    'CRLF line endings': 'Zone,\r\n  ZONE 1,   !- Name\r\n  0.0;\r\n',
    'mixed CRLF and LF': 'Zone,\r\n  A,\n  B;\r\n',
    'BOM prefix': '﻿Version,9.0;\n',
    'non-ASCII in values and comments': 'Zone,\n  Zóna—1,   !- Nom de la zone °C\n  0.0;\n',
    'tabs as separators': 'Zone,\n\tZONE 1,\t!- Name\n\t0.0;\n',
    'blank lines inside an object': 'Zone,\n\n  ZONE 1,\n\n  0.0;\n',
    'comment between objects': 'Version,9.0;\n! between\nZone,A;\n',
    'multiple objects with irregular spacing': 'Version , 9.0 ;\n\n\nZone,A,B;\nZone,C;\n',
    'semicolon immediately after class': 'Foo;\n',
    'empty file': '',
    'whitespace-only file': '\n\n   \n',
    'comments only': '! nothing but comments\n! at all\n',
    'unterminated final object': 'Version,9.0;\nZone,\n  ZONE 1,\n  0.0\n',
    'exclamation inside a comment': 'Zone,A;  !- watch out! tricky\n',
    'consecutive empty fields': 'Zone,A,,,,B;\n',
    'no space around delimiters': 'Zone,A,B,C;\n',
  }

  for (const [name, text] of Object.entries(cases)) {
    it(`is byte-identical: ${name}`, () => {
      expect(roundTrip(text)).toBe(text)
    })
  }
})

describe('renderObject — regeneration of dirty objects', () => {
  it('regenerates only the dirty object and leaves the rest byte-identical', () => {
    const src = '! header\nVersion,9.0;\n\nZone,\n  ZONE 1,   !- Name\n  0.0;      !- North Axis\n\n! tail\n'
    const doc = parseIdf(src)
    const zoneId = doc.byClass.get('zone')![0]!
    const zone = doc.objects.get(zoneId)!
    zone.fields[0]!.value = 'ZONE 2'
    zone.dirty = true

    const out = emitIdf(doc)
    expect(out).toContain('! header')
    expect(out).toContain('Version,9.0;')
    expect(out).toContain('ZONE 2')
    expect(out).not.toContain('ZONE 1')
    expect(out).toContain('! tail')
    // Untouched neighbours keep their exact original text.
    expect(out.startsWith('! header\nVersion,9.0;\n')).toBe(true)
    expect(out.endsWith('! tail\n')).toBe(true)
  })

  it('preserves field comments when regenerating', () => {
    const doc = parseIdf('Zone,\n  ZONE 1,   !- Name\n  0.0;      !- North Axis\n')
    const obj = doc.objects.get(doc.order[0]!)!
    const rendered = renderObject(obj)
    expect(rendered).toContain('!- Name')
    expect(rendered).toContain('!- North Axis')
  })

  it('re-parses its own regenerated output to the same field values', () => {
    const doc = parseIdf('Zone,\n  ZONE 1,   !- Name\n  ,         !- Empty\n  0.0;      !- North Axis\n')
    const obj = doc.objects.get(doc.order[0]!)!
    const reparsed = parseIdf(renderObject(obj))
    const reobj = reparsed.objects.get(reparsed.order[0]!)!
    expect(reobj.className).toBe(obj.className)
    expect(reobj.fields.map((f) => f.value)).toEqual(obj.fields.map((f) => f.value))
  })
})
