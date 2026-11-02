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

  test('a failed fact update is retried: the next outbound at the same version still maps the facts', async () => {
    const facts = mutableFacts()
    const t = await (await openRegexOnly())({ sessionId: 's', facts, log })
    facts.set([{ kind: 'NAME_PATIENT', value: 'Brunhilde Quast', source: 'conn' }])
    const list = facts.list
    let fail = true
    facts.list = kind => {
      if (fail) {
        fail = false
        throw new Error('facts unavailable')
      }
      return list(kind)
    }
    const text = 'Patientin Brunhilde Quast kam heute.'
    await expect(t.outbound(text, leaf)).rejects.toThrow('facts unavailable')
    const out = await t.outbound(text, leaf)
    expect(out).not.toContain('Brunhilde Quast')
    expect(t.inbound(out)).toBe(text)
  })

  test('semantic style: a published fact is pseudonymized and restored', async () => {
    const dir = regexOnlyDir()
    fs.writeFileSync(path.join(dir, 'semantic.yaml'),
      'detectors:\n  onnx:\n    enabled: false\n  llm:\n    enabled: false\nplaceholders:\n  style: semantic\n')
    const facts = mutableFacts()
    const t = await (await anon.open({ config: 'semantic.yaml', markdown: false }, { baseDir: dir, log }))({ sessionId: 's', facts, log })
    facts.set([{ kind: 'NAME_PATIENT', value: 'Brunhilde Quast', source: 'conn' }])
    const text = 'Patientin Brunhilde Quast kam.'
    const out = await t.outbound(text, leaf)
    expect(out).toBe('Patientin {{person1}} kam.')
    expect(t.inbound(out)).toBe(text)
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

describe('anon proxy protection', () => {
  const DEV = [
    'DIRECTUS_URL=http://localhost:8058',
    'gutachten-webedit-directus\tdirectus/directus:11\t0.0.0.0:8058->8055/tcp, [::]:8058->8055/tcp'
  ].join('\n')
  const BASE = 'detectors:\n  onnx:\n    enabled: false\n  llm:\n    enabled: false\nplaceholders:\n  style: presidio\n'
  /** Presidio tokens without their random part, so a whole output compares exactly. */
  const shape = (s: string): string => s.replace(/<([A-Z_]+)_[0-9a-f]{8}>/g, '<$1>')

  async function transform(yaml: string) {
    const dir = regexOnlyDir()
    fs.writeFileSync(path.join(dir, 'protect.yaml'), BASE + yaml)
    const factory = await anon.open({ config: 'protect.yaml', markdown: false }, { baseDir: dir, log })
    return factory({ sessionId: 's', facts: mutableFacts(), log })
  }

  test('dev preset is on by default: localhost URL and port maps pass, a public IP is replaced', async () => {
    const t = await transform('')
    const text = `${DEV}\nServer 84.12.3.4`
    const out = await t.outbound(text, leaf)
    expect(shape(out)).toBe(`${DEV}\nServer <CONTACT_IP>`)
    expect(t.inbound(out)).toBe(text)
  })

  test('presets: [] in the config file turns the default off', async () => {
    const t = await transform('protect:\n  presets: []\n')
    const out = await t.outbound(DEV, leaf)
    const lines = shape(out).split('\n')
    expect(lines[0]).toBe('DIRECTUS_URL=<CONTACT_URL>')
    expect(lines[1]).toStartWith('gutachten-webedit-directus\tdirectus/directus:11\t<CONTACT_IP>:8058->8055/tcp')
    expect(t.inbound(out)).toBe(DEV)
  })

  test('protect.patterns from the config file are honored', async () => {
    const t = await transform(String.raw`protect:
  patterns: ['\b10\.0\.0\.5\b']
`)
    const text = 'intern 10.0.0.5, extern 84.12.3.4'
    const out = await t.outbound(text, leaf)
    expect(shape(out)).toBe('intern 10.0.0.5, extern <CONTACT_IP>')
    expect(t.inbound(out)).toBe(text)
  })
})
