/**
 * Agent chat state: the conversation, tool calls as they run, edits waiting for approval, and the
 * provider settings. Lives in App so the conversation survives switching ribbon tabs. The app is
 * reached through `bridge`, a ref App refreshes every render, so tools always see the current
 * document and simulation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ModelMessage, ToolSet } from 'ai'
import type { AgentEvent } from '../agent/loop.js'
import { buildInstructions, type AgentContext } from '../agent/prompt.js'
import { loadSettings, saveSettings, settingsProblem, type AgentSettings } from '../agent/settings.js'
import type { AgentHost, ApprovalRequest } from '../agent/tools.js'
import { ModelSession } from '../mcp/session.js'

type Runtime = typeof import('../agent/runtime.js')
let runtime: Promise<Runtime> | undefined
/** The AI SDK, loaded on the first message rather than with the app. */
function loadRuntime(): Promise<Runtime> {
  runtime ??= import('../agent/runtime.js').catch((error: unknown) => {
    runtime = undefined
    throw error
  })
  return runtime
}

/** What App provides; everything but approvals and edit mode, which the hook owns. */
export interface AgentBridge extends Omit<AgentHost, 'approve' | 'editMode'> {
  context(): Omit<AgentContext, 'editMode'>
}

export interface ToolPart {
  type: 'tool'
  id: string
  name: string
  input: unknown
  state: 'running' | 'done' | 'error'
  output?: unknown
  error?: string
}

export type AssistantPart = { type: 'text'; text: string } | { type: 'reasoning'; text: string } | ToolPart

export type ChatItem =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'assistant'; parts: AssistantPart[] }
  | { id: number; role: 'error'; text: string }
  | { id: number; role: 'notice'; text: string }

type NewItem = ChatItem extends infer T ? (T extends ChatItem ? Omit<T, 'id'> : never) : never

export interface Agent {
  settings: AgentSettings
  updateSettings(patch: Partial<AgentSettings>): void
  /** Why a message cannot be sent yet, if it cannot. */
  problem: string | undefined
  items: ChatItem[]
  running: boolean
  /** Edits waiting for the user, by tool call id. */
  approvals: Record<string, ApprovalRequest>
  send(text: string): void
  stop(): void
  newChat(): void
  decide(toolCallId: string, approved: boolean): void
}

export function useAgent(bridge: React.RefObject<AgentBridge>): Agent {
  const [settings, setSettings] = useState<AgentSettings>(loadSettings)
  const [items, setItems] = useState<ChatItem[]>([])
  const [running, setRunning] = useState(false)
  const [approvals, setApprovals] = useState<Record<string, ApprovalRequest>>({})

  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const history = useRef<ModelMessage[]>([])
  const abort = useRef<AbortController | undefined>(undefined)
  const resolvers = useRef(new Map<string, (approved: boolean) => void>())
  const nextId = useRef(1)
  // Bumped by New chat, so a turn still finishing does not write into the new conversation.
  const generation = useRef(0)
  const session = useMemo(() => new ModelSession(), [])

  useEffect(() => saveSettings(settings), [settings])

  const updateSettings = useCallback((patch: Partial<AgentSettings>) => setSettings((s) => ({ ...s, ...patch })), [])

  const decide = useCallback((toolCallId: string, approved: boolean) => resolvers.current.get(toolCallId)?.(approved), [])

  const host = useMemo<AgentHost>(
    () => ({
      document: () => bridge.current.document(),
      afterEdit: () => bridge.current.afterEdit(),
      runPython: (code) => bridge.current.runPython(code),
      runSimulation: () => bridge.current.runSimulation(),
      queryResults: (sql, params) => bridge.current.queryResults(sql, params),
      outputText: (name) => bridge.current.outputText(name),
      useWeather: (id) => bridge.current.useWeather(id),
      lastDesignConditions: () => bridge.current.lastDesignConditions(),
      editMode: () => settingsRef.current.editMode,
      approve: (request, signal) =>
        new Promise<boolean>((resolve) => {
          if (signal?.aborted) return resolve(false)
          const done = (approved: boolean): void => {
            resolvers.current.delete(request.toolCallId)
            signal?.removeEventListener('abort', onAbort)
            setApprovals(({ [request.toolCallId]: _, ...rest }) => rest)
            resolve(approved)
          }
          const onAbort = (): void => done(false)
          signal?.addEventListener('abort', onAbort)
          resolvers.current.set(request.toolCallId, done)
          setApprovals((a) => ({ ...a, [request.toolCallId]: request }))
        }),
    }),
    [bridge],
  )
  const tools = useRef<ToolSet | undefined>(undefined)

  const push = useCallback((item: NewItem) => {
    setItems((list) => [...list, { ...item, id: nextId.current++ } as ChatItem])
  }, [])

  /** Apply an event to the assistant message being streamed (the last item). */
  const apply = useCallback((event: AgentEvent) => {
    setItems((list) => {
      const last = list[list.length - 1]
      if (last?.role !== 'assistant') return list
      const parts = [...last.parts]
      const tail = parts[parts.length - 1]
      switch (event.type) {
        case 'text':
        case 'reasoning':
          if (tail?.type === event.type) parts[parts.length - 1] = { ...tail, text: tail.text + event.text }
          else parts.push({ type: event.type, text: event.text })
          break
        case 'tool-call':
          parts.push({ type: 'tool', id: event.id, name: event.name, input: event.input, state: 'running' })
          break
        case 'tool-result':
        case 'tool-error': {
          const i = parts.findIndex((p) => p.type === 'tool' && p.id === event.id)
          if (i < 0) break
          const part = parts[i] as ToolPart
          parts[i] =
            event.type === 'tool-result'
              ? { ...part, state: 'done', output: event.output }
              : { ...part, state: 'error', error: event.error }
          break
        }
      }
      return [...list.slice(0, -1), { ...last, parts }]
    })
  }, [])

  const send = useCallback(
    (text: string) => {
      const prompt = text.trim()
      if (!prompt || abort.current) return
      const problem = settingsProblem(settingsRef.current)
      if (problem) {
        push({ role: 'error', text: problem })
        return
      }
      const user: ModelMessage = { role: 'user', content: prompt }
      push({ role: 'user', text: prompt })
      push({ role: 'assistant', parts: [] })
      const controller = new AbortController()
      abort.current = controller
      const turn = generation.current
      setRunning(true)
      const instructions = buildInstructions({ ...bridge.current.context(), editMode: settingsRef.current.editMode })
      const finish = (): void => {
        setItems((list) => list.filter((item) => item.role !== 'assistant' || item.parts.length > 0))
        abort.current = undefined
        setRunning(false)
      }
      void (async () => {
        try {
          const rt = await loadRuntime()
          tools.current ??= rt.createAgentTools(host, session)
          const r = await rt.runAgentTurn({
            model: rt.createLanguageModel(settingsRef.current),
            instructions,
            messages: [...history.current, user],
            tools: tools.current,
            signal: controller.signal,
            onEvent: apply,
          })
          if (turn !== generation.current) return
          // Keep the user's message even when the reply failed, so the next turn has the context.
          history.current = rt.completeToolCalls([...history.current, user, ...r.messages])
          if (r.aborted) push({ role: 'notice', text: 'Stopped.' })
          else if (r.error) push({ role: 'error', text: r.error })
          finish()
        } catch (e) {
          if (turn !== generation.current) return
          push({ role: 'error', text: e instanceof Error ? e.message : String(e) })
          finish()
        }
      })()
    },
    [apply, bridge, host, push, session],
  )

  const stop = useCallback(() => abort.current?.abort(), [])

  const newChat = useCallback(() => {
    generation.current++
    abort.current?.abort()
    abort.current = undefined
    setRunning(false)
    history.current = []
    setItems([])
  }, [])

  return {
    settings,
    updateSettings,
    problem: settingsProblem(settings),
    items,
    running,
    approvals,
    send,
    stop,
    newChat,
    decide,
  }
}
