import { describe, expect, test } from 'bun:test'
import { createStreamRestorer, restore } from '../src/restore.ts'

// Ausschließlich erfundene Daten.

const entities = [
  { placeholder: '<NAME_PATIENT_ab12cd34>', original: 'Anna Müller' },
  { placeholder: '<DATE_BIRTH_0f9e8d7c>', original: '12.03.1970' },
  { placeholder: '[REDACTED_ID_deadbeef]', original: 'A-4711' },
  { placeholder: '[** LOCATION_CITY K3J9QZ **]', original: 'Berlin' },
  { placeholder: '{{km}}', original: 'Katrin Berger' },
  { placeholder: '{{km}}_vorname', original: 'Katrin' }
]

const text = [
  'Hallo <NAME_PATIENT_ab12cd34>, geboren <DATE_BIRTH_0f9e8d7c> in [** LOCATION_CITY K3J9QZ **].',
  'Akte [REDACTED_ID_deadbeef]; {{km}}_vorname und {{km}}. Kein Platzhalter: a < b, [x], {{y}}, <NAME_PATIENT_',
  'ab12cd3>, NAME_PATIENT_ab12cd34, &lt;DATE_BIRTH_0F9E8D7C&gt;, `<NAME_PATIENT_AB12CD34>`, **<NAME_PATIENT_ab12cd34>** Ende'
].join(' ')

/** Deterministic xorshift for reproducible random chunkings. */
function rng(seed: number): () => number {
  let s = seed
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 0x100000000
  }
}

function stream(_t: string, chunks: string[], lenient: boolean): string {
  const r = createStreamRestorer(entities, { lenient })
  return chunks.map(c => r.push(c)).join('') + r.flush()
}

const chars = (t: string) => [...t]
const everySplit = (t: string) => Array.from({ length: t.length + 1 }, (_, i) => [t.slice(0, i), t.slice(i)])

describe('createStreamRestorer', () => {
  for (const lenient of [false, true]) {
    describe(lenient ? 'lenient' : 'exact', () => {
      const expected = restore(text, entities, { lenient })

      test('1-char chunks equal restore', () => {
        expect(stream(text, chars(text), lenient)).toBe(expected)
      })

      test('every two-chunk split equals restore', () => {
        for (const [a, b] of everySplit(text)) expect(stream(text, [a!, b!], lenient)).toBe(expected)
      })

      test('random chunkings equal restore', () => {
        const rand = rng(12345)
        for (let n = 0; n < 200; n++) {
          const chunks: string[] = []
          for (let i = 0; i < text.length;) {
            const len = 1 + Math.floor(rand() * 12)
            chunks.push(text.slice(i, i + len))
            i += len
          }
          expect(stream(text, chunks, lenient)).toBe(expected)
        }
      })
    })
  }

  test('fuzz: random texts from placeholder fragments and noise, random chunkings', () => {
    const pool = [
      ...entities.map(e => e.placeholder),
      'NAME_PATIENT_ab12cd34', '&lt;DATE_BIRTH_0F9E8D7C&gt;', '<NAME_PAT', 'IENT_ab12cd34>', '&lt;', '&gt;', '&', 'lt;', '<', '>', '[', ']',
      '[**', ' **]', '{{', '}}', '{{km}', '_vorname', '_', ' ', ' ', 'x', 'name', 'ID_deadbeef', 'REDACTED_ID_DEADBEEF', '`', '**', '\n', 'ü'
    ]
    const rand = rng(987654321)
    for (let n = 0; n < 400; n++) {
      let t = ''
      for (let k = 2 + Math.floor(rand() * 14); k > 0; k--) t += pool[Math.floor(rand() * pool.length)]
      const chunks: string[] = []
      for (let i = 0; i < t.length;) {
        const len = 1 + Math.floor(rand() * 8)
        chunks.push(t.slice(i, i + len))
        i += len
      }
      for (const lenient of [false, true]) expect(stream(t, chunks, lenient)).toBe(restore(t, entities, { lenient }))
    }
  })

  test('the exact mode leaves mangled variants alone', () => {
    expect(stream('NAME_PATIENT_ab12cd34', ['NAME_PATIENT_ab12cd34'], false)).toBe('NAME_PATIENT_ab12cd34')
  })

  test('holds back only a possible placeholder prefix', () => {
    const r = createStreamRestorer(entities)
    expect(r.push('Hallo <NAME_PA')).toBe('Hallo ')
    expect(r.push('TIENT_ab12cd34> und')).toBe('Anna Müller und')
    expect(r.push(' <')).toBe(' ')
    expect(r.push(' b')).toBe('< b')
    expect(r.push('{{k')).toBe('')
    expect(r.flush()).toBe('{{k')
  })

  test('a placeholder that prefixes a longer one waits for the next chunk', () => {
    const r = createStreamRestorer(entities)
    expect(r.push('{{km}}')).toBe('')
    expect(r.push('_vorname!')).toBe('Katrin!')
    expect(r.push('{{km}}')).toBe('')
    expect(r.push('.')).toBe('Katrin Berger.')
  })

  test('flush resets the restorer', () => {
    const r = createStreamRestorer(entities)
    expect(r.push('<NAME_PATIENT_ab')).toBe('')
    expect(r.flush()).toBe('<NAME_PATIENT_ab')
    expect(r.push('<NAME_PATIENT_ab12cd34>')).toBe('Anna Müller')
    expect(r.flush()).toBe('')
  })

  test('no entities: pass-through without delay', () => {
    const r = createStreamRestorer([])
    expect(r.push('<a')).toBe('<a')
    expect(r.flush()).toBe('')
  })

  test('lenient bare token holds back until it ends at a word boundary', () => {
    const r = createStreamRestorer(entities, { lenient: true })
    expect(r.push('Hi NAME_PATIENT_ab12cd34')).toBe('Hi ')
    expect(r.push(' ok')).toBe('Anna Müller ok')
  })
})
