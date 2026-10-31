import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SessionFact, SessionFacts, TransformFactory } from '@skaile/transform-proxy'
import anon from '../src/proxy.ts'
import { ANON_SYSTEM } from '../src/session.ts'
import { ENTITY_KINDS } from '../src/types.ts'
import { createStyle } from '../src/placeholders.ts'

const log = { debug() {}, info() {}, warn() {}, error() {} }

function regexOnlyDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anon-proxy-'))
  fs.writeFileSync(path.join(dir, 'regex-only.yaml'),
    'detectors:\n  onnx:\n    enabled: false\n  llm:\n    enabled: false\n')
  return dir
}

function mutableFacts() {
  let facts: SessionFact[] = []
  const store: SessionFacts & { version: number; set(next: SessionFact[]): void } = {
    version: 0,
    list: kind => facts.filter(f => kind === undefined || f.kind === kind),
    set(next) {
      facts = next
      store.version++
    }
  }
  return store
}

async function openRegexOnly(): Promise<TransformFactory> {
  return anon.open({ config: 'regex-only.yaml', markdown: false }, { baseDir: regexOnlyDir(), log })
}

const leaf = { kind: 'user' } as const

describe('anon proxy transform module', () => {
  test('id is anon', () => {
    expect(anon.id).toBe('anon')
  })

  test('open rejects a bad config', async () => {
    const opts = { baseDir: regexOnlyDir(), log }
    await expect(anon.open({ markdown: 'yes' }, opts)).rejects.toThrow(/invalid config/)
    await expect(anon.open({ bogus: 1 }, opts)).rejects.toThrow(/invalid config/)
    await expect(anon.open('x', opts)).rejects.toThrow(/invalid config/)
    await expect(anon.open({ config: 'missing.yaml' }, opts)).rejects.toThrow()
  })

  test('instruction is ANON_SYSTEM', async () => {
    const t = await (await openRegexOnly())({ sessionId: 's', facts: mutableFacts(), log })
    expect(t.instruction).toBe(ANON_SYSTEM)
  })

  test('a fact published after creation is pseudonymized and restored', async () => {
    const facts = mutableFacts()
    const t = await (await openRegexOnly())({ sessionId: 's', facts, log })
    const text = 'Patientin Brunhilde Quast kam heute.'
    expect(await t.outbound(text, leaf)).toBe(text)

    facts.set([
      { kind: 'NAME_PATIENT', value: 'Brunhilde Quast', source: 'conn' },
      { kind: 'FAVOURITE_COLOUR', value: 'heute', source: 'conn' }
    ])
    const out = await t.outbound(text, leaf)
    expect(out).not.toContain('Brunhilde Quast')
    expect(out).toContain('heute')
    expect(out).toMatch(/NAME_PATIENT/)
    expect(t.inbound(out)).toBe(text)

    for (let size = 1; size <= out.length; size++) {
      const s = t.inboundStream()
      let acc = ''
      for (let i = 0; i < out.length; i += size) acc += s.push(out.slice(i, i + size))
      acc += s.flush()
      expect(acc).toBe(text)
    }

    // A fact that disappears stays mapped.
    facts.set([])
    expect(t.inbound(out)).toBe(text)
    expect(await t.outbound(text, leaf)).toBe(out)
  })

  test('placeholders contain no JSON escape characters', () => {
    const style = createStyle('presidio')
    for (const kind of ENTITY_KINDS) {
      for (let i = 0; i < 20; i++) {
        const p = style.token(kind)
        expect(JSON.stringify(p)).toBe(`"${p}"`)
      }
    }
  })
})
