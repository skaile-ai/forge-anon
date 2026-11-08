#!/usr/bin/env node
// `anon` command line: anonymize / deanonymize / inspect / config / profiles / scan / detectors.

import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { Command } from 'commander'
import { stringify } from 'yaml'
import { HOME_CONFIG_TEMPLATE, applyCliOverrides, expandHome, homeConfigPath, loadConfig } from './config.ts'
import type { AnonConfig, CliFlags } from './config.ts'
import { assertLocalUrl, openAiCompatibleChat } from './detectors/llm.ts'
import type { NerChat } from './detectors/llm.ts'
import { onnxCacheStatus } from './detectors/onnx.ts'
import type { OnnxVariant } from './detectors/onnx.ts'
import { KEY_RE, findLedger, ledgerPath, readLedger, saveLedger, sha256, storeDir } from './ledger.ts'
import type { Ledger } from './ledger.ts'
import { anonymize } from './pipeline.ts'
import { createScanner, walkFiles } from './scan.ts'
import type { ScanFileResult } from './scan.ts'
import { restore } from './restore.ts'
import type { Stammdaten } from './types.ts'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

type GlobalOpts = CliFlags & { config?: string; profile?: string }

const program = new Command()

program
  .name('anon')
  .description('Deutsche klinische Texte reversibel anonymisieren (Stammdaten-Regeln, Regex, lokales ONNX-NER, lokales LLM-NER)')
  .version(pkg.version)
  .option('--config <path>', 'Konfigurationsdatei (überschreibt ~/.config/forge-anon/config.yaml und ./anon.config.yaml)')
  .option('--profile <name>', 'Profil aus profiles anwenden (überschreibt ANON_PROFILE und profile; "" = keins)')
  .option('--detectors <list>', 'Detektoren, kommagetrennt aus rules,regex,onnx,llm (setzt enabled exakt)')
  .option('--no-regex', 'Regex-Detektor abschalten')
  .option('--no-onnx', 'ONNX-Detektor abschalten')
  .option('--no-llm', 'LLM-Detektor abschalten')
  .option('--onnx-model <id>', 'ONNX-Modell (Hugging-Face-ID)')
  .option('--onnx-variant <variant>', 'ONNX-Variante: int8|fp16|fp32')
  .option('--onnx-device <device>', 'ONNX-Gerät: cpu|webgpu')
  .option('--threshold <0..1>', 'ONNX-Schwellenwert')
  .option('--llm-url <url>', 'Basis-URL des lokalen OpenAI-kompatiblen LLM-Servers')
  .option('--llm-model <name>', 'LLM-Modellname')
  .option('--entities <list>', 'Entity-Kinds, kommagetrennt (gilt für Regex und ONNX)')
  .option('--style <style>', 'Token-Stil: semantic|presidio|llm-guard|gemtex')
  .option('-f, --fake-names', 'Namen durch erfundene Namen ersetzen')
  .option('--md-aware', 'Markdown-Code und Link-Ziele schützen (Standard laut Konfiguration)')
  .option('--no-md-aware', 'Markdown nicht gesondert behandeln')

// ---- helpers --------------------------------------------------------------------------------

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Runs a command body; a thrown error prints `Fehler: …` and exits with 1. The body returns its exit code. */
async function guarded(fn: () => Promise<number | void> | number | void): Promise<void> {
  try {
    const code = await fn()
    if (code) process.exitCode = Math.max(Number(process.exitCode ?? 0), code)
  } catch (e) {
    console.error(`Fehler: ${errMessage(e)}`)
    process.exitCode = Math.max(Number(process.exitCode ?? 0), 1)
  }
}

/** Config with file layers and CLI flags applied. */
function effectiveConfig(): { config: AnonConfig; sources: string[] } {
  const { config: configPath, profile, ...flags } = program.opts<GlobalOpts>()
  const loaded = loadConfig({ path: configPath, profile })
  return { config: applyCliOverrides(loaded.config, flags), sources: loaded.sources }
}

/** `$ANON_LEDGER_DIR` wins over `ledger.dir`. */
function ledgerDir(config: AnonConfig): string {
  return process.env.ANON_LEDGER_DIR ? storeDir() : expandHome(config.ledger.dir)
}

function writePrivate(path: string, content: string): void {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 })
  chmodSync(path, 0o600)
}

function loadStammdaten(arg: string): Stammdaten {
  const raw = arg.trimStart().startsWith('{') ? arg : readFileSync(arg, 'utf8')
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch (e) {
    throw new Error(`Stammdaten sind kein gültiges JSON: ${errMessage(e)}`)
  }
  const s = doc as Partial<Stammdaten> | null
  if (!s || typeof s !== 'object' || typeof s.vorname !== 'string' || typeof s.nachname !== 'string') {
    throw new Error('Stammdaten brauchen mindestens "vorname" und "nachname" (Strings)')
  }
  return s as Stammdaten
}

function buildChat(config: AnonConfig): NerChat | undefined {
  const llm = config.detectors.llm
  if (!llm.enabled) return undefined
  return openAiCompatibleChat({
    baseUrl: llm.baseUrl,
    model: llm.model,
    apiKey: process.env[llm.apiKeyEnv],
    timeoutMs: llm.timeoutMs,
  })
}

// ---- anonymize ------------------------------------------------------------------------------

program
  .command('anonymize')
  .description('Dateien anonymisieren; schreibt <name>.anon<ext> (Modus 0600)')
  .argument('<files...>', 'Markdown-/Textdateien')
  .option('-s, --store-entities', 'Ledger speichern (nötig zum Wiederherstellen)')
  .option('--stammdaten <json>', 'Stammdaten (Pfad zu einer JSON-Datei oder Inline-JSON): aktiviert Regeln und Restprüfung')
  .option('--out-dir <dir>', 'Ausgabeverzeichnis (Standard: neben der Quelldatei)')
  .action((files: string[], opts: { storeEntities?: boolean; stammdaten?: string; outDir?: string }) =>
    guarded(async () => {
      const { config } = effectiveConfig()
      const stammdaten = opts.stammdaten ? loadStammdaten(opts.stammdaten) : undefined
      const chat = buildChat(config)
      const store = Boolean(opts.storeEntities) || config.ledger.save
      const dir = ledgerDir(config)
      let exit = 0

      for (const file of files) {
        try {
          const text = readFileSync(file, 'utf8')
          const ext = extname(file)
          const markdown = config.markdown.protect && /\.(md|markdown)$/i.test(file)
          const result = await anonymize(text, { config, stammdaten, markdown, chat })

          const outPath = join(opts.outDir ?? dirname(file), `${basename(file, ext)}.anon${ext}`)
          writePrivate(outPath, result.text)

          const n = result.entities.length
          if (store) {
            const { key } = saveLedger({
              sourceFile: basename(file),
              style: config.placeholders.style,
              fakeNames: config.placeholders.fakeNames,
              detectors: result.detectors,
              sourceText: text,
              anonText: result.text,
              entities: result.entities,
              dir,
            })
            console.log(`✓ ${file}: ${n} Entitäten → ${outPath}  (Ledger-Key: ${key})`)
          } else {
            console.log(`✓ ${file}: ${n} Entitäten → ${outPath}  (kein Ledger – nicht umkehrbar; -s zum Speichern)`)
          }
          for (const s of result.review) console.log(`⚠ Prüfen (${s.kind}): "${s.text}" @ ${s.start}`)
          for (const r of result.residual) console.log(`⚠ Rest: "${r.term}" @ ${r.index}`)
          if (result.residual.length) exit = Math.max(exit, 2)
        } catch (e) {
          console.error(`✗ ${file}: ${errMessage(e)}`)
          exit = Math.max(exit, 1)
        }
      }
      return exit
    }),
  )

// ---- deanonymize ----------------------------------------------------------------------------

function deanonPath(anonFile: string): string {
  const ext = extname(anonFile)
  let stem = basename(anonFile, ext)
  if (stem.endsWith('.anon')) stem = stem.slice(0, -'.anon'.length)
  return join(dirname(anonFile), `${stem}.deanon${ext}`)
}

program
  .command('deanonymize')
  .description('Anonymisierte Datei über das Ledger wiederherstellen; schreibt <name>.deanon<ext>')
  .argument('<anonFile>', 'anonymisierte Datei')
  .option('-k, --key <key>', 'Ledger-Key (Standard: Suche über die Prüfsumme)')
  .option('-o, --out <path>', 'Ausgabedatei')
  .option('--no-verify', 'Prüfsummen nicht prüfen')
  .action((anonFile: string, opts: { key?: string; out?: string; verify: boolean }) =>
    guarded(() => {
      const { config } = effectiveConfig()
      const dir = ledgerDir(config)
      const anonText = readFileSync(anonFile, 'utf8')

      let ledger: Ledger
      if (opts.key) ledger = ledgerByKey(opts.key, dir)
      else {
        const found = findLedger(anonText, dir)
        if (!found) throw new Error(noLedger(dir))
        ledger = readLedger(found)
      }
      if (opts.verify && sha256(anonText) !== ledger.checksumAnon) {
        console.error('Warnung: Prüfsumme der anonymisierten Datei weicht vom Ledger ab (Datei wurde nach der Anonymisierung geändert).')
      }
      const restored = restore(anonText, ledger.entities)
      if (opts.verify && sha256(restored) !== ledger.checksumSource) {
        console.error('Warnung: Prüfsumme des wiederhergestellten Textes weicht vom Original ab.')
      }

      const outPath = opts.out ?? deanonPath(anonFile)
      writePrivate(outPath, restored)
      console.log(`✓ ${anonFile}: ${ledger.entities.length} Entitäten → ${outPath}`)
    }),
  )

// ---- inspect --------------------------------------------------------------------------------

const noLedger = (dir: string) => `Kein Ledger zu dieser Datei gefunden (${dir}); mit -k <key> angeben`

function ledgerByKey(key: string, dir: string): Ledger {
  const path = ledgerPath(key, dir)
  if (!existsSync(path)) throw new Error(`Ledger nicht gefunden: ${path}`)
  return readLedger(path)
}

function resolveLedger(arg: string, dir: string): Ledger {
  if (KEY_RE.test(arg)) return ledgerByKey(arg, dir)
  if (!existsSync(arg)) throw new Error(`Weder Ledger-Key noch Datei: ${arg}`)
  const byChecksum = findLedger(readFileSync(arg, 'utf8'), dir)
  if (byChecksum) return readLedger(byChecksum)
  if (/\.ya?ml$/i.test(arg)) return readLedger(arg)
  throw new Error(noLedger(dir))
}

program
  .command('inspect')
  .description('Ledger als Tabelle anzeigen')
  .argument('<keyOrFile>', 'Ledger-Key (32 Hex), anonymisierte Datei oder Ledger-YAML')
  .action((arg: string) =>
    guarded(() => {
      const { config } = effectiveConfig()
      const l = resolveLedger(arg, ledgerDir(config))
      console.log(`key:        ${l.key}`)
      console.log(`source:     ${l.sourceFile}`)
      console.log(`created:    ${l.created}`)
      console.log(`style:      ${l.style}`)
      console.log(`fake_names: ${l.fakeNames}`)
      console.log(`detectors:  ${l.detectors.join(', ')}`)
      console.log('')
      const rows = [
        ['PLACEHOLDER', 'KIND', 'DETECTOR', 'OCC', 'ORIGINAL'],
        ...l.entities.map(e => [e.placeholder, e.kind, e.detector, String(e.occurrences), e.original.replace(/\s+/g, ' ')]),
      ]
      const widths = [0, 1, 2, 3].map(i => Math.max(...rows.map(r => r[i]!.length)))
      for (const r of rows) {
        console.log([...widths.map((w, i) => r[i]!.padEnd(w)), r[4]!].join('  '))
      }
    }),
  )

// ---- config ---------------------------------------------------------------------------------

program
  .command('config')
  .description('Wirksame Konfiguration als YAML ausgeben; --init legt ~/.config/forge-anon/config.yaml an')
  .option('--init', 'Benutzerkonfiguration mit den Profilen fast und good anlegen')
  .option('--force', 'mit --init: vorhandene Datei überschreiben')
  .action((opts: { init?: boolean; force?: boolean }) =>
    guarded(() => {
      if (opts.init) {
        const file = homeConfigPath()
        if (existsSync(file) && !opts.force) throw new Error(`${file} existiert bereits (--force überschreibt)`)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, HOME_CONFIG_TEMPLATE, 'utf8')
        console.log(`angelegt: ${file}`)
        return
      }
      const { config, sources } = effectiveConfig()
      console.log(`# sources: ${sources.join(', ')}`)
      process.stdout.write(stringify(config, { lineWidth: 0 }))
    }),
  )

// ---- profiles -------------------------------------------------------------------------------

program
  .command('profiles')
  .description('Profile auflisten; * markiert das aktive')
  .action(() =>
    guarded(() => {
      const { config } = effectiveConfig()
      const names = Object.keys(config.profiles)
      if (names.length === 0) console.log('(keine Profile)')
      const width = Math.max(...names.map(n => n.length))
      for (const n of names) {
        const desc = config.profiles[n]?.description
        console.log(`${n === config.profile ? '*' : ' '} ${n.padEnd(width)}  ${typeof desc === 'string' ? desc : ''}`.trimEnd())
      }
    }),
  )

// ---- scan -----------------------------------------------------------------------------------

const SCAN_FORMATS = ['text', 'jsonl', 'csv'] as const

type ScanCliOpts = {
  format: string
  out?: string
  filesWithMatches?: boolean
  ext?: string
  publicFilter?: boolean
  hidden?: boolean
  verbose?: boolean
}

const csvCell = (v: unknown): string => {
  const s = v === undefined ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Text report of one file: kinds with counts, then each distinct finding with its lines. */
function scanTextReport(r: ScanFileResult, verbose: boolean): string[] {
  if (r.status !== 'ok') return verbose && r.status === 'skipped' ? [`- ${r.path}: übersprungen (${r.reason})`] : []
  const shown = r.findings.filter(f => verbose || f.level === 'pii')
  if (!r.pii && !verbose) return []
  const counts = new Map<string, number>()
  for (const f of r.findings) if (f.level === 'pii') counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1)
  const summary = [...counts].map(([k, n]) => `${k} ${n}`).join(', ')
  const lines = [r.pii ? `● ${r.path}  ${summary}` : `○ ${r.path}  keine PII`]
  const distinct = new Map<string, { kind: string; text: string; level: string; lines: number[] }>()
  for (const f of shown) {
    const key = `${f.kind}\u0000${f.text}`
    const d = distinct.get(key) ?? { kind: f.kind, text: f.text, level: f.level, lines: [] }
    if (!d.lines.includes(f.line)) d.lines.push(f.line)
    distinct.set(key, d)
  }
  for (const d of distinct.values()) {
    const tag = d.level === 'pii' ? '' : `  [${d.level === 'public' ? 'öffentlich' : 'Kontext'}]`
    const at = d.lines.length > 5 ? `${d.lines.slice(0, 5).join(', ')} …` : d.lines.join(', ')
    lines.push(`    ${d.kind.padEnd(22)} ${JSON.stringify(d.text.replace(/\s+/g, ' '))}  Z. ${at}${tag}`)
  }
  return lines
}

program
  .command('scan')
  .description('Dateien und Verzeichnisse rekursiv nach personenbezogenen Daten durchsuchen (nur Bericht, ändert nichts)')
  .argument('<paths...>', 'Dateien oder Verzeichnisse')
  .option('--format <format>', `Ausgabe: ${SCAN_FORMATS.join('|')}`, 'text')
  .option('-o, --out <file>', 'Bericht in diese Datei schreiben (Modus 0600) statt auf stdout')
  .option('-l, --files-with-matches', 'nur die Pfade der Dateien mit PII ausgeben')
  .option('--ext <list>', 'Dateiendungen, kommagetrennt, ohne Punkt (ersetzt scan.extensions)')
  .option('--public-filter', 'Personen des öffentlichen Lebens über das lokale LLM aussortieren (detectors.llm.baseUrl/model)')
  .option('--no-public-filter', 'Öffentlich-Filter abschalten')
  .option('--hidden', 'auch .dateien und .ordner durchsuchen (scan.hidden)')
  .option('-v, --verbose', 'auch Dateien ohne PII, übersprungene Dateien, Kontext- und öffentliche Funde zeigen')
  .action((paths: string[], opts: ScanCliOpts) =>
    guarded(async () => {
      if (!(SCAN_FORMATS as readonly string[]).includes(opts.format)) {
        throw new Error(`Unbekanntes Format: ${opts.format}. Erlaubt: ${SCAN_FORMATS.join(', ')}`)
      }
      const { config } = effectiveConfig()
      if (opts.ext !== undefined) {
        config.scan.extensions = opts.ext.split(',').map(e => e.trim().replace(/^\./, '').toLowerCase()).filter(Boolean)
      }
      if (opts.hidden) config.scan.hidden = true
      const llm = config.detectors.llm
      const usePublicFilter = opts.publicFilter ?? config.scan.publicFilter
      // Every file would fail one by one against a dead endpoint; fail once, up front.
      if (usePublicFilter || llm.enabled) {
        const state = await llmReachable(llm.baseUrl, process.env[llm.apiKeyEnv])
        if (state !== 'yes') {
          throw new Error(`LLM ${llm.baseUrl} (${llm.model}) nicht erreichbar${state === 'unauthorized' ? `: API-Key fehlt oder falsch ($${llm.apiKeyEnv})` : ''}; Server starten, --no-public-filter/--no-llm oder --profile fast`)
        }
      }
      const publicFilter = usePublicFilter
        ? openAiCompatibleChat({ baseUrl: llm.baseUrl, model: llm.model, apiKey: process.env[llm.apiKeyEnv], timeoutMs: llm.timeoutMs })
        : undefined
      const scanner = createScanner({ config, chat: buildChat(config), publicFilter })

      // Progress line on an interactive stderr only; cleared before anything else is printed to the terminal.
      const tty = Boolean(process.stderr.isTTY)
      let shown = false
      let lastProgress = 0
      const clearProgress = () => {
        if (shown) process.stderr.write('\r\x1b[K')
        shown = false
      }
      const progress = (n: number, path: string) => {
        const now = Date.now()
        if (!tty || now - lastProgress < 200) return
        lastProgress = now
        const width = (process.stderr.columns ?? 100) - 12
        const p = path.length > width ? `…${path.slice(-(width - 1))}` : path
        process.stderr.write(`\r\x1b[K[${n}] ${p}`)
        shown = true
      }

      const fd = opts.out ? openSync(opts.out, 'w', 0o600) : 1
      if (opts.out) chmodSync(opts.out, 0o600)
      const emit = (line: string) => {
        if (fd === 1) clearProgress()
        writeSync(fd, `${line}\n`)
      }
      if (opts.format === 'csv' && !opts.filesWithMatches) {
        emit('path,status,reason,kind,level,text,line,start,end,detector,score')
      }

      const started = Date.now()
      const tally = { files: 0, pii: 0, skipped: 0, errors: 0 }
      try {
        for await (const entry of walkFiles(paths, config.scan)) {
          progress(tally.files + 1, entry.path)
          const r: ScanFileResult = entry.skip
            ? { path: entry.path, status: 'skipped', reason: entry.skip, chars: 0, pii: false, findings: [] }
            : await scanner.scanFile(entry.path)
          tally.files++
          if (r.pii) tally.pii++
          if (r.status === 'skipped') tally.skipped++
          if (r.status === 'error') {
            tally.errors++
            clearProgress()
            console.error(`✗ ${r.path}: ${r.reason}`)
          }

          if (opts.filesWithMatches) {
            if (r.pii) emit(r.path)
          } else if (opts.format === 'jsonl') {
            emit(JSON.stringify(r))
          } else if (opts.format === 'csv') {
            const head = [r.path, r.status, r.reason]
            if (r.findings.length === 0) emit([...head, '', '', '', '', '', '', '', ''].map(csvCell).join(','))
            for (const f of r.findings) {
              emit([...head, f.kind, f.level, f.text, f.line, f.start, f.end, f.detector, f.score.toFixed(2)].map(csvCell).join(','))
            }
          } else {
            for (const line of scanTextReport(r, Boolean(opts.verbose))) emit(line)
          }
        }
      } finally {
        if (opts.out) closeSync(fd)
        clearProgress()
      }

      const secs = ((Date.now() - started) / 1000).toFixed(1)
      const scanned = tally.files - tally.skipped - tally.errors
      console.error(
        `${tally.files} Dateien: ${tally.pii} mit PII, ${scanned - tally.pii} ohne, ${tally.skipped} übersprungen, ${tally.errors} Fehler (${secs} s)`,
      )
      return Math.max(tally.errors > 0 ? 1 : 0, tally.pii > 0 ? 2 : 0)
    }),
  )

// ---- detectors ------------------------------------------------------------------------------

async function packagesInstalled(): Promise<boolean> {
  // Optional dependencies: a static import would make the whole CLI fail when they are not installed.
  try {
    await import('openmed')
    await import('@huggingface/transformers')
    return true
  } catch {
    return false
  }
}

async function llmReachable(baseUrl: string, apiKey?: string): Promise<'yes' | 'no' | 'unauthorized'> {
  try {
    assertLocalUrl(baseUrl)
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(3000)
    })
    if (res.status === 401 || res.status === 403) return 'unauthorized'
    return res.ok ? 'yes' : 'no'
  } catch {
    return 'no'
  }
}

program
  .command('detectors')
  .description('Detektoren, Modell-Cache und LLM-Erreichbarkeit anzeigen')
  .action(() =>
    guarded(async () => {
      const { regex, onnx, llm, rules } = effectiveConfig().config.detectors
      const on = (b: boolean) => (b ? 'enabled' : 'disabled')
      console.log(`rules  ${on(rules.enabled)}${rules.enabled ? '  (nur mit --stammdaten)' : ''}`)
      console.log(`regex  ${on(regex.enabled)}`)
      if (!onnx.enabled) {
        console.log(`onnx   ${on(false)}`)
      } else {
        const state = (await packagesInstalled())
          ? `cache=${onnxCacheStatus({ model: onnx.model, variant: onnx.variant as OnnxVariant, cacheDir: onnx.cacheDir })}`
          : 'packages missing'
        console.log(`onnx   ${on(true)}  model=${onnx.model} ${state}`)
      }
      if (!llm.enabled) {
        console.log(`llm    ${on(false)}`)
      } else {
        const state = await llmReachable(llm.baseUrl, process.env[llm.apiKeyEnv])
        const hint = state === 'unauthorized' ? ` (API-Key fehlt oder falsch: $${llm.apiKeyEnv})` : ''
        console.log(`llm    ${on(true)}  url=${llm.baseUrl} reachable=${state}${hint}`)
      }
    }),
  )

await program.parseAsync()
// onnxruntime / pending fetch handles must not keep the process alive after the command finished.
process.exit(Number(process.exitCode ?? 0))
