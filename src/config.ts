import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { STYLE_NAMES } from './placeholders.ts'
import { ENTITY_KINDS } from './types.ts'
import { PROTECT_PRESETS } from './protect.ts'

const EntityKindSchema = z.enum(ENTITY_KINDS)
const StyleSchema = z.enum(STYLE_NAMES as [string, ...string[]]) as z.ZodType<(typeof STYLE_NAMES)[number]>

const DETECTOR_NAMES = ['rules', 'regex', 'onnx', 'llm'] as const

const ProtectPatternSchema = z.string().superRefine((s, ctx) => {
  try {
    new RegExp(s, 'u')
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: `Ungültiges Muster ${JSON.stringify(s)}: ${(err as Error).message}` })
  }
})

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]*$/

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
  protect: z.strictObject({
    patterns: z.array(ProtectPatternSchema),
    presets: z.array(z.enum(PROTECT_PRESETS)).optional(),
  }),
  scan: z.strictObject({
    extensions: z.array(z.string().regex(/^[a-z0-9]+$/, 'Endung ohne Punkt, klein geschrieben')),
    exclude: z.array(z.string().min(1)),
    hidden: z.boolean(),
    maxBytes: z.number().int().positive(),
    flagKinds: z.array(EntityKindSchema),
    publicFilter: z.boolean(),
  }),
  /** Profile applied on top of the config files (`--profile` and `$ANON_PROFILE` win). */
  profile: z.string().regex(PROFILE_NAME).optional(),
  /** Named partial configs; `description` is shown by `anon profiles` and not merged. */
  profiles: z.record(z.string().regex(PROFILE_NAME, 'Profilname: a-z, 0-9, - und _'), z.record(z.string(), z.unknown())),
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
  protect: { patterns: [] },
  scan: {
    extensions: [
      'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'xml', 'html', 'htm', 'eml', 'log',
      'yaml', 'yml', 'tex', 'srt', 'vtt', 'pdf', 'docx', 'odt', 'xlsx', 'ods', 'pptx',
    ],
    exclude: ['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target'],
    hidden: false,
    maxBytes: 50_000_000,
    flagKinds: [
      'NAME_PATIENT', 'NAME_RELATIVE', 'NAME_DOCTOR', 'NAME_EXT', 'DATE_BIRTH', 'DATE_DEATH', 'LOCATION_STREET',
      'ID', 'CONTACT_PHONE', 'CONTACT_EMAIL', 'CONTACT_FAX',
    ],
    publicFilter: false,
  },
  // Measured choices, see README "Profiles": `fast` takes the int8 weights (GraSCCo regex+onnx recall 82.7 %,
  // corpus 10 s vs 15 s) and no LLM; `good` takes fp16 (onnx recall 81.3 vs 78.6 %) and the public-figure
  // filter with qwen3:8b, the smallest model that kept Scholz/Macron apart from private persons (qwen3:4b did not).
  profiles: {
    fast: {
      description: 'regex + ONNX int8, kein LLM: ganze Verzeichnisbäume',
      detectors: { onnx: { enabled: true, variant: 'int8' }, llm: { enabled: false } },
      scan: { publicFilter: false },
    },
    good: {
      description: 'regex + ONNX fp16 + Öffentlich-Filter (Ollama qwen3:8b): gezielte Ordner',
      detectors: {
        onnx: { enabled: true, variant: 'fp16' },
        llm: { enabled: false, baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' },
      },
      scan: { publicFilter: true },
    },
  },
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
  /** Profile name; wins over `$ANON_PROFILE` and the `profile` key. Empty string: no profile. */
  profile?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  home?: string
}

export function homeConfigPath(home: string = os.homedir()): string {
  return path.join(home, '.config', 'forge-anon', 'config.yaml')
}

/** Written by `anon config --init`: selects `fast` and spells out both profiles so they can be edited in place. */
export const HOME_CONFIG_TEMPLATE = `# forge-anon: Einstellungen für alle Aufrufe dieses Benutzers.
# Schichten: Standardwerte → diese Datei → ./anon.config.yaml → --config → Profil → CLI-Optionen.
# Profil wählen: hier \`profile:\`, oder ANON_PROFILE=good, oder anon --profile good …
# Wirksame Konfiguration: anon config   Profile: anon profiles

profile: fast

scan:
  # Verzeichnisnamen, die nirgends betreten werden (ersetzt die Standardliste).
  exclude: [.git, node_modules, .venv, venv, __pycache__, dist, build, target,
            Library, Applications, Movies, Music, Pictures, Public]
  hidden: false          # .dateien und .ordner unterhalb der Startpfade überspringen

profiles:
  fast:
    description: "regex + ONNX int8, kein LLM: ganze Verzeichnisbäume"
    detectors:
      onnx: { enabled: true, variant: int8 }
      llm: { enabled: false }
    scan: { publicFilter: false }
  good:
    description: "regex + ONNX fp16 + Öffentlich-Filter (Ollama qwen3:8b): gezielte Ordner"
    detectors:
      onnx: { enabled: true, variant: fp16 }
      llm: { enabled: false, baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3:8b" }
    scan: { publicFilter: true }
`

/**
 * Merges profile `name` onto `config`. A profile is a partial config; it may not select or define profiles,
 * and its `description` is not merged.
 */
export function applyProfile(config: AnonConfig, name: string): AnonConfig {
  const body = config.profiles[name]
  if (!body) {
    const known = Object.keys(config.profiles)
    throw new Error(`Unbekanntes Profil: ${name}. Vorhanden: ${known.length ? known.join(', ') : '(keine)'}`)
  }
  const { description: _description, ...rest } = body
  if ('profile' in rest || 'profiles' in rest) throw new Error(`Profil "${name}" darf profile/profiles nicht setzen`)
  return validate({ ...(deepMerge(config, rest) as AnonConfig), profile: name }, `Profil "${name}"`)
}

/**
 * Layers, lowest first: defaults → `<home>/.config/forge-anon/config.yaml` → `<cwd>/anon.config.yaml` →
 * explicit path / `ANON_CONFIG` → the selected profile (`opts.profile` → `$ANON_PROFILE` → `profile` key).
 */
export function loadConfig(opts: LoadConfigOptions = {}): { config: AnonConfig; sources: string[] } {
  const home = opts.home ?? os.homedir()
  const cwd = opts.cwd ?? process.cwd()
  const env = opts.env ?? process.env
  const explicitRaw = opts.path ?? env.ANON_CONFIG
  const explicit = explicitRaw ? path.resolve(cwd, expandHome(explicitRaw, home)) : undefined

  const candidates: { file: string; required: boolean }[] = [
    { file: homeConfigPath(home), required: false },
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
  let config = validate(merged, 'defaults')
  const profile = opts.profile ?? env.ANON_PROFILE ?? config.profile
  if (profile) {
    config = applyProfile(config, profile)
    sources.push(`profile:${profile}`)
  } else {
    delete config.profile
  }
  return { config: expandPaths(config, home), sources }
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
