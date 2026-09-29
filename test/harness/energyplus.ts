/**
 * EnergyPlus test harness — the Phase 6 gate of docs/05-implementation-plan.md.
 *
 * "Move a vertex, validation still passes, EnergyPlus runs the output file without new severe
 * errors." The plan is explicit that this must be a test harness rather than a manual step.
 *
 * The measure is a *diff* of severe errors between a baseline run and an edited run, never an
 * absolute count. Corpus fixtures come from the EnergyPlus `develop` branch and declare
 * version 26.2 while a released binary is 26.1, which produces two benign version warnings;
 * several files carry other pre-existing warnings too. Diffing makes all of that cancel and
 * isolates the one thing under test: did *our edit* break the file.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WORK_ROOT = join(REPO_ROOT, '.eplus-tmp', 'gate')

/**
 * Locate an EnergyPlus binary, in descending order of explicitness.
 *
 * Deliberately no hardcoded personal path: a gate that only runs on one machine is not a
 * gate. `.energyplus-path` is gitignored and exists so a developer can point at a local
 * install in one line without putting their home directory into version control.
 */
export function resolveEnergyPlus(): string | undefined {
  const fromEnv = process.env.ENERGYPLUS_EXE
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  const pixiEnvs = join(REPO_ROOT, '.pixi', 'envs')
  if (existsSync(pixiEnvs)) {
    for (const env of readdirSync(pixiEnvs).sort()) {
      const candidate = join(pixiEnvs, env, 'bin', 'energyplus')
      if (existsSync(candidate)) return candidate
    }
  }

  const pointerFile = join(REPO_ROOT, '.energyplus-path')
  if (existsSync(pointerFile)) {
    const p = readFileSync(pointerFile, 'utf8').trim()
    if (p && existsSync(resolve(REPO_ROOT, p))) return resolve(REPO_ROOT, p)
  }

  try {
    const found = execFileSync('which', ['energyplus'], { encoding: 'utf8' }).trim()
    if (found && existsSync(found)) return found
  } catch {
    // `which` exits non-zero when nothing is on PATH. Not an error.
  }
  return undefined
}

export interface EnergyPlusRun {
  /** True when E+ reached "Completed Successfully". */
  completed: boolean
  exitCode: number
  /** Normalized `** Severe **` messages, in file order. */
  severes: string[]
  /** Normalized `** Fatal **` messages. */
  fatals: string[]
  /** Normalized `** Warning **` messages, in file order. */
  warnings: string[]
  warningCount: number
  /** Raw `.err` text, for reporting a failure usefully. */
  err: string
}

const SEVERE = /^\s*\*\*\s*Severe\s*\*\*\s*(.*)$/
const FATAL = /^\s*\*\*\s*Fatal\s*\*\*\s*(.*)$/
const WARNING = /^\s*\*\*\s*Warning\s*\*\*\s*(.*)$/

/**
 * Strip the parts of a message that move between runs even when nothing is wrong, so two runs
 * can be compared as sets. Timings and the input file's path are the usual offenders; surface
 * and zone names are kept, because an error naming a different surface is a genuinely
 * different error.
 */
function normalize(message: string): string {
  return message
    .replace(/Elapsed Time=[^,;]*/g, 'Elapsed Time=<t>')
    .replace(/\d+hr\s+\d+min\s+[\d.]+sec/g, '<t>')
    .replace(/[/\w.-]*\.idf/g, '<input>.idf')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseErr(err: string): Pick<EnergyPlusRun, 'severes' | 'fatals' | 'warnings' | 'warningCount'> {
  const severes: string[] = []
  const fatals: string[] = []
  const warnings: string[] = []

  for (const line of err.split(/\r?\n/)) {
    const s = SEVERE.exec(line)
    if (s) {
      severes.push(normalize(s[1]!))
      continue
    }
    const f = FATAL.exec(line)
    if (f) {
      fatals.push(normalize(f[1]!))
      continue
    }
    const w = WARNING.exec(line)
    if (w) warnings.push(normalize(w[1]!))
  }
  return { severes, fatals, warnings, warningCount: warnings.length }
}

export interface RunOptions {
  /** Subdirectory of `.eplus-tmp/gate` to run in. Must be unique per concurrent run. */
  workdir: string
  /** Design-day-only avoids needing a weather file. Defaults to true. */
  designDayOnly?: boolean
  timeoutMs?: number
}

/**
 * Run EnergyPlus over IDF text and report what its `.err` file said.
 *
 * Design-day-only on purpose: geometry errors are raised during input processing and surface
 * initialization, before the first timestep, so an annual run costs minutes and reveals
 * nothing extra. It also means no `.epw` is needed, which removes a whole class of fixture
 * plumbing.
 */
export function runEnergyPlus(
  exe: string,
  idfText: string,
  { workdir, designDayOnly = true, timeoutMs = 180_000 }: RunOptions,
): EnergyPlusRun {
  const dir = join(WORK_ROOT, workdir)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  const input = join(dir, 'in.idf')
  writeFileSync(input, idfText, 'utf8')

  const args = [...(designDayOnly ? ['-D'] : []), '-d', dir, '-p', 'base', input]

  let exitCode = 0
  try {
    execFileSync(exe, args, { stdio: 'pipe', timeout: timeoutMs })
  } catch (e) {
    const code = (e as { status?: number }).status
    exitCode = typeof code === 'number' ? code : 1
  }

  // Prefix `base` plus the default legacy suffix style yields `baseout.err`.
  const errPath = join(dir, 'baseout.err')
  const err = existsSync(errPath) ? readFileSync(errPath, 'utf8') : ''

  return {
    completed: /Completed Successfully/.test(err),
    exitCode,
    err,
    ...parseErr(err),
  }
}

export interface SevereDiff {
  added: string[]
  removed: string[]
}

/** Severe and fatal messages present after the edit but not before, and vice versa. */
export function severeDiff(before: EnergyPlusRun, after: EnergyPlusRun): SevereDiff {
  const beforeSet = new Set([...before.severes, ...before.fatals])
  const afterSet = new Set([...after.severes, ...after.fatals])
  return {
    added: [...afterSet].filter((m) => !beforeSet.has(m)),
    removed: [...beforeSet].filter((m) => !afterSet.has(m)),
  }
}

/**
 * Warning messages present after the edit but not before, and vice versa.
 *
 * Compared as text rather than by count, because a count is capable of staying still while one
 * warning is traded for another — which is precisely the case a geometry gate must not miss.
 */
export function warningDiff(before: EnergyPlusRun, after: EnergyPlusRun): SevereDiff {
  const beforeSet = new Set(before.warnings)
  const afterSet = new Set(after.warnings)
  return {
    added: [...afterSet].filter((m) => !beforeSet.has(m)),
    removed: [...beforeSet].filter((m) => !afterSet.has(m)),
  }
}
