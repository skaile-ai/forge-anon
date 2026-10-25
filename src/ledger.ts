// Private entity ledger store: one YAML file per run (`<key>.yaml`) holding placeholder -> original.
// The ledger contains PII: the directory is 0700, each file 0600.

import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { parse, stringify } from 'yaml'
import { expandHome } from './config.ts'
import { STYLE_NAMES, type StyleName } from './placeholders.ts'
import { ENTITY_KINDS } from './types.ts'
import type { DetectorName, Entity, EntityKind } from './types.ts'

export const LEDGER_VERSION = 4

export const KEY_RE = /^[0-9a-f]{32}$/

export type Ledger = {
  version: number
  key: string
  sourceFile: string
  created: string
  style: StyleName
  fakeNames: boolean
  detectors: DetectorName[]
  checksumSource: string
  checksumAnon: string
  entities: Entity[]
}

const DETECTOR_NAMES: readonly DetectorName[] = ['rules', 'regex', 'onnx', 'llm', 'manual']

export function defaultStoreDir(): string {
  return join(homedir(), '.local', 'share', 'forge-anon', 'ledgers')
}

/** `$ANON_LEDGER_DIR` (`~` expanded) or `~/.local/share/forge-anon/ledgers`. */
export function storeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ANON_LEDGER_DIR?.trim()
  return override ? expandHome(override) : defaultStoreDir()
}

export function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/** Path of the ledger for `key` (may not exist). Rejects malformed keys. */
export function ledgerPath(key: string, dir: string = storeDir()): string {
  if (!KEY_RE.test(key)) throw new Error(`Ungültiger Ledger-Key: ${key}`)
  return join(dir, `${key}.yaml`)
}

export type SaveLedgerInput = {
  sourceFile: string
  style: StyleName
  fakeNames: boolean
  detectors: DetectorName[]
  sourceText: string
  anonText: string
  entities: Entity[]
  /** Ledger directory; default `storeDir()`. */
  dir?: string
  /** ISO timestamp override (deterministic tests); default now, second precision. */
  created?: string
}

/** Write a new ledger into the store; returns its key and path. */
export function saveLedger(input: SaveLedgerInput): { key: string; path: string } {
  const dir = input.dir ? expandHome(input.dir) : storeDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // The default store lives in `~/.local/share/forge-anon`; only there is the parent ours to lock down.
  if (dir === defaultStoreDir()) chmodSync(dirname(dir), 0o700)
  chmodSync(dir, 0o700)

  const key = randomUUID().replaceAll('-', '')
  const path = ledgerPath(key, dir)
  const doc = {
    version: LEDGER_VERSION,
    key,
    source_file: input.sourceFile,
    created: input.created ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    style: input.style,
    fake_names: input.fakeNames,
    detectors: input.detectors,
    checksum_source: sha256(input.sourceText),
    checksum_anon: sha256(input.anonText),
    entities: input.entities.map(e => ({
      placeholder: e.placeholder,
      original: e.original,
      kind: e.kind,
      detector: e.detector,
      occurrences: e.occurrences
    }))
  }
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeSync(fd, stringify(doc, { sortMapEntries: false, lineWidth: 0 }))
  } finally {
    closeSync(fd)
  }
  return { key, path }
}

function readDoc(path: string): Record<string, unknown> | undefined {
  try {
    const doc: unknown = parse(readFileSync(path, 'utf8'))
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** Ledger whose `checksum_anon` matches `anonText`; the latest `created` wins. Null when none. */
export function findLedger(anonText: string, dir: string = storeDir()): string | null {
  if (!existsSync(dir)) return null
  const want = sha256(anonText)
  let best: { created: string; path: string } | undefined
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.yaml')) continue
    const path = join(dir, name)
    const doc = readDoc(path)
    if (!doc || doc.checksum_anon !== want) continue
    const created = String(doc.created ?? '')
    if (!best || created > best.created) best = { created, path }
  }
  return best?.path ?? null
}

/** Entity types written by the Python tool (Presidio) -> current kinds. */
const LEGACY_KINDS: Record<string, EntityKind> = {
  PERSON: 'NAME_EXT',
  EMAIL_ADDRESS: 'CONTACT_EMAIL',
  PHONE_NUMBER: 'CONTACT_PHONE',
  URL: 'CONTACT_URL',
  IP_ADDRESS: 'CONTACT_IP',
  DATE_TIME: 'DATE',
  LOCATION: 'LOCATION_OTHER',
  ORGANIZATION: 'LOCATION_ORGANIZATION',
  IBAN_CODE: 'ID'
}

function toKind(raw: unknown): EntityKind {
  const s = String(raw ?? '')
  return (ENTITY_KINDS as readonly string[]).includes(s) ? (s as EntityKind) : (LEGACY_KINDS[s] ?? 'OTHER')
}

function toDetector(raw: unknown): DetectorName {
  return DETECTOR_NAMES.find(d => d === raw) ?? 'manual'
}

function toEntity(raw: unknown, path: string): Entity {
  if (!raw || typeof raw !== 'object') throw new Error(`Ledger ungültig (${path}): Entität ist kein Objekt`)
  const e = raw as Record<string, unknown>
  if (typeof e.placeholder !== 'string' || typeof e.original !== 'string') {
    throw new Error(`Ledger ungültig (${path}): Entität ohne placeholder/original`)
  }
  return {
    placeholder: e.placeholder,
    original: e.original,
    // Ledgers of the Python tool carry `entity_type`; missing fields get neutral defaults.
    kind: toKind(e.kind ?? e.entity_type),
    detector: toDetector(e.detector),
    occurrences: typeof e.occurrences === 'number' ? e.occurrences : 0
  }
}

/** Read a ledger file. Legacy ledgers (`entity_type`, no `style`/`detectors`) stay readable. */
export function readLedger(path: string): Ledger {
  const doc = readDoc(path)
  if (!doc) throw new Error(`Ledger ungültig (${path}): kein YAML-Objekt`)
  const entities = Array.isArray(doc.entities) ? doc.entities.map(e => toEntity(e, path)) : []
  const stem = basename(path, '.yaml')
  return {
    version: typeof doc.version === 'number' ? doc.version : LEDGER_VERSION,
    key: typeof doc.key === 'string' && doc.key ? doc.key : stem,
    sourceFile: String(doc.source_file ?? ''),
    created: String(doc.created ?? ''),
    style: STYLE_NAMES.find(s => s === doc.style) ?? 'presidio',
    fakeNames: Boolean(doc.fake_names),
    detectors: Array.isArray(doc.detectors) ? doc.detectors.map(toDetector) : [],
    checksumSource: String(doc.checksum_source ?? ''),
    checksumAnon: String(doc.checksum_anon ?? ''),
    entities
  }
}
