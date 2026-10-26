import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIG } from '../src/config.ts'
import type { AnonConfig } from '../src/config.ts'
import { regexDetector } from '../src/detectors/regex.ts'
import type { Detector } from '../src/detectors/types.ts'
import { BLOCK_ID_PATTERN, mergeSpans, patternSpans } from '../src/markdown.ts'
import { anonymize, detect } from '../src/pipeline.ts'
import { restore } from '../src/restore.ts'
import { createAnonSession } from '../src/session.ts'
import type { DetectorName, EntityKind, Span } from '../src/types.ts'

// Ausschließlich erfundene Daten.

function config(): AnonConfig {
  const c = structuredClone(DEFAULT_CONFIG)
  c.detectors.onnx.enabled = false
  c.detectors.llm.enabled = false
  c.placeholders.style = 'presidio'
  c.placeholders.fakeNames = false
  return c
}

/** Detector that proposes one span per occurrence of each needle, like an NER model that also shreds ids. */
function fake(name: DetectorName, needles: { text: string; kind: EntityKind }[]): Detector {
  return {
    name,
    async detect(text) {
      const spans: Span[] = []
      for (const n of needles) {
        for (let i = text.indexOf(n.text); i >= 0; i = text.indexOf(n.text, i + n.text.length)) {
          spans.push({ start: i, end: i + n.text.length, text: n.text, kind: n.kind, score: 0.9, detector: name })
        }
      }
      return spans
    }
  }
}

const UUID = '3b241101-e2bb-4255-8caf-4136c566a962'
const TEXT = `[${UUID}] Herr Mustermann wurde aufgenommen.`
// NER-style detector: the name, the whole id and a fragment of it (as the IPv6/ID heuristics do).
const ner = () =>
  fake('onnx', [
    { text: 'Mustermann', kind: 'NAME_EXT' },
    { text: UUID, kind: 'ID' },
    { text: '4136c566a962', kind: 'ID' }
  ])

describe('BLOCK_ID_PATTERN', () => {
  test('matches UUID v4 as a whole token, either case, nothing else', () => {
    const re = (text: string) => patternSpans(text, [BLOCK_ID_PATTERN]).map(([s, e]) => text.slice(s, e))
    expect(re(`a ${UUID} b`)).toEqual([UUID])
    expect(re(UUID.toUpperCase())).toEqual([UUID.toUpperCase()])
    expect(re(`${UUID}x`)).toEqual([])
    expect(re('3b241101-e2bb-1255-8caf-4136c566a962')).toEqual([]) // version 1
    expect(re('3b241101-e2bb-4255-1caf-4136c566a962')).toEqual([]) // variant 1
  })
})

describe('BLOCK_ID_PATTERN boundaries', () => {
  const found = (text: string) => patternSpans(text, [BLOCK_ID_PATTERN]).map(([s, e]) => text.slice(s, e))

  test.each([
    [`[${UUID}] Text`],
    [UUID],
    [`Block ${UUID}.`],
    [`(${UUID})`],
    [`{"id":"${UUID}"}`],
    [`Block ${UUID}, dann ${UUID}`]
  ])('standalone id matches: %s', text => {
    expect(found(text).length).toBeGreaterThan(0)
    expect(found(text)[0]).toBe(UUID)
  })

  test.each([
    [`${UUID}.max@web.de`],
    [`max.${UUID}@web.de`],
    [`max-${UUID}@web.de`],
    [`max@${UUID}.de`],
    [`https://h.example.de/p/${UUID}/a`],
    [`https://h.example.de/p?id=${UUID}`]
  ])('id inside an email or URL does not match: %s', text => {
    expect(found(text)).toEqual([])
  })

  test('email and URL containing an id are still anonymized with protect (the id does not shield them)', async () => {
    const mail = `${UUID}.max@web.de`
    const url = `https://kis.example.de/patient/${UUID}/akte`
    const text = `[${UUID}] Mail: ${mail}, Akte: ${url}.`
    const res = await anonymize(text, {
      config: config(),
      detectors: [regexDetector({ entities: ['CONTACT_EMAIL', 'CONTACT_URL'] })],
      protect: [BLOCK_ID_PATTERN]
    })
    expect(res.text.startsWith(`[${UUID}] `)).toBe(true) // the standalone block id stays
    expect(res.text).not.toContain('web.de')
    expect(res.text).not.toContain('kis.example.de')
    expect(res.entities.map(e => e.original).sort()).toEqual([mail, url].sort())
    expect(restore(res.text, res.entities)).toBe(text)
  })
})

describe('patternSpans / mergeSpans', () => {
  test('non-global patterns work, state is not shared between calls, empty matches are ignored', () => {
    const shared = /ab/g
    const text = 'ab cd ab'
    expect(patternSpans(text, [shared])).toEqual([[0, 2], [6, 8]])
    expect(patternSpans(text, [shared])).toEqual([[0, 2], [6, 8]])
    expect(shared.lastIndex).toBe(0)
    expect(patternSpans(text, [/ab/])).toEqual([[0, 2], [6, 8]])
    expect(patternSpans(text, [/x*/, /(?:)/g])).toEqual([])
    expect(patternSpans(text, [])).toEqual([])
  })

  test('other flags are kept; patterns are unioned and merged', () => {
    expect(patternSpans('AB ab', [/ab/i])).toEqual([[0, 2], [3, 5]])
    expect(patternSpans('abcd', [/abc/, /bcd/])).toEqual([[0, 4]])
  })

  test('mergeSpans unions lists without modifying them', () => {
    const a: [number, number][] = [[0, 3]]
    const b: [number, number][] = [[2, 5], [8, 9]]
    expect(mergeSpans(a, b)).toEqual([[0, 5], [8, 9]])
    expect(a).toEqual([[0, 3]])
    expect(b).toEqual([[2, 5], [8, 9]])
    expect(mergeSpans()).toEqual([])
  })
})

describe('protect option', () => {
  test('UUID stays verbatim, the name is replaced, restore is exact', async () => {
    const res = await anonymize(TEXT, { config: config(), detectors: [ner()], protect: [BLOCK_ID_PATTERN] })
    expect(res.text).toContain(`[${UUID}]`)
    expect(res.text).not.toContain('Mustermann')
    expect(res.entities.map(e => e.original)).toEqual(['Mustermann'])
    expect(restore(res.text, res.entities)).toBe(TEXT)
  })

  test('without protect the same detector shreds the id (control)', async () => {
    const res = await anonymize(TEXT, { config: config(), detectors: [ner()] })
    expect(res.text).not.toContain(UUID)
  })

  test('detect() drops spans that overlap a match, also longer ones', async () => {
    const wide = fake('onnx', [{ text: `Herr Mustermann wurde`, kind: 'NAME_EXT' }, { text: `${UUID}]`, kind: 'ID' }])
    const r = await detect(TEXT, { config: config(), detectors: [wide], protect: [/Mustermann/, BLOCK_ID_PATTERN] })
    expect(r.spans).toEqual([])
    expect(r.review).toEqual([])
  })

  test('applies to every detector, regex included', async () => {
    const text = 'Termin am 12.03.1970 und am 14.03.1970.'
    const res = await anonymize(text, {
      config: config(),
      detectors: [regexDetector({ entities: ['DATE'] })],
      protect: [/12\.03\.1970/]
    })
    expect(res.text).toContain('12.03.1970')
    expect(res.text).not.toContain('14.03.1970')
  })

  test('applies to manual spans and the known mapping as well', async () => {
    const manual = [{ text: UUID, kind: 'ID' as const }, { text: 'Mustermann', kind: 'NAME_EXT' as const }]
    const res = await anonymize(`${UUID} Mustermann`, { config: config(), detectors: [], protect: [BLOCK_ID_PATTERN], manual })
    expect(res.text).toStartWith(UUID)
    expect(res.text).not.toContain('Mustermann')

    const mapping = res.entities
    const again = await anonymize(`${UUID} Mustermann`, { config: config(), detectors: [], protect: [BLOCK_ID_PATTERN], mapping })
    expect(again.text).toBe(res.text)
    const known = [{ placeholder: '<ID_00000000>', original: UUID, kind: 'ID' as const, detector: 'manual' as const, occurrences: 1 }]
    const seeded = await anonymize(UUID, { config: config(), detectors: [], protect: [BLOCK_ID_PATTERN], mapping: known })
    expect(seeded.text).toBe(UUID)
  })

  test('is the union with Markdown protection', async () => {
    const text = `Herr Mustermann, \`Anna Beispiel\`, ${UUID}`
    const detectors = [
      fake('onnx', [
        { text: 'Mustermann', kind: 'NAME_EXT' },
        { text: 'Anna Beispiel', kind: 'NAME_EXT' },
        { text: UUID, kind: 'ID' }
      ])
    ]
    const md = await anonymize(text, { config: config(), detectors, markdown: true, protect: [BLOCK_ID_PATTERN] })
    expect(md.text).toContain('`Anna Beispiel`') // inline code: Markdown protection
    expect(md.text).toContain(UUID) // pattern protection
    expect(md.text).not.toContain('Mustermann') // prose is still anonymized
    expect(restore(md.text, md.entities)).toBe(text)

    const plain = await anonymize(text, { config: config(), detectors, protect: [BLOCK_ID_PATTERN] })
    expect(plain.text).not.toContain('Anna Beispiel') // without `markdown` the code span is detected
    expect(plain.text).toContain(UUID)
  })

  test('flows through createAnonSession for every text of the conversation', async () => {
    const session = createAnonSession({ config: config(), detectors: [ner()], protect: [BLOCK_ID_PATTERN] })
    const a = await session.anonymize(TEXT)
    const b = await session.anonymize(`Frage zu ${UUID}: wer ist Mustermann?`)
    expect(a.text).toContain(UUID)
    expect(b.text).toContain(UUID)
    expect(b.text).not.toContain('Mustermann')
    const placeholder = session.entities[0]!.placeholder
    expect(a.text).toContain(placeholder)
    expect(b.text).toContain(placeholder)
    expect(session.restore(b.text)).toBe(`Frage zu ${UUID}: wer ist Mustermann?`)
  })
})
