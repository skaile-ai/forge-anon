import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIG } from '../src/config.ts'
import type { AnonConfig } from '../src/config.ts'
import { regexDetector } from '../src/detectors/regex.ts'
import type { Detector } from '../src/detectors/types.ts'
import { anonymize, buildDetectors, detect } from '../src/pipeline.ts'
import type { AnonymizeOptions } from '../src/pipeline.ts'
import { createStyle, getStyle } from '../src/placeholders.ts'
import { restore } from '../src/restore.ts'
import type { StyleName } from '../src/placeholders.ts'
import type { DetectorName, EntityKind, Span, Stammdaten } from '../src/types.ts'

// Ausschließlich erfundene Daten.

function config(style: StyleName, over: { fakeNames?: boolean } = {}): AnonConfig {
  const c = structuredClone(DEFAULT_CONFIG)
  c.detectors.onnx.enabled = false
  c.detectors.llm.enabled = false
  c.placeholders.style = style
  c.placeholders.fakeNames = over.fakeNames ?? false
  return c
}

/** Detector that proposes one span per occurrence of each needle. */
function fake(name: DetectorName, needles: { text: string; kind: EntityKind; score?: number }[]): Detector {
  return {
    name,
    async detect(text) {
      const spans: Span[] = []
      for (const n of needles) {
        for (let i = text.indexOf(n.text); i >= 0; i = text.indexOf(n.text, i + n.text.length)) {
          spans.push({ start: i, end: i + n.text.length, text: n.text, kind: n.kind, score: n.score ?? 0.9, detector: name })
        }
      }
      return spans
    }
  }
}

const emailAndDate = () => regexDetector({ entities: ['CONTACT_EMAIL', 'DATE'] })

describe('anonymize round trip', () => {
  const text = 'Anna Müller, geboren 12.03.2011, schrieb an anna.mueller@example.de. Rückruf an anna.mueller@example.de. Anna Müller kam.'
  const styles: StyleName[] = ['semantic', 'presidio', 'llm-guard', 'gemtex']

  for (const name of styles) {
    test(`regex + manual, style ${name}`, async () => {
      const opts: AnonymizeOptions = {
        config: config(name),
        detectors: [emailAndDate()],
        manual: [{ text: 'Anna Müller', kind: 'NAME_PATIENT' }]
      }
      const res = await anonymize(text, opts)
      const style = getStyle(name)

      expect(res.text).not.toContain('Müller')
      expect(res.text).not.toContain('example.de')
      expect(res.text).not.toContain('12.03.2011')
      expect(res.text.match(style.pattern)).toHaveLength(5)
      expect(restore(res.text, res.entities)).toBe(text)

      expect(res.entities).toHaveLength(3)
      expect(res.entities.find(e => e.kind === 'CONTACT_EMAIL')?.occurrences).toBe(2)
      expect(res.entities.find(e => e.kind === 'NAME_PATIENT')?.occurrences).toBe(2)
      expect(res.hits).toHaveLength(5)
      for (const h of res.hits) expect(text.slice(h.start, h.end)).toBe(h.original)
      expect(res.detectors).toEqual(['regex', 'manual'])
      expect(res.review).toEqual([])
      expect(res.residual).toEqual([])
    })
  }

  test('semantic numbering follows candidatePrefix', async () => {
    const res = await anonymize(text, {
      config: config('semantic'),
      detectors: [emailAndDate()],
      manual: [{ text: 'Anna Müller', kind: 'NAME_PATIENT' }]
    })
    expect(res.text).toBe(
      '{{person1}}, geboren {{datum1}}, schrieb an {{kontakt1}}. Rückruf an {{kontakt1}}. {{person1}} kam.'
    )
  })

  test('same name twice is one entity; another spelling gets its own placeholder', async () => {
    const t = 'Anna Müller kam. ANNA MÜLLER ging. Anna Müller blieb.'
    const res = await anonymize(t, {
      config: config('presidio'),
      detectors: [],
      manual: [{ text: 'Anna Müller', kind: 'NAME_EXT' }]
    })
    // manual scan is case-sensitive: the upper-case spelling is not found
    expect(res.entities).toHaveLength(1)
    expect(res.entities[0]!.occurrences).toBe(2)

    const res2 = await anonymize(t, {
      config: config('presidio'),
      detectors: [fake('onnx', [{ text: 'Anna Müller', kind: 'NAME_EXT' }, { text: 'ANNA MÜLLER', kind: 'NAME_EXT' }])]
    })
    expect(res2.entities).toHaveLength(2)
    expect(restore(res2.text, res2.entities)).toBe(t)
  })

  test('manual placeholder is kept', async () => {
    const res = await anonymize('Sprich mit Frau Berger.', {
      config: config('presidio'),
      detectors: [],
      manual: [{ text: 'Berger', kind: 'NAME_EXT', placeholder: '{{therapeutin}}' }]
    })
    expect(res.text).toBe('Sprich mit Frau {{therapeutin}}.')
    expect(res.entities).toEqual([
      { placeholder: '{{therapeutin}}', original: 'Berger', kind: 'NAME_EXT', detector: 'manual', occurrences: 1 }
    ])
  })
})

describe('markdown protection', () => {
  const text = 'Schreib an jane.doe@example.org, bitte.\n\n```\njane.doe@example.org\n```\n'

  test('email in a code block stays verbatim, the same email in prose is replaced', async () => {
    const res = await anonymize(text, { config: config('presidio'), detectors: [emailAndDate()], markdown: true })
    expect(res.hits).toHaveLength(1)
    expect(res.text.startsWith('Schreib an <CONTACT_EMAIL_')).toBe(true)
    expect(res.text.endsWith('```\njane.doe@example.org\n```\n')).toBe(true)
    expect(restore(res.text, res.entities)).toBe(text)
  })

  test('without markdown both are replaced', async () => {
    const res = await anonymize(text, { config: config('presidio'), detectors: [emailAndDate()] })
    expect(res.hits).toHaveLength(2)
    expect(res.text).not.toContain('example.org')
  })

  test('a larger span reaching into code does not suppress a prose span', async () => {
    // The onnx span starts in prose and ends inside the fence: it is dropped first, the email survives.
    const t = 'Kontakt jane@example.org\n```\nx\n```\n'
    const reaching = 'jane@example.org\n```\nx'
    const res = await detect(t, {
      config: config('presidio'),
      detectors: [emailAndDate(), fake('onnx', [{ text: reaching, kind: 'NAME_EXT' }])],
      markdown: true
    })
    expect(res.spans.map(s => s.text)).toEqual(['jane@example.org'])
    expect(res.spans[0]!.start).toBe(t.indexOf('jane'))
  })

  test('config.markdown.protect=false disables the filter', async () => {
    const c = config('presidio')
    c.markdown.protect = false
    const res = await anonymize(text, { config: c, detectors: [emailAndDate()], markdown: true })
    expect(res.hits).toHaveLength(2)
  })
})

describe('review kinds', () => {
  test('AGE is reported, not replaced; names around it are', async () => {
    const t = 'Die 14-jährige Anna Müller kam.'
    const res = await anonymize(t, {
      config: config('presidio'),
      detectors: [fake('onnx', [{ text: '14-jährige', kind: 'AGE' }, { text: 'Anna Müller', kind: 'NAME_EXT' }])]
    })
    expect(res.text).toContain('14-jährige')
    expect(res.text).not.toContain('Müller')
    expect(res.review).toHaveLength(1)
    expect(res.review[0]).toMatchObject({ text: '14-jährige', kind: 'AGE', start: t.indexOf('14') })
    expect(restore(res.text, res.entities)).toBe(t)
  })

  test('a review span overlapping a kept span is not reported', async () => {
    const t = 'Besuch am 12.03.2011 geplant.'
    const res = await detect(t, {
      config: config('presidio'),
      detectors: [emailAndDate(), fake('onnx', [{ text: '12.03.2011', kind: 'AGE' }])]
    })
    expect(res.spans).toHaveLength(1)
    expect(res.review).toEqual([])
  })

  test('manual entries are never set aside', async () => {
    const res = await anonymize('Er ist Lehrer.', {
      config: config('presidio'),
      detectors: [],
      manual: [{ text: 'Lehrer', kind: 'PROFESSION' }]
    })
    expect(res.review).toEqual([])
    expect(res.text).not.toContain('Lehrer')
  })
})

describe('overlaps', () => {
  const S: Stammdaten = {
    vorname: 'Lena',
    nachname: 'Sommerfeld',
    geburtsdatum: '12.03.2010',
    angehoerige: [{ rolle: 'mutter', vorname: 'Katrin' }],
    wohnort: 'Lindenau'
  }

  test('a rules span beats an overlapping onnx span of equal length', async () => {
    const res = await anonymize('Lena Sommerfeld wurde gesehen.', {
      config: config('semantic'),
      stammdaten: S,
      detectors: [fake('onnx', [{ text: 'Lena Sommerfeld', kind: 'NAME_EXT' }])]
    })
    expect(res.text).toBe('{{name}} wurde gesehen.')
    expect(res.entities[0]).toMatchObject({ placeholder: '{{name}}', kind: 'NAME_PATIENT', detector: 'rules' })
  })

  test('a different spelling of a rule original gets its own placeholder and restores exactly', async () => {
    const t = 'Sommerfeld kam. SOMMERFELD ging.'
    const res = await anonymize(t, {
      config: config('semantic'),
      stammdaten: S,
      detectors: [fake('onnx', [{ text: 'SOMMERFELD', kind: 'NAME_EXT' }])]
    })
    expect(restore(res.text, res.entities)).toBe(t)
    expect(res.text.startsWith('{{nachname}} kam. ')).toBe(true)
    expect(res.text).not.toBe('{{nachname}} kam. {{nachname}} ging.')
    const variant = res.entities.find(e => e.original === 'SOMMERFELD')
    expect(variant).toBeDefined()
    expect(variant!.placeholder).not.toBe('{{nachname}}')
  })

  test('the longer span wins regardless of detector priority', async () => {
    const res = await detect('Frau Dr. Berger-Lenz kam.', {
      config: config('presidio'),
      detectors: [fake('regex', [{ text: 'Berger', kind: 'NAME_EXT' }]), fake('llm', [{ text: 'Dr. Berger-Lenz', kind: 'NAME_EXT' }])]
    })
    expect(res.spans.map(s => s.text)).toEqual(['Dr. Berger-Lenz'])
  })

  test('equal length: manual beats regex beats onnx; equal rank: earlier start', async () => {
    const t = 'Anna Müller'
    const res = await detect(t, {
      config: config('presidio'),
      detectors: [fake('onnx', [{ text: 'Anna Müller', kind: 'NAME_EXT' }]), fake('regex', [{ text: 'Anna Müller', kind: 'NAME_EXT' }])],
      manual: [{ text: 'Anna Müller', kind: 'NAME_PATIENT' }]
    })
    expect(res.spans).toHaveLength(1)
    expect(res.spans[0]).toMatchObject({ detector: 'manual', kind: 'NAME_PATIENT' })

    // two overlapping spans of the same length and rank: the earlier start wins
    const res2 = await detect('Anna Berger Lang', {
      config: config('presidio'),
      detectors: [
        fake('onnx', [{ text: 'Berger Lang', kind: 'NAME_EXT' }]),
        fake('onnx', [{ text: 'Anna Berger', kind: 'NAME_EXT' }])
      ]
    })
    expect(res2.spans.map(s => s.text)).toEqual(['Anna Berger'])
  })

  test('semantic: rule placeholders, numbered extras, another spelling of a rule original, residual', async () => {
    const t = 'Lena kam mit Katrin zu Dr. Berger. Später sprach Dr. Berger mit Lena. Lenas Weg in Lindenau: Sommerfelder Straße. SOMMERFELD rief an.'
    const res = await anonymize(t, {
      config: config('semantic'),
      stammdaten: S,
      detectors: [fake('onnx', [
        { text: 'Berger', kind: 'NAME_EXT' },
        { text: 'Katrin', kind: 'NAME_EXT' },
        { text: 'SOMMERFELD', kind: 'NAME_EXT' }
      ])]
    })
    expect(res.text).toBe(
      '{{vorname}} kam mit {{km_vorname}} zu Dr. {{person1}}. Später sprach Dr. {{person1}} mit {{vorname}}. {{vorname}}s Weg in {{wohnort}}: Sommerfelder Straße. {{person2}} rief an.'
    )
    // 'SOMMERFELD' is not matched by the case-sensitive rule and differs in spelling from its original: own placeholder
    expect(res.entities.map(e => e.placeholder)).toEqual(['{{vorname}}', '{{km_vorname}}', '{{person1}}', '{{wohnort}}', '{{person2}}'])
    expect(res.entities.find(e => e.placeholder === '{{person1}}')?.occurrences).toBe(2)
    expect(res.detectors).toEqual(['rules', 'onnx'])
    expect(res.residual.map(r => r.term)).toEqual(['Sommerfelder'])
    expect(res.residual[0]!.index).toBe(res.text.indexOf('Sommerfelder'))
    expect(restore(res.text, res.entities)).toBe(t)
  })

  test('rules disabled in config: no rule spans', async () => {
    const c = config('semantic')
    c.detectors.rules.enabled = false
    const res = await anonymize('Lena kam.', { config: c, stammdaten: S, detectors: [] })
    expect(res.text).toBe('Lena kam.')
    expect(res.detectors).toEqual([])
    expect(res.residual.map(r => r.term)).toEqual(['Lena'])
  })
})

describe('fake names', () => {
  test('fakeNames + semantic throws', async () => {
    await expect(anonymize('Anna Müller kam.', {
      config: config('semantic', { fakeNames: true }),
      detectors: [],
      manual: [{ text: 'Anna Müller', kind: 'NAME_PATIENT' }]
    })).rejects.toThrow('fakeNames ist mit style=semantic nicht kombinierbar')
  })

  test('names are replaced by plausible fakes, other kinds by tokens, and restore is exact', async () => {
    const t = 'Frau Anna Müller (anna@example.de) kam. Anna Müller ging.'
    const res = await anonymize(t, {
      config: config('presidio', { fakeNames: true }),
      detectors: [regexDetector({ entities: ['CONTACT_EMAIL'] })],
      manual: [{ text: 'Anna Müller', kind: 'NAME_PATIENT' }]
    })
    expect(res.text).not.toContain('Anna Müller')
    expect(res.text).not.toContain('anna@example.de')
    expect(res.text).toMatch(/^Frau .+ \(<CONTACT_EMAIL_[0-9a-f]{8}>\) kam\. .+ ging\.$/u)
    const name = res.entities.find(e => e.kind === 'NAME_PATIENT')!
    expect(name.placeholder).not.toMatch(/^</)
    expect(res.text.split(name.placeholder)).toHaveLength(3)
    expect(restore(res.text, res.entities)).toBe(t)
  })
})

describe('round-trip guard', () => {
  const colliding = 'Notiz <CONTACT_EMAIL_deadbeef> zu jane@example.org.'

  test('retries with fresh tokens when a generated token already occurs in the source', async () => {
    const seq = ['deadbeef', 'cafebabe', '0badf00d']
    let calls = 0
    const style = createStyle('presidio', { random: () => seq[Math.min(calls++, seq.length - 1)]! })
    const res = await anonymize(colliding, { config: config('presidio'), detectors: [emailAndDate()], style })
    expect(calls).toBe(2)
    expect(res.text).toBe('Notiz <CONTACT_EMAIL_deadbeef> zu <CONTACT_EMAIL_cafebabe>.')
    expect(restore(res.text, res.entities)).toBe(colliding)
  })

  test('gives up after 10 attempts', async () => {
    let calls = 0
    const style = createStyle('presidio', { random: () => (calls++, 'deadbeef') })
    await expect(anonymize(colliding, { config: config('presidio'), detectors: [emailAndDate()], style }))
      .rejects.toThrow('Round-Trip fehlgeschlagen nach 10 Versuchen')
    expect(calls).toBe(10)
  })

  test('semantic fails immediately and names the colliding placeholder', async () => {
    await expect(anonymize('Notiz {{kontakt1}} zu jane@example.org.', { config: config('semantic'), detectors: [emailAndDate()] }))
      .rejects.toThrow('{{kontakt1}}')
  })

  test('given placeholders cannot be redrawn: fails without retrying', async () => {
    await expect(anonymize('Notiz {{x}} zu Berger.', {
      config: config('presidio'),
      detectors: [],
      manual: [{ text: 'Berger', kind: 'NAME_EXT', placeholder: '{{x}}' }]
    })).rejects.toThrow('{{x}}')
  })

  test('a non-name rule placeholder under fakeNames cannot be redrawn: fails fast naming it', async () => {
    const S: Stammdaten = { vorname: 'Lena', nachname: 'Sommerfeld', wohnort: 'Lindenau' }
    await expect(anonymize('Notiz {{wohnort}} zu Lindenau.', {
      config: config('presidio', { fakeNames: true }),
      stammdaten: S,
      detectors: []
    })).rejects.toThrow('Platzhalter-Kollision: {{wohnort}}')
  })
})

describe('buildDetectors', () => {
  test('regex and onnx from config, llm only with a chat', () => {
    const c = structuredClone(DEFAULT_CONFIG)
    expect(buildDetectors({ config: c }).map(d => d.name)).toEqual(['regex', 'onnx'])
    c.detectors.llm.enabled = true
    expect(buildDetectors({ config: c }).map(d => d.name)).toEqual(['regex', 'onnx'])
    expect(buildDetectors({ config: c, chat: async () => ({}) }).map(d => d.name)).toEqual(['regex', 'onnx', 'llm'])
    c.detectors.regex.enabled = false
    c.detectors.onnx.enabled = false
    expect(buildDetectors({ config: c, chat: async () => ({}) }).map(d => d.name)).toEqual(['llm'])
  })

  test('the config-built list runs when `detectors` is not given (regex only)', async () => {
    const c = config('presidio')
    const res = await anonymize('Mail an jane@example.org.', { config: c })
    expect(res.detectors).toEqual(['regex'])
    expect(res.text).toMatch(/^Mail an <CONTACT_EMAIL_[0-9a-f]{8}>\.$/)
  })

  test('llm detector runs with an injected chat', async () => {
    const c = config('presidio')
    c.detectors.regex.enabled = false
    c.detectors.llm.enabled = true
    const chat = async () => ({ persons: ['Thomas Schneider'], places: [], institutions: [], dates: [] })
    const res = await anonymize('Dr. Thomas Schneider sah sie.', { config: c, chat })
    expect(res.detectors).toEqual(['llm'])
    expect(res.text).toMatch(/^Dr\. <NAME_EXT_[0-9a-f]{8}> sah sie\.$/)
  })
})
