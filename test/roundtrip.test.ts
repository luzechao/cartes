import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emitIdf, parseIdf } from '../src/parser/index.js'

/**
 * PHASE 1 GATE (docs/05-implementation-plan.md)
 *
 *   Parse → emit → byte-identical output, for every fixture, with zero objects modified.
 *
 * Nothing downstream is allowed to proceed until this passes. The whole round-trip
 * promise of the editor rests on it.
 *
 * Two corpora, fetched by scripts/fetch-fixtures.sh and the testfiles download:
 *   fixtures/testfiles/  — the full develop-branch corpus (breadth, one version)
 *   fixtures/versions/   — a small sample per release (version spread, incl. 9.5→9.6)
 */

const FIXTURES = join(import.meta.dirname, 'fixtures')
const BULK_DIR = join(FIXTURES, 'testfiles')
const VERSIONS_DIR = join(FIXTURES, 'versions')

interface Fixture {
  label: string
  path: string
}

function listBulk(): Fixture[] {
  if (!existsSync(BULK_DIR)) return []
  return readdirSync(BULK_DIR)
    .filter((f) => f.endsWith('.idf'))
    .sort()
    .map((f) => ({ label: f, path: join(BULK_DIR, f) }))
}

function listVersioned(): Fixture[] {
  if (!existsSync(VERSIONS_DIR)) return []
  const out: Fixture[] = []
  for (const dir of readdirSync(VERSIONS_DIR).sort()) {
    const full = join(VERSIONS_DIR, dir)
    for (const f of readdirSync(full).filter((x) => x.endsWith('.idf')).sort()) {
      out.push({ label: `${dir}/${f}`, path: join(full, f) })
    }
  }
  return out
}

const bulk = listBulk()
const versioned = listVersioned()
const all = [...bulk, ...versioned]

/** Report the first divergence with context rather than dumping megabytes into the log. */
function expectByteIdentical(source: string, output: string): void {
  if (output === source) return
  let i = 0
  while (i < source.length && i < output.length && source[i] === output[i]) i++
  const line = source.slice(0, i).split('\n').length
  const ctx = (s: string): string => JSON.stringify(s.slice(Math.max(0, i - 60), i + 60))
  throw new Error(
    `Diverged at offset ${i} (line ${line})\n` +
      `  expected: ${ctx(source)}\n` +
      `  actual:   ${ctx(output)}\n` +
      `  lengths: source=${source.length} output=${output.length}`,
  )
}

describe('round-trip fidelity — develop corpus', () => {
  it('has fixtures available', () => {
    expect(bulk.length).toBeGreaterThan(0)
  })

  for (const { label, path } of bulk) {
    it(`byte-identical: ${label}`, () => {
      const source = readFileSync(path, 'utf8')
      expectByteIdentical(source, emitIdf(parseIdf(source)))
    })
  }
})

describe('round-trip fidelity — across EnergyPlus releases', () => {
  it('spans several versions', () => {
    const versions = new Set(
      versioned.map(({ path }) => parseIdf(readFileSync(path, 'utf8')).version),
    )
    expect(versions.size).toBeGreaterThanOrEqual(6)
  })

  for (const { label, path } of versioned) {
    it(`byte-identical: ${label}`, () => {
      const source = readFileSync(path, 'utf8')
      expectByteIdentical(source, emitIdf(parseIdf(source)))
    })
  }
})

describe('round-trip fidelity — line-ending variants', () => {
  // No file in either corpus uses CRLF, yet IDF files authored on Windows routinely do.
  // Synthesise the variants from a real fixture so the coverage is not merely theoretical.
  const sample = all[0]

  it('has a sample to derive from', () => {
    expect(sample).toBeDefined()
  })

  const base = sample ? readFileSync(sample.path, 'utf8').replace(/\r\n/g, '\n') : ''

  it('byte-identical: CRLF throughout', () => {
    const crlf = base.replace(/\n/g, '\r\n')
    expectByteIdentical(crlf, emitIdf(parseIdf(crlf)))
  })

  it('byte-identical: CR-only (classic Mac)', () => {
    const cr = base.replace(/\n/g, '\r')
    expectByteIdentical(cr, emitIdf(parseIdf(cr)))
  })

  it('byte-identical: BOM-prefixed CRLF', () => {
    const bom = '﻿' + base.replace(/\n/g, '\r\n')
    expectByteIdentical(bom, emitIdf(parseIdf(bom)))
  })
})

describe('corpus-wide parser sanity', () => {
  it('produces no parse diagnostics across the corpus', () => {
    const problems: string[] = []
    for (const { label, path } of all) {
      const doc = parseIdf(readFileSync(path, 'utf8'))
      for (const d of doc.diagnostics) {
        problems.push(`${label}: ${d.severity}: ${d.message} @${d.offset}`)
      }
    }
    expect(problems).toEqual([])
  })

  it('finds a Version object in every fixture', () => {
    const missing = all
      .filter(({ path }) => parseIdf(readFileSync(path, 'utf8')).version === undefined)
      .map((f) => f.label)
    expect(missing).toEqual([])
  })

  it('parses a plausible number of objects in every fixture', () => {
    const empty = all
      .filter(({ path }) => parseIdf(readFileSync(path, 'utf8')).order.length < 5)
      .map((f) => f.label)
    expect(empty).toEqual([])
  })

  it('never produces an empty class name', () => {
    const bad: string[] = []
    for (const { label, path } of all) {
      const doc = parseIdf(readFileSync(path, 'utf8'))
      for (const id of doc.order) {
        const obj = doc.objects.get(id)!
        if (obj.className.trim() === '') bad.push(`${label} @${obj.start}`)
      }
    }
    expect(bad).toEqual([])
  })
})
