export { ENTITY_KINDS, kindGroup } from './types.ts'
export type {
  Angehoeriger,
  DetectorName,
  Entity,
  EntityKind,
  Hit,
  KindGroup,
  Rule,
  Span,
  Stammdaten
} from './types.ts'

export { chunkText, maskPlaceholders } from './text.ts'

export {
  STYLE_NAMES,
  candidatePrefix,
  createStyle,
  gemtexStyle,
  getStyle,
  llmGuardStyle,
  presidioStyle,
  semanticStyle
} from './placeholders.ts'
export type { CreateStyleOptions, PlaceholderStyle, StyleName } from './placeholders.ts'
export { createStreamRestorer, restore } from './restore.ts'
export type { RestoreOptions, StreamRestorer } from './restore.ts'

export { addCandidate, applyRules, buildRules, residualScan, toMapping } from './rules.ts'
export type { Candidate } from './rules.ts'

export type { DetectContext, Detector } from './detectors/types.ts'
export { REGEX_ENTITIES, regexDetector } from './detectors/regex.ts'
export { ONNX_DEFAULTS, onnxCacheStatus, onnxDetector } from './detectors/onnx.ts'
export type { OnnxDetectorOptions, OnnxOptions, OnnxVariant } from './detectors/onnx.ts'
export {
  NerResponseSchema,
  assertLocalUrl,
  contextSnippet,
  extractJson,
  findCandidates,
  llmDetector,
  openAiCompatibleChat,
  toRules
} from './detectors/llm.ts'
export type {
  AcceptedCandidate,
  FindCandidatesOptions,
  LlmDetectorOptions,
  NerCandidate,
  NerChat,
  NerKind,
  NerPrompt,
  OpenAiCompatibleChatOptions
} from './detectors/llm.ts'

export { BLOCK_ID_PATTERN, mergeSpans, overlaps, patternSpans, protectedSpans } from './markdown.ts'
export type { Range } from './markdown.ts'
export { FakeNames } from './fake-names.ts'
export type { FakeNamesOptions, FakerLike } from './fake-names.ts'
export {
  LEDGER_VERSION,
  findLedger,
  ledgerPath,
  readLedger,
  saveLedger,
  sha256,
  storeDir
} from './ledger.ts'
export type { Ledger, SaveLedgerInput } from './ledger.ts'

export { AnonConfigSchema, DEFAULT_CONFIG, applyCliOverrides, expandHome, loadConfig } from './config.ts'
export type { AnonConfig, CliFlags, LoadConfigOptions } from './config.ts'

export { findRuleHits } from './rules.ts'
export type { RuleHit } from './rules.ts'
export { anonymize, buildDetectors, detect } from './pipeline.ts'
export type { AnonymizeOptions, AnonymizeResult, DetectResult } from './pipeline.ts'
export { createAnonSession } from './session.ts'
export type { AnonSession, AnonSessionOptions } from './session.ts'
