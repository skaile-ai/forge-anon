// AI SDK binding: a session store keyed by chat/session id and a language-model middleware that sends the model
// placeholders only and restores the originals in its answer. Needs `ai` ^7 and `@ai-sdk/provider` (types only).

import type {
  LanguageModelV4Content,
  LanguageModelV4Message,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolResultOutput
} from '@ai-sdk/provider'
import type { LanguageModelMiddleware } from 'ai'
import type { AnonConfig } from './config.ts'
import { createAnonSession } from './session.ts'
import type { AnonSession } from './session.ts'

// ---------------------------------------------------------------------------
// session store

export type AnonSessionStoreOptions = {
  config: AnonConfig
  /** A session untouched for longer than this is dropped on the next `get`/`evictIdle`. Default one hour. */
  idleTtlMs?: number
  /** Passed to every session: Markdown-aware protection. Default `true`. */
  markdown?: boolean
  /** Passed to every session: patterns that are never anonymized (e.g. `BLOCK_ID_PATTERN`). */
  protect?: readonly RegExp[]
}

export type AnonSessionStore = {
  /** The session of `id`, created on first use; touches it (and first drops every idle one) as of `now`. */
  get(id: string, now?: number): AnonSession
  drop(id: string): void
  has(id: string): boolean
  /** Drops every session idle longer than the TTL as of `now`. */
  evictIdle(now: number): void
}

export const DEFAULT_IDLE_TTL_MS = 60 * 60 * 1000

/** Mappings of many conversations, memory only: the placeholder↔original pairs never touch the disk. */
export function createAnonSessionStore(options: AnonSessionStoreOptions): AnonSessionStore {
  const ttl = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
  const sessions = new Map<string, { session: AnonSession; touched: number }>()

  function evictIdle(now: number): void {
    for (const [id, slot] of sessions) if (now - slot.touched > ttl) sessions.delete(id)
  }

  return {
    get(id, now = Date.now()) {
      evictIdle(now)
      let slot = sessions.get(id)
      if (!slot) {
        slot = {
          session: createAnonSession({ config: options.config, markdown: options.markdown ?? true, protect: options.protect }),
          touched: now
        }
        sessions.set(id, slot)
      }
      slot.touched = now
      return slot.session
    },
    drop: id => void sessions.delete(id),
    has: id => sessions.has(id),
    evictIdle
  }
}

// ---------------------------------------------------------------------------
// JSON helpers

type MapString = (text: string) => string | Promise<string>

/** `value` with every string leaf (not object keys) replaced by `fn`; objects and arrays are rebuilt, other values kept. Leaves run one after another. */
async function mapStrings(value: unknown, fn: MapString): Promise<unknown> {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) out.push(await mapStrings(item, fn))
    return out
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = await mapStrings(item, fn)
    return out
  }
  return value
}

/** `value` with every string leaf anonymized with `session` (keys stay); the session mapping grows with each new original. */
export function anonymizeJson(session: AnonSession, value: unknown): Promise<unknown> {
  return mapStrings(value, text => anonymizeText(session, text))
}

/** `value` with every string leaf restored (lenient) with `session`; keys stay. */
export function restoreJson(session: AnonSession, value: unknown): unknown {
  if (typeof value === 'string') return session.restore(value)
  if (Array.isArray(value)) return value.map(item => restoreJson(session, item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restoreJson(session, item)]))
  }
  return value
}

async function anonymizeText(session: AnonSession, text: string): Promise<string> {
  return text.trim() === '' ? text : (await session.anonymize(text)).text
}

// ---------------------------------------------------------------------------
// middleware

/** A tool result's output with its text/JSON payload mapped; a denial's optional reason is text too. */
async function mapOutput(output: LanguageModelV4ToolResultOutput, fn: MapString): Promise<LanguageModelV4ToolResultOutput> {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return { ...output, value: await fn(output.value) }
    case 'json':
    case 'error-json':
      return { ...output, value: (await mapStrings(output.value, fn)) as typeof output.value }
    case 'execution-denied':
      return output.reason === undefined ? output : { ...output, reason: await fn(output.reason) }
    case 'content': {
      const value = []
      for (const part of output.value) value.push(part.type === 'text' ? { ...part, text: await fn(part.text) } : part)
      return { ...output, value }
    }
    default:
      return output
  }
}

async function anonymizeMessage(message: LanguageModelV4Message, fn: MapString): Promise<LanguageModelV4Message> {
  switch (message.role) {
    case 'system':
      return message
    case 'user': {
      const content = []
      for (const part of message.content) content.push(part.type === 'text' ? { ...part, text: await fn(part.text) } : part)
      return { ...message, content }
    }
    case 'assistant': {
      const content = []
      for (const part of message.content) {
        if (part.type === 'text' || part.type === 'reasoning') content.push({ ...part, text: await fn(part.text) })
        else if (part.type === 'tool-call') content.push({ ...part, input: await mapStrings(part.input, fn) })
        else if (part.type === 'tool-result') content.push({ ...part, output: await mapOutput(part.output, fn) })
        else content.push(part)
      }
      return { ...message, content }
    }
    case 'tool': {
      const content = []
      for (const part of message.content) {
        content.push(part.type === 'tool-result' ? { ...part, output: await mapOutput(part.output, fn) } : part)
      }
      return { ...message, content }
    }
  }
}

/**
 * The input JSON of a tool call with every string leaf restored (lenient). Parsing first matters: substituting
 * into the raw JSON text would break it when an original contains `"` or `\`. Unparsable input is restored as plain text.
 */
function restoreToolInput(session: AnonSession, input: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    return session.restore(input)
  }
  return JSON.stringify(restoreJson(session, parsed))
}

function restoreContent(session: AnonSession, part: LanguageModelV4Content): LanguageModelV4Content {
  if (part.type === 'text') return { ...part, text: session.restore(part.text) }
  if (part.type === 'tool-call') return { ...part, input: restoreToolInput(session, part.input) }
  return part
}

export type AnonMiddlewareOptions = {
  /** The app-owned system prompt, sent as the first system message (host system messages in the prompt follow unchanged). Say there that placeholders stand for real values and must be copied verbatim. */
  system: string
  /** The current document; anonymized and appended to `system` inside `<document>` tags. Empty or absent: no block. */
  document?: string
  /** Line above the document block. Default `'Das aktuelle Dokument des Nutzers:'`. */
  documentLabel?: string
}

const DEFAULT_DOCUMENT_LABEL = 'Das aktuelle Dokument des Nutzers:'

/**
 * Anonymizes every string the prompt carries (user/assistant text, assistant tool-call input leaf by leaf, tool results)
 * and restores placeholders in the answer: streamed text incrementally (a placeholder can straddle deltas, so the
 * restorer buffers a partial `<...` until it closes) and tool calls as parsed JSON. `tool-input-delta` parts pass
 * through untouched: consumers act on the finished `tool-call` part. Fail closed: when anonymizing throws, the
 * model is never called.
 */
export function anonLanguageModelMiddleware(session: AnonSession, options: AnonMiddlewareOptions): LanguageModelMiddleware {
  const fn: MapString = text => anonymizeText(session, text)

  async function anonymizePrompt(prompt: LanguageModelV4Prompt): Promise<LanguageModelV4Prompt> {
    const document = options.document?.trim() ? await fn(options.document) : ''
    const label = options.documentLabel ?? DEFAULT_DOCUMENT_LABEL
    const system = document ? `${options.system}\n\n${label}\n\n<document>\n${document}\n</document>` : options.system
    const out: LanguageModelV4Prompt = [{ role: 'system', content: system }]
    for (const message of prompt) out.push(await anonymizeMessage(message, fn))
    return out
  }

  return {
    async transformParams({ params }) {
      return { ...params, prompt: await anonymizePrompt(params.prompt) }
    },
    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate()
      return { ...result, content: result.content.map(part => restoreContent(session, part)) }
    },
    async wrapStream({ doStream }) {
      const { stream, ...rest } = await doStream()
      const restorer = session.streamRestorer()
      const transform = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
        transform(part, controller) {
          if (part.type === 'text-delta') {
            const delta = restorer.push(part.delta)
            if (delta) controller.enqueue({ ...part, delta })
            return
          }
          if (part.type === 'text-end') {
            const tail = restorer.flush()
            if (tail) controller.enqueue({ type: 'text-delta', id: part.id, delta: tail })
          }
          if (part.type === 'tool-call') {
            controller.enqueue({ ...part, input: restoreToolInput(session, part.input) })
            return
          }
          controller.enqueue(part)
        }
      })
      return { stream: stream.pipeThrough(transform), ...rest }
    }
  }
}
