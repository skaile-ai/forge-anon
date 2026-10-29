# Changelog

## 0.4.0

- `@skaile/forge-anon/ai-sdk`: `anonymizingModelProvider(inner, { sessionFor, isRemote, system? })` decorates a model provider (anything with `languageModel(ref, user)`, e.g. forge-editor's `ModelProvider`). A remote ref (`isRemote`) gets its model wrapped with `anonLanguageModelMiddleware(await sessionFor(user, ref), { system })`; a local ref returns the identical model object; `null` stays `null` without calling `isRemote`/`sessionFor`; a remote ref that resolves to a plain model id string throws (it cannot be wrapped). Other properties of `inner` are kept.
- New exports `ANON_SYSTEM` (German default system message for wrapped calls) and the type `AnonProviderOptions<Ref>`.
- `src/ai-sdk.ts` now imports `wrapLanguageModel` from `ai` at runtime (was types only); `ai` stays an optional peer needed by this entry.

## 0.3.2

- Released through npm trusted publishing (GitHub OIDC from `publish.yml`); no npm token is stored. No package changes.

## 0.3.1

- `anonLanguageModelMiddleware`: reasoning is restored like text, in streams (`reasoning-delta`, own restorer per block, tail flushed on `reasoning-end`) and in `wrapGenerate`. Before, reasoning reached the AI SDK with placeholders; a server-tool host then re-sent it in the next step and `anonymize` threw a placeholder collision.
- `BLOCK_ID_PATTERN` matches standalone ids only. A UUID inside an email (`<uuid>.max@web.de`, `max-<uuid>@web.de`) or URL (`/p/<uuid>/a`, `?id=<uuid>`) no longer matches, so protecting block ids no longer drops the whole email/URL detection and sends the contact in clear text.
- `createAnonSessionStore`: detectors are built once per store and shared by its sessions (one ONNX model per store instead of one per session id).

## 0.3.0

- **Renamed** `@ecsplico/anon` → `@skaile/forge-anon` (repo `skaile-ai/forge-anon`). The `anon` command keeps its name.
- **Directories renamed, no fallback to the old paths** (see README "Upgrading"): ledger store `~/.clinico-anon/ledgers` → `~/.local/share/forge-anon/ledgers`, ONNX model cache `~/.cache/ecsplico-anon/models` → `~/.cache/forge-anon/models`, user config `~/.config/anon/config.yaml` → `~/.config/forge-anon/config.yaml`.
- `AnonymizeOptions.protect?: readonly RegExp[]` (also accepted by `createAnonSession`): matches are never anonymized by any detector, with or without `markdown`. Detections overlapping a match are dropped; patterns need no `g` flag; empty matches are ignored. Use it for structural tokens that the IPv6/ID rules would otherwise shred.
- New exports `BLOCK_ID_PATTERN` (UUID v4, e.g. editor block ids), `patternSpans(text, patterns)` and `mergeSpans(...lists)` next to `protectedSpans` / `overlaps`.
- New subpath `@skaile/forge-anon/ai-sdk` (optional peers `ai` ^7, `@ai-sdk/provider`):
  - `createAnonSessionStore({ config, idleTtlMs?, markdown?, protect? })`: sessions by id, memory only, idle eviction (default one hour), `markdown` on by default.
  - `anonLanguageModelMiddleware(session, { system, document?, documentLabel? })`: the model sees placeholders only, in user/assistant text, assistant tool-call inputs (every string leaf) and tool results. Streamed text is restored incrementally; tool-call inputs are restored as parsed JSON, so originals containing `"` or `\` stay valid; `tool-input-delta` parts pass through. The system prompt and the `<document>` block are options owned by the host.
  - `anonymizeJson(session, value)` / `restoreJson(session, value)`: the leaf-wise helpers behind the middleware.

## 0.2.0

Never tagged; the first tagged release under the new name is 0.3.0.

- `anonymize()`: `mapping` option. Known originals keep their placeholder, new ones extend the mapping.
- `createAnonSession()`: detectors built once (the ONNX model loads once), cumulative entities, `restore()` and `streamRestorer()`. Calls run one after another.
- `restore()`: single regex pass, longest placeholder first; `lenient` also matches LLM-mangled tokens.
- `createStreamRestorer()`: incremental restore that holds back a possible partial placeholder.
- `restore` moved to `src/restore.ts`.
