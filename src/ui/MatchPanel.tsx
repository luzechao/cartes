/**
 * Surface matching review — Phase 7 of docs/05-implementation-plan.md.
 *
 * "Propose, never impose." Every proposal is listed with the exact field changes it would make,
 * and nothing is written until the user applies the ones they have ticked. Everything the
 * matcher found and deliberately did *not* propose is listed too, with the reason, so a quiet
 * panel reads as "checked and fine" rather than "did nothing".
 */
import { useMemo, useState } from 'react'
import type { Model } from '../model/index.js'
import type { MatchNote, MatchProposal, MatchReport, ProposalKind } from '../geometry/index.js'

interface MatchPanelProps {
  model: Model
  report: MatchReport
  selectedId: string | undefined
  onSelect: (id: string) => void
  onApply: (proposals: MatchProposal[]) => void
}

const KIND_LABEL: Record<ProposalKind, string> = {
  'pair-exposed': 'Pair exposed faces',
  'complete-pair': 'Complete one-sided pair',
  'repair-reference': 'Repair reference',
}

function pairKey(p: { a: string; b?: string }): string {
  return `${p.a}|${p.b ?? ''}`
}

export function MatchPanel({ model, report, selectedId, onSelect, onApply }: MatchPanelProps): React.JSX.Element {
  // Rejections are remembered by surface pair, which survives re-running the matcher after
  // an unrelated edit; proposal ids do not.
  const [rejected, setRejected] = useState<ReadonlySet<string>>(new Set())
  const [expanded, setExpanded] = useState<string | undefined>(undefined)

  const accepted = useMemo(
    () => report.proposals.filter((p) => !rejected.has(pairKey(p))),
    [report, rejected],
  )

  const name = (id: string | undefined): string => (id ? (model.surfaces.get(id)?.name ?? id) : '')

  const toggle = (p: MatchProposal): void => {
    const next = new Set(rejected)
    const k = pairKey(p)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    setRejected(next)
  }

  const noteList = (title: string, notes: MatchNote[], tone: string, hint: string): React.JSX.Element | null =>
    notes.length === 0 ? null : (
      <details className="match-panel__section">
        <summary>
          {title} ({notes.length})
        </summary>
        <p className="match-panel__hint">{hint}</p>
        {notes.map((n, i) => (
          <div
            key={`${pairKey(n)}:${i}`}
            className={`issue-card issue-card--${tone}${selectedId === n.a || selectedId === n.b ? ' issue-card--selected' : ''}`}
            onClick={() => onSelect(n.a)}
          >
            <div className="issue-card__name">
              {name(n.a)}
              {n.b ? ` / ${name(n.b)}` : ''}
            </div>
            <p className="issue-card__msg">{n.reason}</p>
          </div>
        ))}
      </details>
    )

  return (
    <div className="match-panel">
      <div className="match-panel__summary">
        <strong>{report.proposals.length}</strong> proposal{report.proposals.length === 1 ? '' : 's'} ·{' '}
        {report.confirmed.length} pair{report.confirmed.length === 1 ? '' : 's'} confirmed
        {report.partial.length > 0 && ` · ${report.partial.length} partial overlap${report.partial.length === 1 ? '' : 's'}`}
      </div>

      {report.proposals.length === 0 ? (
        <div className="validation-panel__empty">
          Nothing to propose. Every coincident pair of surfaces is either already paired or has a
          deliberate boundary condition.
        </div>
      ) : (
        <>
          <div className="match-panel__actions">
            <button
              type="button"
              className="button--active"
              disabled={accepted.length === 0}
              onClick={() => onApply(accepted)}
              title="Write the ticked proposals into the file, as one undo step"
            >
              Apply {accepted.length} of {report.proposals.length}
            </button>
            <button type="button" onClick={() => setRejected(new Set(report.proposals.map(pairKey)))}>
              Untick all
            </button>
            <button type="button" onClick={() => setRejected(new Set())}>
              Tick all
            </button>
          </div>

          {report.proposals.map((p) => {
            const on = !rejected.has(pairKey(p))
            const open = expanded === p.id
            return (
              <div
                key={p.id}
                className={`issue-card match-card${selectedId === p.a || selectedId === p.b ? ' issue-card--selected' : ''}${on ? '' : ' match-card--rejected'}`}
                onClick={() => onSelect(p.a)}
              >
                <div className="issue-card__top">
                  <label className="match-card__tick" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={on} onChange={() => toggle(p)} />
                    <span className="issue-card__code">{KIND_LABEL[p.kind]}</span>
                  </label>
                </div>
                <div className="issue-card__name">
                  {name(p.a)} / {name(p.b)}
                </div>
                <p className="issue-card__msg">{p.reason}</p>
                <button
                  type="button"
                  className="match-card__more"
                  onClick={(e) => {
                    e.stopPropagation()
                    setExpanded(open ? undefined : p.id)
                  }}
                >
                  {open ? 'Hide' : 'Show'} {p.changes.length} field change{p.changes.length === 1 ? '' : 's'}
                </button>
                {open && (
                  <table className="match-card__changes">
                    <tbody>
                      {p.changes.map((c, i) => (
                        <tr key={i}>
                          <td>{c.objectName}</td>
                          <td>{c.fieldName}</td>
                          <td className="match-card__from">{c.from === '' ? '(blank)' : c.from}</td>
                          <td>→</td>
                          <td className="match-card__to">{c.to}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )
          })}
        </>
      )}

      {report.partial.length > 0 && (
        <details className="match-panel__section" open>
          <summary>Partial overlaps ({report.partial.length})</summary>
          <p className="match-panel__hint">
            These faces touch over only part of their area. Pairing them needs one side split to
            match the other first; nothing is proposed.
          </p>
          {report.partial.map((p) => (
            <div
              key={pairKey(p)}
              className={`issue-card issue-card--warning${selectedId === p.a || selectedId === p.b ? ' issue-card--selected' : ''}`}
              onClick={() => onSelect(p.a)}
            >
              <div className="issue-card__name">
                {name(p.a)} / {name(p.b)}
              </div>
              <p className="issue-card__msg">
                Overlap {p.overlapArea.toFixed(2)} m² — {(p.fractionA * 100).toFixed(1)} % of {name(p.a)},{' '}
                {(p.fractionB * 100).toFixed(1)} % of {name(p.b)}.
              </p>
            </div>
          ))}
        </details>
      )}

      {noteList(
        'Not proposed',
        report.blocked,
        'warning',
        'Coincident faces that could be paired, but where doing so is not clearly right.',
      )}
      {noteList(
        'Declared pairs that do not coincide',
        report.unconfirmed,
        'info',
        'EnergyPlus pairs surfaces by name and area, not position, so these may be intended — for example zones drawn at their inside faces. Left alone.',
      )}
      {noteList(
        'Deliberate boundaries',
        report.intentional,
        'info',
        'Coincident faces where one side is Adiabatic, Ground or similar by choice. Left alone.',
      )}
    </div>
  )
}
