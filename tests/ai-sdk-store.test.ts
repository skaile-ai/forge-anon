import { expect, mock, test } from 'bun:test'
import { DEFAULT_CONFIG } from '../src/config.ts'
import * as real from '../src/pipeline.ts'

// Ausschließlich erfundene Daten.

// Counts detector-set constructions; everything else is the real pipeline.
let built = 0
const realBuild = real.buildDetectors
mock.module('../src/pipeline.ts', () => ({
  ...real,
  buildDetectors: (...args: Parameters<typeof realBuild>) => {
    built++
    return realBuild(...args)
  }
}))

test('a store builds its detectors once and shares them across sessions (one ONNX model per store, not per session id)', async () => {
  const { createAnonSessionStore } = await import('../src/ai-sdk.ts')
  const config = structuredClone(DEFAULT_CONFIG)
  config.detectors.onnx.enabled = false
  config.detectors.llm.enabled = false
  config.detectors.rules.enabled = false
  const before = built
  const store = createAnonSessionStore({ config })
  expect(built).toBe(before + 1)
  const a = store.get('a')
  const b = store.get('b')
  await a.anonymize('Rückruf unter max@example.org.')
  await b.anonymize('Rückruf unter anna@example.org.')
  expect(built).toBe(before + 1)
  expect(a.entities.map(e => e.original)).toEqual(['max@example.org'])
  expect(b.entities.map(e => e.original)).toEqual(['anna@example.org'])
})
