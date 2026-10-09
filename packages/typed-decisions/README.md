# @dsh-task/typed-decisions

A real, independently usable DSH service plugin for bounded classification,
selection and scoring. It mounts `ctx.typedDecisions`, validates requests and
provider output, returns versioned receipts, and aborts pending evaluations when
its native Cordis fiber unloads. It needs no task ledger, executor, Feishu, web
host, separate daemon, Python installation or live model account in rules mode.

The native entry exports `name`, Standard Schema-compatible `Config`, and
`apply`. It deliberately has no default export. `./core` exports the engine,
providers and validators without loading Cordis.

## Compatibility and installation

Built for Node 24, DSH `0.2.0-rc.2` at
`639ed015397290b3745d163aafe02ffee4aa3f84`, native
`@deepseek-ai/cordis@4.0.4` and `@deepseek-ai/schemastery@3.18.4`.
The native packages are exact peer dependencies and development dependencies
so the plugin shares the host's service runtime.

From the standalone repository root (or this package directory):

```sh
npm ci
npm run build
npm test
npm pack
dsh plugin --profile my-host add ./dsh-task-typed-decisions-0.2.0.tgz
dsh --profile my-host --dump-config
dsh --profile my-host --dump-config-schema
```

The shipped `dsh.bundle.patch` adds one executable service row in rules mode.
The default has no rules and abstains; it does not invent routing heuristics.
Use your persistent native DSH profile to boot the service. A config dump is not
a boot test. Remove with `dsh plugin --profile my-host remove
@dsh-task/typed-decisions`, then restart the host to change installed bundle
membership. Runtime fiber disposal also removes the service and cancels its
evaluations. This plugin does not supervise, restart or update the DSH host.

## Independent use: no task system

A consumer injects `typedDecisions` and supplies finite candidates:

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@dsh-task/typed-decisions'

export const name = 'classify-support-message'
export const inject = ['typedDecisions']

export async function apply(ctx: Context) {
  const receipt = await ctx.typedDecisions.evaluate({
    requestId: 'support-message-481:classification:v1',
    stateHash: 'sha256-of-current-message-and-catalog',
    context: { message: 'Please refund the duplicate payment', category: 'billing' },
    questions: [{
      questionId: 'department', questionVersion: '1', type: 'choice',
      instructions: 'Choose the responsible support department',
      candidates: { billing: 'Payments and refunds', technical: 'Product faults' },
    }],
  })
  // Store the receipt with the caller's durable record. Apply your own policy.
  // An answered classification never grants permission to send a message.
}
```

A profile overlay for deterministic rules (a later row `config` replaces the
earlier config, rather than deep-merging it):

```yaml
- id: task-typed-decisions
  config:
    defaultProvider: rules
    providers:
      - id: rules
        kind: rules
        rulesVersion: 'support-v1'
        rules:
          - questionId: department
            questionVersion: '1'
            path: [category]
            equals: billing
            answer: {type: choice, choice: billing}
```

Rules match an exact context path/value and exact question version. Zero matches
abstain; multiple matches abstain. No arbitrary expressions or code are evaluated.
Rule outputs undergo the same question-specific validation as model outputs.

## Unified request and answer contract

Each request contains `requestId`, caller-owned `stateHash`, JSON `context` and
1–128 questions. Optional `provider`, `model` and `reasoningEffort` select only
configured capabilities. Each question has a nonempty `questionId`,
`questionVersion` and `instructions`:

| Type | Question | Accepted answer |
| --- | --- | --- |
| `choice` | `candidates: {id: rubricOrNull}` with 1–255 options | `{type:'choice', choice:'candidate-id'}` |
| `noul` | optional `criteria: {true: rubric, false: rubric}` | `{type:'noul', noul: number}` in `[0,1]` |
| `score` | `levels: [rubric, rubric, ...]`, 2–10 ordered levels | `{type:'score', score: number}` in `[0, levels.length-1]` |
| abstention | Any question with insufficient evidence or invalid provider output | `{type:'abstain', reason:'...'}` |

`noul` from an ordinary model is a model-reported numeric judgment, not a proven
calibrated probability. A score may lie between rubric levels. Provider limits
can be lower than the shared contract.

Unknown fields, non-JSON values, duplicate question IDs, duplicate JSON object
keys (including escaped keys), extra/missing answers, unknown candidate IDs,
type mismatches, NaN, infinity and out-of-range numbers are rejected. There is no
prose/fence extraction or best-effort JSON repair. Distribution-bearing backends
must return all finite probabilities, sum to one within `1e-6`, select a maximum
probability choice, and return a score equal to the weighted level indices.
Score legends must match the requested rubric. Malformed provider output causes
whole-request abstention, never partial unvalidated acceptance.

Input validation throws `DecisionValidationError`; configured-provider failures
produce an abstained receipt. An unknown provider is a configuration/request
error. Unsupported configured model/effort/question combinations produce an
`unsupported` receipt before the provider is called. No fallback silently changes
the requested provider, model or effort.

## Providers and capability honesty

### Ordinary models through the existing DSH provider

The optional `@dsh-task/typed-decisions/dsh-completion` plugin supplies the real
`typedDecisionCompletion` service. It calls the host's pinned DSH `llm` service
and existing model provider directly. It needs no custom adapter, task system,
agent loop, sessions, tools or separate process. Keep your usual native model
provider/authentication configuration; no model call occurs on plugin load.

The independent **Settings → Decisions** page is installed by this package's own
`./console-server` and `./client` companions. It does not require task-system,
a task database, an executor or an agent session. Configure named presets, manage
rule sets, and run a bounded connection check there. Native provider credentials
remain in DSH **Models**; Jev/compatible adapters retain their existing env references.
The page does not edit or create credentials.

Each model preset owns its provider configuration, pins the model and optional
reasoning effort, and retains a stable ID when renamed. Rule presets reference a
shared rule set. Rules can be created, edited, removed, imported and exported as
versioned JSON; import first creates a draft. Saved rule content determines its
version. No match or multiple matches produce abstention. An answer must still
belong to the caller's finite candidate set.

**Check connection** makes one small real model/API request, validates its answer,
and displays the result with a timestamp. It can incur normal provider charges.
Rules instead show **local rules validated** and their rule count. Neither metadata
readiness nor a configured API key is reported as a successful connection. Results
are page-local and invalidated when saved configuration changes.

The task-system page chooses presets separately for executor selection
(`task-planning`) and workspace/session selection (`task-session`). Other plugins
can store a preset ID in their own configuration and call the same service:

```ts
export const inject = ['typedDecisions'];
export function apply(ctx, config) {
  // Populate your plugin's own preset selector from this list.
  const choices = ctx.typedDecisions.presets().map(p => ({id: p.id, name: p.name}));
  // Pass the selected ID. Do not combine preset with provider/model/effort.
  const evaluate = (request, options) => ctx.typedDecisions.evaluate(
    {...request, preset: config.decisionPreset}, options,
  );
}
```

`DecisionRequest.preset` selects the stored route. Unknown preset IDs and mixed
preset/explicit routing are rejected. Explicit provider/model/effort routing
remains supported. The receipt's `requestDigest` always covers the **original
caller request**, including its preset ID. Preset resolution cannot bypass the
consumer's catalog, ownership or authorization checks. IDs/configurations belong
to one DSH host; each host configures its own presets.

Configuration reads and CAS writes are owned by `./console`. The independent RPC
service is `typedDecisionSettings` (`view`, `command`, `page`). Commands allow
preset/rule CRUD, default selection, per-consumer binding, model capability lookup
and connection probing. Existing narrow `./settings` APIs remain available for
older consumers. Saves preserve unrelated providers, routes, unknown fields and
credential references and restart only the affected decision plugins. Active
native calls and optional task/executor configuration guards reject unsafe edits.
Used presets/rule sets cannot be removed through the console.

The bundle installs an idle native bridge with `routes: []`, finite budgets, and
one settings companion. Keep existing entry IDs/configuration when updating;
do not load duplicate instances. Rules-only core service usage needs no Web
companion or model service. On phone widths the Decisions and Task system settings
move DSH navigation above their content and stack the cards.

Rule fields (all required):

| Field | Meaning | Current settings editor |
| --- | --- | --- |
| `questionId` | Exact question ID supplied by the consumer | Text field |
| `questionVersion` | Exact version supplied by the consumer | Text field |
| `path` | Segments to traverse from the request's `context`; `[]` selects the whole context | Add/remove path segment fields |
| `equals` | Value to compare by structural equality, including its type | Type selector with text/number/boolean/null/object/list controls |
| `answer` | Choice, 0–1 (`noul`), score, or explicit abstention | Answer-type selector and the corresponding input |

Each question must match **exactly one** rule. Zero matches yields
`no-matching-rule`; multiple matches yield `ambiguous-rules`, even if the answers
are identical. Rules do not have priority, regex, ranges, AND/OR groups, or a
first-match fallback. A missing context path does not equal JSON `null`.

Answers use `{ "type": "choice", "choice": "candidate-id" }`,
`{ "type": "noul", "noul": 0.8 }`, `{ "type": "score", "score": 2 }`, or
`{ "type": "abstain", "reason": "insufficient-evidence" }`. The consumer owns
the candidate IDs and score levels; evaluation validates the answer against the
actual question. Settings cannot infer a consumer's dynamic candidate list.

The settings UI nests rule cards inside their rule-set card. Edit expands the
selected card in place; collapse keeps unfinished form values. Rule summaries use
readable text, with 16px between the summary and action buttons. Forms never ask
the user to write JSON: nested objects/lists are edited with add/remove field and
item controls, and every scalar has an explicit type. The file format below is
produced/read automatically by import/export.

Finish a rule to update the rule-set draft, or save the rule set directly to include
the active rule form. Draft changes are applied only after saving the rule set;
discard restores the saved configuration. Export always exports the saved version.
Duplicate object field names and invalid numbers are rejected in the form. Switching
to another rule set warns before discarding an unfinished draft.

Rule import/export format:

```json
{
  "schemaVersion": 1,
  "id": "example-rules",
  "rules": [{
    "questionId": "session",
    "questionVersion": "1",
    "path": ["taskId"],
    "equals": "example-task-id",
    "answer": {"type": "choice", "choice": "new"}
  }]
}
```


For headless/operator configuration, the same existing protocol is:

```yaml
- id: typed-decision-native-completion
  name: '@dsh-task/typed-decisions/dsh-completion'
  config:
    routes:
      - model: judge
        provider: your-native-dsh-provider
        modelVersion: your-versioned-model-id
        reasoningEfforts: [low, high]
    maxOutputTokens: 2048
    maxInputBytes: 65536
    maxOutputBytes: 131072
    maxRuntimeMs: 10000
    maxConcurrent: 2
- id: task-typed-decisions
  config:
    defaultProvider: ordinary
    timeoutMs: 10000
    maxAttempts: 1
    providers:
      - id: ordinary
        kind: structured
        models:
          - model: judge
            version: your-versioned-model-id
            versionSource: configured-pin
            reasoningEfforts: [low, high]
```

`model` is the decision selector; `modelVersion` is the exact model ID sent to
DSH's configured provider. Supply a versioned provider model ID when available.
The pinned DSH stream API does not expose an independently reported response
version: native receipts explicitly say `modelVersionSource: configured-pin`.
They do not attest that a moving provider alias resolved to a particular model.
The declared `versionSource` must match the response source; a configured pin
cannot masquerade as `provider-reported`. Consumers requiring attestation must
reject configured pins or use a provider that reports its actual response ID.

Native `llm.prepareCall()` binds model resolution and streaming to one adapter
generation. Explicit effort selection and adapter-provided default efforts must
remain inside the configured allowlist, and DSH validates the selected effort
against that model's actual adapter metadata. Unsupported efforts abstain before
generation. No fallback substitutes a model, provider or effort.

Each judgment is one tool-free request containing only its system instructions,
context/questions and response JSON schema. The direct `llm.prepareCall` seam does not expose a native JSON
schema response-format switch, so the schema is included as prompt data
and the complete returned text undergoes the existing strict JSON validator.
Tool calls, truncated or unterminated streams, prose/fences, invalid JSON and
out-of-contract answers fail closed. Ordinary completions cannot return
`confidence`, `probabilities`, calibration levels or authorization fields.
Receipt evidence remains `structured-output / none`.

All five native budgets are required. Input bytes include the complete serialized
system/messages/tools payload. Output bytes conservatively count streamed text
and reasoning plus assembled blocks, including repeated text. Output tokens are
capped in the native request; reported usage above that cap is rejected. The
runtime limit includes provider metadata resolution and stream consumption.
Concurrent excess calls fail without another generation. These are explicit
request/usage bounds, not a guaranteed currency cap: native DSH exposes neither
provider pricing nor enforcement of billing. Configure a monetary limit with
the provider/account when needed. The bridge does not add retries; host LLM
middleware remains operator-owned and can affect billed request counts.

Parent cancellation, timeout and plugin unload abort each owned call, close its
iterator and remove listeners/timers. No agent/session is allocated or disposed.
A non-cooperative in-process provider or middleware cannot be forcibly stopped;
its late result is ignored and its iterator cleanup requested. The host itself
continues running, and other model users are unaffected.

### Custom ordinary-model integrations

A host may instead provide `StructuredCompletionAdapter.complete(input)` itself.
The input includes selected model/version, exact effort, system instructions,
JSON context/questions, response schema and `AbortSignal`. Return
`{output, modelVersion, modelVersionSource?, usage?}`, where output is a parsed
object or the complete JSON string `{answers:{questionId:answer}}`.
Omitting `modelVersionSource` retains the original `provider-reported` contract.
The version and its source must match the configured capability. A missing or
unloaded completion service produces a provider failure. No custom adapter is
needed for ordinary models already configured in the native DSH `llm` service.

### Hosted Jev

`kind: jev` uses the official fixed endpoint
`https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer ...`, and the exact
`{state,model,questions}` / `{model,answers,usage}` wire. Default model/version is
`jev-1.13.0`; `apiKeyEnv` defaults to `TYPESAFE_API_KEY`. Secrets are read at call
time and never stored in receipts. No calls happen on load.

The response version must match the configured pin, including when a request
model alias is explicitly configured. Jev's documented choice/score confidence
and probabilities are preserved as provider output; the receipt labels its
calibration `provider-claimed`, not locally validated. The official API has no
reasoning-effort field and no native abstain answer. Its capability says
`abstention: validation-only`: runtime errors/invalid output abstain, but a request
with explicit semantic `abstainWhen` conditions is unsupported. Use deterministic
consumer uncertainty thresholds or a provider with native abstention instead of
pretending Jev can satisfy those conditions. No API capability is invented.

Official wire and model references, checked 2026-10-01:
[API](https://docs.typesafe.ai/api), [models](https://docs.typesafe.ai/models).

### AnyJev-like compatible typed API

`kind: compatible` connects to an **already available** backend implementing that
typed wire. The plugin does not install, host or pretend to be AnyJev. Set the
full endpoint, model/version and explicit `capabilityDeclaration`:

```yaml
capabilityDeclaration:
  readout: logits
  calibration: L0
  maxChoices: 26
  maxScoreLevels: 10
  questionTypes: [choice, noul, score]
  reasoningEfforts: []
```

The readout must be `logits` or `hidden-states`, not text-only JSON. L1/L2 require
an operator-supplied `calibrationArtifact` identifier. This is an auditable
operator declaration, not proof that this plugin has trained or calibrated the
backend. L0 corrects position bias and is not a calibrated confidence guarantee.
The referenced AnyJev letter readout supports at most 26 choices; declare your
actual backend limit. A different backend may declare another supported finite
limit. Unsupported efforts fail because this wire has no effort field.

Endpoints require HTTPS, with loopback HTTP allowed for local backends. URLs may
not contain user info, queries or fragments; redirects fail. Responses are read
with a configurable byte cap. This adapter is compatible with the documented
wire, not a claim of live interoperability with every AnyJev deployment.

Upstream research baseline:
[AnyJev](https://github.com/nokia-applied-research/AnyJev/tree/10d5db91dda38dbde74c6abc1c075ce6463723d1).

## Bounded evaluation, identity and lifecycle

Configuration defaults:

| Option | Default | Meaning |
| --- | ---: | --- |
| `timeoutMs` | 10000 | Whole evaluation budget, including retries/backoff |
| `maxAttempts` | 1 | Maximum provider calls, 1–5 |
| `retryBaseMs` | 100 | Exponential retry base |
| `failureLimit` | 3 | Consecutive failed requests before opening provider circuit |
| `cooldownMs` | 30000 | Circuit cooldown |
| `maxReceipts` | 10000 | Engine-lifetime idempotency capacity, no silent eviction |
| `maxResponseBytes` | 1048576 | HTTP provider body limit |

Hosted HTTP retries are limited to 429/529. 401/422 never retry. Retry-After
seconds and exponential backoff remain inside the overall timeout. There is no
automatic fallback. Explicit abstentions reset the transport failure count;
unsupported requests and cancellation do not count as provider failures.

Receipts include schema/request/question/provider versions, the validated
model version and explicit `modelVersionSource`, request digest, capability-augmented input digest, state hash,
answers, evidence provenance, attempts, elapsed time and bounded error code.
No valid provider response means both `modelVersion` and `modelVersionSource` are null. Provider exception text,
raw prompts and credentials are not copied into receipts. Receipts are deeply
immutable. Confidence is never synthesized.

Concurrent identical request IDs share one pending evaluation and the same final
receipt. Reuse with different input/capabilities is rejected. A replay's abort
signal cannot cancel the original caller's evaluation. The cache is in memory
for one engine/plugin lifetime: **the caller must persist receipts in its own
durable task transaction and reuse persisted receipts across reload/restart**.
At capacity, new requests fail closed rather than evicting identity records.
Create a new engine only after the consumer has durably checkpointed identity.

Timeout or unload aborts the owned signal, settles pending service evaluations,
and ignores late provider responses. Core cannot forcibly stop arbitrary
in-process JavaScript supplied by an adapter. Adapters must honor the signal and
own cleanup of their external resources; do not attach detached side effects.
The native HTTP provider passes that signal through fetch and response reading.

## Domain consumers

Task-specific proposal helpers live in `@dsh-task/task-system/task-policy`.
That consumer builds finite questions and checks current task/workspace policy
before committing effects. This package has no task ledger, remote execution,
channel or task-domain dependency. Generic protocol validators are available
through `@dsh-task/typed-decisions/validation`.

## Verification and limits

The package test suite uses Node's test runner and the real pinned Cordis runtime
for independent service mount/unmount and optional adapter loss. The native
completion tests boot the actual DSH Loader and LLM runtime with only the
external model stubbed; they cover tool-free dispatch, version-source checks,
actual reasoning capability validation, malformed streams, explicit budgets,
cancellation, unload and reload without an agent/session/tool service. It verifies
wire payloads using in-memory fetch doubles, strict malformed response handling,
finite values, unsupported combinations, pin checks, bounded retries/failures,
timeouts, cancellation, immutable/idempotent receipts and task policy invariants.

No live model credentials, Jev calls, external compatible backend, calibrated
decision-quality evaluation or production deployment is implied by these tests.
DSH CLI Loader/profile boot and packaged install/remove are tracked by the
monorepo integration harness separately from native Cordis unit tests.

## Official structured subagents

DSH 0.2.0-rc.2 also offers `ctx.subagents.start` with `outputSchema`,
`toolFilter`, `persona`, an owning parent Agent and an AbortSignal. Consumers
already running inside an Agent can reuse that public path and accept only a
completed `structured` result, disposing the run afterward. Its object-rooted
schema subset and child lifecycle are provided by DSH. A failed or uncaptured
result must not be recovered from the last assistant text.

This standalone service uses the existing DSH LLM adapter for a single bounded,
tool-free call; rules and HTTP providers do not need an Agent or session.
Creating a parent Agent solely to evaluate a standalone question would add a
second ownership lifetime. The native adapter therefore remains on
`llm.prepareCall`, and does not implement a separate Agent loop. The task-system consumer maintains its own policy checks.

### Preset cards and independent API credentials

Preset editing expands inside its card, like rule-set editing. Collapsing a card retains the current draft. Save a new Typesafe/registered compatible API preset first; its expanded card then exposes a password input and separate **Save key** / **Remove this preset's key** controls. Blank input never overwrites a key. Ordinary DSH models continue to use the host Models configuration.

API keys are stored through `ctx.credentials` under a per-provider reference, never in plugin configuration or public console responses. Existing environment references remain supported. Saving a private key switches only that preset to its own reference. Each API call re-resolves the reference, so key rotation applies on the next call. If configuration save fails, the previous stored key is restored. Without a writable credential service, the page reports a specific error rather than claiming a successful save.

The caller supplies a preset ID, state/context, typed questions and finite candidates. The plugin resolves the configured adapter and returns validated answers and a receipt. Choice/Score probability distributions and confidence exist only where the backend supports them; Rules and ordinary JSON-output models do not acquire artificial probability metadata. Jev confidence summarizes distribution concentration, not empirical correctness.

### Ordinary models with probability readout

Verified upstream projects on 2026-10-07:

| Project | Mechanism | Integration boundary |
| --- | --- | --- |
| [AnyJev](https://github.com/nokia-applied-research/AnyJev) | Training-free Decider reads label-token probabilities and corrects order/label bias; separate Tacit checkpoints use self-distillation. | Requires its model/backend runtime. The current `/v1/decide` gateway has its own wire contract; it is not automatically a TypeSafe `/v1/systemone` endpoint. |
| [notjev](https://github.com/9pings/notjev) | Node library, one-token logprobs readout from a compatible model endpoint. | The server offers `/v1/systemone`, but adds `notjev` metadata and uses a different confidence formula. Needs a dedicated response adapter rather than relaxing strict Jev validation. |
| [jevper](https://github.com/zhulinchng/jevper) | Python wrapper with logprobs, grammar, structured and discrete modes. | `auto` may fall back to self-reported JSON probabilities. A future adapter must retain the actual readout method and reject unsupported logprobs rather than silently present JSON numbers as measured probabilities. |

These projects are researched candidates, **not installed or integrated backends in this release**. Probability readout needs logits/logprobs access; JSON output alone is not equivalent. Calibration must be measured for the intended routing questions. The existing Compatible adapter only consumes an explicitly registered typed backend with declared readout capabilities; it does not install AnyJev or transform the DSH chat service.

[OpenAI's DevDay announcement](https://openai.com/index/devday-2026-recap/) describes Decisions API in limited preview. Its specific request/response contract was not located in the official developer-doc search during this check. No guessed Decisions endpoint or compatibility claim is included.

### 外观与待办

决策设置跟随 DSH 的浅色、深色和系统外观。切换外观只更新配色，不重新加载页面或丢弃预设、规则草稿；未收到宿主主题时使用系统外观。手机继续使用上方设置导航与嵌套卡片。

notjev 概率读出接入已暂缓，触发条件与验证要求见 [BACKLOG.md](./BACKLOG.md)。


### Settings scrolling and standalone deployment

The DSH settings container owns vertical scrolling. The embedded decision page reports its content height, including a small rounding allowance; expanding and collapsing cards grows and shrinks the frame without adding an inner scrollbar.

This plugin runs without task-system. A clean official DSH Web profile was checked with only typed-decisions installed: its settings page saved a ruleset and preset through ConfigEditor, retained them after reload, evaluated the saved rules, and reported successful GUI rule validation. The ordinary-model and typed-API presets still require their respective configured provider and credentials; this deployment check made no paid API calls.
