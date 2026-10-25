import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { STYLE_NAMES } from './placeholders.ts'
import { ENTITY_KINDS } from './types.ts'

const EntityKindSchema = z.enum(ENTITY_KINDS)
const StyleSchema = z.enum(STYLE_NAMES as [string, ...string[]]) as z.ZodType<(typeof STYLE_NAMES)[number]>

const DETECTOR_NAMES = ['rules', 'regex', 'onnx', 'llm'] as const

export const AnonConfigSchema = z.strictObject({
  detectors: z.strictObject({
    rules: z.strictObject({ enabled: z.boolean() }),
    regex: z.strictObject({ enabled: z.boolean(), entities: z.array(EntityKindSchema) }),
    onnx: z.strictObject({
      enabled: z.boolean(),
      model: z.string().min(1),
      variant: z.enum(['int8', 'fp16', 'fp32']),
      device: z.enum(['cpu', 'webgpu']),
      threshold: z.number().min(0).max(1),
      chunkChars: z.number().int().positive(),
      localFilesOnly: z.boolean(),
      cacheDir: z.string().min(1),
      entities: z.array(EntityKindSchema),
    }),
    llm: z.strictObject({
      enabled: z.boolean(),
      baseUrl: z.string().min(1),
      model: z.string().min(1),
      apiKeyEnv: z.string().min(1),
      timeoutMs: z.number().int().positive(),
      chunkChars: z.number().int().positive(),
      overlapChars: z.number().int().min(0),
    }),
  }),
  placeholders: z.strictObject({ style: StyleSchema, fakeNames: z.boolean() }),
  review: z.strictObject({ kinds: z.array(EntityKindSchema) }),
  markdown: z.strictObject({ protect: z.boolean() }),
  ledger: z.strictObject({ dir: z.string().min(1), save: z.boolean() }),
})

export type AnonConfig = z.infer<typeof AnonConfigSchema>

export const DEFAULT_CONFIG: AnonConfig = {
  detectors: {
    rules: { enabled: true },
    regex: {
      enabled: true,
      entities: [
        'CONTACT_EMAIL',
        'CONTACT_PHONE',
        'CONTACT_FAX',
        'CONTACT_URL',
        'CONTACT_IP',
        'ID',
        'DATE',
        'AGE',
        'NAME_EXT',
      ],
    },
    onnx: {
      enabled: true,
      model: 'OpenMed/OpenMed-PII-German-SuperClinical-Small-44M-v1-onnx-android',
      variant: 'fp16',
      device: 'cpu',
      threshold: 0.3,
      chunkChars: 900,
      localFilesOnly: false,
      cacheDir: '~/.cache/forge-anon/models',
      entities: [
        'NAME_EXT',
        'DATE_BIRTH',
        'DATE',
        'AGE',
        'CONTACT_EMAIL',
        'CONTACT_PHONE',
        'CONTACT_URL',
        'CONTACT_IP',
        'LOCATION_CITY',
        'LOCATION_STATE',
        'LOCATION_STREET',
        'LOCATION_ZIP',
        'LOCATION_OTHER',
        'LOCATION_ORGANIZATION',
        'PROFESSION',
        'ID',
      ],
    },
    llm: {
      enabled: false,
      baseUrl: 'http://127.0.0.1:8000/v1',
      model: 'mlx-community--gemma-4-26b-a4b-it-8bit',
      apiKeyEnv: 'ANON_LLM_API_KEY',
      timeoutMs: 120000,
      chunkChars: 3000,
      overlapChars: 300,
    },
  },
  placeholders: { style: 'presidio', fakeNames: false },
  review: { kinds: ['AGE', 'PROFESSION', 'OTHER'] },
  markdown: { protect: true },
  ledger: { dir: '~/.local/share/forge-anon/ledgers', save: false },
}

export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === '~') return home
  if (p.startsWith('~/')) return path.join(home, p.slice(2))
  return p
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Objects merge recursively; arrays and scalars in `over` replace. Returns a new value. */
function deepMerge(base: unknown, over: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(over)) {
    const out: Record<string, unknown> = { ...base }
    for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v
    return out
  }
  return structuredClone(over)
}

function validate(value: unknown, where: string): AnonConfig {
  const r = AnonConfigSchema.safeParse(value)
  if (!r.success) {
    const issues = r.error.issues
      .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
      .join('; ')
    throw new Error(`Konfiguration ungültig (${where}): ${issues}`)
  }
  return r.data
}

function readLayer(file: string): unknown {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    throw new Error(`Konfiguration ungültig (${file}): ${(e as Error).message}`)
  }
  let doc: unknown
  try {
    doc = parseYaml(raw)
  } catch (e) {
    throw new Error(`Konfiguration ungültig (${file}): ${(e as Error).message}`)
  }
  if (doc === null || doc === undefined) return {}
  if (!isPlainObject(doc)) throw new Error(`Konfiguration ungültig (${file}): Wurzel muss ein Objekt sein`)
  return doc
}

function expandPaths(config: AnonConfig, home: string): AnonConfig {
  return {
    ...config,
    detectors: {
      ...config.detectors,
      onnx: { ...config.detectors.onnx, cacheDir: expandHome(config.detectors.onnx.cacheDir, home) },
    },
    ledger: { ...config.ledger, dir: expandHome(config.ledger.dir, home) },
  }
}

export type LoadConfigOptions = {
  path?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  home?: string
}

/** Layers, lowest first: defaults → `<home>/.config/forge-anon/config.yaml` → `<cwd>/anon.config.yaml` → explicit path / `ANON_CONFIG`. */
export function loadConfig(opts: LoadConfigOptions = {}): { config: AnonConfig; sources: string[] } {
  const home = opts.home ?? os.homedir()
  const cwd = opts.cwd ?? process.cwd()
  const env = opts.env ?? process.env
  const explicitRaw = opts.path ?? env.ANON_CONFIG
  const explicit = explicitRaw ? path.resolve(cwd, expandHome(explicitRaw, home)) : undefined

  const candidates: { file: string; required: boolean }[] = [
    { file: path.join(home, '.config', 'forge-anon', 'config.yaml'), required: false },
    { file: path.join(cwd, 'anon.config.yaml'), required: false },
  ]
  if (explicit) candidates.push({ file: explicit, required: true })

  let merged: unknown = structuredClone(DEFAULT_CONFIG)
  const sources = ['defaults']
  for (const { file, required } of candidates) {
    if (!fs.existsSync(file)) {
      if (required) throw new Error(`Konfiguration nicht gefunden: ${file}`)
      continue
    }
    // Validate each layer on top of the lower ones so errors name the offending file.
    merged = validate(deepMerge(merged, readLayer(file)), file)
    sources.push(file)
  }
  return { config: expandPaths(validate(merged, 'defaults'), home), sources }
}

export type CliFlags = {
  detectors?: string
  regex?: boolean
  onnx?: boolean
  llm?: boolean
  onnxModel?: string
  onnxVariant?: string
  onnxDevice?: string
  threshold?: number | string
  llmUrl?: string
  llmModel?: string
  entities?: string
  style?: string
  fakeNames?: boolean
  mdAware?: boolean
}

function splitList(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

/** Pure: maps CLI flags onto a config copy and re-validates it. */
export function applyCliOverrides(config: AnonConfig, flags: CliFlags): AnonConfig {
  const c = structuredClone(config)

  if (flags.detectors !== undefined) {
    const names = splitList(flags.detectors)
    const bad = names.filter((n) => !(DETECTOR_NAMES as readonly string[]).includes(n))
    if (bad.length) {
      throw new Error(`Unbekannte Detektoren: ${bad.join(', ')}. Erlaubt: ${DETECTOR_NAMES.join(', ')}`)
    }
    for (const n of DETECTOR_NAMES) c.detectors[n].enabled = names.includes(n)
  }
  if (flags.regex === false) c.detectors.regex.enabled = false
  if (flags.onnx === false) c.detectors.onnx.enabled = false
  if (flags.llm === false) c.detectors.llm.enabled = false

  if (flags.onnxModel !== undefined) c.detectors.onnx.model = flags.onnxModel
  if (flags.onnxVariant !== undefined) c.detectors.onnx.variant = flags.onnxVariant as AnonConfig['detectors']['onnx']['variant']
  if (flags.onnxDevice !== undefined) c.detectors.onnx.device = flags.onnxDevice as AnonConfig['detectors']['onnx']['device']
  if (flags.threshold !== undefined) {
    const t = Number(flags.threshold)
    if (!Number.isFinite(t) || t < 0 || t > 1) throw new Error(`Ungültiger Schwellenwert: ${flags.threshold}. Erlaubt: 0..1`)
    c.detectors.onnx.threshold = t
  }
  if (flags.llmUrl !== undefined) c.detectors.llm.baseUrl = flags.llmUrl
  if (flags.llmModel !== undefined) c.detectors.llm.model = flags.llmModel

  if (flags.entities !== undefined) {
    const kinds = splitList(flags.entities)
    const bad = kinds.filter((k) => !(ENTITY_KINDS as readonly string[]).includes(k))
    if (bad.length) {
      throw new Error(`Unbekannte Entity-Kinds: ${bad.join(', ')}. Erlaubt: ${ENTITY_KINDS.join(', ')}`)
    }
    c.detectors.regex.entities = kinds as AnonConfig['detectors']['regex']['entities']
    c.detectors.onnx.entities = kinds as AnonConfig['detectors']['onnx']['entities']
  }

  if (flags.style !== undefined) c.placeholders.style = flags.style as AnonConfig['placeholders']['style']
  if (flags.fakeNames !== undefined) c.placeholders.fakeNames = flags.fakeNames
  if (flags.mdAware !== undefined) c.markdown.protect = flags.mdAware

  return validate(c, 'CLI-Optionen')
}
