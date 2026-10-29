// Session: one cumulative placeholder mapping across many texts (a conversation); detectors are built once.

import type { Detector } from './detectors/types.ts'
import { anonymize, buildDetectors } from './pipeline.ts'
import type { AnonymizeOptions, AnonymizeResult } from './pipeline.ts'
import { createStreamRestorer, restore } from './restore.ts'
import type { StreamRestorer } from './restore.ts'
import type { Entity } from './types.ts'

export type AnonSessionOptions = Omit<AnonymizeOptions, 'mapping' | 'manual'>

export type AnonSession = {
  /** Cumulative mapping of all texts anonymized so far (`occurrences` summed over the calls). */
  readonly entities: readonly Entity[]
  /**
   * Anonymizes `text` with the session mapping: known originals keep their placeholder, new ones extend it. Calls run one after another.
   *
   * An identical text is anonymized once per mapping generation (bounded LRU, 512 texts): a repeat call returns the earlier
   * result object and adds no `occurrences`, so a conversation that resends its history every turn does not re-run the detectors.
   * The cache is cleared whenever the mapping gains a placeholder, because a text anonymized before an original became known
   * could still carry it (known originals are matched by exact text, without a detector hit).
   */
  anonymize(text: string): Promise<AnonymizeResult>
  /** Lenient restore (also LLM-mangled placeholders) with the current mapping. */
  restore(text: string): string
  /** Incremental lenient restore bound to the current mapping (entities added later are not known to it). */
  streamRestorer(): StreamRestorer
}

/**
 * German system instruction for a model that sees anonymized text: placeholders stand for real values, copy them
 * verbatim. The default of the AI SDK decorator and of the workspaces model endpoint's anonymizing transform.
 */
export const ANON_SYSTEM =
  'Platzhalter wie NAME_PATIENT_xxxx oder DATE_BIRTH_xxxx stehen für echte Werte. Übernimm sie wörtlich und unverändert; rate nicht, was dahintersteht.'

const CACHE_LIMIT = 512

export function createAnonSession(opts: AnonSessionOptions): AnonSession {
  // Built once: the ONNX model loads on first use and is reused by every call of the session.
  const detectors: Detector[] = opts.detectors ?? buildDetectors(opts)
  const byPlaceholder = new Map<string, Entity>()
  const cache = new Map<string, AnonymizeResult>()
  let entities: readonly Entity[] = []
  let tail: Promise<unknown> = Promise.resolve()

  function merge(result: AnonymizeResult): void {
    // `result.entities` is the union of the session mapping and the new entities, counted for this text.
    for (const e of result.entities) {
      const known = byPlaceholder.get(e.placeholder)
      byPlaceholder.set(e.placeholder, known ? { ...known, occurrences: known.occurrences + e.occurrences } : e)
    }
    entities = [...byPlaceholder.values()]
  }

  return {
    get entities() {
      return entities
    },
    anonymize(text) {
      // Serialised: two overlapping calls must not both draw tokens for the same new original.
      const next = tail.then(async () => {
        const hit = cache.get(text)
        if (hit) {
          cache.delete(text)
          cache.set(text, hit) // LRU touch
          return hit
        }
        const result = await anonymize(text, { ...opts, detectors, mapping: entities })
        const known = byPlaceholder.size
        merge(result)
        if (byPlaceholder.size !== known) cache.clear() // a new original may hide in older texts: re-anonymize them next time
        cache.set(text, result)
        if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
        return result
      })
      tail = next.catch(() => undefined)
      return next
    },
    restore: text => restore(text, entities, { lenient: true }),
    streamRestorer: () => createStreamRestorer(entities, { lenient: true })
  }
}
