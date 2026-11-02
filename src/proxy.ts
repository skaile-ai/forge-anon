// The `anon` transform module for `@skaile/transform-proxy`: one forge-anon session per proxy session. Personal data
// leaves `outbound` as placeholders; `inbound` and `inboundStream` put the originals back. Facts published for the
// session (kinds from ENTITY_KINDS) are added to the mapping before the next outbound text.

import path from 'node:path'
import type { Transform, TransformModule } from '@skaile/transform-proxy'
import * as z from 'zod'
import { loadConfig } from './config.ts'
import { buildDetectors } from './pipeline.ts'
import { PROXY_DEFAULT_PRESETS } from './protect.ts'
import { ANON_SYSTEM, createAnonSession } from './session.ts'
import { ENTITY_KINDS } from './types.ts'
import type { Entity, EntityKind } from './types.ts'

/** What `inspect()` of the anon transform returns to the host: the session mapping, originals included. Host-only. */
export interface AnonProxyInspection {
  entities: readonly Entity[]
}

const ProxyConfigSchema = z.strictObject({
  /**
   * forge-anon config file, relative to the proxy `baseDir`. Default: forge-anon's own layers
   * (`~/.config/forge-anon/config.yaml`, `<baseDir>/anon.config.yaml`, `$ANON_CONFIG`).
   */
  config: z.string().optional(),
  /** Keep markdown structure out of the detectors (forge-anon `markdown`). */
  markdown: z.boolean().default(true)
})

const KINDS: ReadonlySet<string> = new Set(ENTITY_KINDS)

const anon: TransformModule = {
  id: 'anon',
  async open(raw, { baseDir }) {
    const parsed = ProxyConfigSchema.safeParse(raw ?? {})
    if (!parsed.success) throw new Error(`anon transform: invalid config: ${z.prettifyError(parsed.error)}`)
    const { markdown } = parsed.data
    const { config } = loadConfig({
      cwd: baseDir,
      ...(parsed.data.config ? { path: path.resolve(baseDir, parsed.data.config) } : {})
    })
    // Built once per proxy: the ONNX pipeline is cached per detector instance.
    // The proxy protects developer values (`dev` preset) unless the config names its own presets.
    const effective =
      config.protect.presets === undefined
        ? { ...config, protect: { ...config.protect, presets: [...PROXY_DEFAULT_PRESETS] } }
        : config
    const detectors = buildDetectors({ config: effective, markdown })

    return async ({ facts }) => {
      const session = createAnonSession({ config: effective, detectors, markdown })
      let seen = -1
      const transform: Transform = {
        instruction: ANON_SYSTEM,
        async outbound(text) {
          const version = facts.version
          if (version !== seen) {
            // Facts that disappear stay mapped: an already sent placeholder must still restore.
            await session.extend(facts.list()
              .filter(f => KINDS.has(f.kind))
              .map(f => ({ kind: f.kind as EntityKind, original: f.value })))
            // Only once applied: after a failed update the next outbound retries it instead of sending the facts in clear.
            seen = version
          }
          return (await session.anonymize(text)).text
        },
        inbound: text => session.restore(text),
        inboundStream() {
          const restorer = session.streamRestorer()
          return { push: chunk => restorer.push(chunk), flush: () => restorer.flush() }
        },
        inspect: (): AnonProxyInspection => ({ entities: [...session.entities] }),
        // For the proxy's leak check only (never sent): a value replaced once must not reach the provider in clear elsewhere.
        // Detected and fact-added originals share the mapping; a fresh, deduplicated array per call.
        knownOriginals() {
          const byKey = new Map<string, { kind: string; value: string }>()
          for (const e of session.entities) byKey.set(`${e.kind}\0${e.original}`, { kind: e.kind, value: e.original })
          return [...byKey.values()]
        }
      }
      return transform
    }
  }
}

export default anon
