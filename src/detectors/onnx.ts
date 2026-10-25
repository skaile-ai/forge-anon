import { existsSync } from 'node:fs'
import path from 'node:path'
import { expandHome } from '../config.ts'
import { kindGroup } from '../types.ts'
import type { EntityKind, Span } from '../types.ts'
import { alignedPipeline } from './align.ts'
import type { DetectContext, Detector } from './types.ts'

export type OnnxVariant = 'int8' | 'fp16' | 'fp32'

export type OnnxOptions = {
  model: string
  variant: OnnxVariant
  device: 'cpu' | 'webgpu'
  threshold: number
  chunkChars: number
  localFilesOnly: boolean
  cacheDir: string
  entities: EntityKind[]
  /** Test injection: a token-classification pipeline that replaces model loading. */
  pipeline?: unknown
}

export const ONNX_DEFAULTS: Required<Omit<OnnxOptions, 'pipeline'>> = {
  model: 'OpenMed/OpenMed-PII-German-SuperClinical-Small-44M-v1-onnx-android',
  variant: 'fp16',
  device: 'cpu',
  threshold: 0.3,
  // The model truncates silently at 512 tokens; German clinical prose is ~2.9 chars/token,
  // numbers and abbreviations tokenise denser, so 900 chars keeps a safe margin.
  chunkChars: 900,
  localFilesOnly: false,
  cacheDir: '~/.cache/forge-anon/models',
  entities: [
    'NAME_EXT', 'DATE_BIRTH', 'DATE', 'AGE', 'CONTACT_EMAIL', 'CONTACT_PHONE', 'CONTACT_URL', 'CONTACT_IP',
    'LOCATION_CITY', 'LOCATION_STATE', 'LOCATION_STREET', 'LOCATION_ZIP', 'LOCATION_OTHER',
    'LOCATION_ORGANIZATION', 'PROFESSION', 'ID',
  ],
}

/** The slice of the `openmed` package this detector uses (structural, so tests can fake it). */
export type OpenmedModule = {
  extractPii(text: string, options?: { pipeline?: unknown; threshold?: number }): Promise<OpenmedSpan[]>
  loadOnnxModel(
    model: string,
    options?: { variant?: OnnxVariant; device?: string; localFilesOnly?: boolean; runtime?: unknown },
  ): Promise<unknown>
}

export type OpenmedSpan = {
  start: number
  end: number
  entity_type: string
  canonical_label?: string
  score: number | null
}

export type OnnxDetectorOptions = Partial<OnnxOptions> & {
  /** Test injection: replaces `import('openmed')`. */
  loader?: () => Promise<OpenmedModule>
  /**
   * Called once per model call that left tokens without a place in the text (they are treated as
   * label `O`; the document is still processed). The message carries counts only, never text.
   */
  onWarning?: (message: string) => void
}

const MISSING_PACKAGES =
  'ONNX-Detektor: Pakete "openmed" und "@huggingface/transformers" fehlen (npm i openmed @huggingface/transformers) – oder detectors.onnx.enabled=false setzen'

const MODEL_FILE: Record<OnnxVariant, string> = { int8: 'model_int8.onnx', fp16: 'model_fp16.onnx', fp32: 'model.onnx' }
const MODEL_SIDE_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json']

/**
 * `hit` when the model files are on disk under `cacheDir`. Plain fs check: transformers' own
 * `ModelRegistry.is_pipeline_cached` expects `onnx/model.onnx`, which `-onnx-android` repos lack.
 */
export function onnxCacheStatus(
  opts: { model?: string; variant?: OnnxVariant; cacheDir?: string } = {},
): 'hit' | 'missing' {
  const model = opts.model ?? ONNX_DEFAULTS.model
  const variant = opts.variant ?? ONNX_DEFAULTS.variant
  const cacheDir = expandHome(opts.cacheDir ?? ONNX_DEFAULTS.cacheDir)
  const dir = path.join(cacheDir, ...model.split('/'))
  const files = [...MODEL_SIDE_FILES, MODEL_FILE[variant]]
  return files.every(f => existsSync(path.join(dir, f))) ? 'hit' : 'missing'
}

// ---- kind mapping -------------------------------------------------------------------------

const NAME_PART = /^(?:FIRST|LAST|MIDDLE)_?NAME$/i

const KIND_MAP: Record<string, EntityKind> = {}
function map(kind: EntityKind, labels: string): void {
  for (const l of labels.split(' ')) KIND_MAP[l] = kind
}
map('NAME_EXT', 'FIRSTNAME LASTNAME MIDDLENAME FIRST_NAME LAST_NAME MIDDLE_NAME PERSON ACCOUNTNAME')
map('DATE_BIRTH', 'DATEOFBIRTH DATE_OF_BIRTH')
map('DATE', 'DATE')
map('AGE', 'AGE')
map('CONTACT_EMAIL', 'EMAIL')
map('CONTACT_PHONE', 'PHONE')
map('CONTACT_URL', 'URL')
map('CONTACT_IP', 'IPADDRESS IP_ADDRESS')
map('LOCATION_CITY', 'CITY')
map('LOCATION_STATE', 'STATE COUNTY')
map('LOCATION_STREET', 'STREET BUILDINGNUMBER SECONDARYADDRESS STREET_ADDRESS BUILDING_NUMBER')
map('LOCATION_ZIP', 'ZIPCODE')
map('LOCATION_OTHER', 'LOCATION GPSCOORDINATES GPS_COORDINATES')
map('LOCATION_ORGANIZATION', 'ORGANIZATION JOBDEPARTMENT JOB_DEPARTMENT')
map('PROFESSION', 'JOBTITLE JOB_TITLE OCCUPATION')
map(
  'ID',
  'SSN IBAN BIC BANKACCOUNT ACCOUNT_NUMBER CREDITCARD CREDIT_CARD IMEI VIN VRM VEHICLE_REGISTRATION ' +
    'USERNAME PASSWORD PIN CVV MACADDRESS MAC_ADDRESS MASKEDNUMBER MASKED_NUMBER ID_NUM API_KEY',
)


// ---- chunking -----------------------------------------------------------------------------

type Seg = { start: number; end: number }

function splitBy(text: string, seg: Seg, sep: RegExp): Seg[] {
  const out: Seg[] = []
  const slice = text.slice(seg.start, seg.end)
  let last = 0
  for (const m of slice.matchAll(sep)) {
    if (m.index > last) out.push({ start: seg.start + last, end: seg.start + m.index })
    last = m.index + m[0].length
  }
  if (last < slice.length) out.push({ start: seg.start + last, end: seg.end })
  return out
}

function hardSplit(text: string, seg: Seg, limit: number): Seg[] {
  const out: Seg[] = []
  let start = seg.start
  while (seg.end - start > limit) {
    let cut = start + limit
    const ws = text.lastIndexOf(' ', cut)
    if (ws > start) cut = ws + 1
    else if (/[\uD800-\uDBFF]/.test(text[cut - 1] ?? '')) cut -= 1
    out.push({ start, end: cut })
    start = cut
  }
  if (start < seg.end) out.push({ start, end: seg.end })
  return out
}

/** Paragraph-packed chunk ranges of at most `limit` chars; sentence split, then hard split, for oversized units. */
export function chunkRanges(text: string, limit: number): Seg[] {
  const units: Seg[] = []
  for (const para of splitBy(text, { start: 0, end: text.length }, /\n[ \t\r]*\n/g)) {
    if (para.end - para.start <= limit) {
      units.push(para)
      continue
    }
    for (const sentence of splitBy(text, para, /(?<=[.!?])\s+/g)) {
      if (sentence.end - sentence.start <= limit) units.push(sentence)
      else units.push(...hardSplit(text, sentence, limit))
    }
  }
  const chunks: Seg[] = []
  for (const unit of units) {
    const cur = chunks[chunks.length - 1]
    if (cur && unit.end - cur.start <= limit) cur.end = unit.end
    else chunks.push({ ...unit })
  }
  return chunks.filter(c => text.slice(c.start, c.end).trim() !== '')
}

// ---- post-processing ----------------------------------------------------------------------

type Item = { start: number; end: number; kind: EntityKind; score: number; namePart: boolean }

const LETTER = /\p{L}/u
const NAME_GAP = /^[^\S\r\n]+$/
const DATE_GAP = /^[./-]\s?$/

function extendToWord(masked: string, it: Item): void {
  while (it.start > 0 && LETTER.test(masked[it.start - 1]!)) it.start--
  while (it.end < masked.length && LETTER.test(masked[it.end]!)) it.end++
}

function isDate(kind: EntityKind): boolean {
  return kind === 'DATE' || kind === 'DATE_BIRTH'
}

function mergeItems(items: Item[], masked: string): Item[] {
  const out: Item[] = []
  for (const it of items) {
    const prev = out[out.length - 1]
    if (prev) {
      const gap = it.start <= prev.end ? '' : masked.slice(prev.end, it.start)
      const overlaps = it.start < prev.end
      const names = prev.namePart && it.namePart && (overlaps || NAME_GAP.test(gap))
      const dates = prev.kind === it.kind && isDate(it.kind) && (overlaps || DATE_GAP.test(gap))
      if (names || dates) {
        prev.end = Math.max(prev.end, it.end)
        prev.score = Math.min(prev.score, it.score)
        prev.namePart = prev.namePart && it.namePart
        if (names) prev.kind = 'NAME_EXT'
        continue
      }
    }
    out.push({ ...it })
  }
  return out
}

function trim(text: string, it: Item): boolean {
  const date = isDate(it.kind)
  const lead = /^[\s([{"'«„‚]+/u
  const trail = date ? /[\s,;:]+$/u : /[\s.,;:!?)\]}"'»“”‘’-]+$/u
  let s = text.slice(it.start, it.end)
  s = s.replace(lead, (m) => { it.start += m.length; return '' })
  s = s.replace(trail, (m) => { it.end -= m.length; return '' })
  return it.end > it.start
}

// ---- detector -----------------------------------------------------------------------------

// openmed and @huggingface/transformers are optionalDependencies: they are imported lazily on
// first use (static imports would crash at load time when absent and drag onnxruntime into bundles).
export function onnxDetector(opts: OnnxDetectorOptions = {}): Detector {
  const defined = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as OnnxDetectorOptions
  const cfg = { ...ONNX_DEFAULTS, ...defined }
  const allowed = new Set<EntityKind>(cfg.entities)
  const cacheDir = expandHome(cfg.cacheDir)
  const loader = opts.loader ?? (() => import('openmed') as unknown as Promise<OpenmedModule>)

  let ready: Promise<{ mod: OpenmedModule; pipeline: unknown }> | undefined

  // Transformers.js emits tokens without offsets and openmed's own aligner throws on any token it
  // cannot find, so every pipeline is wrapped by our aligner, which drops such tokens instead.
  const report = ({ unaligned }: { unaligned: unknown[] }): void => {
    opts.onWarning?.(`ONNX: ${unaligned.length} Token(s) ohne Textposition als O behandelt`)
  }

  async function load(): Promise<{ mod: OpenmedModule; pipeline: unknown }> {
    let mod: OpenmedModule
    try {
      mod = await loader()
    } catch {
      throw new Error(MISSING_PACKAGES)
    }
    if (cfg.pipeline !== undefined) return { mod, pipeline: alignedPipeline(cfg.pipeline, report) }
    let transformers: typeof import('@huggingface/transformers')
    try {
      transformers = await import('@huggingface/transformers')
      transformers.env.cacheDir = cacheDir
    } catch {
      throw new Error(MISSING_PACKAGES)
    }
    // openmed's loader wraps whatever `runtime.pipeline` returns in its (throwing) aligner; ours
    // already supplies offsets, so its pass-through branch is taken.
    const runtime = {
      env: transformers.env,
      pipeline: async (...args: unknown[]) =>
        alignedPipeline(await (transformers.pipeline as (...a: unknown[]) => Promise<unknown>)(...args), report),
    }
    try {
      const pipeline = await mod.loadOnnxModel(cfg.model, {
        variant: cfg.variant,
        device: cfg.device,
        localFilesOnly: cfg.localFilesOnly,
        runtime,
      })
      return { mod, pipeline }
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      if (/Install @huggingface\/transformers/i.test(msg)) throw new Error(MISSING_PACKAGES)
      if (cfg.localFilesOnly && /local_files_only|allowRemoteModels|not found locally/i.test(msg)) {
        throw new Error(`Modell ${cfg.model} nicht im Cache (${cacheDir}); einmal mit localFilesOnly=false laden`)
      }
      throw e
    }
  }

  function ensure(): Promise<{ mod: OpenmedModule; pipeline: unknown }> {
    ready ??= load().catch((e) => {
      ready = undefined
      throw e
    })
    return ready
  }

  return {
    name: 'onnx',
    async detect(text: string, ctx: DetectContext): Promise<Span[]> {
      const masked = ctx.masked
      const chunks = chunkRanges(masked, cfg.chunkChars)
      if (chunks.length === 0) return []
      const { mod, pipeline } = await ensure()

      const items: Item[] = []
      for (const chunk of chunks) {
        const raw = await mod.extractPii(masked.slice(chunk.start, chunk.end), {
          pipeline,
          threshold: cfg.threshold,
        })
        for (const r of raw) {
          const rawType = r.entity_type.toUpperCase()
          const kind = KIND_MAP[rawType] ?? (r.canonical_label ? KIND_MAP[r.canonical_label.toUpperCase()] : undefined)
          if (!kind || !allowed.has(kind)) continue
          items.push({
            start: chunk.start + r.start,
            end: chunk.start + r.end,
            kind,
            score: r.score ?? 0,
            namePart: NAME_PART.test(r.entity_type),
          })
        }
      }

      for (const it of items) if (kindGroup(it.kind) === 'NAME') extendToWord(masked, it)
      items.sort((a, b) => a.start - b.start || a.end - b.end)

      const spans: Span[] = []
      for (const it of mergeItems(items, masked)) {
        if (!trim(masked, it)) continue
        spans.push({
          start: it.start,
          end: it.end,
          text: text.slice(it.start, it.end),
          kind: it.kind,
          score: it.score,
          detector: 'onnx',
        })
      }
      return spans
    },
  }
}
