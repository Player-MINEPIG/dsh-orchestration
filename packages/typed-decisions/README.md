# @dsh-task/typed-decisions

A real, independently usable DSH service plugin for bounded classification,
selection and scoring. It mounts `ctx.typedDecisions`, validates requests and
provider output, returns versioned receipts, and aborts pending evaluations when
its native Cordis fiber unloads. It needs no task ledger, executor, Feishu, web
host, separate daemon, Python installation or live model account in rules mode.

The native entry exports `name`, Standard Schema-compatible `Config`, and
`apply`. It deliberately has no default export. `./core` exports the engine,
providers, validators and task policy helpers without loading Cordis.

## Compatibility and installation

Built for Node 24, DSH `0.2.0-rc.2` at
`639ed015397290b3745d163aafe02ffee4aa3f84`, native
`@deepseek-ai/cordis@4.0.4` and `@deepseek-ai/schemastery@3.18.4`.
The native packages are exact peer dependencies and development dependencies
so the plugin shares the host's service runtime.

From the monorepo root:

```sh
npm run build --workspace=@dsh-task/typed-decisions
npm test --workspace=@dsh-task/typed-decisions
npm pack --workspace=@dsh-task/typed-decisions
dsh plugin --profile my-host add ./dsh-task-typed-decisions-0.1.0.tgz
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

When used with the task-system Web companion, **Settings → Task system → Decision model settings** selects an existing DSH provider/model and saves through the public ConfigEditor. Both task roles share the same decision configuration. Manage native providers and credentials in the official **Models** page. The form preserves env references, unknown fields and unrelated routes. It never calls a model or creates credentials. Jev non-secret fields and existing compatible model/endpoints are editable; absent credentials remain visibly not ready.

The bundle installs an idle native bridge with `routes: []` and finite budgets for the first explicit GUI save. Preserve any existing bridge instance/config when updating; do not load duplicate instances. The independent `./settings` module owns narrow configuration reads and CAS edits and has no Task/remote dependency.

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
`llm.prepareCall`, and does not implement a separate Agent loop. See the
[reuse assessment](../../docs/PLUGIN-BOUNDARIES.zh-CN.md).
