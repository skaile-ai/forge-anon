import { describe, expect, test } from 'bun:test'
import type { LanguageModelV4, LanguageModelV4Prompt, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { wrapLanguageModel } from 'ai'
import type { LanguageModelMiddleware } from 'ai'
import { anonLanguageModelMiddleware, anonymizeJson, createAnonSessionStore, DEFAULT_IDLE_TTL_MS, restoreJson } from '../src/ai-sdk.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'
import type { AnonConfig } from '../src/config.ts'
import { regexDetector } from '../src/detectors/regex.ts'
import type { Detector } from '../src/detectors/types.ts'
import { BLOCK_ID_PATTERN } from '../src/markdown.ts'
import { createAnonSession } from '../src/session.ts'
import type { EntityKind, Span } from '../src/types.ts'

// Ausschließlich erfundene Daten.

/** Regex detectors only: no model download, deterministic. */
function config(): AnonConfig {
  const c = structuredClone(DEFAULT_CONFIG)
  c.detectors.onnx.enabled = false
  c.detectors.llm.enabled = false
  c.detectors.rules.enabled = false
  return c
}

/** Detector that proposes one span per occurrence of each needle. */
function needles(list: { text: string; kind: EntityKind }[]): Detector {
  return {
    name: 'onnx',
    async detect(text) {
      const spans: Span[] = []
      for (const n of list) {
        for (let i = text.indexOf(n.text); i >= 0; i = text.indexOf(n.text, i + n.text.length)) {
          spans.push({ start: i, end: i + n.text.length, text: n.text, kind: n.kind, score: 0.9, detector: 'onnx' })
        }
      }
      return spans
    }
  }
}

const SYSTEM = 'Du bist ein Assistent. Platzhalter stehen für echte Werte.'
const DOCUMENT = 'Termin am 12.03.1970, Rückruf unter 089 1234567 oder max@example.org.'
const ORIGINALS = ['12.03.1970', '089 1234567', 'max@example.org']

/** A session that also recognises the surname after "Herr" (regex salutation rule). */
const newSession = () => createAnonSession({ config: config(), markdown: true })

function promptText(prompt: LanguageModelV4Prompt): string {
  return JSON.stringify(prompt)
}

function textStream(chunks: string[]): ReadableStream<LanguageModelV4StreamPart> {
  return partsStream([
    { type: 'text-start', id: 't' },
    ...chunks.map(delta => ({ type: 'text-delta' as const, id: 't', delta })),
    { type: 'text-end', id: 't' }
  ])
}

function partsStream(parts: unknown[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part as LanguageModelV4StreamPart)
      controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: {} as never })
      controller.close()
    }
  })
}

async function drain(s: ReadableStream<LanguageModelV4StreamPart>): Promise<LanguageModelV4StreamPart[]> {
  const out: LanguageModelV4StreamPart[] = []
  for await (const part of s) out.push(part)
  return out
}

async function streamed(mw: LanguageModelMiddleware, parts: ReadableStream<LanguageModelV4StreamPart>) {
  const { stream } = await mw.wrapStream!({
    doStream: async () => ({ stream: parts }),
    doGenerate: async () => ({}) as never,
    params: {} as never,
    model: {} as never
  })
  return drain(stream)
}

const transform = (mw: LanguageModelMiddleware, prompt: unknown[]) =>
  mw.transformParams!({ params: { prompt } as never, type: 'stream', model: {} as never })

describe('anonLanguageModelMiddleware', () => {
  test('no original of the document or the question reaches the model', async () => {
    const session = newSession()
    const mw = anonLanguageModelMiddleware(session, { system: SYSTEM, document: DOCUMENT })
    const out = await transform(mw, [
      { role: 'user', content: [{ type: 'text', text: 'Wann ist der Termin am 12.03.1970 und wie lautet die Nummer 089 1234567?' }] }
    ])
    const sent = promptText(out.prompt)
    for (const original of ORIGINALS) expect(sent).not.toContain(original)
    expect(sent).toContain('<document>')
    expect(sent).toContain('Das aktuelle Dokument des Nutzers:')
    expect(out.prompt[0]).toMatchObject({ role: 'system' })
    expect((out.prompt[0] as { content: string }).content).toStartWith(SYSTEM)
    // One placeholder per original, shared between document and question.
    const date = session.entities.find(e => e.original === '12.03.1970')!
    expect(sent.split(date.placeholder).length - 1).toBe(2)
  })

  test('without a document there is only the system prompt; the label is configurable', async () => {
    const plain = await transform(anonLanguageModelMiddleware(newSession(), { system: SYSTEM, document: '  ' }), [])
    expect(plain.prompt).toEqual([{ role: 'system', content: SYSTEM }])
    const labelled = await transform(anonLanguageModelMiddleware(newSession(), { system: SYSTEM, document: 'Text', documentLabel: 'Dokument:' }), [])
    expect((labelled.prompt[0] as { content: string }).content).toBe(`${SYSTEM}\n\nDokument:\n\n<document>\nText\n</document>`)
  })

  test('placeholders split across stream deltas are restored, and a mangled one leniently', async () => {
    const session = newSession()
    await session.anonymize(DOCUMENT)
    const [date, phone] = ORIGINALS.map(o => session.entities.find(e => e.original === o)!)
    const answer = `Der Termin ist am ${date!.placeholder}, Rückruf ${phone!.placeholder.slice(1, -1)}.`
    const cut = answer.indexOf('_') + 3 // inside the first placeholder's random part
    const parts = await streamed(
      anonLanguageModelMiddleware(session, { system: SYSTEM }),
      textStream([answer.slice(0, cut), answer.slice(cut, cut + 1), answer.slice(cut + 1)])
    )
    const text = parts.flatMap(p => (p.type === 'text-delta' ? [p.delta] : [])).join('')
    expect(text).toBe('Der Termin ist am 12.03.1970, Rückruf 089 1234567.')
  })

  test('fail closed: a failing anonymize rejects transformParams and the model is never called', async () => {
    const real = newSession()
    const failing = new Proxy(real, {
      get: (target, key) =>
        key === 'anonymize'
          ? async () => {
              throw new Error('detector down')
            }
          : Reflect.get(target, key)
    })
    const mw = anonLanguageModelMiddleware(failing, { system: SYSTEM, document: DOCUMENT })
    const params = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'Rückruf unter 089 1234567?' }] }] } as never
    await expect(mw.transformParams!({ params, type: 'stream', model: {} as never })).rejects.toThrow('detector down')

    // Through the real wrapper: transformParams runs before doStream, so a throw there means the model never sees the prompt.
    let doStreamCalls = 0
    const spy = {
      specificationVersion: 'v4',
      provider: 'spy',
      modelId: 'spy',
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error('unexpected doGenerate')
      },
      doStream: async () => {
        doStreamCalls++
        return { stream: textStream(['x']) }
      }
    } as unknown as LanguageModelV4
    await expect(wrapLanguageModel({ model: spy, middleware: mw }).doStream(params)).rejects.toThrow('detector down')
    expect(doStreamCalls).toBe(0)
  })

  test('host system messages pass through unchanged, after the injected system block', async () => {
    const system = { role: 'system', content: 'Regel für 12.03.1970' }
    const user = { role: 'user', content: [{ type: 'text', text: 'Mail an max@example.org' }] }
    const out = await transform(anonLanguageModelMiddleware(newSession(), { system: SYSTEM }), [system, user])
    expect(out.prompt).toHaveLength(3)
    expect(out.prompt[0]).toEqual({ role: 'system', content: SYSTEM })
    expect(out.prompt[1]).toEqual(system as never)
    expect(promptText([out.prompt[2]!])).not.toContain('max@example.org')
  })

  test('tool results are anonymized: text, json (nested leaves), error-text; non-strings stay', async () => {
    const session = newSession()
    const result = (output: unknown) => ({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'doc.read', output }]
    })
    const out = await transform(anonLanguageModelMiddleware(session, { system: SYSTEM }), [
      result({ type: 'text', value: 'Rückruf 089 1234567' }),
      result({ type: 'json', value: { text: 'Mail an max@example.org', n: 3, ok: true, nested: [{ d: 'geboren am 12.03.1970' }] } }),
      result({ type: 'error-text', value: 'Fehler bei 12.03.1970' })
    ])
    const sent = promptText(out.prompt)
    for (const original of ORIGINALS) expect(sent).not.toContain(original)
    const message = out.prompt[2]
    if (message?.role !== 'tool') throw new Error('expected a tool message')
    const part = message.content[0]
    if (part?.type !== 'tool-result' || part.output.type !== 'json') throw new Error('expected a json tool result')
    const json = part.output.value as { text: string; n: number; ok: boolean }
    expect(json.text).toMatch(/^Mail an <[A-Z_]+_[0-9a-f]+>$/)
    expect(json.n).toBe(3)
    expect(json.ok).toBe(true)
  })

  test('assistant tool-call input is anonymized leaf by leaf; keys and non-strings stay', async () => {
    const session = newSession()
    const input = { ops: [{ type: 'update', id: 'b1', markdown: 'Rückruf 089 1234567', n: 2 }], note: 'am 12.03.1970' }
    const out = await transform(anonLanguageModelMiddleware(session, { system: SYSTEM }), [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'doc.propose_ops', input }] }
    ])
    const sent = promptText(out.prompt)
    expect(sent).not.toContain('089 1234567')
    expect(sent).not.toContain('12.03.1970')
    const sentInput = (out.prompt[1] as { content: { input: typeof input }[] }).content[0]!.input
    expect(Object.keys(sentInput)).toEqual(['ops', 'note'])
    expect(sentInput.ops[0]).toMatchObject({ type: 'update', id: 'b1', n: 2 })
    expect(restoreJson(session, sentInput)).toEqual(input)
  })

  test('a tool-call with a placeholder in its JSON input reaches the client restored, as valid JSON', async () => {
    const session = newSession()
    await session.anonymize(DOCUMENT)
    const date = session.entities.find(e => e.original === '12.03.1970')!
    const input = JSON.stringify({ ops: [{ type: 'update', id: 'b1', markdown: `Termin am ${date.placeholder}` }] })
    const parts = await streamed(
      anonLanguageModelMiddleware(session, { system: SYSTEM }),
      partsStream([
        { type: 'tool-input-start', id: 'c1', toolName: 'doc.propose_ops' },
        { type: 'tool-input-delta', id: 'c1', delta: input.slice(0, 30) },
        { type: 'tool-input-delta', id: 'c1', delta: input.slice(30) },
        { type: 'tool-input-end', id: 'c1' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'doc.propose_ops', input }
      ])
    )
    const call = parts.find(p => p.type === 'tool-call') as { input: string }
    expect(JSON.parse(call.input)).toEqual({ ops: [{ type: 'update', id: 'b1', markdown: 'Termin am 12.03.1970' }] })
    // tool-input-delta is not rewritten
    expect(parts.filter(p => p.type === 'tool-input-delta').map(p => (p as { delta: string }).delta).join('')).toBe(input)
  })

  test('tool-call input stays valid JSON when an original contains a quote or a backslash', async () => {
    const original = 'Max "Mäx" C:\\Pfad'
    const session = createAnonSession({ config: config(), detectors: [needles([{ text: original, kind: 'NAME_EXT' }])] })
    const anonymized = await session.anonymize(`Name: ${original}`)
    const placeholder = session.entities[0]!.placeholder
    expect(anonymized.text).toBe(`Name: ${placeholder}`)

    const input = JSON.stringify({ markdown: `Hallo ${placeholder}!` })
    const parts = await streamed(
      anonLanguageModelMiddleware(session, { system: SYSTEM }),
      partsStream([{ type: 'tool-call', toolCallId: 'c1', toolName: 'doc.propose_ops', input }])
    )
    const call = parts.find(p => p.type === 'tool-call') as { input: string }
    expect(JSON.parse(call.input)).toEqual({ markdown: `Hallo ${original}!` })

    // Unparsable input is restored as plain text rather than dropped.
    const raw = await streamed(
      anonLanguageModelMiddleware(session, { system: SYSTEM }),
      partsStream([{ type: 'tool-call', toolCallId: 'c2', toolName: 'x', input: `{broken ${placeholder}` }])
    )
    expect((raw.find(p => p.type === 'tool-call') as { input: string }).input).toBe(`{broken ${original}`)
  })

  test('wrapGenerate restores text and tool-call input', async () => {
    const session = newSession()
    await session.anonymize(DOCUMENT)
    const date = session.entities.find(e => e.original === '12.03.1970')!
    const mw = anonLanguageModelMiddleware(session, { system: SYSTEM })
    const result = await mw.wrapGenerate!({
      doGenerate: async () =>
        ({
          content: [
            { type: 'text', text: `Am ${date.placeholder}` },
            { type: 'tool-call', toolCallId: 'c1', toolName: 'x', input: JSON.stringify({ d: date.placeholder }) }
          ],
          finishReason: { unified: 'stop', raw: undefined },
          usage: {},
          warnings: []
        }) as never,
      doStream: async () => ({}) as never,
      params: {} as never,
      model: {} as never
    })
    expect(result.content[0]).toMatchObject({ text: 'Am 12.03.1970' })
    expect(JSON.parse((result.content[1] as { input: string }).input)).toEqual({ d: '12.03.1970' })
  })

  test('protected patterns reach the model verbatim (block ids), names do not', async () => {
    const uuid = '3b241101-e2bb-4255-8caf-4136c566a962'
    const session = createAnonSession({
      config: config(),
      protect: [BLOCK_ID_PATTERN],
      detectors: [regexDetector(), needles([{ text: uuid, kind: 'ID' }, { text: 'Mustermann', kind: 'NAME_EXT' }])]
    })
    const out = await transform(anonLanguageModelMiddleware(session, { system: SYSTEM, document: `[${uuid}] Herr Mustermann` }), [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'x', input: { id: uuid, md: 'Herr Mustermann' } }] }
    ])
    const sent = promptText(out.prompt)
    expect(sent).toContain(uuid)
    expect(sent).not.toContain('Mustermann')
  })
})

describe('anonymizeJson / restoreJson', () => {
  test('round trip over nested values; keys, numbers, booleans and null stay', async () => {
    const session = newSession()
    const value = { 'max@example.org': 'Mail max@example.org', list: ['am 12.03.1970', 7, null, false], deep: { a: { b: 'x' } } }
    const anonymized = (await anonymizeJson(session, value)) as typeof value
    expect(JSON.stringify(anonymized)).not.toContain('12.03.1970')
    expect(anonymized['max@example.org']).not.toContain('max@example.org')
    expect(anonymized.list.slice(1)).toEqual([7, null, false])
    expect(restoreJson(session, anonymized)).toEqual(value)
  })
})

describe('createAnonSessionStore', () => {
  test('get creates once per id; has/drop; sessions are independent', async () => {
    const store = createAnonSessionStore({ config: config() })
    const a = store.get('a', 0)
    expect(store.get('a', 1)).toBe(a)
    expect(store.has('a')).toBe(true)
    expect(store.has('b')).toBe(false)
    await a.anonymize(DOCUMENT)
    expect(a.entities.length).toBeGreaterThan(0)
    expect(store.get('b', 1).entities).toEqual([])
    store.drop('a')
    expect(store.has('a')).toBe(false)
    expect(store.get('a', 2).entities).toEqual([])
  })

  test('evictIdle drops a slot after idleTtlMs; touching keeps it alive; default TTL is one hour', () => {
    const store = createAnonSessionStore({ config: config(), idleTtlMs: 1000 })
    store.get('a', 0)
    store.get('b', 0)
    store.get('b', 900) // touched
    store.evictIdle(1001)
    expect(store.has('a')).toBe(false)
    expect(store.has('b')).toBe(true)
    store.evictIdle(1900)
    expect(store.has('b')).toBe(true)
    store.evictIdle(1901)
    expect(store.has('b')).toBe(false)

    const dflt = createAnonSessionStore({ config: config() })
    dflt.get('x', 0)
    dflt.evictIdle(DEFAULT_IDLE_TTL_MS)
    expect(dflt.has('x')).toBe(true)
    dflt.evictIdle(DEFAULT_IDLE_TTL_MS + 1)
    expect(dflt.has('x')).toBe(false)
  })

  test('get evicts other idle slots, and a returning idle id starts with an empty mapping', async () => {
    const store = createAnonSessionStore({ config: config(), idleTtlMs: 1000 })
    await store.get('old', 0).anonymize(DOCUMENT)
    store.get('new', 5000)
    expect(store.has('old')).toBe(false)
    expect(store.get('old', 5001).entities).toEqual([])
  })

  test('markdown protection is on by default and can be switched off; protect reaches the sessions', async () => {
    const text = 'Rückruf `089 1234567` bitte'
    const on = await createAnonSessionStore({ config: config() }).get('s').anonymize(text)
    expect(on.text).toContain('`089 1234567`')
    const off = await createAnonSessionStore({ config: config(), markdown: false }).get('s').anonymize(text)
    expect(off.text).not.toContain('089 1234567')
    const protectedText = await createAnonSessionStore({ config: config(), markdown: false, protect: [/089 1234567/] }).get('s').anonymize(text)
    expect(protectedText.text).toContain('089 1234567')
  })
})
