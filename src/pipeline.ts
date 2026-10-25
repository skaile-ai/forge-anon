// Pipeline: detectors -> Markdown filter -> overlap resolution -> placeholders -> replacement (+ round-trip guard).

import type { AnonConfig } from './config.ts'
import { llmDetector } from './detectors/llm.ts'
import type { NerChat } from './detectors/llm.ts'
import { onnxDetector } from './detectors/onnx.ts'
import { regexDetector } from './detectors/regex.ts'
import type { Detector } from './detectors/types.ts'
import { FakeNames } from './fake-names.ts'
import { mergeSpans, overlaps, patternSpans, protectedSpans } from './markdown.ts'
import type { Range } from './markdown.ts'
import { getStyle } from './placeholders.ts'
import { restore } from './restore.ts'
import type { PlaceholderStyle } from './placeholders.ts'
import { addCandidate, buildRules, findRuleHits, residualScan } from './rules.ts'
import type { Candidate } from './rules.ts'
import { AFTER, BEFORE, escapeRe, literal, maskPlaceholders } from './text.ts'
import { kindGroup } from './types.ts'
import type { DetectorName, Entity, EntityKind, Hit, Rule, Span, Stammdaten } from './types.ts'

export type AnonymizeOptions = {
  config: AnonConfig
  stammdaten?: Stammdaten
  markdown?: boolean
  /**
   * Caller-defined protected patterns: every match is left verbatim by every detector (regex, onnx, llm, rules,
   * manual, mapping), with or without `markdown`. A detection that overlaps a match is dropped. Patterns need no
   * `g` flag (it is added on a copy); empty matches are ignored. Use it for structural tokens such as ids.
   */
  protect?: readonly RegExp[]
  /** Required for the `llm` detector (it only runs when `config.detectors.llm.enabled` and `chat` is given). */
  chat?: NerChat
  manual?: { text: string; kind: EntityKind; placeholder?: string }[]
  /**
   * Placeholders already handed out (e.g. earlier turns of one conversation). An original in the mapping keeps
   * its placeholder wherever it occurs, whether or not a detector fires on it; new originals get fresh tokens
   * that collide neither with the text nor with the mapping. `result.entities` is the union (mapping entities
   * absent from this text keep `occurrences: 0`). Matching is on the exact original: another spelling
   * ("MÜLLER" vs "Müller") is a new entity so that `restore` stays exact.
   */
  mapping?: readonly Entity[]
  /** Test injection: token-classification pipeline for the `onnx` detector. */
  onnxPipeline?: unknown
  /** Replaces the config-built detector list (tests/eval). Rules and manual entries still apply. */
  detectors?: Detector[]
  /** Replaces the config style (tests). */
  style?: PlaceholderStyle
}

export type DetectResult = { spans: Span[]; review: Span[]; detectors: DetectorName[] }

export type AnonymizeResult = {
  text: string
  entities: Entity[]
  hits: Hit[]
  review: Span[]
  residual: { term: string; index: number }[]
  detectors: DetectorName[]
}

/** Lower number wins an overlap tie. */
const PRIORITY: Record<DetectorName, number> = { manual: 0, rules: 1, regex: 2, onnx: 3, llm: 4 }

const MAX_ATTEMPTS = 10

function resolveStyle(opts: AnonymizeOptions): PlaceholderStyle {
  return opts.style ?? getStyle(opts.config.placeholders.style)
}

/** Detectors from the config: regex, onnx, llm (llm only with an injected `chat`). */
export function buildDetectors(opts: AnonymizeOptions): Detector[] {
  const { regex, onnx, llm } = opts.config.detectors
  const style = resolveStyle(opts)
  const out: Detector[] = []
  if (regex.enabled) out.push(regexDetector({ entities: regex.entities }))
  if (onnx.enabled) {
    const { enabled: _enabled, ...rest } = onnx
    out.push(onnxDetector({ ...rest, pipeline: opts.onnxPipeline }))
  }
  if (llm.enabled && opts.chat) {
    out.push(llmDetector({
      chat: opts.chat,
      chunkChars: llm.chunkChars,
      overlapChars: llm.overlapChars,
      placeholderPattern: style.pattern
    }))
  }
  return out
}

/** Longest span wins; tie: detector priority, then earlier start. Zero-length spans are dropped. */
function resolveOverlaps(spans: Span[], length: number): Span[] {
  const order = spans
    .filter(s => s.end > s.start)
    .sort((a, b) =>
      (b.end - b.start) - (a.end - a.start) || PRIORITY[a.detector] - PRIORITY[b.detector] || a.start - b.start)
  const taken = new Uint8Array(length)
  const kept: Span[] = []
  for (const s of order) {
    let free = true
    for (let k = s.start; k < s.end; k++) {
      if (taken[k]) { free = false; break }
    }
    if (!free) continue
    taken.fill(1, s.start, s.end)
    kept.push(s)
  }
  return kept.sort((a, b) => a.start - b.start)
}

/** Entities of the mapping, first one per placeholder (restore semantics). */
function uniqueMapping(mapping: readonly Entity[] | undefined): Entity[] {
  const seen = new Set<string>()
  const out: Entity[] = []
  for (const e of mapping ?? []) {
    if (!e.placeholder || seen.has(e.placeholder)) continue
    seen.add(e.placeholder)
    out.push(e)
  }
  return out
}

const WORD_START = /^[\p{L}\p{N}_]/u
const WORD_END = /[\p{L}\p{N}_]$/u

/** One regex over the exact originals of the mapping (longest first); word boundaries only where the original has a word edge. */
function seedMapping(mapping: readonly Entity[] | undefined): { re?: RegExp; byOriginal: Map<string, Entity> } {
  const byOriginal = new Map<string, Entity>()
  for (const e of uniqueMapping(mapping)) if (e.original.trim() && !byOriginal.has(e.original)) byOriginal.set(e.original, e)
  if (byOriginal.size === 0) return { byOriginal }
  const alts = [...byOriginal.keys()]
    .sort((a, b) => b.length - a.length)
    .map(o => `${WORD_START.test(o) ? BEFORE : ''}${escapeRe(o)}${WORD_END.test(o) ? AFTER : ''}`)
  return { re: new RegExp(alts.map(a => `(?:${a})`).join('|'), 'gu'), byOriginal }
}

type Run = { style: PlaceholderStyle; spans: Span[]; review: Span[]; detectors: DetectorName[]; rules: Rule[] }

async function run(text: string, opts: AnonymizeOptions, style: PlaceholderStyle): Promise<Run> {
  const { config, stammdaten } = opts
  const masked = maskPlaceholders(text, style.pattern)
  const ran: DetectorName[] = []
  const all: Span[] = []

  // rules (only with Stammdaten)
  let rules: Rule[] = []
  if (stammdaten && config.detectors.rules.enabled) {
    rules = buildRules(stammdaten)
    ran.push('rules')
    for (const h of findRuleHits(masked, rules)) {
      const rule = rules[h.rule]!
      all.push({
        start: h.start,
        end: h.end,
        text: text.slice(h.start, h.end),
        kind: rule.kind,
        score: 1,
        detector: 'rules',
        placeholder: rule.placeholder
      })
    }
  }

  // regex, onnx, llm
  const detectors = opts.detectors ?? buildDetectors(opts)
  const results = await Promise.all(detectors.map(d => d.detect(text, { masked, stammdaten })))
  detectors.forEach((d, i) => {
    if (!ran.includes(d.name)) ran.push(d.name)
    all.push(...results[i]!)
  })

  // manual
  const manual = (opts.manual ?? []).filter(m => m.text.trim())
  if (manual.length > 0) ran.push('manual')
  for (const m of manual) {
    const re = new RegExp(`${BEFORE}(?:${literal(m.text)})${AFTER}`, 'gu')
    for (const x of masked.matchAll(re)) {
      all.push({
        start: x.index!,
        end: x.index! + x[0].length,
        text: text.slice(x.index!, x.index! + x[0].length),
        kind: m.kind,
        score: 1,
        detector: 'manual',
        placeholder: m.placeholder
      })
    }
  }

  // Known mapping: every exact occurrence of an already tokenised original, with its placeholder. Same rank as
  // `manual`, so on equal length the known placeholder wins; a longer detector span still wins as everywhere.
  const seeded = seedMapping(opts.mapping)
  if (seeded.re) {
    for (const x of masked.matchAll(seeded.re)) {
      const e = seeded.byOriginal.get(x[0])!
      all.push({
        start: x.index!,
        end: x.index! + x[0].length,
        text: x[0],
        kind: e.kind,
        score: 1,
        detector: 'manual',
        placeholder: e.placeholder
      })
    }
  }

  // Protection first: a span inside code or a protected pattern must not suppress a prose span.
  const markdownSpans: Range[] = (opts.markdown ?? false) && config.markdown.protect ? protectedSpans(text) : []
  const protect = mergeSpans(markdownSpans, patternSpans(text, opts.protect ?? []))
  const candidates = protect.length > 0 ? all.filter(s => !overlaps(s.start, s.end, protect)) : all

  // Review kinds are reported, not replaced. Explicit decisions (manual, rules) are never set aside.
  const reviewKinds = new Set<EntityKind>(config.review.kinds)
  const isReview = (s: Span) => reviewKinds.has(s.kind) && s.detector !== 'manual' && s.detector !== 'rules'
  const spans = resolveOverlaps(candidates.filter(s => !isReview(s)), text.length)
  const kept: Range[] = spans.map(s => [s.start, s.end])
  const review = resolveOverlaps(candidates.filter(isReview), text.length).filter(s => !overlaps(s.start, s.end, kept))

  return { style, spans, review, detectors: ran, rules }
}

export async function detect(text: string, opts: AnonymizeOptions): Promise<DetectResult> {
  const r = await run(text, opts, resolveStyle(opts))
  return { spans: r.spans, review: r.review, detectors: r.detectors }
}

// ---------------------------------------------------------------------------
// anonymize

const normalize = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase()

/** All spans that share one placeholder. */
type Unit = {
  key: string
  kind: EntityKind
  detector: DetectorName
  /** Text of the first occurrence. */
  original: string
  firstStart: number
  occurrences: number
  /** Placeholder that is given (rule or explicit manual placeholder). */
  fixed?: string
  /** `fixed` stems from a Stammdaten rule (fake names may replace it). */
  fromRule: boolean
  placeholder: string
}

const NEVER = /(?!)/u

function groupSpans(spans: Span[], rules: Rule[]): { units: Unit[]; unitOf: Unit[] } {
  // Non-rule spans with exactly a rule's original (same kind group) reuse that rule's placeholder.
  // Exact text only: a different spelling ("SOMMERFELD") gets its own placeholder so restore stays exact.
  const seed = new Map<string, string>()
  for (const r of rules) {
    const k = `${kindGroup(r.kind)}|${r.original}`
    if (!seed.has(k)) seed.set(k, r.placeholder)
  }

  const units = new Map<string, Unit>()
  const exactOf = new Map<string, string>()
  const unitOf: Unit[] = []
  for (const s of spans) {
    let key: string
    let fixed: string | undefined
    let fromRule = false
    if (s.placeholder) {
      fixed = s.placeholder
      fromRule = s.detector === 'rules'
      key = `p:${fixed}`
    } else {
      const base = `${kindGroup(s.kind)}|${normalize(s.text)}`
      const seeded = seed.get(`${kindGroup(s.kind)}|${s.text}`)
      if (seeded) {
        fixed = seeded
        fromRule = true
        key = `p:${fixed}`
      } else {
        // One placeholder per normalized text, but a different spelling ("ANNA" vs "Anna") gets its own
        // placeholder so the restore stays exact.
        let first = exactOf.get(base)
        if (first === undefined) {
          first = s.text
          exactOf.set(base, first)
        }
        key = first === s.text ? base : `${base}|${s.text}`
      }
    }
    let u = units.get(key)
    if (!u) {
      u = {
        key, kind: s.kind, detector: s.detector, original: s.text, firstStart: s.start,
        occurrences: 0, fixed, fromRule, placeholder: ''
      }
      units.set(key, u)
    }
    u.occurrences++
    unitOf.push(u)
  }
  return { units: [...units.values()], unitOf }
}

function assignSemantic(units: Unit[], rules: Rule[], mapping: readonly Entity[], style: PlaceholderStyle): void {
  const registry: Rule[] = [
    ...rules,
    ...mapping.map(e => ({ placeholder: e.placeholder, original: e.original, kind: e.kind, pattern: NEVER, source: e.detector }))
  ]
  const known = new Set(registry.map(r => r.placeholder))
  for (const u of units) {
    if (u.fixed) {
      u.placeholder = u.fixed
      if (!known.has(u.fixed)) {
        registry.push({ placeholder: u.fixed, original: u.original, kind: u.kind, pattern: NEVER, source: u.detector })
        known.add(u.fixed)
      }
      continue
    }
    const cand: Candidate = { text: u.original, kind: u.kind, source: u.detector as Candidate['source'] }
    const rule = addCandidate(registry, cand, style)
    u.placeholder = rule.placeholder
    if (!known.has(rule.placeholder)) {
      registry.push(rule)
      known.add(rule.placeholder)
    }
  }
}

function assignTokens(units: Unit[], text: string, style: PlaceholderStyle, fakeNames: boolean, taken: ReadonlySet<string>): void {
  const fake = fakeNames ? new FakeNames(text) : undefined
  const used = new Set<string>(taken)
  for (const u of units) {
    let p: string | undefined
    if (fake && kindGroup(u.kind) === 'NAME' && (u.fixed === undefined || u.fromRule)) {
      const f = fake.replacement(u.original, text.slice(Math.max(0, u.firstStart - 12), u.firstStart))
      if (f !== u.original && !used.has(f)) p = f
    }
    p ??= u.fixed ?? style.token(u.kind)
    // A drawn token must not be one the mapping already owns.
    if (u.fixed === undefined) for (let i = 0; i < MAX_ATTEMPTS && taken.has(p); i++) p = style.token(u.kind)
    u.placeholder = p
    used.add(p)
  }
}

export async function anonymize(text: string, opts: AnonymizeOptions): Promise<AnonymizeResult> {
  const style = resolveStyle(opts)
  const fakeNames = opts.config.placeholders.fakeNames
  if (fakeNames && style.name === 'semantic') throw new Error('fakeNames ist mit style=semantic nicht kombinierbar')

  const known = uniqueMapping(opts.mapping)
  const taken = new Set(known.map(e => e.placeholder))
  const inText = known.find(e => text.includes(e.placeholder))
  if (inText) throw new Error(`Platzhalter-Kollision: ${inText.placeholder} kommt bereits im Quelltext vor`)

  const r = await run(text, opts, style)
  const { units, unitOf } = groupSpans(r.spans, r.rules)

  for (let attempt = 1; ; attempt++) {
    if (style.name === 'semantic') assignSemantic(units, r.rules, known, style)
    else assignTokens(units, text, style, fakeNames, taken)

    const collided = units.filter(u => text.includes(u.placeholder))
    const found = units.map((u): Entity => ({
      placeholder: u.placeholder, original: u.original, kind: u.kind, detector: u.detector, occurrences: u.occurrences
    }))
    // Union: the mapping (this text's occurrence counts, 0 when absent) followed by the new entities.
    const counts = new Map(found.map(e => [e.placeholder, e.occurrences]))
    const entities: Entity[] = [
      ...known.map(e => ({ ...e, occurrences: counts.get(e.placeholder) ?? 0 })),
      ...found.filter(e => !taken.has(e.placeholder))
    ]

    let out = ''
    let expected = ''
    let pos = 0
    const hits: Hit[] = []
    r.spans.forEach((s, i) => {
      const u = unitOf[i]!
      const gap = text.slice(pos, s.start)
      out += gap + u.placeholder
      expected += gap + u.original
      hits.push({ placeholder: u.placeholder, original: s.text, start: s.start, end: s.end })
      pos = s.end
    })
    out += text.slice(pos)
    expected += text.slice(pos)

    if (collided.length === 0 && restore(out, entities) === expected) {
      return {
        text: out,
        entities,
        hits,
        review: r.review,
        residual: opts.stammdaten ? residualScan(out, opts.stammdaten, style) : [],
        detectors: r.detectors
      }
    }

    // A given placeholder (rule/manual) cannot be redrawn, and semantic keys are deterministic.
    const stuck = collided.find(u => u.fixed !== undefined && !(u.fromRule && fakeNames && kindGroup(u.kind) === 'NAME'))
    const fatal = style.name === 'semantic' || stuck !== undefined
    if (fatal || attempt >= MAX_ATTEMPTS) {
      const hit = stuck ?? collided[0]
      if (fatal && hit) throw new Error(`Platzhalter-Kollision: ${hit.placeholder} kommt bereits im Quelltext vor`)
      throw new Error(`Round-Trip fehlgeschlagen nach ${attempt} Versuchen`)
    }
  }
}
