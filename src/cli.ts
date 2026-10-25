#!/usr/bin/env node
// `anon` command line: anonymize / deanonymize / inspect / config / detectors.

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { Command } from 'commander'
import { stringify } from 'yaml'
import { applyCliOverrides, expandHome, loadConfig } from './config.ts'
import type { AnonConfig, CliFlags } from './config.ts'
import { assertLocalUrl, openAiCompatibleChat } from './detectors/llm.ts'
import type { NerChat } from './detectors/llm.ts'
import { onnxCacheStatus } from './detectors/onnx.ts'
import type { OnnxVariant } from './detectors/onnx.ts'
import { KEY_RE, findLedger, ledgerPath, readLedger, saveLedger, sha256, storeDir } from './ledger.ts'
import type { Ledger } from './ledger.ts'
import { anonymize } from './pipeline.ts'
import { restore } from './restore.ts'
import type { Stammdaten } from './types.ts'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

type GlobalOpts = CliFlags & { config?: string }

const program = new Command()

program
  .name('anon')
  .description('Deutsche klinische Texte reversibel anonymisieren (Stammdaten-Regeln, Regex, lokales ONNX-NER, lokales LLM-NER)')
  .version(pkg.version)
  .option('--config <path>', 'Konfigurationsdatei (überschreibt ~/.config/anon/config.yaml und ./anon.config.yaml)')
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
  const { config: configPath, ...flags } = program.opts<GlobalOpts>()
  const loaded = loadConfig({ path: configPath })
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
  .description('Wirksame Konfiguration als YAML ausgeben')
  .action(() =>
    guarded(() => {
      const { config, sources } = effectiveConfig()
      console.log(`# sources: ${sources.join(', ')}`)
      process.stdout.write(stringify(config, { lineWidth: 0 }))
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
