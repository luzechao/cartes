/**
 * Raw-IDF and Live Diff Panel — Phase 5 of docs/05-implementation-plan.md.
 *
 * Provides full transparency of file changes:
 * - Live unified diff showing exactly which objects and fields changed
 * - Raw-IDF text view
 * - One-click "Download IDF" export and "Revert All" affordances
 */
import { useMemo, useState } from 'react'
import type { IdfDocument } from '../parser/types.js'
import { computeLineDiff } from '../diff/diff.js'
import { getDirtyObjects } from '../model/edit.js'

interface DiffPanelProps {
  doc: IdfDocument
  originalText: string
  currentText: string
  fileName: string
  onClose: () => void
  onRevertAll: () => void
}

export function DiffPanel({
  doc,
  originalText,
  currentText,
  fileName,
  onClose,
  onRevertAll,
}: DiffPanelProps): React.JSX.Element {
  const [tab, setTab] = useState<'diff' | 'raw'>('diff')
  const [copied, setCopied] = useState(false)

  const diff = useMemo(
    () => computeLineDiff(originalText, currentText, 3),
    [originalText, currentText],
  )

  const dirtyCount = useMemo(() => getDirtyObjects(doc).length, [doc])

  const downloadFile = () => {
    const blob = new Blob([currentText], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const outName = fileName.replace(/\.idf$/i, '') + '-edited.idf'
    a.href = url
    a.download = outName
    a.click()
    URL.revokeObjectURL(url)
  }

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(tab === 'diff' ? diff.unifiedText : currentText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback
    }
  }

  return (
    <div className="diff-modal-backdrop" onClick={onClose}>
      <div className="diff-modal" onClick={(e) => e.stopPropagation()}>
        <div className="diff-modal__header">
          <div className="diff-modal__title-group">
            <span className="diff-modal__title">Live Changes</span>
            <span className="diff-modal__stats">
              {dirtyCount} object{dirtyCount === 1 ? '' : 's'} modified ·{' '}
              <span className="text-added">+{diff.addedLines}</span> /{' '}
              <span className="text-deleted">-{diff.deletedLines}</span> lines
            </span>
          </div>

          <div className="diff-modal__actions">
            <button
              type="button"
              className="btn btn--action"
              onClick={copyToClipboard}
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
            <button
              type="button"
              className="btn btn--action btn--primary"
              onClick={downloadFile}
            >
              Download IDF
            </button>
            {dirtyCount > 0 && (
              <button
                type="button"
                className="btn btn--revert"
                onClick={onRevertAll}
              >
                Revert All
              </button>
            )}
            <button
              type="button"
              className="diff-modal__close"
              onClick={onClose}
              title="Close panel"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="diff-modal__tabs">
          <button
            type="button"
            className={`diff-modal__tab${tab === 'diff' ? ' diff-modal__tab--active' : ''}`}
            onClick={() => setTab('diff')}
          >
            Unified Diff
          </button>
          <button
            type="button"
            className={`diff-modal__tab${tab === 'raw' ? ' diff-modal__tab--active' : ''}`}
            onClick={() => setTab('raw')}
          >
            Full IDF Text
          </button>
        </div>

        <div className="diff-modal__body">
          {tab === 'diff' ? (
            diff.hunks.length === 0 ? (
              <div className="diff-modal__empty">
                No changes made yet. Edit any field in the Inspector to see live diffs.
              </div>
            ) : (
              <div className="diff-viewer">
                {diff.hunks.map((hunk, hIdx) => (
                  <div key={hIdx} className="diff-hunk">
                    <div className="diff-hunk__header">
                      @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
                    </div>
                    {hunk.lines.map((line, lIdx) => (
                      <div
                        key={lIdx}
                        className={`diff-line diff-line--${line.type}`}
                      >
                        <span className="diff-line__num diff-line__num--old">
                          {line.oldLineNumber ?? ''}
                        </span>
                        <span className="diff-line__num diff-line__num--new">
                          {line.newLineNumber ?? ''}
                        </span>
                        <span className="diff-line__marker">
                          {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                        </span>
                        <span className="diff-line__content">{line.content}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )
          ) : (
            <pre className="raw-idf-viewer">{currentText}</pre>
          )}
        </div>
      </div>
    </div>
  )
}

