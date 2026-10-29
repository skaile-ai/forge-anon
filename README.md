# @skaile/forge-anon

Reversible anonymization for German clinical text (discharge letters, reports): patient, relatives, therapists, schools, places, dates, contact data and IDs. TypeScript library plus the `anon` command.

Detection is layered. Every layer can be switched on or off and, where it has a model, selected per config file or CLI flag:

|Detector|What it finds|Needs|
|---|---|---|
|`rules`|Names, relatives, birth date, school, place from **Stammdaten** you supply; yields semantic placeholders such as `{{vorname}}`, `{{km}}`|Stammdaten (library option / `--stammdaten`)|
|`regex`|E-mail, phone/fax (DE/AT/CH), IBAN (checksum verified), Krankenversichertennummer, URL, IP, dates, names after `Herr`/`Frau`/`Dr.`|nothing|
|`onnx`|Names, dates, age, places, organisations, professions, IDs via an [OpenMed German PII](https://huggingface.co/collections/OpenMed/openmed-pii-german) token-classification model, run locally|`openmed` + `@huggingface/transformers` (optional dependencies), one model download|
|`llm`|Persons, places, institutions, dates via a **local** OpenAI-compatible server (oMLX, Ollama, llama.cpp …), with a hallucination filter|a running local server|

A residual scan against the Stammdaten reports leaks that survived (inflected or misspelled names). Everything runs on your machine; the LLM endpoint is rejected unless it is local.

## Install

```sh
npm i -g @skaile/forge-anon        # or: bun install -g @skaile/forge-anon
anon --help

npm i @skaile/forge-anon           # as a library
```

Node ≥ 22. The first run with the `onnx` detector downloads the default model (about 270 MB, FP16) to `~/.cache/forge-anon/models`; later runs work offline (`localFilesOnly: true` forbids the download).

## Upgrading

### 0.2 → 0.3

The package is now `@skaile/forge-anon` (was `@ecsplico/anon`). The `anon` command is unchanged. Three directories moved; the old paths are **not** read any more, so move your data once:

```sh
mkdir -p ~/.local/share/forge-anon && mv ~/.clinico-anon/ledgers ~/.local/share/forge-anon/ledgers   # ledgers
mkdir -p ~/.cache/forge-anon && mv ~/.cache/ecsplico-anon/models ~/.cache/forge-anon/models          # ONNX model cache
mkdir -p ~/.config/forge-anon && mv ~/.config/anon/config.yaml ~/.config/forge-anon/config.yaml      # user config
```

## CLI

```text
anon [global options] <command>
```

### Global options

|Option|Effect|
|---|---|
|`--config <path>`|extra config file (highest file layer; also `ANON_CONFIG`)|
|`--detectors <list>`|comma list from `rules,regex,onnx,llm`; enables exactly these|
|`--no-regex` `--no-onnx` `--no-llm`|switch one detector off|
|`--onnx-model <id>`|Hugging Face model id|
|`--onnx-variant <int8\|fp16\|fp32>`|weight variant|
|`--onnx-device <cpu\|webgpu>`|inference device|
|`--threshold <0..1>`|ONNX confidence threshold|
|`--llm-url <url>` `--llm-model <name>`|local LLM endpoint and model|
|`--entities <list>`|entity kinds for `regex` **and** `onnx`, e.g. `NAME_EXT,CONTACT_EMAIL`; unknown kinds exit 1 and list the allowed ones|
|`--style <semantic\|presidio\|llm-guard\|gemtex>`|placeholder style|
|`-f, --fake-names`|replace names by invented German names instead of tokens (not with `semantic`)|
|`--md-aware` / `--no-md-aware`|protect fenced code, inline code and link targets (applies to `.md`/`.markdown` files)|

Flags override every config file. They may stand before or after the command.

### `anon anonymize <files...>`

```sh
anon anonymize bericht.md                 # bericht.anon.md, NOT reversible
anon anonymize bericht.md -s              # also saves a ledger, prints its key
anon anonymize bericht.md --style gemtex --no-onnx --no-llm
anon anonymize bericht.md --style semantic --stammdaten stammdaten.json
```

|Option|Effect|
|---|---|
|`-s, --store-entities`|save the ledger (placeholder → original); `ledger.save: true` in the config does the same|
|`--stammdaten <json>`|path to a JSON file (or inline JSON) with the Stammdaten, see below|
|`--out-dir <dir>`|write outputs there instead of next to the source|

Output `<stem>.anon<ext>` has mode 0600. Per file:

```text
✓ bericht.md: 7 Entitäten → bericht.anon.md  (Ledger-Key: 3f2a…)
⚠ Prüfen (AGE): "14-jährige" @ 1203        # detected, NOT replaced: needs a human
⚠ Rest: "Sommerfelder" @ 88                 # Stammdaten term still in the output
```

Kinds in `review.kinds` (default `AGE`, `PROFESSION`, `OTHER`) are reported but left in the text, as the GeMTeX guidelines require manual review. Files are processed independently; a failing file prints `✗ <file>: <reason>` and the run continues. Exit code: 0 ok, 1 an error occurred (or bad options), 2 residual leaks found; with several files the maximum wins.

Stammdaten JSON (all fields except `vorname`/`nachname` optional):

```json
{
  "vorname": "Jane", "nachname": "Doe", "geburtsdatum": "01.01.2010",
  "koseformen": ["Janie"],
  "angehoerige": [{ "rolle": "Mutter", "vorname": "Mary", "nachname": "Doe" }],
  "schule": "Goethe-Schule", "wohnort": "Musterstadt",
  "weitere": [{ "text": "Dr. Beispiel", "placeholder": "therapeut1" }]
}
```

### `anon deanonymize <anonFile>`

```sh
anon deanonymize bericht.anon.md          # → bericht.deanon.md
anon deanonymize bericht.anon.md -k <key> -o restored.md
```

The ledger is found by the SHA-256 of the anonymized file, or by `-k`. A checksum mismatch (file edited since, or restored text differs from the source) prints a warning on stderr and never stops the run; `--no-verify` skips the checks. The output has mode 0600.

### `anon inspect <keyOrFile>`

Prints the ledger header (`key`, `source`, `created`, `style`, `fake_names`, `detectors`) and a table `PLACEHOLDER  KIND  DETECTOR  OCC  ORIGINAL`. The argument is a 32-hex key, an anonymized file, or a ledger YAML path. The originals are shown in clear text.

### `anon config`

Prints the effective configuration (files plus flags) as YAML, preceded by `# sources: defaults, …`.

### `anon detectors`

```text
rules  enabled  (nur mit --stammdaten)
regex  enabled
onnx   enabled  model=OpenMed/OpenMed-PII-German-SuperClinical-Small-44M-v1-onnx-android cache=hit
llm    enabled  url=http://127.0.0.1:8000/v1 reachable=yes
```

`cache=missing` means the next run downloads the model; `packages missing` means `openmed` / `@huggingface/transformers` are not installed. LLM reachability is a `GET <baseUrl>/models` with a 3 s timeout.

## Configuration

Layers, lowest first, deep-merged (objects merge; arrays and scalars replace): built-in defaults → `~/.config/forge-anon/config.yaml` → `./anon.config.yaml` → `--config <path>` / `$ANON_CONFIG` → CLI flags. A malformed file is an error naming the file. `~` expands to the home directory.

```yaml
detectors:
  rules: { enabled: true }                 # active only when Stammdaten are supplied
  regex:
    enabled: true
    entities: [CONTACT_EMAIL, CONTACT_PHONE, CONTACT_FAX, CONTACT_URL, CONTACT_IP, ID, DATE, AGE, NAME_EXT]
  onnx:
    enabled: true
    model: OpenMed/OpenMed-PII-German-SuperClinical-Small-44M-v1-onnx-android
    variant: fp16                          # int8 | fp16 | fp32
    device: cpu                            # cpu | webgpu
    threshold: 0.3
    chunkChars: 900                        # characters per model call (models truncate at 512 tokens)
    localFilesOnly: false                  # true: never download
    cacheDir: ~/.cache/forge-anon/models
    entities: [NAME_EXT, DATE_BIRTH, DATE, AGE, CONTACT_EMAIL, CONTACT_PHONE, CONTACT_URL, CONTACT_IP,
               LOCATION_CITY, LOCATION_STATE, LOCATION_STREET, LOCATION_ZIP, LOCATION_OTHER,
               LOCATION_ORGANIZATION, PROFESSION, ID]
  llm:
    enabled: false
    baseUrl: http://127.0.0.1:8000/v1      # must be local, see Privacy
    model: mlx-community--gemma-4-26b-a4b-it-8bit
    apiKeyEnv: ANON_LLM_API_KEY            # name of the env var holding the key, never the key itself
    timeoutMs: 120000
    chunkChars: 3000
    overlapChars: 300
placeholders: { style: presidio, fakeNames: false }
review: { kinds: [AGE, PROFESSION, OTHER] }  # detected, reported, not replaced
markdown: { protect: true }
ledger: { dir: ~/.local/share/forge-anon/ledgers, save: false }   # $ANON_LEDGER_DIR wins over dir
```

### Placeholder styles

|Style|Example|Notes|
|---|---|---|
|`semantic`|`{{vorname}}`, `{{km}}`, `{{person1}}`|deterministic keys; Stammdaten-driven; used by epikrisen-generator|
|`presidio`|`<NAME_EXT_1a2b3c4d>`|random per run|
|`llm-guard`|`[REDACTED_NAME_EXT_1a2b3c4d]`|random per run|
|`gemtex`|`[** NAME_EXT FR7CR8 **]`|GeMTeX surrogate format|

Random tokens differ on every run; the ledger is the only way back. Anonymization verifies `restore(result) === source` and redraws colliding tokens up to 10 times.

### Entity kinds

GeMTeX scheme: `NAME_PATIENT`, `NAME_RELATIVE`, `NAME_DOCTOR`, `NAME_EXT`, `NAME_TITLE`, `DATE_BIRTH`, `DATE_DEATH`, `DATE`, `AGE`, `LOCATION_STREET`, `LOCATION_CITY`, `LOCATION_ZIP`, `LOCATION_COUNTRY`, `LOCATION_STATE`, `LOCATION_HOSPITAL`, `LOCATION_ORGANIZATION`, `LOCATION_OTHER`, `ID`, `CONTACT_PHONE`, `CONTACT_EMAIL`, `CONTACT_FAX`, `CONTACT_URL`, `CONTACT_IP`, `PROFESSION`, `OTHER`.

## Model choice (`onnx`)

Measured on GraSCCo_PII_V2 (see Evaluation), `onnx` alone, threshold 0.3, overlap recall in %:

|Model (`detectors.onnx.model`, all `…-v1-onnx-android`)|Variant|File|NAME|DATE|LOCATION|Total|Corpus time|
|---|---|---:|---:|---:|---:|---:|---:|
|`OpenMed/OpenMed-PII-German-SuperClinical-Small-44M` (default)|fp16|270 MB|95.7|75.9|90.1|81.3|15 s|
|`OpenMed/OpenMed-PII-German-SuperClinical-Small-44M`|int8|445 MB|95.7|71.6|87.2|78.6|10 s|
|`OpenMed/OpenMed-PII-German-SuperClinical-Base-184M`|fp16|352 MB|94.4|75.2|89.0|80.8|28 s|
|`OpenMed/OpenMed-PII-German-SuperClinical-Large-434M`|fp16|831 MB|96.0|75.3|77.9|79.8|79 s|
|`OpenMed/OpenMed-PII-German-ClinicalE5-Small-33M`|int8|66 MB|60.8|24.4|11.0|30.5|8 s|

`SuperClinical-Base-184M` with `int8` returns no spans (broken model file); use `fp16`. ClinicalE5 models label German dates as IP addresses. Only `-onnx-android` repositories load through OpenMed's ONNX loader directly; other repositories need an `onnx/model.onnx` export.

## Library

```ts
import {
  anonymize, detect, restore, loadConfig, applyCliOverrides,
  buildRules, applyRules, addCandidate, residualScan, toMapping,
  findCandidates, toRules, openAiCompatibleChat,
  semanticStyle, saveLedger, findLedger, readLedger,
} from '@skaile/forge-anon'

const { config } = loadConfig({ cwd: process.cwd() })
const result = await anonymize(text, {
  config: applyCliOverrides(config, { onnx: false, llm: false, style: 'presidio' }),
  markdown: true,
})
result.text      // anonymized text
result.entities  // [{ placeholder, original, kind, detector, occurrences }]
result.review    // spans detected but left in the text (config.review.kinds)
result.residual  // Stammdaten leaks (only with `stammdaten`)
restore(result.text, result.entities) === text
```

|Export|Purpose|
|---|---|
|`anonymize(text, opts)` / `detect(text, opts)`|full pipeline / spans only. `opts`: `config`, `stammdaten?`, `markdown?`, `protect?` (`RegExp[]`: matches are never anonymized by any detector, with or without `markdown`; no `g` flag needed, empty matches ignored), `chat?` (required for the `llm` detector), `manual?`, `mapping?` (placeholders already handed out)|
|`restore(text, entities, { lenient? })`|placeholder → original in one pass (first mapping per placeholder wins, longest placeholder first, replaced text is never rescanned); `lenient: true` also restores LLM-mangled tokens, see below|
|`loadConfig({ path?, cwd?, env? })`, `applyCliOverrides(config, flags)`|config layers; flag mapping|
|`buildRules(stammdaten)`, `applyRules(text, rules)`, `addCandidate(rules, candidate, style)`, `residualScan(text, stammdaten, style)`, `toMapping(rules)`|Stammdaten rule layer with semantic placeholders|
|`findCandidates(text, { chat, placeholderPattern })`, `toRules(...)`, `openAiCompatibleChat(opts)`, `contextSnippet(text, index, length)`|LLM NER; `chat` is injected, so the caller owns transport and logging; `contextSnippet` builds the review contexts shown for each candidate|
|`regexDetector`, `onnxDetector`, `llmDetector`|individual detectors (`Detector.detect(text, { masked })`)|
|`saveLedger`, `findLedger`, `readLedger`, `sha256`|ledger store|
|`semanticStyle`, `presidioStyle`, `llmGuardStyle`, `gemtexStyle`, `getStyle`|placeholder styles|
|`patternSpans(text, patterns)`, `mergeSpans(...lists)`, `protectedSpans(text)`, `overlaps(start, end, spans)`|protected-range helpers behind `protect` and `markdown`: sorted, merged `[start, end)` ranges|
|`BLOCK_ID_PATTERN`|UUID v4 (editor block ids) as a `protect` pattern|
|`createAnonSession(opts)`, `createStreamRestorer(entities, opts?)`|conversation mapping and streamed restore, see below|

## Library: sessions and streaming

A conversation anonymizes many texts with one mapping: an original keeps its placeholder in every later text.

```ts
import { createAnonSession } from '@skaile/forge-anon'

const session = createAnonSession({ config })       // detectors (and the ONNX model) are built once
const a = await session.anonymize('Herr Müller, geb. 12.03.1970')
const b = await session.anonymize('Was hat Müller gesagt?')   // same placeholder for Müller as in `a`
session.entities                                    // cumulative mapping, occurrences summed
session.restore(llmAnswer)                          // lenient restore
const r = session.streamRestorer()                  // for streamed answers
for await (const delta of llmStream) out += r.push(delta)
out += r.flush()
```

- `createAnonSession` takes `protect` like `anonymize` (`createAnonSession({ config, protect: [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g] })` keeps UUIDs verbatim in every text). A detection that overlaps a protected match is dropped, also a longer one.
- `anonymize(text, { mapping })` is the primitive underneath: known originals (exact text, word boundaries) keep their placeholder with or without a detector hit; new originals get fresh tokens that collide neither with the text nor with the mapping; `result.entities` is the union, `occurrences` counted for this text (`0` for mapping entries not in it). Another spelling of a known original ("MÜLLER") is a new entity so that `restore` stays exact. A longer detector span ("Herr Müller") wins over a shorter known original.
- `session.anonymize` calls run one after another, so overlapping calls never draw two tokens for the same new original.
- `restore(text, entities, { lenient: true })` (used by the session) also restores tokens of the styles `presidio`, `llm-guard` and `gemtex` without their brackets (`NAME_PATIENT_ab12cd34`), with HTML-escaped brackets (`&lt;…&gt;`) and with upper-case random part; wrapping such as backticks or `**` stays. `semantic` placeholders are always exact. The CLI keeps exact restore.
- `createStreamRestorer(entities, { lenient? })`: `push(chunk)` returns the restored text that is final and holds back a trailing piece that could still become a placeholder; `flush()` returns the rest. For every chunking, `push(c1) + … + push(cn) + flush() === restore(text, entities, opts)`. The session's restorer is bound to the mapping at the time of the call.

## Library: AI SDK (`@skaile/forge-anon/ai-sdk`)

For hosts that call a model through the [AI SDK](https://ai-sdk.dev) (`ai` ^7, optional peers `ai` and `@ai-sdk/provider`): the model sees placeholders only and the answer comes back restored.

```ts
import { wrapLanguageModel } from 'ai'
import { BLOCK_ID_PATTERN, loadConfig } from '@skaile/forge-anon'
import { anonLanguageModelMiddleware, createAnonSessionStore } from '@skaile/forge-anon/ai-sdk'

const store = createAnonSessionStore({ config: loadConfig().config, protect: [BLOCK_ID_PATTERN] })

// per request, with the id of the user's chat session:
const session = store.get(sessionId)
const model = wrapLanguageModel({
  model: baseModel,
  middleware: anonLanguageModelMiddleware(session, { system: MY_SYSTEM_PROMPT, document: currentDocumentMarkdown })
})
```

- `createAnonSessionStore({ config, idleTtlMs?, markdown?, protect? })` → `{ get(id, now?), drop(id), has(id), evictIdle(now) }`. Sessions live in memory only; one idle for longer than `idleTtlMs` (default one hour) is dropped on the next `get`/`evictIdle`. `markdown` defaults to `true`.
- `anonLanguageModelMiddleware(session, { system, document?, documentLabel? })`: `system` is your prompt (tell the model that placeholders stand for real values and must be copied verbatim) and goes first as a system message; system messages already in the prompt follow unchanged. `document` is anonymized and appended as `<document>…</document>` below `documentLabel` (default `Das aktuelle Dokument des Nutzers:`).
- Anonymized: every string leaf of user/assistant text, of assistant `tool-call` inputs (recursively) and of tool results. Restored: streamed text incrementally (a placeholder may straddle deltas; `text-end` flushes), `tool-call` inputs as parsed JSON (originals with `"` or `\` stay valid; unparsable input is restored as plain text). `tool-input-delta` parts pass through untouched, so act on the finished `tool-call`. If anonymizing fails, the model is never called.
- `anonymizeJson(session, value)` / `restoreJson(session, value)`: the same leaf-wise mapping for your own JSON (object keys are never touched).

### Als ModelProvider-Dekorator

Hosts that resolve models through a provider object (forge-editor's `ModelProvider`: `languageModel(ref, user)`) wrap it once instead of wrapping every model: remote models get the middleware above, local ones come back as the identical object.

```ts
import { createAnonSession } from '@skaile/forge-anon'
import { ANON_SYSTEM, anonymizingModelProvider } from '@skaile/forge-anon/ai-sdk'
import { createEditorModelProvider } from '@skaile/forge-settings/runtime/editor'

const inner = createEditorModelProvider({ registry, env, onFailure })

export const editorModels = anonymizingModelProvider(inner, {
  // `true` → anonymize; `false` → untouched local model. Unknown ref → `true` (fail closed).
  isRemote: async ref => !istLokal(await baseUrlOf(ref)), // hostname localhost, 127.0.0.0/8, ::1, 10/8, 172.16/12, 192.168/16, *.local
  // one session per user, built from the Stammdaten of the user's cases; called once per languageModel() call
  sessionFor: user => sessionOf(user), // Map<userId, createAnonSession({ config, markdown: true, stammdaten })>
  system: ANON_SYSTEM // optional, this is the default
})

// editorModels.languageModel({ preset: 'remote-70b' }, user) → wrapped; ({ endpoint: 'http://localhost:1234/v1', … }, user) → as is
```

- `anonymizingModelProvider(inner, { sessionFor, isRemote, system? })` returns a copy of `inner` (own properties and prototype methods kept) whose `languageModel` is replaced. An `inner` without `languageModel` stays without one.
- `null` from `inner.languageModel` stays `null`; `isRemote` and `sessionFor` are not called then. `isRemote(ref)` is `false` → the model is returned as is. Otherwise `sessionFor(user, ref)` runs once and the model is wrapped with `anonLanguageModelMiddleware(session, { system })`; the session is shared by every request on that model object, so key it by what must share placeholders (user, case).
- A remote ref that resolves to a plain model id string cannot be wrapped and throws instead of sending text in clear.
- `ANON_SYSTEM` (German): „Platzhalter wie NAME_PATIENT_xxxx oder DATE_BIRTH_xxxx stehen für echte Werte. Übernimm sie wörtlich und unverändert; rate nicht, was dahintersteht.“ The decorator has no `document` option: compose and chat carry the document inside the prompt, which the middleware anonymizes anyway.
- Everything that must stay local (embeddings, transcription) is not a language model and bypasses the decorator; keep it local yourself.

## Ledger

`anon anonymize -s` writes `~/.local/share/forge-anon/ledgers/<key>.yaml` (directory 0700, file 0600) with the source file name, creation time, style, detectors, SHA-256 of source and anonymized text, and every `placeholder → original` pair. Ledgers written by the earlier Python `clinico-anon` stay readable (`entity_type` is read as `kind`).

## Privacy

- The ledger contains the original PII in clear text; treat it like the source document. Delete it when you no longer need to restore.
- `anon` never contacts a cloud service for inference. The ONNX model is downloaded once from Hugging Face; after that set `localFilesOnly: true`.
- The LLM endpoint must be local: `localhost`, `*.localhost`, `*.local`, loopback, or private/link-local addresses. Anything else fails with `LLM-Endpunkt muss lokal sein`. There is no DNS resolution, so a hostname that resolves publicly but ends in `.local` is your responsibility.
- Output files are written with mode 0600.
- Anonymization is not a guarantee. `review` lines need a human, ML detectors miss identifiers, and free text can identify a patient without naming anyone. Read the result before sharing it.
- Never commit real patient data. This repository's tests use invented cases only.

## Evaluation

`scripts/eval-grascco.ts` measures strict entity-level precision and recall per kind group on the synthetic GraSCCo_PII corpus (Zenodo record 15747389, CC-BY-4.0). Download it manually into `eval/corpus/` (git-ignored), then:

```sh
bun scripts/eval-grascco.ts --corpus eval/corpus --detectors regex,onnx --skip-labels NAME_TITLE
```

Results 2026-10-18 (63 documents, 1297 gold spans without `NAME_TITLE`; ONNX = `SuperClinical-Small-44M` at threshold 0.3; LLM = local `gemma-4-26b-a4b-it-8bit`), overlap recall in %:

|Detectors|NAME|DATE|AGE|LOCATION|ID|CONTACT|Total|
|---|---:|---:|---:|---:|---:|---:|---:|
|regex|30.6|62.5|36.8|0.0|0.0|89.3|43.5|
|llm|92.3|8.7|0.0|82.6|0.0|0.0|38.6|
|regex+llm|94.8|62.5|36.8|82.6|0.0|89.3|70.5|
|regex+onnx (int8)|96.9|81.8|73.7|87.2|3.4|92.9|82.7|
|regex+onnx+llm (int8)|98.1|81.8|73.7|99.4|3.4|92.9|84.7|

Strict precision is low for the ONNX settings (about 30-57 % total), mostly boundary mismatches and extra DATE/LOCATION spans; for a safety net with human review, recall is the number that counts. ID recall drops from 44 % (`onnx` alone) to 3 % when `regex` runs too: overlap resolution prefers the longer span, and recall is scored per kind group.

## Development

```sh
bun install
bun run typecheck
bun test
bun run build        # tsdown → dist/index.mjs, dist/cli.mjs, dist/ai-sdk.mjs
```

MIT licensed.
