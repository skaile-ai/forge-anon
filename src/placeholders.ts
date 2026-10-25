import { randomBytes, randomInt } from 'node:crypto'
import type { EntityKind } from './types.ts'

export type StyleName = 'semantic' | 'presidio' | 'llm-guard' | 'gemtex'

export const STYLE_NAMES: readonly StyleName[] = ['semantic', 'presidio', 'llm-guard', 'gemtex']

export type PlaceholderStyle = {
  name: StyleName
  /**
   * Global pattern matching any placeholder of this style. Shared and stateful (`lastIndex`):
   * use it with `replace`/`matchAll`, or reset `lastIndex` before `exec`/`test`.
   */
  pattern: RegExp
  /**
   * Builds a placeholder. `semantic` requires `key` (`vorname`, `km`, `person1`, …) and throws without it;
   * the token styles ignore `key` and draw a fresh random token on every call.
   */
  token(kind: EntityKind, key?: string): string
}

export type CreateStyleOptions = {
  /**
   * Random source for the token styles (ignored by `semantic`). Returns the random part verbatim:
   * 8 lowercase hex digits for `presidio`/`llm-guard`, 6 chars of `[A-Z0-9]` for `gemtex`.
   * Default: `crypto.randomBytes` / `crypto.randomInt`. Inject a fixed or colliding generator in tests.
   */
  random?: () => string
}

const GEMTEX_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

const defaultHex8 = (): string => randomBytes(4).toString('hex')
const defaultKey6 = (): string => {
  let s = ''
  for (let i = 0; i < 6; i++) s += GEMTEX_ALPHABET[randomInt(GEMTEX_ALPHABET.length)]
  return s
}

export function createStyle(name: StyleName, opts: CreateStyleOptions = {}): PlaceholderStyle {
  switch (name) {
    case 'semantic':
      return {
        name,
        pattern: /\{\{[^{}]+\}\}/g,
        token(_kind, key) {
          if (!key) throw new Error('semantic style: key required')
          return `{{${key}}}`
        }
      }
    case 'presidio': {
      const random = opts.random ?? defaultHex8
      return { name, pattern: /<[A-Z_]+_[0-9a-f]{8}>/g, token: kind => `<${kind}_${random()}>` }
    }
    case 'llm-guard': {
      const random = opts.random ?? defaultHex8
      return { name, pattern: /\[REDACTED_[A-Z_]+_[0-9a-f]{8}\]/g, token: kind => `[REDACTED_${kind}_${random()}]` }
    }
    case 'gemtex': {
      const random = opts.random ?? defaultKey6
      return { name, pattern: /\[\*\* [A-Z_]+ [A-Z0-9]{6} \*\*\]/g, token: kind => `[** ${kind} ${random()} **]` }
    }
  }
}

export const semanticStyle: PlaceholderStyle = createStyle('semantic')
export const presidioStyle: PlaceholderStyle = createStyle('presidio')
export const llmGuardStyle: PlaceholderStyle = createStyle('llm-guard')
export const gemtexStyle: PlaceholderStyle = createStyle('gemtex')

const STYLES: Record<StyleName, PlaceholderStyle> = {
  semantic: semanticStyle,
  presidio: presidioStyle,
  'llm-guard': llmGuardStyle,
  gemtex: gemtexStyle
}

/** Shared style instance with default (cryptographic) randomness. */
export function getStyle(name: StyleName): PlaceholderStyle {
  return STYLES[name]
}

/** Key prefix for numbered semantic candidates (`{{person1}}`, `{{ort1}}`, …). */
export function candidatePrefix(kind: EntityKind): string {
  if (kind.startsWith('NAME_')) return 'person'
  if (kind.startsWith('DATE')) return 'datum'
  if (kind === 'LOCATION_ORGANIZATION' || kind === 'LOCATION_HOSPITAL') return 'institution'
  if (kind.startsWith('LOCATION_')) return 'ort'
  if (kind.startsWith('CONTACT_')) return 'kontakt'
  if (kind === 'ID') return 'id'
  if (kind === 'AGE') return 'alter'
  if (kind === 'PROFESSION') return 'beruf'
  return 'sonstiges'
}
