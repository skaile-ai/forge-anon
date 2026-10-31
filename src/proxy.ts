// The `anon` transform module for `@skaile/transform-proxy`: one forge-anon session per proxy session. Personal data
// leaves `outbound` as placeholders; `inbound` and `inboundStream` put the originals back. Facts published for the
// session (kinds from ENTITY_KINDS) are added to the mapping before the next outbound text.

import path from 'node:path'
import type { Transform, TransformModule } from '@skaile/transform-proxy'
import * as z from 'zod'
import { loadConfig } from './config.ts'
import { buildDetectors } from './pipeline.ts'
import { ANON_SYSTEM, createAnonSession } from './session.ts'
import { ENTITY_KINDS } from './types.ts'
import type { EntityKind } from './types.ts'

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
    const detectors = buildDetectors({ config, markdown })

    return async ({ facts }) => {
      const session = createAnonSession({ config, detectors, markdown })
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
        }
      }
      return transform
    }
  }
}

export default anon
