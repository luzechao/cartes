/**
 * Line diff engine — Phase 5 of docs/05-implementation-plan.md.
 *
 * Produces structured hunks and standard unified diff patches.
 * Optimised with common-prefix and common-suffix pruning so that computing live diffs
 * on large (10,000+ line) IDF files takes < 1 ms when a single object changes.
 */

export interface DiffLine {
  type: 'add' | 'del' | 'eq'
  content: string
  oldLineNumber?: number
  newLineNumber?: number
}

export interface DiffHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

export interface DiffSummary {
  addedLines: number
  deletedLines: number
  hunks: DiffHunk[]
  unifiedText: string
}

/** Compute a line-by-line diff between two texts with unified context. */
export function computeLineDiff(
  oldText: string,
  newText: string,
  contextLines = 3,
): DiffSummary {
  if (oldText === newText) {
    return { addedLines: 0, deletedLines: 0, hunks: [], unifiedText: '' }
  }

  const oldLines = oldText.split(/\r?\n/)
  const newLines = newText.split(/\r?\n/)

  // 1. Fast path: prune common prefix
  let prefixCount = 0
  while (
    prefixCount < oldLines.length &&
    prefixCount < newLines.length &&
    oldLines[prefixCount] === newLines[prefixCount]
  ) {
    prefixCount++
  }

  // 2. Fast path: prune common suffix
  let suffixCount = 0
  while (
    suffixCount < oldLines.length - prefixCount &&
    suffixCount < newLines.length - prefixCount &&
    oldLines[oldLines.length - 1 - suffixCount] ===
      newLines[newLines.length - 1 - suffixCount]
  ) {
    suffixCount++
  }

  const middleOld = oldLines.slice(prefixCount, oldLines.length - suffixCount)
  const middleNew = newLines.slice(prefixCount, newLines.length - suffixCount)

  // 3. LCS on middle section
  const ops = computeLcsDiff(middleOld, middleNew)

  // 4. Assemble full edit script around the middle section
  // We include up to contextLines before and after
  const beforeContext = Math.min(contextLines, prefixCount)
  const afterContext = Math.min(contextLines, suffixCount)

  const hunkOldStart = prefixCount - beforeContext + 1
  const hunkNewStart = prefixCount - beforeContext + 1

  const hunkLines: DiffLine[] = []

  // Leading context
  for (let i = prefixCount - beforeContext; i < prefixCount; i++) {
    hunkLines.push({
      type: 'eq',
      content: oldLines[i]!,
      oldLineNumber: i + 1,
      newLineNumber: i + 1,
    })
  }

  // Changed lines
  let curOld = prefixCount + 1
  let curNew = prefixCount + 1
  let added = 0
  let deleted = 0

  for (const op of ops) {
    if (op.type === 'del') {
      hunkLines.push({
        type: 'del',
        content: op.text,
        oldLineNumber: curOld++,
      })
      deleted++
    } else if (op.type === 'add') {
      hunkLines.push({
        type: 'add',
        content: op.text,
        newLineNumber: curNew++,
      })
      added++
    } else {
      hunkLines.push({
        type: 'eq',
        content: op.text,
        oldLineNumber: curOld++,
        newLineNumber: curNew++,
      })
    }
  }

  // Trailing context
  const suffixStart = oldLines.length - suffixCount
  for (let i = 0; i < afterContext; i++) {
    const oldIdx = suffixStart + i
    const newIdx = newLines.length - suffixCount + i
    hunkLines.push({
      type: 'eq',
      content: oldLines[oldIdx]!,
      oldLineNumber: oldIdx + 1,
      newLineNumber: newIdx + 1,
    })
  }

  const oldCount =
    beforeContext + (oldLines.length - prefixCount - suffixCount) + afterContext
  const newCount =
    beforeContext + (newLines.length - prefixCount - suffixCount) + afterContext

  const hunk: DiffHunk = {
    oldStart: hunkOldStart,
    oldCount,
    newStart: hunkNewStart,
    newCount,
    lines: hunkLines,
  }

  // Build standard unified diff text
  const header = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@\n`
  const body = hunkLines
    .map((l) => {
      const prefix = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '
      return `${prefix}${l.content}`
    })
    .join('\n')

  return {
    addedLines: added,
    deletedLines: deleted,
    hunks: [hunk],
    unifiedText: `${header}${body}\n`,
  }
}

interface EditOp {
  type: 'add' | 'del' | 'eq'
  text: string
}

function computeLcsDiff(a: string[], b: string[]): EditOp[] {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!)
      }
    }
  }

  const result: EditOp[] = []
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.push({ type: 'eq', text: a[i - 1]! })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.push({ type: 'add', text: b[j - 1]! })
      j--
    } else if (i > 0 && (j === 0 || dp[i]![j - 1]! < dp[i - 1]![j]!)) {
      result.push({ type: 'del', text: a[i - 1]! })
      i--
    }
  }

  return result.reverse()
}

