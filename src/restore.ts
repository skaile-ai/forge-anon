// De-anonymization: exact restore, lenient restore of LLM-mangled tokens, incremental restore for streams.

import { escapeRe } from './text.ts'

export type RestoreOptions = {
  /**
   * Also restore mangled variants of tokens that carry a random part (`presidio`, `llm-guard`, `gemtex`):
   * missing or HTML-escaped brackets (`NAME_PATIENT_ab12cd34`, `&lt;NAME_PATIENT_ab12cd34&gt;`), upper-case random
   * part. Wrapping (backticks, `**`) stays untouched. `semantic` placeholders are always matched exactly.
   * Default `false`: exact placeholders only.
   */
  lenient?: boolean
}

export type StreamRestorer = {
  /** Appends a chunk; returns the part of the text so far that is final (restored). A possible placeholder prefix at the end is held back. */
  push(chunk: string): string
  /** Returns whatever is still held back (restored) and resets the restorer. */
  flush(): string
}

type EntityLike = { placeholder: string; original: string }

/** Token shapes with a random part: affixes, the core between them, and the length of the random tail. */
type Shape = { opens: string[]; closes: string[]; core: string; randomLen: number }

const SHAPES: { re: RegExp; opens: string[]; closes: string[]; randomLen: number }[] = [
  { re: /^<([A-Z_]+_[0-9a-f]{8})>$/, opens: ['<', '&lt;'], closes: ['>', '&gt;'], randomLen: 8 },
  { re: /^\[(REDACTED_[A-Z_]+_[0-9a-f]{8})\]$/, opens: ['['], closes: [']'], randomLen: 8 },
  { re: /^\[\*\* ([A-Z_]+ [A-Z0-9]{6}) \*\*\]$/, opens: ['[** '], closes: [' **]'], randomLen: 6 }
]

function shapeOf(placeholder: string): Shape | undefined {
  for (const s of SHAPES) {
    const m = placeholder.match(s.re)
    if (m) return { opens: s.opens, closes: s.closes, core: m[1]!, randomLen: s.randomLen }
  }
  return undefined
}

/** Regex source of a core whose last `randomLen` characters match case-insensitively. */
function corePattern(core: string, randomLen: number): string {
  const fold = (c: string) => (c.toLowerCase() !== c.toUpperCase() ? `[${c.toLowerCase()}${c.toUpperCase()}]` : escapeRe(c))
  const cut = core.length - randomLen
  return escapeRe(core.slice(0, cut)) + [...core.slice(cut)].map(fold).join('')
}

const WORD_CHAR = '[A-Za-z0-9_]'
const ALL_OPENS = [...new Set(SHAPES.flatMap(s => s.opens))].map(s => s.toLowerCase()).sort((a, b) => b.length - a.length)
const ALL_CLOSES = [...new Set(SHAPES.flatMap(s => s.closes))].map(s => s.toLowerCase()).sort((a, b) => b.length - a.length)

/** Core (lower case) of a matched lenient token: strips one open and one close affix. */
function coreKey(matched: string): string {
  let s = matched.toLowerCase()
  const open = ALL_OPENS.find(o => s.startsWith(o))
  if (open) s = s.slice(open.length)
  const close = ALL_CLOSES.find(c => s.endsWith(c))
  if (close) s = s.slice(0, -close.length)
  return s
}

type Compiled = {
  /** Restores `text`; `prev`/`next` are the raw characters around it (context for the word-boundary lookbehind/lookahead). */
  apply(text: string, prev: string, next: string): string
  /** Index from which the end of `buf` could still grow into a placeholder; `buf.length` when none. */
  holdFrom(buf: string, prev: string): number
}

function compile(entities: readonly EntityLike[], lenient: boolean): Compiled {
  const exact = new Map<string, string>()
  const loose = new Map<string, string>()
  const parts: { len: number; source: string }[] = []
  const targets: string[] = []

  for (const e of entities) {
    const p = e.placeholder
    if (!p || exact.has(p)) continue
    const shape = lenient ? shapeOf(p) : undefined
    if (shape) {
      const key = shape.core.toLowerCase()
      if (loose.has(key)) continue
      loose.set(key, e.original)
      exact.set(p, e.original)
      const opens = shape.opens.map(escapeRe).join('|')
      const closes = shape.closes.map(escapeRe).join('|')
      // An affix is optional, but then the token must not touch a word character on that side.
      parts.push({
        len: p.length,
        source: `(?:${opens}|(?<!${WORD_CHAR}))${corePattern(shape.core, shape.randomLen)}(?:${closes}|(?!${WORD_CHAR}))`
      })
      for (const o of ['', ...shape.opens]) for (const c of shape.closes) targets.push((o + shape.core + c).toLowerCase())
    } else {
      exact.set(p, e.original)
      parts.push({ len: p.length, source: escapeRe(p) })
      targets.push(p.toLowerCase())
    }
  }

  if (parts.length === 0) return { apply: text => text, holdFrom: buf => buf.length }

  parts.sort((a, b) => b.len - a.len)
  const re = new RegExp(parts.map(x => x.source).join('|'), 'g')
  const firstChars = new Set(targets.map(t => t[0]!))
  const window = Math.max(...targets.map(t => t.length)) - 1

  return {
    apply(text, prev, next) {
      // `prev` and `next` only give the word-boundary lookbehind/lookahead their context; they are not output.
      const s = prev + text + next
      const end = prev.length + text.length
      re.lastIndex = prev.length
      let out = ''
      let pos = prev.length
      for (let m = re.exec(s); m && m.index < end; m = re.exec(s)) {
        out += s.slice(pos, m.index) + (exact.get(m[0]) ?? loose.get(coreKey(m[0])) ?? m[0])
        pos = m.index + m[0].length
      }
      return out + s.slice(pos, end)
    },
    holdFrom(buf, prev) {
      // Positions strictly inside a match of the buffer are no placeholder starts ("name" in `{{km}}_vorname`).
      const s = prev + buf
      const inside = new Uint8Array(buf.length)
      re.lastIndex = prev.length
      for (let m = re.exec(s); m; m = re.exec(s)) {
        const from = m.index - prev.length
        inside.fill(1, from + 1, from + m[0].length)
      }
      for (let i = Math.max(0, buf.length - window); i < buf.length; i++) {
        if (inside[i] || !firstChars.has(buf[i]!.toLowerCase())) continue
        const tail = buf.slice(i).toLowerCase()
        if (targets.some(t => t.length > tail.length && t.startsWith(tail))) return i
      }
      return buf.length
    }
  }
}

/**
 * Replaces every placeholder by its original in one pass (longest placeholder first; first mapping per
 * placeholder wins; replaced text is never rescanned).
 */
export function restore(text: string, entities: readonly EntityLike[], opts: RestoreOptions = {}): string {
  return compile(entities, opts.lenient ?? false).apply(text, '', '')
}

/**
 * Incremental `restore` for streamed text (LLM deltas): for any split of a text into chunks,
 * `push(c1) + … + push(cn) + flush() === restore(text, entities, opts)`.
 */
export function createStreamRestorer(entities: readonly EntityLike[], opts: RestoreOptions = {}): StreamRestorer {
  const compiled = compile(entities, opts.lenient ?? false)
  let buf = ''
  let prev = ''

  function emit(n: number): string {
    if (n === 0) return ''
    const seg = buf.slice(0, n)
    const out = compiled.apply(seg, prev, buf.slice(n, n + 1))
    buf = buf.slice(n)
    prev = seg[seg.length - 1]!
    return out
  }

  return {
    push(chunk) {
      buf += chunk
      return emit(compiled.holdFrom(buf, prev))
    },
    flush() {
      const out = emit(buf.length)
      prev = ''
      return out
    }
  }
}
