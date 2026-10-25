import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/ai-sdk.ts'],
  format: 'esm',
  platform: 'node',
  dts: true,
  shims: true
})
