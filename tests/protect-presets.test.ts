import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIG } from '../src/config.ts'
import type { AnonConfig } from '../src/config.ts'
import { regexDetector } from '../src/detectors/regex.ts'
import type { Detector } from '../src/detectors/types.ts'
import { anonymize } from '../src/pipeline.ts'
import { configProtect, PRESET_PATTERNS, PROXY_DEFAULT_PRESETS } from '../src/protect.ts'
import type { ProtectPreset } from '../src/protect.ts'
import { restore } from '../src/restore.ts'
import type { DetectorName, EntityKind, Span } from '../src/types.ts'

// Ausschließlich erfundene Daten.

function config(presets?: ProtectPreset[], patterns: string[] = []): AnonConfig {
  const c = structuredClone(DEFAULT_CONFIG)
  c.detectors.onnx.enabled = false
  c.detectors.llm.enabled = false
  c.placeholders.style = 'presidio'
  c.placeholders.fakeNames = false
  c.protect.patterns = patterns
  if (presets) c.protect.presets = presets
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

/** Presidio tokens without their random part, so a whole output line compares exactly. */
const shape = (s: string): string => s.replace(/<([A-Z_]+)_[0-9a-f]{8}>/g, '<$1>')

const DEV_LINES = [
  'DIRECTUS_URL=http://localhost:8058',
  'gutachten-webedit-directus\tdirectus/directus:11\t0.0.0.0:8058->8055/tcp, [::]:8058->8055/tcp',
  'backend-pgvector-1\tpgvector/pgvector:pg17\t0.0.0.0:8062->5432/tcp',
  'clinico-e2e-mail-1\tgreenmail/standalone:2.1.3\t127.0.0.1:3025->3025/tcp'
]
const PERSON = 'Patient Herr Klaus Bergmann, geb. 12.03.1980, Tel. 0761 1234567, https://praxis-bergmann.de, IP 84.12.3.4'
const SESSION = [...DEV_LINES, PERSON].join('\n')

// What the ONNX model proposed in the failing session: a fragment of a port, the port of a localhost URL, a surname.
const detectors = [
  regexDetector(),
  fake('onnx', [
    { text: '806', kind: 'CONTACT_IP' },
    { text: ':8058', kind: 'LOCATION_STREET' },
    { text: 'Bergmann', kind: 'NAME_EXT' }
  ])
]

describe('dev preset on a developer session', () => {
  test('dev lines stay byte-identical, the person data is replaced, restore is exact', async () => {
    const res = await anonymize(SESSION, { config: config(['dev']), detectors })
    const lines = res.text.split('\n')
    expect(lines.slice(0, DEV_LINES.length)).toEqual(DEV_LINES)
    expect(shape(lines[DEV_LINES.length]!)).toBe(
      'Patient Herr <NAME_EXT> <NAME_EXT>, geb. <DATE>, Tel. <CONTACT_PHONE>, <CONTACT_URL>, IP <CONTACT_IP>'
    )
    expect(res.entities.map(e => e.original)).toEqual([
      'Klaus',
      'Bergmann',
      '12.03.1980',
      '0761 1234567',
      'https://praxis-bergmann.de',
      '84.12.3.4'
    ])
    expect(restore(res.text, res.entities)).toBe(SESSION)
  })

  test('without presets (CLI default) the same detectors replace the localhost URL and 0.0.0.0', async () => {
    const res = await anonymize(SESSION, { config: config(), detectors })
    const lines = res.text.split('\n')
    expect(shape(lines[0]!)).toBe('DIRECTUS_URL=<CONTACT_URL>')
    expect(res.entities.map(e => e.original)).toContain('http://localhost:8058')
    expect(res.entities.map(e => e.original)).toContain('0.0.0.0')
    expect(res.text).not.toContain('0.0.0.0')
    expect(restore(res.text, res.entities)).toBe(SESSION)
  })
})

describe('dev preset boundaries', () => {
  const run = async (text: string) =>
    shape((await anonymize(text, { config: config(['dev']), detectors: [regexDetector()] })).text)

  test('a public host IP in front of a port map is replaced, the ports pass', async () => {
    expect(await run('84.12.3.4:80->80/tcp')).toBe('<CONTACT_IP>:80->80/tcp')
  })

  test('private ranges are not protected', async () => {
    expect(await run('Server 192.168.1.20 und 10.0.0.5')).toBe('Server <CONTACT_IP> und <CONTACT_IP>')
  })

  test('a date after a colon is no image reference (no slash)', async () => {
    expect(await run('datum:12.03.1980')).toBe('datum:<DATE>')
  })

  test('loopback is protected, a public IP is not', async () => {
    expect(await run('Loopback 127.0.0.1, extern 84.12.3.4')).toBe('Loopback 127.0.0.1, extern <CONTACT_IP>')
  })
})

describe('protect.patterns from the config', () => {
  const text = 'Antwort von Claude an Frau Bergmann.'
  const names = fake('onnx', [
    { text: 'Claude', kind: 'NAME_EXT' },
    { text: 'Bergmann', kind: 'NAME_EXT' }
  ])

  test('a configured pattern keeps its match verbatim', async () => {
    const res = await anonymize(text, { config: config(undefined, ['\\bClaude\\b']), detectors: [names] })
    expect(shape(res.text)).toBe('Antwort von Claude an Frau <NAME_EXT>.')
    expect(restore(res.text, res.entities)).toBe(text)
  })

  test('without the pattern the name is replaced (control)', async () => {
    const res = await anonymize(text, { config: config(), detectors: [names] })
    expect(shape(res.text)).toBe('Antwort von <NAME_EXT> an Frau <NAME_EXT>.')
  })
})

describe('configProtect', () => {
  test('no patterns and no presets: nothing protected', () => {
    expect(configProtect(config())).toEqual([])
  })

  test('patterns come first, compiled with flag u; then the preset patterns', () => {
    const out = configProtect(config(['dev'], ['\\bClaude\\b']))
    expect(out[0]!.source).toBe('\\bClaude\\b')
    expect(out[0]!.flags).toContain('u')
    expect(out.slice(1)).toEqual([...PRESET_PATTERNS.dev])
  })

  test('defaults apply only when presets is undefined', () => {
    expect(PROXY_DEFAULT_PRESETS).toEqual(['dev'])
    expect(configProtect(config(), PROXY_DEFAULT_PRESETS)).toEqual([...PRESET_PATTERNS.dev])
    expect(configProtect(config([]), PROXY_DEFAULT_PRESETS)).toEqual([])
  })
})
