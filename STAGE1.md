# free-model-aggregator-02 — Stage 1

## Kit

- Bundle sha256 (kit.json): `28061215ed3af767cc0fdb1b14333f822088887358735da957f97047bf6b1e28`
  — verified: all 32 files in the tarball match kit.json hashes. (The tarball
  file itself hashes differently; the bundle sha is the kit.json value.)
- Competition: agent/v1, $500 escrowed, deadline Tue 2026-11-17 10:30 WIB,
  7 submissions already in at Stage 1 time. Practice trials 0–2, drand round
  33963938. Pod: 240 s wall, 1 CPU, 1024 MB, 64 processes.
- Scoring: quality 60, served 15, wire 10, failover 10, catalog 5.
  Tie-break: fewer upstream calls, then earlier receipt.

## Rules verified from this kit (not assumed from -01)

- 14 models, ALL `openrouter/*:free`, one provider. No paid model in the
  catalog at all.
- Gateway allowlist is `openrouter/*:free`; anything else is 400
  `model_not_allowed`. Every free model is dialled on Chat Completions
  (`POST $OPENAI_BASE_URL/chat/completions`) ONLY — the Anthropic Messages
  route refuses these ids with 400 `invalid_request_error`.
- Six prompts per trial, 3 OpenAI + 3 Anthropic, 2 streaming (weight 2),
  2 JSON-mode (both OpenAI wire — the scorer throws otherwise), 1 tools,
  3 with a system prompt. Each prompt carries a unique token the answer
  must carry back; the scorer's proof needs the provider's own recorded
  response body to carry that token, and the reported model to be a
  successful gateway call.
- Model calls are REQUIRED here: a trial with no model call scores 0, and
  an entry with none on any trial is refused. (This is the opposite of -01,
  where `model_calls: optional`.)
- OpenRouter key REQUIRED, from an account with at least 10 credits
  purchased, pushed as `OPENROUTER_API_KEY` before submit. No key pushed
  yet at Stage 1 (checked via `secrets ls`: none). Without it every model
  call is refused 401, no prompt is served, entry is not ranked. Under
  10 credits the free ceiling is 50/day (1000/day at 10+).
- At most 60 model calls per trial; `max_tokens` required and ≤ 8192.
- Failover: `x-makefun-upstream-failures` header (JSON array, max 8 rows,
  max 8 KiB) is the only way a recovered retry/failover is visible. With
  no failures at all and something served, failover scores 100.
- Catalog: registered catalog + both `GET /v1/models` answers must list
  exactly the 14 dialable ids, once each. `--list` prints the same document
  the server registers.
- Determinism: no wall clock, no unseeded randomness; replay must leave
  the same state export byte for byte. Practice floor is 0; final is
  staged (first scored trial, top 60 run all 3, rank on mean).

## Hypotheses from -01: kept / changed

- KEPT: JSON-mode must not route to the Anthropic wire (now enforced by
  the gateway refusal + scorer throw). Exactly 1 successful upstream call
  per request is optimal (tie-break + proof consumes 1 success per prompt).
  Catalog probes are unnecessary — the catalog is static from the brief
  and the server answers `/v1/models` locally, never via the gateway.
- CHANGED: "1st call to any provider always succeeds" does NOT hold here —
  there is no simulated provider and no first-call guarantee in this kit;
  refusals are real OpenRouter 429/5xx, so the design retries/fails over
  and reports them. "Only paid model is opus-5.5 (1520, trap)" is GONE —
  no paid model exists in this catalog. "10 providers" is now 1 provider,
  14 models. Pod is 240 s / 1024 MB (was 180 s / 2048 MB).

## Routing design (main.ts v1, authored fresh this session)

- Parse the brief's models doc at runtime; build the catalog from it.
- Per request, from the request itself: JSON if `response_format` is
  json_object/json_schema; tools if `tools` present; vision if image
  content present. Anthropic requests are translated to Chat Completions
  (system → system message, tools → OpenAI function tools, tool_use /
  tool_result history → tool_calls / tool messages).
- Among models meeting the requirements, pick the highest rating:
  plain/tools → `openrouter/thinkingmachines/inkling-2-small:free` (1475);
  JSON → `openrouter/nvidia/nemotron-3.5-super-vl:free` (1303, best
  JSON-capable). Both are the per-requirement best, so quality should
  reach 100 if every prompt is served and proven.
- Up to 3 attempts per prompt (best, then next-best eligible), only on
  upstream refusal; failures reported in the header. Streamed upstream
  answers are buffered, then re-emitted in the exact event order each
  wire requires (OpenAI: content chunk, finish chunk, usage chunk,
  `[DONE]`; Anthropic: message_start, content_block_start, delta, stop,
  message_delta, message_stop), with the dialled id on every answer/chunk
  and usage with output ≥ 1.

## Grade-local

- Pending a live OpenRouter key: no key is pushed and none was found in
  the workspace, so a live trial cannot score until one is available.
  Run the no-key trial to smoke-test wire/catalog/failover handling, then
  re-run live once the key is pushed.
