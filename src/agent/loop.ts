/**
 * One agent turn: stream the model's reply, run the tools it calls, and loop until it answers
 * without a tool call (or the step budget runs out). Kept free of React so it can be tested with
 * the AI SDK's mock models; `useAgent` renders the events it emits.
 */
import { isStepCount, streamText, type LanguageModel, type ModelMessage, type ToolSet } from 'ai'

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'tool-result'; id: string; output: unknown }
  | { type: 'tool-error'; id: string; error: string }

export interface TurnOptions {
  model: LanguageModel
  instructions: string
  /** The conversation so far, ending with the user's new message. */
  messages: ModelMessage[]
  tools: ToolSet
  signal?: AbortSignal | undefined
  /** Model calls per turn; each tool round trip is one. */
  maxSteps?: number
  onEvent: (event: AgentEvent) => void
}

export interface TurnResult {
  /** Assistant and tool messages to append to the conversation. */
  messages: ModelMessage[]
  error?: string
  aborted?: boolean
}

export const MAX_STEPS = 24

export function errorText(error: unknown): string {
  if (error instanceof Error) {
    const body = (error as { responseBody?: unknown }).responseBody
    if (typeof body === 'string' && body.trim()) {
      try {
        const parsed = JSON.parse(body) as { error?: { message?: string } | string }
        const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message
        if (message) return `${error.message}: ${message}`
      } catch {
        // Not JSON; the message alone will do.
      }
    }
    return error.message
  }
  return typeof error === 'string' ? error : JSON.stringify(error)
}

export async function runAgentTurn(o: TurnOptions): Promise<TurnResult> {
  let error: string | undefined
  let aborted = false
  const result = streamText({
    model: o.model,
    instructions: o.instructions,
    messages: o.messages,
    tools: o.tools,
    stopWhen: isStepCount(o.maxSteps ?? MAX_STEPS),
    ...(o.signal ? { abortSignal: o.signal } : {}),
    // Errors arrive as stream parts below; the default handler would only log them.
    onError: () => {},
  })

  try {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          o.onEvent({ type: 'text', text: part.text })
          break
        case 'reasoning-delta':
          o.onEvent({ type: 'reasoning', text: part.text })
          break
        case 'tool-call':
          o.onEvent({ type: 'tool-call', id: part.toolCallId, name: part.toolName, input: part.input })
          break
        case 'tool-result':
          o.onEvent({ type: 'tool-result', id: part.toolCallId, output: part.output })
          break
        case 'tool-error':
          o.onEvent({ type: 'tool-error', id: part.toolCallId, error: errorText(part.error) })
          break
        case 'error':
          error = errorText(part.error)
          break
        case 'abort':
          aborted = true
          break
      }
    }
  } catch (e) {
    if (o.signal?.aborted) aborted = true
    else error = errorText(e)
  }

  let messages: ModelMessage[] = []
  try {
    messages = (await result.responseMessages) as ModelMessage[]
  } catch {
    // An aborted or failed turn may have no messages to keep.
  }
  return { messages, ...(error !== undefined ? { error } : {}), ...(aborted ? { aborted } : {}) }
}

/**
 * Drop tool calls that never got a result — a turn stopped mid-step leaves them — since providers
 * reject a conversation in which a tool call goes unanswered.
 */
export function completeToolCalls(messages: ModelMessage[]): ModelMessage[] {
  const answered = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'tool') continue
    for (const part of m.content) if (part.type === 'tool-result') answered.add(part.toolCallId)
  }
  const out: ModelMessage[] = []
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') {
      out.push(m)
      continue
    }
    const content = m.content.filter((part) => part.type !== 'tool-call' || answered.has(part.toolCallId))
    if (content.length > 0) out.push({ ...m, content })
  }
  return out
}
