import type { AnonConfig } from './config.ts'

export const PROTECT_PRESETS = ['dev'] as const
export type ProtectPreset = (typeof PROTECT_PRESETS)[number]

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const LOOPBACK4 = `(?:127(?:\\.${OCTET}){3}|0\\.0\\.0\\.0)`
const PORT = '(?::\\d{1,5})?'

/** Regexes of one preset. */
export const PRESET_PATTERNS: Readonly<Record<ProtectPreset, readonly RegExp[]>> = {
  dev: [
    // Loopback / unspecified IPv4, optional port; not glued to neighbouring digits or dots.
    new RegExp(`(?<![\\w.])${LOOPBACK4}${PORT}(?!\\d|\\.\\d)`),
    // IPv6 loopback / unspecified, optional port for the bracketed form.
    /(?<![\w:.\]])(?:\[::1?\](?::\d{1,5})?|::1)(?![\w:])/,
    // localhost with optional port.
    /\blocalhost(?::\d{1,5})?\b/,
    // http(s) URLs on a local host; trailing sentence punctuation stays outside.
    new RegExp(
      `\\bhttps?://(?:localhost|${LOOPBACK4}|\\[::1\\])${PORT}(?:[/?#][^\\s<>()"']*?)?(?=[.,;:!?]*(?:[\\s<>()"']|$))`,
    ),
    // Docker/compose port maps; only a loopback/unspecified host is part of the span.
    new RegExp(
      `(?<![\\d.])(?:(?:${LOOPBACK4}|\\[::1?\\]):)?\\d{1,5}(?:-\\d{1,5})?->\\d{1,5}(?:-\\d{1,5})?/(?:tcp|udp|sctp)\\b`,
    ),
    // Container image references with at least one slash and a tag.
    /(?<![A-Za-z0-9./])[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}/,
  ],
}

/** The presets the proxy applies when the config names none. */
export const PROXY_DEFAULT_PRESETS: readonly ProtectPreset[] = ['dev']

const cache = new WeakMap<AnonConfig, RegExp[]>()

/** config.protect.patterns compiled with flag 'u', plus the patterns of config.protect.presets (`defaults` when presets is undefined). Cached per config object (WeakMap) when defaults is empty. */
export function configProtect(config: AnonConfig, defaults: readonly ProtectPreset[] = []): RegExp[] {
  const cacheable = defaults.length === 0
  if (cacheable) {
    const hit = cache.get(config)
    if (hit) return hit
  }
  const presets = config.protect.presets ?? defaults
  const out = [
    ...config.protect.patterns.map(s => new RegExp(s, 'u')),
    ...presets.flatMap(p => PRESET_PATTERNS[p]),
  ]
  if (cacheable) cache.set(config, out)
  return out
}
