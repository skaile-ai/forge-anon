import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Every test spawns the CLI one to three times (`Bun.spawnSync`); on a loaded machine that exceeds bun's 5 s default.
setDefaultTimeout(30_000)

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const SOURCE = 'Kontakt: anna.mueller@example.de, Tel. +49 30 1234567, Termin am 12.03.2024 mit Frau Müller.\n'
// Detection stays regex-only so the tests need neither a model download nor an LLM server.
const OFF = ['--no-onnx', '--no-llm']

let tmp: string
let ledgers: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'anon-cli-'))
  ledgers = join(tmp, 'ledgers')
  writeFileSync(join(tmp, 'bericht.md'), SOURCE)
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function anon(args: string[]) {
  const r = Bun.spawnSync(['bun', CLI, ...args], {
    cwd: tmp,
    env: { ...process.env, HOME: tmp, ANON_LEDGER_DIR: ledgers, ANON_CONFIG: '' },
  })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

const read = (name: string) => readFileSync(join(tmp, name), 'utf8')
const mode = (p: string) => statSync(p).mode & 0o777
const ledgerFiles = () => {
  try {
    return readdirSync(ledgers).filter(f => f.endsWith('.yaml'))
  } catch {
    return []
  }
}

describe('anon CLI', () => {
  test('--help lists all five commands', () => {
    const r = anon(['--help'])
    expect(r.code).toBe(0)
    for (const c of ['anonymize', 'deanonymize', 'inspect', 'config', 'detectors']) expect(r.out).toContain(c)
  })

  test('anonymize without -s writes <stem>.anon<ext> (0600) and no ledger', () => {
    const r = anon(['anonymize', 'bericht.md', ...OFF])
    expect(r.code).toBe(0)
    expect(r.out).toContain('nicht umkehrbar')
    const out = read('bericht.anon.md')
    expect(out).not.toContain('anna.mueller@example.de')
    expect(out).not.toContain('+49 30 1234567')
    expect(out).toMatch(/<CONTACT_EMAIL_[0-9a-f]{8}>/)
    expect(mode(join(tmp, 'bericht.anon.md'))).toBe(0o600)
    expect(ledgerFiles()).toEqual([])
  })

  test('-s saves a 0600 ledger that inspect lists (by key and by file)', () => {
    const r = anon(['anonymize', 'bericht.md', '-s', ...OFF])
    expect(r.code).toBe(0)
    const key = /Ledger-Key: ([0-9a-f]{32})/.exec(r.out)?.[1]
    expect(key).toBeDefined()
    expect(ledgerFiles()).toEqual([`${key}.yaml`])
    expect(mode(join(ledgers, `${key}.yaml`))).toBe(0o600)

    const byKey = anon(['inspect', key!])
    expect(byKey.code).toBe(0)
    expect(byKey.out).toContain('PLACEHOLDER')
    expect(byKey.out).toContain('anna.mueller@example.de')
    expect(byKey.out).toContain('CONTACT_EMAIL')

    const byFile = anon(['inspect', 'bericht.anon.md'])
    expect(byFile.code).toBe(0)
    expect(byFile.out).toContain(key!)
  })

  test('deanonymize restores the source byte for byte', () => {
    anon(['anonymize', 'bericht.md', '-s', ...OFF])
    const r = anon(['deanonymize', 'bericht.anon.md'])
    expect(r.code).toBe(0)
    expect(r.err).not.toContain('Warnung')
    expect(read('bericht.deanon.md')).toBe(SOURCE)
    expect(mode(join(tmp, 'bericht.deanon.md'))).toBe(0o600)
  })

  test('deanonymize with -k and -o; a changed file warns but still restores', () => {
    const key = /Ledger-Key: ([0-9a-f]{32})/.exec(anon(['anonymize', 'bericht.md', '-s', ...OFF]).out)![1]!
    writeFileSync(join(tmp, 'bericht.anon.md'), read('bericht.anon.md') + 'Nachtrag.\n')
    const r = anon(['deanonymize', 'bericht.anon.md', '-k', key, '-o', 'zurueck.md'])
    expect(r.code).toBe(0)
    expect(r.err).toContain('Warnung')
    expect(read('zurueck.md')).toBe(SOURCE + 'Nachtrag.\n')
  })

  test('deanonymize without a ledger exits 1', () => {
    anon(['anonymize', 'bericht.md', ...OFF])
    const r = anon(['deanonymize', 'bericht.anon.md'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('Kein Ledger')
  })

  test('--entities FOO exits 1 and lists the allowed kinds', () => {
    const r = anon(['anonymize', 'bericht.md', '--entities', 'FOO', ...OFF])
    expect(r.code).toBe(1)
    expect(r.err).toContain('Unbekannte Entity-Kinds: FOO')
    expect(r.err).toContain('NAME_PATIENT')
  })

  test('--entities restricts detection', () => {
    const r = anon(['anonymize', 'bericht.md', '--entities', 'CONTACT_EMAIL', ...OFF])
    expect(r.code).toBe(0)
    const out = read('bericht.anon.md')
    expect(out).toMatch(/<CONTACT_EMAIL_[0-9a-f]{8}>/)
    expect(out).toContain('+49 30 1234567')
  })

  test('--style gemtex produces gemtex tokens', () => {
    const r = anon(['anonymize', 'bericht.md', '--style', 'gemtex', ...OFF])
    expect(r.code).toBe(0)
    expect(read('bericht.anon.md')).toMatch(/\[\*\* CONTACT_EMAIL [A-Z0-9]{6} \*\*\]/)
  })

  test('a config file style is honoured and --style overrides it', () => {
    writeFileSync(join(tmp, 'anon.config.yaml'), 'placeholders:\n  style: llm-guard\n')
    expect(anon(['anonymize', 'bericht.md', ...OFF]).code).toBe(0)
    expect(read('bericht.anon.md')).toMatch(/\[REDACTED_CONTACT_EMAIL_[0-9a-f]{8}\]/)

    expect(anon(['anonymize', 'bericht.md', '--style', 'presidio', ...OFF]).code).toBe(0)
    expect(read('bericht.anon.md')).toMatch(/<CONTACT_EMAIL_[0-9a-f]{8}>/)
  })

  test('ledger.save in the config acts like -s', () => {
    writeFileSync(join(tmp, 'anon.config.yaml'), 'ledger:\n  save: true\n')
    const r = anon(['anonymize', 'bericht.md', ...OFF])
    expect(r.out).toContain('Ledger-Key:')
    expect(ledgerFiles()).toHaveLength(1)
  })

  test('--out-dir redirects the output', () => {
    const r = anon(['anonymize', 'bericht.md', '--out-dir', 'out', ...OFF])
    expect(r.code).toBe(1) // the directory does not exist: reported per file
    expect(r.err).toContain('✗ bericht.md')
    Bun.spawnSync(['mkdir', join(tmp, 'out')])
    expect(anon(['anonymize', 'bericht.md', '--out-dir', 'out', ...OFF]).code).toBe(0)
    expect(readFileSync(join(tmp, 'out', 'bericht.anon.md'), 'utf8')).toContain('<CONTACT_EMAIL_')
  })

  test('files are processed independently; the exit code is the maximum', () => {
    const r = anon(['anonymize', 'fehlt.md', 'bericht.md', ...OFF])
    expect(r.code).toBe(1)
    expect(r.err).toContain('✗ fehlt.md')
    expect(read('bericht.anon.md')).toContain('<CONTACT_EMAIL_')
  })

  test('--stammdaten uses semantic placeholders and exits 2 on residual leaks', () => {
    writeFileSync(
      join(tmp, 'stammdaten.json'),
      JSON.stringify({ vorname: 'Anna', nachname: 'Müller', angehoerige: [{ rolle: 'Mutter' }] }),
    )
    writeFileSync(join(tmp, 'fall.md'), 'Anna Müller kam mit Frau Müller. Später sprach Müllerstein mit Anna.\n')
    const r = anon(['anonymize', 'fall.md', '--style', 'semantic', '--stammdaten', 'stammdaten.json', ...OFF])
    const out = read('fall.anon.md')
    expect(out).toContain('{{name}}')
    expect(out).toContain('{{km}}')
    expect(out).not.toContain('Anna Müller')
    expect(r.code).toBe(2)
    expect(r.out).toContain('⚠ Rest: "Müllerstein"')
  })

  test('a non-local --llm-url exits 1', () => {
    const r = anon(['anonymize', 'bericht.md', '--detectors', 'regex,llm', '--llm-url', 'https://api.openai.com/v1'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('LLM-Endpunkt muss lokal sein')
  })

  test('config prints the effective YAML with sources', () => {
    writeFileSync(join(tmp, 'anon.config.yaml'), 'placeholders:\n  style: gemtex\n')
    const r = anon(['config', '--style', 'presidio'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('# sources: defaults')
    expect(r.out).toContain('anon.config.yaml')
    expect(r.out).toContain('style: presidio')
  })

  test('detectors reports each detector', () => {
    const r = anon(['detectors', '--no-llm'])
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/^regex\s+enabled/m)
    expect(r.out).toMatch(/^onnx\s+enabled\s+model=OpenMed\//m)
    expect(r.out).toMatch(/^llm\s+disabled/m)
  })
})
