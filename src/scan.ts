// Bulk scan: walk directories, extract text per file type, run the detectors, report findings per file.
//
// Decisions:
// - Detection only; nothing is rewritten. Detectors are built once per scan (the ONNX model loads once).
// - A file counts as containing PII when at least one finding has a kind in `scan.flagKinds`. Other kinds
//   (plain dates, cities, organisations, professions …) are reported as `context`: alone they rarely identify
//   anyone, and flagging them would mark every newspaper article.
// - Office and PDF files are read through standard command line tools (`pdftotext`, `unzip`) instead of
//   bundled parsers. A missing tool skips the file with a reason; it never fails the scan.
// - The optional public-figure filter asks the local LLM which detected person names are public figures.
//   It can only demote names the detectors found, never add findings; names it returns that are not in the
//   list are ignored.

import { execFile } from 'node:child_process'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { AnonConfig } from './config.ts'
import { contextSnippet } from './detectors/llm.ts'
import type { NerChat } from './detectors/llm.ts'
import type { Detector } from './detectors/types.ts'
import { buildDetectors, detect } from './pipeline.ts'
import { kindGroup } from './types.ts'
import type { DetectorName, EntityKind, Span } from './types.ts'

export type ScanConfig = AnonConfig['scan']

/** `pii`: kind in `scan.flagKinds`; `context`: other kinds; `public`: a person name judged a public figure. */
export type FindingLevel = 'pii' | 'context' | 'public'

export type ScanFinding = {
  kind: EntityKind
  text: string
  level: FindingLevel
  /** 1-based line in the extracted text. */
  line: number
  /** Offsets into the extracted text (for plain text files: the file content). */
  start: number
  end: number
  detector: DetectorName
  score: number
}

export type ScanFileResult = {
  path: string
  status: 'ok' | 'skipped' | 'error'
  /** Why the file was skipped or failed. */
  reason?: string
  /** Characters of extracted text. */
  chars: number
  /** At least one finding with level `pii`. */
  pii: boolean
  findings: ScanFinding[]
}

export type ScanOptions = {
  config: AnonConfig
  /** Built once by `createScanner` when absent. */
  detectors?: Detector[]
  /** Chat for the `llm` detector (used only when `detectors.llm.enabled`). */
  chat?: NerChat
  /** Chat for the public-figure filter; the filter runs only when this is given. */
  publicFilter?: NerChat
}

// ---------------------------------------------------------------------------
// Walking

export type WalkEntry = { path: string; skip?: string }

/**
 * Files below `roots` (files given directly are always yielded), depth first, sorted by name.
 * Symlinks are not followed. Directories named in `exclude` are skipped, and with `hidden: false` every
 * dot-entry below a root; files whose extension is not in `extensions` are not yielded at all; files above
 * `maxBytes` are yielded with a skip reason.
 */
export async function* walkFiles(
  roots: readonly string[],
  scan: Pick<ScanConfig, 'extensions' | 'exclude' | 'hidden' | 'maxBytes'>,
): AsyncGenerator<WalkEntry> {
  const exts = new Set(scan.extensions)
  const exclude = new Set(scan.exclude)

  async function* visit(path: string, explicit: boolean): AsyncGenerator<WalkEntry> {
    let st
    try {
      st = await lstat(path)
    } catch (e) {
      yield { path, skip: `nicht lesbar: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` }
      return
    }
    if (st.isSymbolicLink()) {
      if (explicit) yield { path, skip: 'symbolischer Link' }
      return
    }
    if (st.isDirectory()) {
      let names: string[]
      try {
        names = (await readdir(path)).sort()
      } catch (e) {
        yield { path, skip: `Verzeichnis nicht lesbar: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` }
        return
      }
      for (const name of names) {
        if (exclude.has(name) || (!scan.hidden && name.startsWith('.'))) continue
        yield* visit(join(path, name), false)
      }
      return
    }
    if (!st.isFile()) return
    if (!explicit && !exts.has(extOf(path))) return
    if (st.size > scan.maxBytes) {
      yield { path, skip: `größer als scan.maxBytes (${st.size} > ${scan.maxBytes} Bytes)` }
      return
    }
    yield { path }
  }

  for (const root of roots) yield* visit(root, true)
}

function extOf(path: string): string {
  return extname(path).slice(1).toLowerCase()
}

// ---------------------------------------------------------------------------
// Text extraction

/** Thrown when a file cannot be read as text; the scan reports it as skipped, not as an error. */
export class SkipFile extends Error {}

const MAX_BUFFER = 256 * 1024 * 1024
const execFileAsync = promisify(execFile)

async function run(cmd: string, args: string[], okCodes: number[] = [0]): Promise<string> {
  try {
    return (await execFileAsync(cmd, args, { encoding: 'utf8', maxBuffer: MAX_BUFFER })).stdout
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: string | number; stdout?: string; stderr?: string }
    if (e.code === 'ENOENT') throw new SkipFile(`${cmd} nicht installiert`)
    if (typeof e.code === 'number' && okCodes.includes(e.code)) return e.stdout ?? ''
    throw new Error(`${cmd}: ${(e.stderr || e.message).trim().split('\n')[0]}`)
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** XML to text: `breaks` become newlines, `tabs` tabs, every other tag disappears. */
function xmlText(xml: string, breaks: RegExp, tabs?: RegExp): string {
  let s = xml.replace(breaks, '\n')
  if (tabs) s = s.replace(tabs, '\t')
  return decodeEntities(s.replace(/<[^>]*>/g, ''))
}

/** `unzip -p` of all members matching the patterns; exit code 11 (no match) yields ''. */
function unzipMembers(path: string, patterns: string[]): Promise<string> {
  return run('unzip', ['-p', path, ...patterns], [11])
}

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true })
const LATIN_DECODER = new TextDecoder('windows-1252')

function decodeText(buf: Buffer): string {
  if (buf.subarray(0, 8192).includes(0)) throw new SkipFile('Binärdatei')
  try {
    return TEXT_DECODER.decode(buf)
  } catch {
    return LATIN_DECODER.decode(buf) // legacy German files: Windows-1252
  }
}

function htmlText(html: string): string {
  const body = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|table|section|article)\s*>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
  return decodeEntities(body)
}

/** Spreadsheet cells (xlsx): shared strings, inline strings and literal values; shared-string indices are skipped. */
function xlsxText(sharedStrings: string, sheets: string): string {
  const shared = xmlText(sharedStrings, /<\/si>/g)
  const rows = sheets.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (_m, attrs: string, inner?: string) =>
    !inner || /\bt="s"/.test(attrs) ? '' : `${inner}\t`)
  return `${shared}\n${xmlText(rows, /<\/row>/g)}`
}

/** Plain text of a file; throws `SkipFile` for unsupported or unreadable content. */
export async function extractText(path: string): Promise<string> {
  switch (extOf(path)) {
    case 'pdf':
      return run('pdftotext', ['-enc', 'UTF-8', '-q', path, '-'])
    case 'docx':
      return xmlText(
        await unzipMembers(path, ['word/document.xml', 'word/header*.xml', 'word/footer*.xml', 'word/footnotes.xml', 'word/comments.xml']),
        /<\/w:p>|<w:br\/>|<w:cr\/>/g,
        /<w:tab\/>/g,
      )
    case 'odt':
    case 'ods':
      return xmlText(await unzipMembers(path, ['content.xml']), /<\/text:p>|<\/text:h>|<text:line-break\/>|<\/table:table-row>/g, /<text:tab\/>|<\/table:table-cell>/g)
    case 'pptx':
      return xmlText(await unzipMembers(path, ['ppt/slides/slide*.xml', 'ppt/notesSlides/notesSlide*.xml']), /<\/a:p>|<a:br\/>/g)
    case 'xlsx':
      return xlsxText(await unzipMembers(path, ['xl/sharedStrings.xml']), await unzipMembers(path, ['xl/worksheets/sheet*.xml']))
    case 'html':
    case 'htm':
      return htmlText(decodeText(await readFile(path)))
    default:
      return decodeText(await readFile(path))
  }
}

// ---------------------------------------------------------------------------
// Public-figure filter

const PublicResponseSchema = z.object({ public: z.array(z.string()).default([]) })

const PUBLIC_SYSTEM = `Du prüfst Personennamen, die in Dokumenten gefunden wurden. Entscheide für jeden Namen anhand des Kontexts, ob er eine Person des öffentlichen Lebens in ihrer öffentlichen Rolle bezeichnet oder eine Privatperson.

Öffentlich: amtierende oder frühere Politikerinnen und Politiker, Staatsoberhäupter, Prominente, bekannte Sportlerinnen und Sportler, Künstlerinnen und Künstler, historische Personen, zitierte Autorinnen und Autoren, fiktive Figuren, Namensgeber (z. B. Goethe in "Goethe-Schule").
Privat: alle anderen, insbesondere Patientinnen und Patienten, Angehörige, Kundinnen und Kunden, Mitarbeitende, Behandelnde, Absender und Empfänger von Briefen und E-Mails.
Im Zweifel: privat.

Antworte ausschließlich mit JSON: {"public": ["Name genau wie angegeben", ...]}. Gibt es keine öffentlichen Personen, liefere {"public": []}.`

const PUBLIC_BATCH = 40

type NameCandidate = { text: string; contexts: string[] }

/** Names (exactly as listed) that the model judges to be public figures. */
export async function judgePublicNames(names: readonly NameCandidate[], chat: NerChat): Promise<Set<string>> {
  const out = new Set<string>()
  for (let i = 0; i < names.length; i += PUBLIC_BATCH) {
    const batch = names.slice(i, i + PUBLIC_BATCH)
    const known = new Map(batch.map(n => [n.text.trim().toLowerCase(), n.text]))
    const list = batch.map(n => `- "${n.text}": ${n.contexts.map(c => `«${c}»`).join(' ')}`).join('\n')
    const raw = await chat({ system: PUBLIC_SYSTEM, user: `Namen mit Kontext:\n${list}\n\nGib das JSON zurück.` })
    const parsed = PublicResponseSchema.safeParse(raw)
    if (!parsed.success) throw new Error(`Antwort des Öffentlich-Filters ungültig: ${parsed.error.issues[0]?.message ?? ''}`)
    for (const name of parsed.data.public) {
      const hit = known.get(name.trim().toLowerCase())
      if (hit) out.add(hit)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Scanning

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

function lineOf(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

export type Scanner = {
  /** Findings in one text; `markdown` protects code and link targets as in `anonymize`. */
  scanText(text: string, markdown?: boolean): Promise<ScanFinding[]>
  scanFile(path: string): Promise<ScanFileResult>
}

/** Builds the detectors once and returns functions that scan texts and files with them. */
export function createScanner(opts: ScanOptions): Scanner {
  const { config } = opts
  const detectors = opts.detectors ?? buildDetectors({ config, chat: opts.chat })
  const flag = new Set<EntityKind>(config.scan.flagKinds)

  async function scanText(text: string, markdown = false): Promise<ScanFinding[]> {
    if (!text.trim()) return []
    const r = await detect(text, { config, markdown, detectors, chat: opts.chat })
    const spans: Span[] = [...r.spans, ...r.review].sort((a, b) => a.start - b.start)

    let publicNames = new Set<string>()
    if (opts.publicFilter) {
      const byName = new Map<string, NameCandidate>()
      for (const s of spans) {
        if (kindGroup(s.kind) !== 'NAME' || !flag.has(s.kind)) continue
        const c = byName.get(s.text) ?? { text: s.text, contexts: [] }
        if (c.contexts.length < 2) c.contexts.push(contextSnippet(text, s.start, s.end - s.start))
        byName.set(s.text, c)
      }
      if (byName.size > 0) publicNames = await judgePublicNames([...byName.values()], opts.publicFilter)
    }

    const starts = lineStarts(text)
    return spans.map(s => ({
      kind: s.kind,
      text: s.text,
      level: publicNames.has(s.text) && kindGroup(s.kind) === 'NAME' ? 'public' : flag.has(s.kind) ? 'pii' : 'context',
      line: lineOf(starts, s.start),
      start: s.start,
      end: s.end,
      detector: s.detector,
      score: s.score,
    }))
  }

  async function scanFile(path: string): Promise<ScanFileResult> {
    let text: string
    try {
      text = await extractText(path)
    } catch (e) {
      const status = e instanceof SkipFile ? 'skipped' : 'error'
      return { path, status, reason: (e as Error).message, chars: 0, pii: false, findings: [] }
    }
    try {
      const findings = await scanText(text, config.markdown.protect && /^(md|markdown)$/.test(extOf(path)))
      return { path, status: 'ok', chars: text.length, pii: findings.some(f => f.level === 'pii'), findings }
    } catch (e) {
      return { path, status: 'error', reason: (e as Error).message, chars: text.length, pii: false, findings: [] }
    }
  }

  return { scanText, scanFile }
}
