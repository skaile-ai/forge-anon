import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIG } from '../src/config.ts'
import type { AnonConfig } from '../src/config.ts'
import { regexDetector } from '../src/detectors/regex.ts'
import type { Detector } from '../src/detectors/types.ts'
import { anonymize } from '../src/pipeline.ts'
import { getStyle } from '../src/placeholders.ts'
import type { StyleName } from '../src/placeholders.ts'
import { restore } from '../src/restore.ts'
import { createAnonSession } from '../src/session.ts'
import type { DetectorName, Entity, EntityKind, Span } from '../src/types.ts'

// Ausschließlich erfundene Daten.

function config(style: StyleName): AnonConfig {
  const c = structuredClone(DEFAULT_CONFIG)
  c.detectors.onnx.enabled = false
  c.detectors.llm.enabled = false
  c.placeholders.style = style
  c.placeholders.fakeNames = false
  return c
}

/** Detector that proposes one span per occurrence of each needle (counts its calls). */
function fake(name: DetectorName, needles: { text: string; kind: EntityKind }[], onCall?: () => void): Detector {
  return {
    name,
    async detect(text) {
      onCall?.()
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

const NAME: EntityKind = 'NAME_PATIENT'
const dateDetector = () => regexDetector({ entities: ['DATE'] })

describe('anonymize with mapping', () => {
  const known: Entity = { placeholder: '<NAME_PATIENT_aaaaaaaa>', original: 'Müller', kind: NAME, detector: 'onnx', occurrences: 3 }
  const opts = (style: StyleName = 'presidio') => ({ config: config(style), detectors: [fake('onnx', [{ text: 'Schmidt', kind: NAME }])] })

  test('a known original keeps its placeholder although no detector fires on it', async () => {
    const res = await anonymize('Was hat Müller gesagt? Müller ging.', { ...opts(), mapping: [known] })
    expect(res.text).toBe('Was hat <NAME_PATIENT_aaaaaaaa> gesagt? <NAME_PATIENT_aaaaaaaa> ging.')
    expect(res.entities).toEqual([{ ...known, occurrences: 2 }])
    expect(res.hits).toHaveLength(2)
  })

  test('a detector finding a known original draws no new token', async () => {
    const res = await anonymize('Müller und Schmidt', {
      config: config('presidio'),
      detectors: [fake('onnx', [{ text: 'Müller', kind: NAME }, { text: 'Schmidt', kind: NAME }])],
      mapping: [known]
    })
    expect(res.entities).toHaveLength(2)
    expect(res.entities[0]).toEqual({ ...known, occurrences: 1 })
    expect(res.text.startsWith('<NAME_PATIENT_aaaaaaaa> und ')).toBe(true)
    expect(res.entities[1]!.original).toBe('Schmidt')
    expect(res.entities[1]!.placeholder).not.toBe(known.placeholder)
  })

  test('the result is the union; mapping entities absent from the text keep occurrences 0', async () => {
    const other: Entity = { placeholder: '<ID_bbbbbbbb>', original: 'A-4711', kind: 'ID', detector: 'regex', occurrences: 1 }
    const res = await anonymize('Schmidt kam.', { ...opts(), mapping: [known, other] })
    expect(res.entities.map(e => [e.original, e.occurrences])).toEqual([['Müller', 0], ['A-4711', 0], ['Schmidt', 1]])
    expect(restore(res.text, res.entities)).toBe('Schmidt kam.')
  })

  test('a longer detector span still wins over a shorter known original', async () => {
    const res = await anonymize('Herr Müller kam', {
      config: config('presidio'),
      detectors: [fake('onnx', [{ text: 'Herr Müller', kind: NAME }])],
      mapping: [known]
    })
    expect(res.entities.map(e => [e.original, e.occurrences])).toEqual([['Müller', 0], ['Herr Müller', 1]])
    expect(restore(res.text, res.entities)).toBe('Herr Müller kam')
  })

  test('another spelling is a new entity so that restore stays exact', async () => {
    const t = 'MÜLLER und Müller'
    const res = await anonymize(t, {
      config: config('presidio'),
      detectors: [fake('onnx', [{ text: 'MÜLLER', kind: NAME }])],
      mapping: [known]
    })
    expect(res.entities).toHaveLength(2)
    expect(restore(res.text, res.entities)).toBe(t)
  })

  test('word boundaries: a known original inside another word is left alone', async () => {
    const res = await anonymize('Müllerei, Müllers Hund', { ...opts(), mapping: [known] })
    expect(res.text).toBe('Müllerei, <NAME_PATIENT_aaaaaaaa>s Hund')
  })

  test('originals with regex metacharacters and non-word edges match exactly', async () => {
    const odd: Entity = { placeholder: '<ID_cccccccc>', original: '(030) 123-45+6', kind: 'ID', detector: 'manual', occurrences: 1 }
    const res = await anonymize('Tel (030) 123-45+6.', { config: config('presidio'), detectors: [], mapping: [odd] })
    expect(res.text).toBe('Tel <ID_cccccccc>.')
  })

  test('new tokens never reuse a mapping placeholder', async () => {
    const seq = ['aaaaaaaa', 'aaaaaaaa', 'dddddddd']
    const style = { ...getStyle('presidio'), token: (kind: EntityKind) => `<${kind}_${seq.shift()!}>` }
    const res = await anonymize('Schmidt', { ...opts(), style, mapping: [known] })
    expect(res.text).toBe('<NAME_PATIENT_dddddddd>')
  })

  test('a mapping placeholder in the source text is a collision', async () => {
    await expect(anonymize('wirklich <NAME_PATIENT_aaaaaaaa>?', { ...opts(), mapping: [known] })).rejects.toThrow('Platzhalter-Kollision')
  })

  test('semantic style continues the numbering of the mapping', async () => {
    const m: Entity = { placeholder: '{{person1}}', original: 'Müller', kind: NAME, detector: 'onnx', occurrences: 1 }
    const res = await anonymize('Müller und Schmidt', { ...opts('semantic'), mapping: [m] })
    expect(res.text).toBe('{{person1}} und {{person2}}')
    expect(restore(res.text, res.entities)).toBe('Müller und Schmidt')
  })

  test('empty and duplicate mapping entries are harmless', async () => {
    const res = await anonymize('Müller', {
      ...opts(),
      mapping: [known, { ...known, original: 'Zweiter' }, { ...known, placeholder: '<NAME_PATIENT_eeeeeeee>', original: ' ' }]
    })
    expect(res.text).toBe('<NAME_PATIENT_aaaaaaaa>')
    expect(res.entities).toHaveLength(2)
  })
})

describe('createAnonSession', () => {
  const presidio = () => ({ config: config('presidio') })

  test('reuses the placeholder of an earlier turn', async () => {
    const s = createAnonSession({ ...presidio(), detectors: [fake('onnx', [{ text: 'Müller', kind: NAME }]), dateDetector()] })
    const a = await s.anonymize('Herr Müller, geb. 12.03.1970')
    const b = await s.anonymize('Was hat Müller gesagt?')
    const ph = s.entities.find(e => e.original === 'Müller')!.placeholder
    expect(a.text).toContain(ph)
    expect(b.text).toBe(`Was hat ${ph} gesagt?`)
    expect(s.entities.map(e => e.original).sort()).toEqual(['12.03.1970', 'Müller'])
    expect(s.entities.find(e => e.original === 'Müller')!.occurrences).toBe(2)
    expect(s.restore(`${ph} sagte nichts`)).toBe('Müller sagte nichts')
  })

  test('reuses the placeholder even when the detector misses the original later', async () => {
    const s = createAnonSession({ ...presidio(), detectors: [fake('onnx', [{ text: 'Müller', kind: NAME }])] })
    await s.anonymize('Herr Müller')
    const ph = s.entities[0]!.placeholder
    expect((await s.anonymize('müller? nein, Müller.')).text).toBe(`müller? nein, ${ph}.`)
  })

  test('detectors are used as given and never rebuilt', async () => {
    let calls = 0
    const detectors = [fake('onnx', [{ text: 'Müller', kind: NAME }], () => calls++)]
    const s = createAnonSession({ ...presidio(), detectors })
    await s.anonymize('Müller kam')
    await s.anonymize('Müller ging')
    expect(calls).toBe(2)
  })

  describe('memo cache', () => {
    const counting = (needles: { text: string; kind: EntityKind }[]) => {
      const count = { calls: 0 }
      return { count, detectors: [fake('onnx', needles, () => count.calls++)] }
    }

    test('the same text twice runs the detectors once, returns the same text and adds no occurrences', async () => {
      const { count, detectors } = counting([{ text: 'Schmidt', kind: NAME }])
      const s = createAnonSession({ ...presidio(), detectors })
      const a = await s.anonymize('Schmidt und Schmidt')
      const b = await s.anonymize('Schmidt und Schmidt')
      expect(count.calls).toBe(1)
      expect(b).toBe(a)
      expect(b.text).toBe(a.text)
      expect(s.entities).toHaveLength(1)
      expect(s.entities[0]!.occurrences).toBe(2)
    })

    test('a text that adds a new original clears the cache: the first text runs the detectors again', async () => {
      const { count, detectors } = counting([{ text: 'Meier', kind: NAME }])
      const s = createAnonSession({ ...presidio(), detectors })
      await s.anonymize('Hallo Welt')
      expect(count.calls).toBe(1)
      await s.anonymize('Hallo Welt')
      expect(count.calls).toBe(1)
      await s.anonymize('Meier kam')
      expect(count.calls).toBe(2)
      await s.anonymize('Hallo Welt')
      expect(count.calls).toBe(3)
      await s.anonymize('Hallo Welt')
      expect(count.calls).toBe(3)
    })

    test('an older text picks up an original that became known later', async () => {
      // The detector only fires on a text that starts with "Meier"; in "ohne Meier" only the session mapping can match it.
      const startsWithMeier: Detector = {
        name: 'onnx',
        async detect(text) {
          return text.startsWith('Meier') ? [{ start: 0, end: 5, text: 'Meier', kind: NAME, score: 0.9, detector: 'onnx' }] : []
        }
      }
      const s = createAnonSession({ ...presidio(), detectors: [startsWithMeier] })
      const first = await s.anonymize('ohne Meier')
      expect(first.text).toBe('ohne Meier')
      await s.anonymize('Meier kam')
      const ph = s.entities[0]!.placeholder
      const old = await s.anonymize('ohne Meier')
      expect(old).not.toBe(first)
      expect(old.text).toBe(`ohne ${ph}`)
    })

    test('a result without new entities leaves the cache intact', async () => {
      const { count, detectors } = counting([{ text: 'Schmidt', kind: NAME }])
      const s = createAnonSession({ ...presidio(), detectors })
      await s.anonymize('Hallo Welt')
      await s.anonymize('Schmidt kam')
      expect(count.calls).toBe(2)
      await s.anonymize('Schmidt ging') // known original: mapping gains no placeholder
      expect(count.calls).toBe(3)
      await s.anonymize('Schmidt kam')
      await s.anonymize('Schmidt ging')
      expect(count.calls).toBe(3)
    })

    test('the cache is bounded: the oldest text is evicted past 512 entries (LRU)', async () => {
      const { count, detectors } = counting([{ text: 'Schmidt', kind: NAME }])
      const s = createAnonSession({ ...presidio(), detectors })
      for (let i = 0; i < 512; i++) await s.anonymize(`text ${i}`)
      expect(count.calls).toBe(512)
      await s.anonymize('text 0') // hit, becomes the most recent
      expect(count.calls).toBe(512)
      await s.anonymize('text 512') // 513th entry evicts 'text 1', not the touched 'text 0'
      expect(count.calls).toBe(513)
      await s.anonymize('text 0')
      expect(count.calls).toBe(513)
      await s.anonymize('text 1')
      expect(count.calls).toBe(514)
    })
  })

  test('overlapping calls are serialised: one token per new original', async () => {
    const s = createAnonSession({ ...presidio(), detectors: [fake('onnx', [{ text: 'Schmidt', kind: NAME }])] })
    const [a, b, c] = await Promise.all([s.anonymize('Schmidt kam'), s.anonymize('Schmidt ging'), s.anonymize('Schmidt blieb')])
    const ph = s.entities[0]!.placeholder
    expect(s.entities).toHaveLength(1)
    expect([a.text, b.text, c.text]).toEqual([`${ph} kam`, `${ph} ging`, `${ph} blieb`])
    expect(s.entities[0]!.occurrences).toBe(3)
  })

  test('a failed call does not poison the queue', async () => {
    const boom: Detector = { name: 'onnx', detect: async text => { if (text === 'boom') throw new Error('x'); return [] } }
    const s = createAnonSession({ ...presidio(), detectors: [boom] })
    const [bad, good] = await Promise.allSettled([s.anonymize('boom'), s.anonymize('ok')])
    expect(bad.status).toBe('rejected')
    expect(good.status).toBe('fulfilled')
  })

  test('restore is lenient for mangled tokens; semantic stays exact', async () => {
    const s = createAnonSession({ ...presidio(), detectors: [fake('onnx', [{ text: 'Müller', kind: NAME }])] })
    await s.anonymize('Müller')
    const core = s.entities[0]!.placeholder.slice(1, -1)
    const upper = core.slice(0, -8) + core.slice(-8).toUpperCase()
    expect(s.restore(`${core} &lt;${core}&gt; <${upper}> ${upper}`)).toBe('Müller Müller Müller Müller')
    expect(s.restore(`**<${core}>** \`${core}\``)).toBe('**Müller** `Müller`')

    const sem = createAnonSession({ config: config('semantic'), detectors: [fake('onnx', [{ text: 'Müller', kind: NAME }])] })
    await sem.anonymize('Müller')
    expect(sem.restore('{{person1}} person1 {{PERSON1}}')).toBe('Müller person1 {{PERSON1}}')
  })

  test('streamRestorer is bound to the current mapping', async () => {
    const s = createAnonSession({ ...presidio(), detectors: [fake('onnx', [{ text: 'Müller', kind: NAME }])] })
    await s.anonymize('Müller')
    const ph = s.entities[0]!.placeholder
    const answer = `Herr ${ph} sagte, ${ph.slice(1, -1)} ging.`
    const r = s.streamRestorer()
    const out = [...answer].map(c => r.push(c)).join('') + r.flush()
    expect(out).toBe(s.restore(answer))
    expect(out).toBe('Herr Müller sagte, Müller ging.')
  })

  test('works with the onnx detector from the config (injected pipeline)', async () => {
    const c = config('presidio')
    c.detectors.onnx.enabled = true
    const onnxPipeline = async (text: string) => {
      const i = text.indexOf('Müller')
      return i < 0 ? [] : [{ entity: 'B-LASTNAME', score: 0.95, index: 1, word: 'müller', start: i, end: i + 6 }]
    }
    const s = createAnonSession({ config: c, onnxPipeline })
    const a = await s.anonymize('Frau Müller kam.')
    const b = await s.anonymize('Müller ging.')
    expect(a.entities).toHaveLength(1)
    expect(b.text.startsWith(s.entities[0]!.placeholder)).toBe(true)
    expect(s.entities).toHaveLength(1)
  })
})
