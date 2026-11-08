import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../src/config.ts'
import type { AnonConfig } from '../src/config.ts'
import type { Detector } from '../src/detectors/types.ts'
import type { NerChat } from '../src/detectors/llm.ts'
import { createScanner, extractText, walkFiles } from '../src/scan.ts'
import type { EntityKind, Span } from '../src/types.ts'

// Ausschließlich erfundene Daten.

setDefaultTimeout(30_000)

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'anon-scan-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function config(): AnonConfig {
  const c = structuredClone(DEFAULT_CONFIG)
  c.detectors.onnx.enabled = false
  c.detectors.llm.enabled = false
  return c
}

/** Detector that proposes one span per occurrence of each needle. */
function fake(needles: { text: string; kind: EntityKind }[]): Detector {
  return {
    name: 'onnx',
    async detect(text) {
      const spans: Span[] = []
      for (const n of needles) {
        for (let i = text.indexOf(n.text); i >= 0; i = text.indexOf(n.text, i + n.text.length)) {
          spans.push({ start: i, end: i + n.text.length, text: n.text, kind: n.kind, score: 0.9, detector: 'onnx' })
        }
      }
      return spans
    },
  }
}

const NEEDLES: { text: string; kind: EntityKind }[] = [
  { text: 'Olaf Scholz', kind: 'NAME_EXT' },
  { text: 'Petra Schneider', kind: 'NAME_EXT' },
  { text: 'Berlin', kind: 'LOCATION_CITY' },
]

async function paths(roots: string[], over: Partial<AnonConfig['scan']> = {}) {
  const out: { path: string; skip?: string }[] = []
  for await (const e of walkFiles(roots, { ...DEFAULT_CONFIG.scan, ...over })) out.push({ ...e, path: e.path.slice(tmp.length + 1) })
  return out
}

describe('scanText levels', () => {
  test('flagKinds decide pii vs context; lines are 1-based', async () => {
    const s = createScanner({ config: config(), detectors: [fake(NEEDLES)] })
    const f = await s.scanText('Termin in Berlin.\nFrau Petra Schneider kommt.')
    expect(f.map(x => [x.text, x.level, x.line])).toEqual([
      ['Berlin', 'context', 1],
      ['Petra Schneider', 'pii', 2],
    ])
  })

  test('public filter demotes only names the model lists that were detected', async () => {
    const prompts: string[] = []
    const chat: NerChat = async p => {
      prompts.push(p.user)
      return { public: ['olaf scholz', 'Angela Merkel'] }
    }
    const s = createScanner({ config: config(), detectors: [fake(NEEDLES)], publicFilter: chat })
    const f = await s.scanText('Olaf Scholz besuchte Berlin. Petra Schneider sah zu.')
    expect(f.map(x => [x.text, x.level])).toEqual([
      ['Olaf Scholz', 'public'],
      ['Berlin', 'context'],
      ['Petra Schneider', 'pii'],
    ])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).not.toContain('"Berlin"')
  })

  test('a malformed filter answer fails the file instead of passing names through', async () => {
    const s = createScanner({ config: config(), detectors: [fake(NEEDLES)], publicFilter: async () => ({ public: 'Olaf Scholz' }) })
    writeFileSync(join(tmp, 'a.txt'), 'Olaf Scholz')
    const r = await s.scanFile(join(tmp, 'a.txt'))
    expect(r.status).toBe('error')
    expect(r.pii).toBe(false)
  })

  test('no names, no filter call', async () => {
    let calls = 0
    const s = createScanner({ config: config(), detectors: [fake(NEEDLES)], publicFilter: async () => (calls++, { public: [] }) })
    await s.scanText('Nur Berlin.')
    expect(calls).toBe(0)
  })
})

describe('scan.maxChars', () => {
  test('only the head is scanned, cut at whitespace; chars still counts the whole text', async () => {
    const c = config()
    c.scan.maxChars = 30
    const s = createScanner({ config: c, detectors: [fake(NEEDLES)] })
    // 'Petra Schneider' straddles char 30; the cut falls before it, so it is not reported half.
    const text = 'Olaf Scholz schrieb an Frau Petra Schneider in Berlin.'
    writeFileSync(join(tmp, 'a.txt'), text)
    const r = await s.scanFile(join(tmp, 'a.txt'))
    expect(r.chars).toBe(text.length)
    expect(r.scanned).toBe('Olaf Scholz schrieb an Frau'.length)
    expect(r.findings.map(f => f.text)).toEqual(['Olaf Scholz'])
  })
})

describe('walkFiles', () => {
  beforeEach(() => {
    mkdirSync(join(tmp, 'a/node_modules'), { recursive: true })
    writeFileSync(join(tmp, 'a/x.txt'), 'x')
    writeFileSync(join(tmp, 'a/b.MD'), 'x')
    writeFileSync(join(tmp, 'a/bild.png'), 'x')
    writeFileSync(join(tmp, 'a/groß.txt'), 'x'.repeat(100))
    writeFileSync(join(tmp, 'a/node_modules/y.txt'), 'x')
    symlinkSync(join(tmp, 'a/x.txt'), join(tmp, 'a/link.txt'))
  })

  test('filters by extension (case-insensitive), excludes dirs, skips large files, ignores symlinks', async () => {
    expect(await paths([join(tmp, 'a')], { maxBytes: 50 })).toEqual([
      { path: 'a/b.MD' },
      { path: 'a/groß.txt', skip: 'größer als scan.maxBytes (100 > 50 Bytes)' },
      { path: 'a/x.txt' },
    ])
  })

  test('dot-entries below a root are skipped unless hidden; an explicit dot-root is scanned', async () => {
    mkdirSync(join(tmp, 'a/.obsidian'))
    writeFileSync(join(tmp, 'a/.obsidian/n.md'), 'x')
    writeFileSync(join(tmp, 'a/.notiz.txt'), 'x')
    expect((await paths([join(tmp, 'a')])).map(e => e.path)).not.toContain('a/.notiz.txt')
    expect((await paths([join(tmp, 'a')], { hidden: true })).map(e => e.path)).toContain('a/.obsidian/n.md')
    expect((await paths([join(tmp, 'a/.obsidian')])).map(e => e.path)).toEqual(['a/.obsidian/n.md'])
  })

  test('explicit files bypass the extension filter; missing paths are reported', async () => {
    const r = await paths([join(tmp, 'a/bild.png'), join(tmp, 'fehlt.txt')])
    expect(r[0]).toEqual({ path: 'a/bild.png' })
    expect(r[1]?.skip).toContain('ENOENT')
  })
})

describe('extractText', () => {
  test('binary content is skipped, latin-1 is decoded', async () => {
    writeFileSync(join(tmp, 'bin.txt'), Buffer.from([0, 1, 2, 3]))
    writeFileSync(join(tmp, 'l1.txt'), Buffer.from('Müller', 'latin1'))
    await expect(extractText(join(tmp, 'bin.txt'))).rejects.toThrow('Binärdatei')
    expect(await extractText(join(tmp, 'l1.txt'))).toBe('Müller')
  })

  test('html loses tags and scripts, keeps entities decoded', async () => {
    writeFileSync(join(tmp, 'p.html'), '<p>Frau&nbsp;M&uuml;ller &amp; Sohn</p><script>var n="Hans"</script>')
    const t = await extractText(join(tmp, 'p.html'))
    expect(t).not.toContain('Hans')
    expect(t).not.toContain('<')
    expect(t).toContain('&')
  })

  test('docx paragraphs become lines', async () => {
    const dir = join(tmp, 'd')
    mkdirSync(join(dir, 'word'), { recursive: true })
    writeFileSync(
      join(dir, 'word/document.xml'),
      '<w:document><w:body><w:p><w:r><w:t>Petra</w:t></w:r></w:p><w:p><w:r><w:t>Schneider &amp; Co</w:t></w:r></w:p></w:body></w:document>',
    )
    Bun.spawnSync(['zip', '-qr', join(tmp, 'b.docx'), 'word'], { cwd: dir })
    expect((await extractText(join(tmp, 'b.docx'))).trim().split('\n')).toEqual(['Petra', 'Schneider & Co'])
  })
})

describe('anon scan CLI', () => {
  const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
  const run = (args: string[]) => {
    const r = Bun.spawnSync(['bun', CLI, 'scan', ...args, '--no-onnx', '--no-llm'], {
      cwd: tmp,
      env: { ...process.env, HOME: tmp, ANON_CONFIG: '' },
    })
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
  }

  beforeEach(() => {
    writeFileSync(join(tmp, 'mit.txt'), 'Bitte an anna.mueller@example.de schreiben.\n')
    writeFileSync(join(tmp, 'ohne.txt'), 'Das Wetter ist schön.\n')
  })

  test('-l lists only files with PII and exits 2', () => {
    const r = run(['-l', '.'])
    expect(r.code).toBe(2)
    expect(r.out.trim()).toBe('mit.txt')
    expect(r.err).toContain('2 Dateien: 1 mit PII, 1 ohne')
  })

  test('jsonl reports every file; no PII exits 0', () => {
    const r = run(['--format', 'jsonl', 'ohne.txt'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out)).toMatchObject({ path: 'ohne.txt', status: 'ok', pii: false, findings: [] })
  })

  test('csv quotes fields and has one row per finding', () => {
    const r = run(['--format', 'csv', 'mit.txt'])
    const rows = r.out.trim().split('\n')
    expect(rows[0]).toStartWith('path,status,reason,kind,level,text,line')
    expect(rows[1]).toStartWith('mit.txt,ok,,CONTACT_EMAIL,pii,anna.mueller@example.de,1,')
  })

  test('an unreachable LLM fails once up front when the public filter is on', () => {
    const r = run(['--public-filter', '--llm-url', 'http://127.0.0.1:9/v1', '.'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('nicht erreichbar')
    expect(r.out).toBe('')
  })

  test('an unknown format exits 1', () => {
    expect(run(['--format', 'xml', '.']).code).toBe(1)
  })
})
