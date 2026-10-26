// Markdown-aware protection: detection must never rewrite structural Markdown (fenced/inline code,
// link targets, autolinks). Frontmatter and link text are NOT protected: they can hold PII.

/** Fenced code blocks: ``` or ~~~ … matching closing fence (line anchored). */
const FENCE = /^[ \t]*(`{3,}|~{3,})[\s\S]*?^[ \t]*\1[ \t]*$/gm
/** Inline code: `code` or ``co`de`` (matched backtick run length). */
const INLINE_CODE = /(`+).+?\1/g
/** Link / image URL target: `](<url>)`; only the parenthesised target (capture group 1, at the match end). */
const LINK_TARGET = /\]\(\s*(<?[^)\s]+>?)/g
/** Autolinks `<https://…>` / `<mailto:…>`; only the inner URL (group 1) is protected. */
const AUTOLINK = /<((?:https?|mailto|ftp):[^>\s]+)>/g

export type Range = [start: number, end: number]

/** Sorted, merged `[start, end)` ranges that must not be touched. */
export function protectedSpans(text: string): Range[] {
  const spans: Range[] = []
  for (const m of text.matchAll(FENCE)) spans.push([m.index, m.index + m[0].length])
  for (const m of text.matchAll(INLINE_CODE)) spans.push([m.index, m.index + m[0].length])
  for (const m of text.matchAll(LINK_TARGET)) {
    const g = m[1]!
    spans.push([m.index + m[0].length - g.length, m.index + m[0].length])
  }
  for (const m of text.matchAll(AUTOLINK)) {
    const g = m[1]!
    spans.push([m.index + 1, m.index + 1 + g.length])
  }
  return merge(spans)
}

/**
 * UUID v4 (e.g. editor block ids, `8-4-4-4-12` hex, version nibble 4, variant 8-b, either case) as a standalone token:
 * not when glued to a longer token (email local part or domain, URL path/query, `x-<uuid>`), so protecting block ids
 * never shields part of an email or URL from its own detector.
 * Pass it as `protect` so ids reach the model verbatim instead of being shredded by the IPv6/ID detectors.
 */
export const BLOCK_ID_PATTERN = /(?<![\w.@/%+:=?&#-])[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\w@/%+-]|\.\w)/i

/**
 * Sorted, merged `[start, end)` ranges of every match of the caller-defined `patterns`. Each pattern is cloned with
 * the `g` flag added when missing (other flags kept), so non-global patterns and shared `lastIndex` state are safe.
 * Empty matches are ignored.
 */
export function patternSpans(text: string, patterns: readonly RegExp[]): Range[] {
  const spans: Range[] = []
  for (const pattern of patterns) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[0].length === 0) re.lastIndex++
      else spans.push([m.index, m.index + m[0].length])
    }
  }
  return merge(spans)
}

/** Union of range lists: sorted, overlapping or touching ranges merged. Inputs are not modified. */
export function mergeSpans(...lists: readonly (readonly Range[])[]): Range[] {
  return merge(lists.flatMap(list => list.map((r): Range => [r[0], r[1]])))
}

function merge(spans: Range[]): Range[] {
  if (spans.length === 0) return []
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: Range[] = [spans[0]!]
  for (const [start, end] of spans.slice(1)) {
    const last = merged[merged.length - 1]!
    if (start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

/** True if `[start, end)` intersects any protected span. */
export function overlaps(start: number, end: number, spans: readonly Range[]): boolean {
  return spans.some(([s, e]) => start < e && s < end)
}
