import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CONFIG, applyCliOverrides, loadConfig } from '../src/config.ts'

let root: string
let home: string
let cwd: string

function write(file: string, content: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}
const homeCfg = () => path.join(home, '.config', 'forge-anon', 'config.yaml')
const cwdCfg = () => path.join(cwd, 'anon.config.yaml')
const load = (extra: { path?: string; env?: NodeJS.ProcessEnv } = {}) =>
  loadConfig({ home, cwd, env: {}, ...extra })

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'anon-config-'))
  home = path.join(root, 'home')
  cwd = path.join(root, 'cwd')
  fs.mkdirSync(home)
  fs.mkdirSync(cwd)
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('loadConfig', () => {
  test('defaults when no files exist', () => {
    const { config, sources } = load()
    expect(sources).toEqual(['defaults'])
    expect(config.placeholders.style).toBe('presidio')
    expect(config.detectors.onnx.chunkChars).toBe(900)
    expect(config.detectors.llm.enabled).toBe(false)
    expect(config.detectors.onnx.cacheDir).toBe(path.join(home, '.cache/forge-anon/models'))
    expect(config.ledger.dir).toBe(path.join(home, '.local/share/forge-anon/ledgers'))
    expect(DEFAULT_CONFIG.ledger.dir).toBe('~/.local/share/forge-anon/ledgers')
  })

  test('precedence: home < cwd < explicit path', () => {
    write(homeCfg(), 'placeholders:\n  style: gemtex\nmarkdown:\n  protect: false\n')
    expect(load().config.placeholders.style).toBe('gemtex')
    write(cwdCfg(), 'placeholders:\n  style: llm-guard\n')
    const mid = load()
    expect(mid.config.placeholders.style).toBe('llm-guard')
    expect(mid.config.markdown.protect).toBe(false)
    const explicit = write(path.join(root, 'x.yaml'), 'placeholders:\n  style: semantic\n')
    const top = load({ path: explicit })
    expect(top.config.placeholders.style).toBe('semantic')
    expect(top.sources).toEqual(['defaults', homeCfg(), cwdCfg(), explicit])
  })

  test('ANON_CONFIG used when no path given; path wins over env', () => {
    const a = write(path.join(root, 'a.yaml'), 'placeholders:\n  style: gemtex\n')
    const b = write(path.join(root, 'b.yaml'), 'placeholders:\n  style: semantic\n')
    expect(load({ env: { ANON_CONFIG: a } }).config.placeholders.style).toBe('gemtex')
    expect(load({ env: { ANON_CONFIG: a }, path: b }).config.placeholders.style).toBe('semantic')
  })

  test('missing explicit path is an error, missing implicit files are skipped', () => {
    expect(() => load({ path: path.join(root, 'nope.yaml') })).toThrow(/Konfiguration nicht gefunden: .*nope\.yaml/)
  })

  test('deep merge keeps siblings; arrays replace', () => {
    write(cwdCfg(), 'detectors:\n  onnx:\n    threshold: 0.8\n  regex:\n    entities: [CONTACT_EMAIL]\n')
    const { config } = load()
    expect(config.detectors.onnx.threshold).toBe(0.8)
    expect(config.detectors.onnx.model).toBe(DEFAULT_CONFIG.detectors.onnx.model)
    expect(config.detectors.regex.entities).toEqual(['CONTACT_EMAIL'])
    expect(config.detectors.regex.enabled).toBe(true)
  })

  test('~ is expanded in cacheDir and ledger.dir', () => {
    write(cwdCfg(), 'detectors:\n  onnx:\n    cacheDir: ~/models\nledger:\n  dir: ~/led\n')
    const { config } = load()
    expect(config.detectors.onnx.cacheDir).toBe(path.join(home, 'models'))
    expect(config.ledger.dir).toBe(path.join(home, 'led'))
  })

  test('malformed YAML gives German error with path', () => {
    const f = write(cwdCfg(), 'detectors: [unclosed\n')
    expect(() => load()).toThrow(`Konfiguration ungültig (${f})`)
  })

  test('invalid value gives German error with path and key', () => {
    const f = write(cwdCfg(), 'placeholders:\n  style: nonsense\n')
    expect(() => load()).toThrow(`Konfiguration ungültig (${f})`)
    write(cwdCfg(), 'detectors:\n  onnx:\n    threshold: 2\n')
    expect(() => load()).toThrow(/detectors\.onnx\.threshold/)
    write(cwdCfg(), 'review:\n  kinds: [FOO]\n')
    expect(() => load()).toThrow(/review\.kinds/)
  })

  test('unknown key is rejected', () => {
    const f = write(cwdCfg(), 'detectors:\n  onnx:\n    treshold: 0.3\n')
    expect(() => load()).toThrow(`Konfiguration ungültig (${f})`)
    write(cwdCfg(), 'bogus: 1\n')
    expect(() => load()).toThrow(/bogus/)
  })

  test('empty file is fine', () => {
    write(cwdCfg(), '')
    expect(load().sources).toEqual(['defaults', cwdCfg()])
  })
})

describe('applyCliOverrides', () => {
  const base = () => loadConfig({ home, cwd, env: {} }).config

  test('--detectors regex disables the others exactly', () => {
    const c = applyCliOverrides(base(), { detectors: 'regex' })
    expect(c.detectors.regex.enabled).toBe(true)
    expect(c.detectors.rules.enabled).toBe(false)
    expect(c.detectors.onnx.enabled).toBe(false)
    expect(c.detectors.llm.enabled).toBe(false)
    const d = applyCliOverrides(base(), { detectors: 'regex, llm' })
    expect(d.detectors.llm.enabled).toBe(true)
  })

  test('unknown detector throws', () => {
    expect(() => applyCliOverrides(base(), { detectors: 'regex,foo' })).toThrow(
      'Unbekannte Detektoren: foo. Erlaubt: rules, regex, onnx, llm',
    )
  })

  test('--no-onnx / --no-regex / --no-llm; true flags leave config untouched', () => {
    const b = base()
    const c = applyCliOverrides(b, { onnx: false, regex: false, llm: false })
    expect(c.detectors.onnx.enabled).toBe(false)
    expect(c.detectors.regex.enabled).toBe(false)
    expect(applyCliOverrides(b, { onnx: true }).detectors.onnx.enabled).toBe(true)
    expect(b.detectors.onnx.enabled).toBe(true) // input not mutated
  })

  test('--entities FOO throws; valid list applies to regex and onnx', () => {
    expect(() => applyCliOverrides(base(), { entities: 'FOO' })).toThrow(/^Unbekannte Entity-Kinds: FOO\. Erlaubt: NAME_PATIENT,/)
    const c = applyCliOverrides(base(), { entities: 'CONTACT_EMAIL,DATE' })
    expect(c.detectors.regex.entities).toEqual(['CONTACT_EMAIL', 'DATE'])
    expect(c.detectors.onnx.entities).toEqual(['CONTACT_EMAIL', 'DATE'])
  })

  test('--style, --threshold, model/url/fake-names/md-aware', () => {
    const c = applyCliOverrides(base(), {
      style: 'gemtex',
      threshold: 0.3,
      onnxModel: 'x/y',
      onnxVariant: 'fp16',
      onnxDevice: 'webgpu',
      llmUrl: 'http://localhost:1/v1',
      llmModel: 'm',
      fakeNames: true,
      mdAware: false,
    })
    expect(c.placeholders.style).toBe('gemtex')
    expect(c.placeholders.fakeNames).toBe(true)
    expect(c.detectors.onnx).toMatchObject({ threshold: 0.3, model: 'x/y', variant: 'fp16', device: 'webgpu' })
    expect(c.detectors.llm).toMatchObject({ baseUrl: 'http://localhost:1/v1', model: 'm' })
    expect(c.markdown.protect).toBe(false)
  })

  test('invalid style / threshold / variant rejected', () => {
    expect(() => applyCliOverrides(base(), { style: 'foo' })).toThrow(/Konfiguration ungültig/)
    expect(() => applyCliOverrides(base(), { threshold: 1.5 })).toThrow(/Schwellenwert/)
    expect(() => applyCliOverrides(base(), { onnxVariant: 'q4' })).toThrow(/Konfiguration ungültig/)
  })
})
