import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  KEY_RE,
  LEDGER_VERSION,
  findLedger,
  ledgerPath,
  readLedger,
  saveLedger,
  sha256,
  storeDir
} from '../src/ledger.ts'
import type { Entity } from '../src/types.ts'

const mode = (p: string) => statSync(p).mode & 0o777

const entities: Entity[] = [
  { placeholder: '<NAME_EXT_1a2b3c4d>', original: 'Anna Müller', kind: 'NAME_EXT', detector: 'onnx', occurrences: 2 },
  { placeholder: '<CONTACT_EMAIL_0a0b0c0d>', original: 'anna@example.de', kind: 'CONTACT_EMAIL', detector: 'regex', occurrences: 1 }
]

let tmp: string
let savedEnv: string | undefined

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'anon-ledger-'))
  savedEnv = process.env.ANON_LEDGER_DIR
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env.ANON_LEDGER_DIR
  else process.env.ANON_LEDGER_DIR = savedEnv
  rmSync(tmp, { recursive: true, force: true })
})

function save(dir: string, anonText: string, created: string) {
  return saveLedger({
    sourceFile: 'bericht.md',
    style: 'presidio',
    fakeNames: false,
    detectors: ['regex', 'onnx'],
    sourceText: 'Original',
    anonText,
    entities,
    dir,
    created
  })
}

describe('store location', () => {
  test('ANON_LEDGER_DIR wins, `~` expands, default is ~/.local/share/forge-anon/ledgers', () => {
    expect(storeDir({ ANON_LEDGER_DIR: '/tmp/somewhere' })).toBe('/tmp/somewhere')
    expect(storeDir({ ANON_LEDGER_DIR: '~/my-ledgers' })).toBe(join(homedir(), 'my-ledgers'))
    expect(storeDir({})).toBe(join(homedir(), '.local', 'share', 'forge-anon', 'ledgers'))
    expect(storeDir({ ANON_LEDGER_DIR: '  ' })).toBe(join(homedir(), '.local', 'share', 'forge-anon', 'ledgers'))
  })

  test('sha256 is prefixed lowercase hex of the UTF-8 bytes', () => {
    expect(sha256('')).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  test('ledgerPath rejects malformed keys', () => {
    const key = 'a'.repeat(32)
    expect(KEY_RE.test(key)).toBe(true)
    expect(ledgerPath(key, '/x')).toBe(`/x/${key}.yaml`)
    expect(() => ledgerPath('../etc/passwd', '/x')).toThrow('Ungültiger Ledger-Key')
    expect(() => ledgerPath('A'.repeat(32), '/x')).toThrow()
  })
})

describe('saveLedger / readLedger', () => {
  test('directory is 0700, file is 0600, content round-trips', () => {
    const dir = join(tmp, 'nested', 'ledgers')
    const { key, path } = saveLedger({
      sourceFile: 'bericht.md',
      style: 'gemtex',
      fakeNames: true,
      detectors: ['regex', 'onnx'],
      sourceText: 'Anna Müller schrieb.',
      anonText: '<NAME_EXT_1a2b3c4d> schrieb.',
      entities,
      dir
    })
    expect(key).toMatch(KEY_RE)
    expect(path).toBe(join(dir, `${key}.yaml`))
    expect(mode(dir)).toBe(0o700)
    expect(mode(path)).toBe(0o600)

    const ledger = readLedger(path)
    expect(ledger).toMatchObject({
      version: LEDGER_VERSION,
      key,
      sourceFile: 'bericht.md',
      style: 'gemtex',
      fakeNames: true,
      detectors: ['regex', 'onnx'],
      checksumSource: sha256('Anna Müller schrieb.'),
      checksumAnon: sha256('<NAME_EXT_1a2b3c4d> schrieb.')
    })
    expect(ledger.entities).toEqual(entities)
    expect(ledger.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  })

  test('without `dir`, $ANON_LEDGER_DIR is used; an existing loose directory is tightened to 0700', () => {
    const dir = join(tmp, 'env-ledgers')
    mkdirSync(dir, { mode: 0o755 })
    process.env.ANON_LEDGER_DIR = dir
    const { path } = saveLedger({
      sourceFile: 'a.md',
      style: 'presidio',
      fakeNames: false,
      detectors: ['regex'],
      sourceText: 'x',
      anonText: 'y',
      entities: []
    })
    expect(path.startsWith(dir)).toBe(true)
    expect(mode(dir)).toBe(0o700)
    expect(mode(path)).toBe(0o600)
  })

  test('every run gets its own file', () => {
    const a = save(tmp, 'same', '2026-10-18T10:00:00Z')
    const b = save(tmp, 'same', '2026-10-18T10:00:00Z')
    expect(a.key).not.toBe(b.key)
    expect(readdirSync(tmp).filter(f => f.endsWith('.yaml'))).toHaveLength(2)
  })

  test('awkward originals survive YAML quoting', () => {
    const odd: Entity[] = [
      { placeholder: '[** NAME_EXT AB12CD **]', original: 'true', kind: 'NAME_EXT', detector: 'manual', occurrences: 1 },
      { placeholder: '{{person1}}', original: 'O\'Brien: "der" #1 – Müßig', kind: 'NAME_EXT', detector: 'llm', occurrences: 3 },
      { placeholder: '<ID_deadbeef>', original: `Zeile eins\nZeile zwei ${'lang '.repeat(30)}`, kind: 'ID', detector: 'regex', occurrences: 1 }
    ]
    const { path } = saveLedger({
      sourceFile: 'x.md',
      style: 'semantic',
      fakeNames: false,
      detectors: ['manual', 'llm'],
      sourceText: 's',
      anonText: 'a',
      entities: odd,
      dir: tmp
    })
    expect(readLedger(path).entities).toEqual(odd)
  })
})

describe('findLedger', () => {
  test('returns the newest ledger with matching checksum_anon, regardless of file order', () => {
    const newest = save(tmp, 'Text <A>', '2026-10-18T11:00:00Z')
    save(tmp, 'Text <A>', '2026-10-18T09:00:00Z')
    save(tmp, 'Anderer Text', '2026-10-18T12:00:00Z')
    expect(findLedger('Text <A>', tmp)).toBe(newest.path)
  })

  test('no match, missing directory and unreadable files give null / are skipped', () => {
    save(tmp, 'Text <A>', '2026-10-18T11:00:00Z')
    writeFileSync(join(tmp, 'kaputt.yaml'), ': : [unclosed')
    writeFileSync(join(tmp, 'liste.yaml'), '- a\n- b\n')
    expect(findLedger('unbekannt', tmp)).toBeNull()
    expect(findLedger('Text <A>', tmp)).not.toBeNull()
    expect(findLedger('x', join(tmp, 'gibt-es-nicht'))).toBeNull()
  })

  test('uses $ANON_LEDGER_DIR by default', () => {
    process.env.ANON_LEDGER_DIR = tmp
    const saved = save(tmp, 'Text <B>', '2026-10-18T11:00:00Z')
    expect(findLedger('Text <B>')).toBe(saved.path)
  })
})

describe('legacy ledgers (Python tool)', () => {
  test('entity_type instead of kind, no style/detectors/key', () => {
    const path = join(tmp, `${'b'.repeat(32)}.yaml`)
    writeFileSync(
      path,
      [
        'version: 3',
        'source_file: alt.md',
        'created: 2026-01-02T03:04:05+00:00',
        'fake_names: false',
        'checksum_source: sha256:aaa',
        'checksum_anon: sha256:bbb',
        'entities:',
        '  - placeholder: <PERSON_1a2b3c4d>',
        '    original: Anna Müller',
        '    entity_type: PERSON',
        '    occurrences: 2',
        '  - placeholder: <MEDICAL_LICENSE_5e6f7a8b>',
        '    original: XY-12',
        '    entity_type: MEDICAL_LICENSE',
        ''
      ].join('\n')
    )
    const ledger = readLedger(path)
    expect(ledger.version).toBe(3)
    expect(ledger.key).toBe('b'.repeat(32))
    expect(ledger.style).toBe('presidio')
    expect(ledger.detectors).toEqual([])
    expect(ledger.checksumAnon).toBe('sha256:bbb')
    expect(ledger.entities).toEqual([
      { placeholder: '<PERSON_1a2b3c4d>', original: 'Anna Müller', kind: 'NAME_EXT', detector: 'manual', occurrences: 2 },
      { placeholder: '<MEDICAL_LICENSE_5e6f7a8b>', original: 'XY-12', kind: 'OTHER', detector: 'manual', occurrences: 0 }
    ])
    expect(readFileSync(path, 'utf8')).toContain('entity_type')
  })

  test('a malformed entity is an error naming the file', () => {
    const path = join(tmp, 'x.yaml')
    writeFileSync(path, 'entities:\n  - placeholder: <A_00000000>\n')
    expect(() => readLedger(path)).toThrow('x.yaml')
  })
})
