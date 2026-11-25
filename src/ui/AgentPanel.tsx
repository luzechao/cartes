/**
 * The Agent sidebar: the conversation, each tool call as a collapsible card, and the edits waiting
 * for approval — with Approve and Reject on the card itself.
 */
import { useEffect, useRef, useState } from 'react'
import { PROVIDERS } from '../agent/settings.js'
import type { ApprovalRequest } from '../agent/tools.js'
import type { ComparisonChart } from '../simulate/scenarios.js'
import type { SeriesChart } from '../results/index.js'
import type { Agent, AssistantPart, ToolPart } from './useAgent.js'
import { AgentIcon } from './icons.js'

const SUGGESTIONS = [
  'Summarize this model: zones, constructions and what will be simulated.',
  'Which exterior walls have no windows?',
  'Compute the window-to-wall ratio for each orientation.',
  'Change the run period to January only, then simulate and report the heating energy.',
]

export function AgentPanel({ agent, hasModel }: { agent: Agent; hasModel: boolean }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const pending = Object.keys(agent.approvals).length

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [agent.items, agent.approvals])

  useEffect(() => inputRef.current?.focus(), [])

  const submit = (text = draft): void => {
    if (!text.trim() || agent.running) return
    agent.send(text)
    setDraft('')
  }

  const provider = PROVIDERS[agent.settings.provider]
  const modelId = agent.settings.models[agent.settings.provider]

  return (
    <div className="agent-panel">
      <div className="agent-panel__bar">
        <AgentIcon size={14} />
        <span className="agent-panel__model" title="Change in the Agent tab">
          {provider.label}
          {modelId ? ` · ${modelId}` : ''}
        </span>
        <span className="spacer" />
        <span className={`agent-panel__mode agent-panel__mode--${agent.settings.editMode}`}>
          {agent.settings.editMode === 'ask' ? 'Ask before edits' : 'Edits apply automatically'}
        </span>
      </div>

      <div className="agent-panel__list" ref={listRef}>
        {agent.items.length === 0 && (
          <div className="agent-panel__welcome">
            <p>
              Ask about the open model or tell the agent what to change. It reads and edits the model through cartes’ own
              tools — every change is one undo step — and can run Python and simulate.
            </p>
            {agent.problem && <p className="agent-panel__problem">{agent.problem}</p>}
            {!hasModel && <p className="agent-panel__problem">Open an IDF or load an example first.</p>}
            <div className="agent-panel__suggestions">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="agent-panel__suggestion"
                  disabled={!hasModel || agent.problem !== undefined}
                  onClick={() => submit(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {agent.items.map((item) =>
          item.role === 'user' ? (
            <div key={item.id} className="agent-panel__user">
              {item.text}
            </div>
          ) : item.role === 'assistant' ? (
            <div key={item.id} className="agent-panel__assistant">
              {item.parts.map((part, i) => (
                <Part key={part.type === 'tool' ? part.id : i} part={part} agent={agent} />
              ))}
            </div>
          ) : (
            <div key={item.id} className={`agent-panel__${item.role}`}>
              {item.text}
            </div>
          ),
        )}
        {agent.running && pending === 0 && <div className="agent-panel__working">Working…</div>}
      </div>

      <div className="agent-panel__prompt">
        <textarea
          ref={inputRef}
          className="agent-panel__input"
          rows={3}
          placeholder={agent.problem ?? 'Ask or instruct the agent…'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          spellCheck
        />
        {agent.running ? (
          <button type="button" className="agent-panel__send" onClick={agent.stop}>
            Stop
          </button>
        ) : (
          <button type="button" className="agent-panel__send agent-panel__send--primary" onClick={() => submit()} disabled={!draft.trim()}>
            Send
          </button>
        )}
      </div>
      <div className="agent-panel__hint">Enter send · Shift+Enter new line · Ctrl+Z undoes agent edits too</div>
    </div>
  )
}

function Part({ part, agent }: { part: AssistantPart; agent: Agent }): React.JSX.Element | null {
  if (part.type === 'text') return <Markdown text={part.text} />
  if (part.type === 'reasoning') {
    return (
      <details className="agent-panel__reasoning">
        <summary>Thinking</summary>
        <div>{part.text}</div>
      </details>
    )
  }
  return <ToolCard part={part} approval={agent.approvals[part.id]} onDecide={(ok) => agent.decide(part.id, ok)} />
}

function ToolCard({
  part,
  approval,
  onDecide,
}: {
  part: ToolPart
  approval: ApprovalRequest | undefined
  onDecide: (approved: boolean) => void
}): React.JSX.Element {
  const output = part.output as { rejected?: boolean; error?: string } | undefined
  const status = approval
    ? 'waiting'
    : part.state === 'running'
      ? 'running'
      : part.state === 'error' || output?.error
        ? 'failed'
        : output?.rejected
          ? 'declined'
          : 'done'
  const code = part.name === 'run_python' ? (part.input as { code?: string } | undefined)?.code : undefined
  const charts = ['run_scenarios', 'plot_timeseries'].includes(part.name) ? resultCharts(part.output) : []

  return (
    <details
      className={`agent-tool agent-tool--${status}${approval?.kind === 'destructive' ? ' agent-tool--destructive' : ''}`}
      open={approval !== undefined || charts.length > 0 || undefined}
    >
      <summary>
        <span className="agent-tool__name">{part.name}</span>
        <span className="agent-tool__args">{code ? firstLine(code) : brief(part.input)}</span>
        <span className="agent-tool__status">{status}</span>
      </summary>
      {code ? <pre className="agent-tool__code">{code}</pre> : <pre className="agent-tool__json">{pretty(part.input)}</pre>}
      {approval && (
        <div className="agent-tool__approval">
          <span>{approval.kind === 'destructive' ? 'This removes objects. Allow it?' : 'Allow this edit?'}</span>
          <button type="button" className="agent-tool__approve" onClick={() => onDecide(true)}>
            Approve
          </button>
          <button type="button" className="agent-tool__reject" onClick={() => onDecide(false)}>
            Reject
          </button>
        </div>
      )}
      {part.error && <pre className="agent-tool__error">{part.error}</pre>}
      {charts.map((chart) => (
        <figure className="agent-tool__chart" key={chart.title}>
          <figcaption>{chart.title} ({chart.units})</figcaption>
          {chart.kind === 'bar' ? chart.points.map((point) => (
            <div className="agent-tool__chart-row" key={point.label}>
              <span>{point.label}</span>
              <meter min={0} max={Math.max(...chart.points.map((item) => item.value)) || 1} value={point.value} aria-label={`${point.label}: ${point.value} ${chart.units}`} />
              <span>{point.value.toLocaleString()}</span>
            </div>
          )) : <LineChart chart={chart} />}
        </figure>
      ))}
      {part.output !== undefined && (charts.length
        ? <details className="agent-tool__data"><summary>Data and details</summary><pre className="agent-tool__json agent-tool__output">{pretty(part.output)}</pre></details>
        : <pre className="agent-tool__json agent-tool__output">{pretty(part.output)}</pre>)}
    </details>
  )
}

function resultCharts(output: unknown): Array<ComparisonChart | SeriesChart> {
  if (!output || typeof output !== 'object' || !('charts' in output) || !Array.isArray(output.charts)) return []
  return output.charts.filter((chart): chart is ComparisonChart | SeriesChart =>
    chart && typeof chart === 'object' && typeof chart.title === 'string' && typeof chart.units === 'string' &&
    (chart.kind === 'bar' || chart.kind === 'line') &&
    Array.isArray(chart.points) && chart.points.length >= (chart.kind === 'bar' ? 2 : 1) &&
    chart.points.length <= (chart.kind === 'bar' ? 6 : 48) &&
    chart.points.every((point: unknown) =>
      point && typeof point === 'object' && 'label' in point && typeof point.label === 'string' &&
      'value' in point && typeof point.value === 'number' && Number.isFinite(point.value) &&
      (chart.kind !== 'bar' || point.value >= 0)),
  )
}

function LineChart({ chart }: { chart: SeriesChart }): React.JSX.Element {
  const values = chart.points.map((point) => point.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const position = (index: number, value: number): [number, number] => [
    chart.points.length === 1 ? 150 : 5 + index * 290 / (chart.points.length - 1),
    min === max ? 50 : 95 - (value - min) * 90 / (max - min),
  ]
  const positions = chart.points.map((point, index) => position(index, point.value))
  return (
    <>
      <svg className="agent-tool__line-chart" viewBox="0 0 300 100" role="img"
        aria-label={`${chart.title}: ${chart.points.length} equally spaced points, from ${min} to ${max} ${chart.units}`}>
        <polyline points={positions.map(([x, y]) => `${x},${y}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="2" />
        {positions.length === 1 && <circle cx={positions[0]![0]} cy={positions[0]![1]} r="3" fill="currentColor" />}
      </svg>
      <div className="agent-tool__chart-axis">
        <span>{chart.points[0]!.label}</span>
        <span>{min}–{max} {chart.units}</span>
        <span>{chart.points[chart.points.length - 1]!.label}</span>
      </div>
      <div>Points are equally spaced; see Data and details for values.</div>
    </>
  )
}

function brief(value: unknown): string {
  if (value === undefined || (typeof value === 'object' && value !== null && Object.keys(value).length === 0)) return ''
  const text = JSON.stringify(value)
  return text.length > 90 ? `${text.slice(0, 90)}…` : text
}

function firstLine(code: string): string {
  const line = code.trim().split('\n')[0] ?? ''
  return line.length > 70 ? `${line.slice(0, 70)}…` : line
}

function pretty(value: unknown): string {
  if (typeof value === 'string') return value
  const text = JSON.stringify(value, null, 2) ?? ''
  return text.length > 20_000 ? `${text.slice(0, 20_000)}\n…` : text
}

/** Enough Markdown for chat: fenced code, inline code, bold, headings and lists — as React nodes, never HTML. */
function Markdown({ text }: { text: string }): React.JSX.Element {
  const blocks = text.split(/^```[^\n]*\n?/m)
  return (
    <div className="agent-md">
      {blocks.map((block, i) =>
        i % 2 === 1 ? (
          <pre key={i} className="agent-md__code">
            {block.replace(/\n$/, '')}
          </pre>
        ) : (
          <Prose key={i} text={block} />
        ),
      )}
    </div>
  )
}

function Prose({ text }: { text: string }): React.JSX.Element | null {
  const lines = text.replace(/^\n+|\n+$/g, '')
  if (!lines) return null
  return (
    <>
      {lines.split(/\n{2,}/).map((para, i) => {
        const rows = para.split('\n')
        if (rows.every((r) => /^\s*([-*]|\d+\.)\s/.test(r))) {
          const ordered = /^\s*\d+\./.test(rows[0]!)
          const items = rows.map((r, j) => <li key={j}>{inline(r.replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>)
          return ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>
        }
        const heading = /^(#{1,4})\s+(.*)$/.exec(para)
        if (heading && rows.length === 1) return <p key={i} className="agent-md__heading">{inline(heading[2]!)}</p>
        return (
          <p key={i}>
            {rows.map((r, j) => (
              <span key={j}>
                {j > 0 && <br />}
                {inline(r)}
              </span>
            ))}
          </p>
        )
      })}
    </>
  )
}

function inline(text: string): React.ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((piece, i) => {
    if (piece.startsWith('`') && piece.endsWith('`') && piece.length > 1) return <code key={i}>{piece.slice(1, -1)}</code>
    if (piece.startsWith('**') && piece.endsWith('**') && piece.length > 3) return <strong key={i}>{piece.slice(2, -2)}</strong>
    return piece
  })
}
