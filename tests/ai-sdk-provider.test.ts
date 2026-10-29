import { describe, expect, test } from 'bun:test'
import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { ANON_SYSTEM, anonymizingModelProvider } from '../src/ai-sdk.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'
import type { AnonConfig } from '../src/config.ts'
import { createAnonSession } from '../src/session.ts'
import type { AnonSession } from '../src/session.ts'

// Ausschließlich erfundene Daten.

/** Rules (from the Stammdaten) and regex detectors only: no model download, deterministic. */
function config(): AnonConfig {
  const c = structuredClone(DEFAULT_CONFIG)
  c.detectors.onnx.enabled = false
  c.detectors.llm.enabled = false
  c.detectors.rules.enabled = true
  c.placeholders.fakeNames = false
  return c
}

const newSession = () =>
  createAnonSession({
    config: config(),
    markdown: true,
    stammdaten: { vorname: 'Lena', nachname: 'Sommerfeld', geburtsdatum: '12.03.2009' }
  })

const PROMPT = [{ role: 'user', content: [{ type: 'text', text: 'Lena Sommerfeld, geboren am 12.03.2009, wurde aufgenommen.' }] }]
const SURNAME = 'Sommerfeld'
const FULLNAME = `Lena ${SURNAME}`

const call = (model: LanguageModelV4, prompt: unknown[] = PROMPT) => model.doGenerate({ prompt } as unknown as LanguageModelV4CallOptions)

/** A generate result with one text part; the finish fields are boilerplate the tests do not look at. */
const answer = (text: string) =>
  ({ content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: undefined }, usage: {}, warnings: [] }) as never

/** A model that answers with the placeholder it was sent for the patient's name, so the answer shows whether it was restored. */
function echoModel(session: AnonSession) {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      // The prompt names the patient as "Lena Sommerfeld": the session covers that with one full-name entity.
      const entity = session.entities.find(e => e.original === FULLNAME)
      return answer(`Bericht über ${entity?.placeholder ?? 'KEIN-PLATZHALTER'}.`)
    }
  })
}

type Ref = { endpoint: string }

describe('anonymizingModelProvider', () => {
  test('a local ref returns the identical model object and the prompt arrives untouched', async () => {
    const session = newSession()
    const model = echoModel(session)
    let sessions = 0
    const provider = anonymizingModelProvider(
      { languageModel: async (_ref: Ref, _user: object | null): Promise<LanguageModel | null> => model },
      {
        isRemote: ref => !ref.endpoint.includes('localhost'),
        sessionFor: () => {
          sessions++
          return session
        }
      }
    )
    const resolved = await provider.languageModel!({ endpoint: 'http://localhost:11434/v1' }, null)
    expect(resolved).toBe(model)
    await call(resolved as LanguageModelV4)
    expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toBe(JSON.stringify(PROMPT))
    expect(sessions).toBe(0)
  })

  test('a remote ref hides the Stammdaten from the model and restores them in the answer', async () => {
    const session = newSession()
    const model = echoModel(session)
    const provider = anonymizingModelProvider(
      { languageModel: async (_ref: Ref, _user: object | null): Promise<LanguageModel | null> => model },
      { isRemote: () => true, sessionFor: () => session }
    )
    const resolved = (await provider.languageModel!({ endpoint: 'https://api.example.org/v1' }, null)) as LanguageModelV4
    expect(resolved).not.toBe(model)
    const result = await call(resolved)

    const sent = JSON.stringify(model.doGenerateCalls[0]!.prompt)
    expect(sent).not.toContain(SURNAME)
    expect(sent).not.toContain('Lena')
    expect(sent).not.toContain('12.03.2009')
    expect(model.doGenerateCalls[0]!.prompt[0]).toEqual({ role: 'system', content: ANON_SYSTEM })

    const text = result.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('')
    expect(text).toBe(`Bericht über ${FULLNAME}.`)
  })

  test('the system option replaces ANON_SYSTEM', async () => {
    const session = newSession()
    const model = echoModel(session)
    const provider = anonymizingModelProvider(
      { languageModel: async (_ref: Ref, _user: object | null): Promise<LanguageModel | null> => model },
      { isRemote: () => true, sessionFor: () => session, system: 'Eigener Systemtext.' }
    )
    await call((await provider.languageModel!({ endpoint: 'https://api.example.org/v1' }, null)) as LanguageModelV4)
    expect(model.doGenerateCalls[0]!.prompt[0]).toEqual({ role: 'system', content: 'Eigener Systemtext.' })
  })

  test('null from the inner provider stays null and neither isRemote nor sessionFor runs', async () => {
    let calls = 0
    const provider = anonymizingModelProvider(
      { languageModel: async (_ref: Ref, _user: object | null): Promise<LanguageModel | null> => null },
      {
        isRemote: () => {
          calls++
          return true
        },
        sessionFor: () => {
          calls++
          return newSession()
        }
      }
    )
    expect(await provider.languageModel!({ endpoint: 'https://api.example.org/v1' }, null)).toBeNull()
    expect(calls).toBe(0)
  })

  test('sessionFor runs once per languageModel() call, with the user and the ref, and not per request', async () => {
    const session = newSession()
    const model = echoModel(session)
    const seen: { user: object | null; ref: Ref }[] = []
    const provider = anonymizingModelProvider(
      { languageModel: async (_ref: Ref, _user: object | null): Promise<LanguageModel | null> => model },
      {
        isRemote: async () => true,
        sessionFor: async (user, ref) => {
          seen.push({ user, ref })
          return session
        }
      }
    )
    const user = { id: 'u1' }
    const ref = { endpoint: 'https://api.example.org/v1' }
    const resolved = (await provider.languageModel!(ref, user)) as LanguageModelV4
    expect(seen).toEqual([{ user, ref }])
    await call(resolved)
    await call(resolved)
    expect(seen).toHaveLength(1)
    await provider.languageModel!(ref, null)
    expect(seen).toHaveLength(2)
  })

  test('every other property of the inner provider is kept, also methods of its prototype', async () => {
    class Inner {
      label = 'inner'
      async languageModel(_ref: Ref, _user: object | null): Promise<LanguageModel | null> {
        return null
      }
      async listModels() {
        return [this.label]
      }
    }
    const provider = anonymizingModelProvider(new Inner(), { isRemote: () => true, sessionFor: newSession })
    expect(provider.label).toBe('inner')
    expect(await provider.listModels()).toEqual(['inner'])
    expect(provider.languageModel).not.toBe(Inner.prototype.languageModel)
  })

  test('an inner provider without languageModel gets none', () => {
    const provider = anonymizingModelProvider<{ listModels(): string[]; languageModel?: never }>(
      { listModels: () => ['a'] },
      { isRemote: () => true, sessionFor: newSession }
    )
    expect(provider.listModels()).toEqual(['a'])
    expect('languageModel' in provider).toBe(false)
  })

  test('a remote ref that resolves to a model id string is refused (cannot be wrapped, never sent in clear)', async () => {
    const provider = anonymizingModelProvider(
      { languageModel: async (_ref: Ref, _user: object | null): Promise<LanguageModel | null> => 'openai/gpt-x' },
      { isRemote: () => true, sessionFor: newSession }
    )
    await expect(provider.languageModel!({ endpoint: 'https://api.example.org/v1' }, null)).rejects.toThrow('Remote-Modell als Modell-ID')
  })
})
