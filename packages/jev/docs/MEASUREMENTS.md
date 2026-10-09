# Why this plugin exists — and the measurements behind it

This document is the evidence for `dsh-jev-plugin`. It records what was measured, what
was falsified, and why the plugin does exactly one thing: give the agent a tool
for batch judgements. It exists so the next person does not have to re-run any of
it.

All numbers come from real data: 402 sessions of a working DeepSeek Harness
install (353,992 tool results, 7,812 model requests, 368 subagents), unless a
line says otherwise.

## 1. What Jev is (verified, not from marketing)

TypeSafe AI's System One model. `POST …/v1/systemone` takes a `state` and typed
`questions` and returns typed answers — it does **not** generate text.

| | |
| --- | --- |
| Question types | `noul` (yes/no → probability 0–1), `choice` (named options → `choice`, `probabilities`, `confidence`), `score` (ordered rubric → `score`, `probabilities`, `confidence`) |
| Parallelism | every question is evaluated in parallel against the same state; 40 questions cost and take about as much as 1 |
| Price | $42/Btok input ($0.042/Mtok), **output free** |
| Limits | 64k context (32k for `state` + longest question), 1200 req/min, **text only** |
| Language | English is the primary training language; others are "handled but not equally well" |
| `confidence` | a statistic derived from the distribution — `(n × p_max − 1) / (n − 1)` — not a guarantee |

### The endpoint trap

Evaluation is **not** served through the OpenAI-, Anthropic- or
Cohere-compatible endpoints. Vercel's documentation is explicit:

> It is not supported through the OpenAI-compatible, Anthropic-compatible, or
> Cohere-compatible endpoints.

Requests to `/v1/chat/completions`, `/v1/messages` and `/v1/responses` fail
always. Valid routes:

| Route | Endpoint | Model |
| --- | --- | --- |
| TypeSafe direct | `POST https://api.typesafe.ai/v1/systemone` | `jev-latest` |
| Vercel AI Gateway, native | `POST https://ai-gateway.vercel.sh/v1/evaluate` | `typesafe-ai/jev` |
| Vercel AI Gateway, TypeSafe-compatible | `POST https://ai-gateway.vercel.sh/typesafe/v1/systemone` | `typesafe-ai/jev` |

The third returns the same shape as the direct API, which is why this plugin uses
it for the gateway: one parser covers both backends.

Also on the gateway: the free tier requires a **payment method on file** before
even the included $5/month can be spent (`customer_verification_required`), and
Jev's upstream answers `429` under load often enough to need a retry ladder.

## 2. Measurements

### 2.1 Batch judgement — the one place Jev wins

Same task, same real data: 26 shell outputs from real sessions, hand-labelled,
identical `state` and identical questions. Jev answered **37 items in one call**;
each model answered the 26-item gold set.

| model | accuracy | latency | tok_in | tok_out | cost |
| --- | --- | --- | --- | --- | --- |
| google/gemini-2.5-flash | 25/26 (96%) | 5,932 ms | 4,152 | 1,080 | $0.00395 |
| xiaomi/mimo-v2.5 | **26/26 (100%)** | 17,359 ms | 4,142 | 1,509 | $0.00100 |
| alibaba/qwen-3-14b | 24/26 (92%) | 23,424 ms | 3,903 | 1,053 | $0.00072 |
| **Jev** (37 items, 1 call) | 25/26 (96%) | **456 ms** | 6,864 | 0 | **$0.00029** |

- Against gemini-2.5-flash, **at identical accuracy**: **13x faster, 13.6x cheaper** — while doing 11 more items.
- Against mimo (one more correct): 38x faster, 3.4x cheaper.
- Against qwen: better accuracy, 51x faster, 2.5x cheaper.

Measured against what the harness does today when it needs a judgement outside
its own context — **368 real subagents**:

| | median | p90 |
| --- | --- | --- |
| model requests | 9 | 48 |
| wall clock | **48 s** | 150 s |
| message tokens | **116.7k** | 192.5k |
| input cost | **$0.035** | — |

**105x faster and ~120x cheaper per occasion.**

Honest limit: this is a **per-occasion** gain, not a global saving. 368 subagents
in total is ~5 hours and ~$13 of wall clock across the whole history, and not all
of them are batch judgements.

### 2.2 Where Jev loses

With a mechanical criterion, `grep` is free, exact and instant. There is nothing
to add. Jev's own substring test fell to 60–70% accuracy — it is not a search
engine, and it should not be used as one.

### 2.3 Skill selection — no-go (measured)

26 real (request → skill the user actually loaded) pairs and 200 real turns where
no skill was loaded:

| metric | Jev | TypeSafe's own cookbook |
| --- | --- | --- |
| wrong load | **54.2%** | 16.8% agent alone / 7.3% with a suggestion |
| needless load | **95.0%** | 9.8% / 4.0% |

Root cause: all three gate questions from the cookbook have **zero discriminative
power** on a coding workload (mean on positives vs negatives):

| question | positives | negatives | separation |
| --- | --- | --- | --- |
| `acts_on_user_system` | 0.33 | 0.36 | −0.03 |
| `would_follow_documented_procedure` | 0.54 | 0.51 | +0.03 |
| `prose_suffices` | 0.25 | 0.33 | −0.08 |
| `is_small_talk_or_meta` (written for this workload) | 0.29 | 0.51 | **−0.22** |

`confidence` was also **not calibrated** here (accuracy by confidence band:
33% / 25% / 67% / 57%), including two wrong answers at 0.85 and 0.96 confidence.

### 2.4 Replacing the deterministic tool-result pruner — falsified

The prize looked large. In this install the surface is re-sent on every request,
so a tool result costs its size × the times it is re-sent:

| | |
| --- | --- |
| tool results | 353,992 |
| raw tokens | 103.8 M |
| **re-sent tokens** (bounded by compaction) | **1,178.2 M** |
| amplification | **11.3x** |
| results ≥8,192 chars — exactly what the pruner rewrites | 5,692 (**40%** of the re-sent total) |

`dsh-compaction-tool-result-pruner` keeps head 4,096 + tail 1,024 chars and drops
the middle, deterministically and for free. Could Jev pick a better middle?

A first run suggested yes (pruner 0/4, Jev 3/4) — **but that run was invalid**:
it told Jev the exact token to find, i.e. it leaked the future question. A
compressor never knows the future question.

Re-run with the honest design — generic salience, same 5,120-char budget,
and **only cases where the full-output control arm succeeded**:

| case | pruner | Jev (generic salience) |
| --- | --- | --- |
| 15,629 chars | FAIL | **FAIL** (6 chunks kept, top score 0.90) |
| 12,918 chars | FAIL | **FAIL** (0 chunks — everything scored <0.5) |
| 9,272 chars | FAIL | **FAIL** (6 chunks, top score 0.87) |

**0/3 and 0/3.** With query-specific selection the advantage was an artefact; it
disappears entirely once the compressor does not know what will be asked. The
network call, the added latency and the 429 failure mode are not worth paying for
no gain. **Not built.**

### 2.5 Candidates with nothing to optimise (measured, discarded)

| candidate | measurement | verdict |
| --- | --- | --- |
| Search-result re-ranking | 2,102 searches; the agent reads **0** pages after 72% of them (mean 0.49) | nothing to fix |
| Approval friction | **34** approval prompts in 402 sessions | nothing to fix |
| Sensitive material in context | **0** hits across 118,398 tool/assistant messages | no problem to cover |
| Tool-schema pruning | 14,160 tokens/request × 7,812 = 110.6 M | impossible: breaks prefix caching, risks hiding a needed tool |

### 2.6 Structurally impossible

- Summarising, titling, compaction — Jev cannot generate text.
- A guardrail on **every** tool call: 351,870 calls × ~450 ms = ~44 hours. The
  seam exists (`tools/pre-execute` is an async waterfall and async gates are
  supported by design), but the frequency makes it unaffordable.

## 3. The internal seams, for whoever tries next

Every one of these is an async waterfall, i.e. a real decision point that a
plugin can take over:

| seam | decision | fires |
| --- | --- | --- |
| `tools/post-execute` | accept, **replace**, enrich or block a dispatch result | 351,870 |
| `tools/pre-execute` | allow / deny / ask before dispatch | 351,870 |
| `agent/request` | replace the frozen call configuration (provider/model) | 7,812 |
| `llm/stream` | wrap every streaming model call | 7,812 |
| `agent/pre-step` | reject a step or replace the messages entering it | 347,790 |
| `system-prompt/assemble` | mutate sections, contexts and tools | 347,790 |
| `approval/request`, `user-questions/request` | answer in place of the human | 34 |
| `fs/write-intent`, `fs/edit-intent` | decide before a write or edit | rare |

`tools/post-execute` remains the architecturally correct home for any future
context-compression attempt (it can fail open by delegating to `next()`), and
`agent/request` is where per-request model routing would live. Neither is worth
building without a measured win.

## 4. Method notes worth keeping

Two of the negative results above were originally positive, and both times the
fault was the measurement, not the model:

1. **Check the label.** A triage experiment scored Jev at 56.8% using
   `tool/result.content[].isError` as ground truth. That flag marks *transport*
   failures (a denied sandbox escalation, an interrupted call), not a non-zero
   exit — a `git` that exits 1 does not set it. Hand-labelling the same 37 items
   gave **25/26 (96.2%)**.
2. **Never leak the question.** A compressor that is told what to look for will
   look good and be useless.

Include a control arm that must score ~100%, and treat its failure as
invalidation of the whole run rather than as a data point.

## 5. Conclusion

Jev is used in DSH for exactly one thing: **the `jev` tool**, for batch
judgements a regex cannot express, where the alternative is a subagent or
poisoning the context. Everything else in this document is either measured and
losing, structurally impossible, or unmeasured and therefore not built.
