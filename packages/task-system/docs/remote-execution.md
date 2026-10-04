# Remote execution inside a DSH host

`@dsh-task/task-system/remote` provides an authenticated task bridge and an executor worker inside an existing DSH host. Its default signed mode uses the existing host HTTP carrier. The optional trusted-network mode owns one exact-address listener inside that same host. It does not start a daemon, supervise DSH, install a model runtime, generate credentials, or expose shell execution. Suite version 0.2.0 targets Node 24 and DSH `0.2.0-rc.2`, pinned upstream commit `639ed015397290b3745d163aafe02ffee4aa3f84`, with Cordis `4.0.4` and Schemastery `3.18.4`.

## Installation and composition

The package includes built ESM and declarations, a `dsh.bundle.patch`, and native named `apply`, `Config`, and `inject` exports. The bundle inserts one host-owned plugin. Its required `taskSystem` service supplies a structural `{ ledger: LedgerPort }` contract; a replacement provider can supply that seam without installing a planner, model-decision, or Feishu plugin. The task-system package in this repository supplies a matching ledger. No dependency on that package is imported by this package.

- `planner`: exposes `remoteExecution.gateway`; does not create local workers
- `executor`: exposes `remoteExecution.createWorker(provider)`; cannot mount the coordinator HTTP route
- `both`: exposes both paths, using the same durable lease lifecycle

`exposeHttp` defaults to false. In default `authMode: ed25519`, when enabled for a planner/both host, the plugin separately injects `webServer` and registers one exact POST route, `/dsh-task/v1/commands` by default. This uses the existing host HTTP carrier. Provider removal detaches the route; plugin unload stops admission, drains owned requests and workers, then closes its recovery store. Records survive unload and reinstall.

Native schema configuration: `authMode`, optional `trustedNetwork`, `role`, `nodeId`, `statePath`, `audience`, `peers`, `capabilities`, `workspaces`, `leaseTtlMs`, `exposeHttp`, `routePath`, `allowLoopbackHttp`, `maxBodyBytes`, `maxResponseBytes`, `pollIntervalMs`, `concurrency`, optional `coordinator`, and optional `observationForwarding`. Empty capabilities/workspaces/peers grant no authority. In signed mode each peer names an existing Ed25519 public key, a key ID, a node ID, one audience, permitted operations, workspace IDs, and capabilities. The host either injects an existing private `KeyObject` into `RemoteClient` or sets `coordinator.privateKeyEnv` to the name of an existing PEM environment variable. The package reads that variable only when opted in, does not generate or persist it, and never exposes its value in configuration or receipts.

The bundle intentionally does not invent peer credentials, workspace roots, or a workload provider. Configure those existing resources explicitly before allowing work. `createWorker(provider)` mounts one `ExecutionProvider` implementing the exported host-owned interface per recovery store. A remote executor can give its worker a `RemoteLedgerClient`; a local executor can give it a directly injected transactional ledger. A provider that already owns its own ledger settlement, such as task-system's native execution controller, should use the gateway/client seam directly rather than be wrapped as a second settling worker.

`worker.pollOnce(concurrency)` discovers assigned queued runs using `LedgerPort.pendingRuns(nodeId)`; the authenticated `listWork` operation derives that node from its signing key, filters workspace/capability grants, and returns at most 32 candidates. No caller can enumerate another node by supplying an identity. `pollIntervalMs` defaults to zero (off). When explicitly enabled, `createWorker` recovers durable results before starting its host-owned timer with a bounded concurrency of 1–16. Provider disposal clears the timer and drains accepted work. The client serializes signed command transmissions so concurrent provider execution does not reorder authentication sequences.

## Atomic protocol and identity

Version 1 accepts one operation per request: `listWork`, `claim`, `renew`, `bindSession`, `markRunning`, `submit`, `cancel`, `acknowledgeCancellation`, `getRun`, `getAttempt`, `observe`, `receipt`, `delegate`, `taskHistory`, `taskWait`, `taskNote`, `taskReport`, `heartbeat`, `nodeStatus`, `retryBeforeEffects`, `offerApproval`, `approvalStatus`, or `cancelApproval`. Each maps to one bounded ledger action; there are no batches, arbitrary commands, incoming filesystem paths, actor overrides, or arbitrary notification destinations. Optional `report.data` and `report.schemaId` preserve generic structured reports; JSON bounds still apply and the core ledger validates the configured template contract. Text report body remains required. These additive fields are supported by the pinned matching implementation; a peer must not assume older deployments support them.

The envelope includes version, key ID, authenticated node ID, audience, stable command ID, random nonce, monotonic sequence, issuance/expiry times, operation, payload, and signature. Ed25519 signs a domain-separated canonical JSON encoding of all unsigned fields. Verification binds the configured key to its exact node, audience, permitted operations, workspace, and capabilities. Nodes cannot promote their permissions through payload claims. The gateway fills ledger `nodeId` from the verified identity, scopes inspection and execution to assigned runs, and rechecks exact attempt/fence identity. The ledger remains the transaction and lease authority.

JSON content and wrapping have separate fixed depth budgets. Ordinary input, trigger, report data, and provider-status JSON retain a 16-level content limit. Template input/result schemas allow 24 levels because schema `properties`/`items`/`allOf` wrappers are structural, not deeper workload data. Complete signed/network envelopes, authority receipts and client/worker SQLite records use the same canonical encoder with a hard limit of 32, leaving at most eight wrapping levels around a bounded schema. Array, key, finite-number, forbidden-key and byte caps are unchanged; there is no caller-configurable depth override. The authority validates the claim plus its receipt/storage wrappers before committing an Attempt, so an invalid transport shape cannot strand a newly created lease. Both endpoints must use the matching build; an older 16-level consumer still rejects the newly supported schema shape.

Requests default to 64 KiB and responses to 128 KiB. Both are explicitly configurable from 1024 bytes through 16 MiB (16,777,216 bytes); nonfinite/fractional values or larger limits are rejected. `maxBodyBytes` bounds incoming gateway requests and the configured coordinator client's outgoing envelope. Root `maxResponseBytes` bounds gateway responses; `coordinator.maxResponseBytes` independently bounds received coordinator responses. Opt both ends into the needed size. Limits count the complete encoded message, including envelope/receipt overhead, not just report data. The configured worker reserves 4096 request bytes for the signed settlement wrapper; its maximum serialized result is `maxBodyBytes - 4096` (minimum 1024). Direct worker API defaults to a 60,000-byte result cap and accepts an explicit `maxResultBytes` up to 16 MiB, still subject to its transport limit.

Large node/game reports can use bounded inline `report.data` without remote artifact uploads. The human-readable report body remains limited to 32 KiB, summary to 5000 bytes, ordinary JSON content depth to 16, arrays to 256 elements, records to 64 keys, and request lifetime to 60 seconds by default. Declared Content-Length and actual streamed bytes are both checked. Oversized requests stop before ledger effects; oversized or interrupted responses yield uncertainty because a ledger action may already have committed. Response readers are cancelled at the limit. Unknown fields/operations/versions, expired/future timestamps, malformed keys, wrong nodes/audiences, payload tampering, repeated nonces, reordered sequence numbers, and changed payloads under an existing command ID are rejected. Nonce/sequence admission and the command receipt commit together in SQLite WAL/FULL mode. Replay state survives restart. A sender must retain its sequence database; deleting it is not a supported identity reset.

TLS is required by default. Explicit `allowLoopbackHttp` permits HTTP only on literal loopback endpoints and only when both the accepted socket's local and remote addresses are loopback. Forwarded headers do not establish trust. The package neither adds TLS nor verifies a reverse proxy's deployment: configure the host/operator TLS boundary separately. Outbound requests reject redirects and URL credentials, use timeouts, and bound response bytes.

## Optional trusted-network authentication

The default remains `authMode: ed25519`: signed v1 envelopes over TLS, with the existing explicit loopback exception. `authMode: trusted-network` is a separate, explicit v2 protocol for an operator-supplied trusted network. It uses no application signing key and does not fall back when signature verification fails. Both peers must opt in; an unsigned v2 command is rejected by a signed gateway and a signed v1 command is rejected by a network gateway.

This mode is useful when an existing encrypted network, such as a Tailscale tailnet, already authenticates and encrypts the path. The package itself neither encrypts HTTP nor proves Tailscale membership: it checks actual connection addresses against the operator's fixed exact-IP snapshot. It does not discover devices, refresh the list, accept CIDRs, change Tailscale/ACL/firewall/Serve settings, enroll devices, or create credentials. Configure only network paths whose address ownership and ingress are trusted. Programs sharing an authorized source machine share its network identity. An application key offers a separate process identity when its secret is isolated; choose signed mode if that boundary is needed.

A network coordinator uses this shape (documentation addresses are placeholders, not deployable defaults):

```json
{
  "role": "planner",
  "nodeId": "planner",
  "audience": "planner",
  "authMode": "trusted-network",
  "exposeHttp": true,
  "routePath": "/dsh-task/v1/commands",
  "trustedNetwork": {
    "listen": { "address": "192.0.2.10", "port": 18440 },
    "allowHttp": true,
    "allowedAddresses": ["192.0.2.11", "192.0.2.12"],
    "peers": [{
      "address": "192.0.2.11",
      "nodeId": "worker",
      "role": "executor",
      "audience": "planner",
      "operations": ["listWork", "claim", "markRunning", "bindSession", "renew", "submit", "getRun", "getAttempt", "receipt", "acknowledgeCancellation"],
      "workspaces": ["workspace"],
      "capabilities": ["read"]
    }]
  }
}
```

`allowedAddresses` controls the network admission boundary; `peers` grants application authority separately. The second example address is admitted by the network list but has no peer entry and therefore cannot invoke any command. No addresses are enabled by default. One canonical source address maps to one node; duplicate addresses or node mappings are rejected. This protocol contains executor-scoped operations only: a peer configured as `planner` cannot invoke it, while `executor` and `both` can invoke their explicitly permitted operations. Workspace, capability, assigned-run, execution owner, lease, fence, approval and subtree restrictions are unchanged. A request's claimed `nodeId` must equal the address-mapped identity and never creates its own authority.

The executor must opt in both at plugin level and on its coordinator:

```json
{
  "role": "executor",
  "nodeId": "worker",
  "authMode": "trusted-network",
  "coordinator": {
    "authMode": "trusted-network",
    "endpoint": "http://192.0.2.10:18440/dsh-task/v1/commands",
    "audience": "planner",
    "trustedNetwork": {
      "address": "192.0.2.10",
      "port": 18440,
      "localAddress": "192.0.2.11",
      "allowHttp": true
    },
    "nativeRoutes": []
  }
}
```

Supply the existing native routes, workspace bindings, capabilities and polling settings separately as required by the execution policy. Omit `keyId`, `privateKeyEnv`, signed `peers`, and `allowLoopbackHttp` in network mode. An executor does not need the server-side `trustedNetwork` listener policy. Network mode must be explicitly selected on `RemoteClient` too; its `trustedNetwork` target is the same object as `coordinator.trustedNetwork`, with no `privateKey` or injected `fetch`.

The dedicated listener binds only the configured literal IPv4 or IPv6 address and exact port (1–65535). It does not use DSH's `0.0.0.0` carrier, expose any other DSH route, or change the default carrier. Plugin activation awaits a successful bind; bind failure fails activation. Disposal closes admission and owned connections, drains gateway/worker/client work, and closes the store; pending listener startup is also owned by disposal.

Both accepted socket addresses and the local port must match the policy. IPv4-mapped IPv6 socket addresses normalize to IPv4. HTTP requires one exact `Host` matching the listener's literal address and port, with brackets for IPv6; every `Origin`, `Forwarded`, and `X-Forwarded-*` header is rejected. Only exact-path POST with `application/json` is accepted; no CORS permission is granted. Host validation prevents DNS-rebinding browser traffic; rejecting Origins avoids treating browser ambient network identity as permission to run commands. A proxy is not a supported network-mode intermediary.

The native Node HTTP client binds `localAddress`, rejects DNS hosts, implicit/mismatched targets, userinfo, queries, fragments and redirects, and verifies its actual connected peer/local addresses and peer port before writing the request body. It does not use environment proxy settings or follow redirects. IP ownership and the network path remain the operator's responsibility.

Network envelopes contain `version: 2`, `authMode: trusted-network`, node/audience, command ID, nonce, monotonic sequence, issuance/expiry, operation and payload; `keyId` and `signature` are forbidden. The durable journal records the original sender, audience, URL and authentication binding. A retry cannot silently switch auth mode, source address or target; legacy journal records without auth metadata are accepted only as signed v1 records. Keep the same command ID to reconcile an unknown result and never invent a new command to bypass an auth-binding mismatch. Nonce/sequence admission, receipt recovery and execution-owner fencing remain identical in both modes.

Authentication is a replaceable `RequestVerifier` seam returning an `AuthorizedPeer`; the core task ledger has no Tailscale dependency. A future optional Tailscale LocalAPI adapter can add verified node identity and app-capability mapping at that boundary. Exact-IP mode does not claim to perform that identity lookup.

## Execution, restart, and uncertainty

The worker claims from its injected ledger, validates role/node/provider/model/capability policy, resolves the configured workspace against its real allowed root, marks the attempt running for one execution owner, and then binds an exclusive session identity. A dispatch intent is committed before any provider effect. Session binding and fencing are ledger operations, including for local execution. The host provider must actually constrain its tools and filesystem to the policy it advertises; path validation alone is not an OS sandbox and cannot prevent malicious trusted in-process providers or a concurrent filesystem replacement.

Each recovery database persists a nonsecret instance UUID. The worker derives an attempt-specific `executionId` from that identity and first calls `markRunning` with an execution-specific command ID, then binds its session, then permits provider effects. The ledger atomically binds the first execution owner. A different store on the same authenticated node cannot start a second execution by replaying the deterministic claim command; subsequent renew/bind/submit/cancellation acknowledgments must carry the bound owner. The signed gateway requires `executionId` on `markRunning` and propagates it on all lease operations. Older direct ledger calls may omit the field only before an owner is bound; that compatibility does not permit a new remote start without an owner. Copying a recovery database deliberately copies its owner identity and is not a supported way to create another executor instance.

Task-specific `allowedNodeIds` and `allowedWorkspaceIds` narrow the host policy; an explicit empty list denies all. `maxRuntimeMs` supplies a separate abort deadline. `allowedTools` and `maxDepth` remain on the passed task policy for native tool/delegation enforcement. `nativeExecutionAdapter(native, { provider, models, capabilities })` connects the host's execution-only `executeExternal(request)` entrypoint to this worker with an explicit provider/model/effort allowlist. That entrypoint must return a staged structured outcome after native session flush and owned-agent cleanup; it must not settle the ledger itself.

Task `requiredResources` remains on the claim and is automatically acquired by the authoritative core; peers cannot omit it by leaving resources out of the wire request. Imported `observationOnly` runs are excluded from discovery and rejected by dispatch/mutation entrypoints. They remain evidence and never become executable work through the bridge.

Lease renewal failure or lease expiry aborts the provider. The provider contract requires abort cooperation and its promise to settle only after owned work quiesces. Unload awaits this contract and never kills a shared host. A non-cooperative provider cannot be made safe by this package; use a host-owned execution boundary that can stop its own work. Local `worker.cancel` stops only an active owned execution; durable user cancellation is the coordinator's scoped `cancel` operation. After quiescence, an authoritative cancellation is acknowledged if the ledger supports that method. Cancellation means work stopped, not that prior effects were undone.

Structured provider results are persisted before ledger submission. Submission uses a stable result ID; a missing acknowledgment retries only that exact durable result. After restart, an interrupted dispatch becomes `uncertain` and is never automatically executed again. For an uncertain gateway receipt, the optional ledger `commandReceipt` read can prove that the exact node-scoped command already committed. Only a matching durable receipt promotes that journal entry to done; missing or mismatched proof keeps uncertainty and never reexecutes the command. Callers must not replace the command ID to force a retry of uncertain effects. The client commits outbound intent before network transmission and stores the reply before returning.

## Install-and-configure remote execution

With `coordinator` configured, the plugin constructs the signed client and remote ledger itself, binds the current native `taskSystem.native.executeExternal` provider, and uses the remote ledger for its worker. A `both` host still uses its local ledger for its incoming gateway. Native provider absence makes the configured route unavailable; it cannot silently fall back to another provider. One native backend supports only the explicit provider/model/effort tuples in `nativeRoutes`. Its diagnostic backend ID does not authorize a different model vendor. Polling remains off until `pollIntervalMs` is positive.

The following is a complete executor overlay for an existing DSH profile. Replace the example endpoint, configured model/provider names, and real workspace paths. The signing key must already exist in the named environment variable. The local task-system row needs `role: executor`, `observationEnabled: true` if forwarding is desired, `autoAdmitObservations: false`, and its explicitly allowed `executionTools`. The coordinator ledger must register the same node, allowed models/capabilities, and workspace before routing work.

```yaml
- id: task-remote-execution
  config:
    role: executor
    nodeId: worker-one
    statePath: .dsh-task/remote-execution.sqlite
    exposeHttp: false
    audience: planner-one
    peers: []
    allowLoopbackHttp: false
    capabilities: [read]
    workspaces:
      - workspaceId: project-one
        nodeId: worker-one
        path: /srv/workspaces/project-one
        allowedRoot: /srv/workspaces
    leaseTtlMs: 60000
    maxBodyBytes: 1048576
    maxResponseBytes: 1048576
    pollIntervalMs: 1000
    concurrency: 1
    coordinator:
      endpoint: https://coordinator.example.invalid/dsh-task/v1/commands
      audience: planner-one
      keyId: worker-one-key
      privateKeyEnv: DSH_WORKER_ONE_SIGNING_KEY
      maxResponseBytes: 1048576
      heartbeatIntervalMs: 15000
      nativeRoutes:
        - provider: configured-provider
          models:
            - model: configured-model
              reasoningEfforts: [low]
    observationForwarding:
      workspaceId: project-one
```

The coordinator's remote plugin uses `role: planner`, `audience: planner-one`, `exposeHttp: true`, and a configured existing host HTTP/TLS carrier. Its peer entry names `keyId: worker-one-key`, `nodeId: worker-one`, the existing Ed25519 `publicKey` PEM, `audience: planner-one`, `workspaces: [project-one]`, `capabilities: [read]`, and these needed operations: `[listWork, claim, bindSession, markRunning, renew, submit, getRun, getAttempt, acknowledgeCancellation, taskWait, receipt, observe, heartbeat, nodeStatus]`. `taskWait` is required by native success/partial settlement even when delegation tools are disabled. Omit `heartbeat` and `nodeStatus` and set `heartbeatIntervalMs: 0` if reachability observation is not enabled. Omit `observe` if observation transmission is not approved; omit `observationForwarding` on the executor as well. Peer cancellation is separately opt-in and remains scoped to that peer's assigned node. Do not place private key PEM in a patch, package, or state database.

For the 1 MiB example, also set the coordinator gateway's `maxBodyBytes` and `maxResponseBytes` to `1048576`. Leaving defaults on the other side keeps that side's smaller bound. These fields do not change TLS, key scopes, task policies, or artifact ownership.

## Active native approval requests

To forward live native approval requests, explicitly add `offerApproval`, `approvalStatus`, and `cancelApproval` to the executor peer's operations. The worker exposes these through its bound collaboration port. The native host owns the actual pending SDK callback and creates a unique request identity for that live call. The offer contains only request/session/agent/call/tool identifiers, an arguments digest, a description of at most 4000 characters, an expiry no more than five minutes ahead, and whether a one-time remote approval is eligible. It contains no raw arguments, actor, source override, or decision. Task tool policy and the exact live lease/session/execution owner are checked again at the coordinator.

Only a trusted coordinator operator adapter may respond with `allowed-once` or `denied`; `respondApproval` is deliberately absent from the peer protocol and collaboration port. Coordinator `approvalDestinations` can queue requests for a separately configured trusted delivery adapter. `allowRemoteOnce: false` retains host-only approval. This bridge cannot grant a persistent permission, approve its own request, or widen the task's tool policy.

Status polling uses fresh read identities and requires the same live owned lease, including retries of a previously recorded status command. Cleanup cancellation captures the original ref and remains callable after the execution signal aborts or lease expires; it can only narrow that old pending request. Native application must also recheck the exact request/call/session/attempt/execution identity, expiry, and current signal before responding to its held callback. Historical receipts or restarted journals never reconstruct SDK callbacks or authorize a new attempt. Tests use fabricated public descriptions and actual core records; native hook and callback lifecycle verification lives in the joined DSH fixture.

## Bounded native continuation

Retries are off by default. Opt in through task-system `safeRetry` on the native executor and coordinator, for example `{maxRetries: 1, baseDelayMs: 30000, maxDelayMs: 60000}`, and explicitly add `retryBeforeEffects` to that peer's operations. The coordinator pins retry policy to each run. The compatibility operation name also supports explicitly reviewed completed-tool continuation. Only the owned native runtime produces evidence after a transient `RATE_LIMIT`, `SERVER`, `TRANSPORT`, or provider `TIMEOUT` terminal event, complete capture, flush, quiescence, and owned-handle disposal. The original `dsh-owned-zero-tools-v1` witness requires zero tool requests and dispatches.

Completed-tool continuation additionally requires the operator's `safeRetry.resumableTools` allowlist on the coordinator and native executor. It defaults to `[]` and is pinned in `run.retryPolicy`; task `allowedTools` can narrow it further. The `dsh-owned-completed-tools-v1` witness requires equal positive `toolCallCount`, `toolDispatchCount`, and `toolResultCount` values of at most 32, plus an equally sized `completedTools` array. Each entry has exactly `name` and `argumentsDigest`; the latter is a lowercase 64-character SHA256 digest of canonical `{name, arguments}`, with no raw arguments on the wire. Duplicate fingerprints are permitted in a witness. The coordinator accumulates distinct fingerprints in `run.retry.completedTools` across retries, preserves them through later zero-tool retries, and caps the set at 160 (five retries of at most 32 tools). On continuation, the native executor retains the saved session and rejects a previously reviewed tool name and argument digest before dispatch. Operators must review which tools are safe to resume after successful completion; the protocol does not infer that from a tool's name or report text.

Both variants are authenticated node attestations. The remote gateway checks the strict schema and bound session/lease/owner; the coordinator checks the pinned allowlist, task policy, and retry budget. Native tests establish the actual event linkage, successful completion, persistence, and dispatch-guard evidence rules. Remote package fixtures explicitly mock native evidence and do not independently establish those properties.

An ordinary unknown outcome has no retry authority. With a valid witness, the worker persists `retry_pending`, stops renewal, and requests one stable `retryBeforeEffects` command. A coordinator-approved retry becomes `retry_scheduled`; only later discovery after backoff may claim a new fenced attempt. The run and authorized session are retained, and runtime limits remain anchored to the run's original `executionStartedAt`. A host with a tighter runtime budget may attest `retryAllowed: false`, which can only refuse another retry. Disabled, exhausted, or expired retry policy yields the coordinator's durable terminal failure. Malformed runtime evidence leaves the dispatch uncertain; rejected coordinator evidence or an uncertain transition keeps recovery pending. A lost receipt retries only the same durable command and proof, without dispatching a provider or tool. No new command ID is invented to resolve an ambiguous effect.

## Authenticated node reachability

`coordinator.heartbeatIntervalMs` is disabled by default (`0`); an explicit interval of 1000–3600000 ms enables an owned heartbeat timer, independent of work polling. The timer stops and drains on plugin removal. Each heartbeat includes a bounded sample timestamp, derives the node from its signing identity, reports whether the current native `executeExternal` capability exists, and reports the larger of native active handles and this worker’s active provider executions (bounded to 128). Configured vendors are reported as `not-probed`: local runtime availability is not evidence that a model endpoint will succeed. No network model probes, URLs, secrets, capability grants, or model registrations appear in heartbeat payloads.

The planner core owns heartbeat TTL (`heartbeatTtlMs`, default 60000 ms) and stale/recovery evaluation. Older samples cannot regress the newest observation; exact receipt retries do not refresh reachability. Core `requireFreshHeartbeat` is separately opt-in if routing should require online status. A heartbeat is an authenticated peer observation, not an authority grant; it cannot enable a disabled node or change capabilities, workspaces, routes, or concurrency limits. `nodeStatus` takes an empty payload and returns only the authenticated peer's registered status. Provider status accepts bounded `not-probed`, `ready`, and `unavailable` observations and is never proof of model readiness. `RemoteLedgerClient.recordNodeHeartbeat` and `ownNodeStatus` expose the same operations; timer errors set `lastHeartbeatFailed`, and a later timer tick sends a new current observation rather than replaying effects.

## Scoped recursive collaboration

To permit the owned executor's recursive task tools, explicitly add `delegate`, `taskHistory`, `taskWait`, `taskNote`, and `taskReport` to its peer operations and allow the corresponding native tools in task policy. Every call includes the already-bound live run/attempt/fence/executionId. The gateway checks that authority again; core methods permit only the current task or its descendants and derive the parent and actor themselves. A signed caller cannot supply a new parent, impersonate an actor, or inspect/write unrelated task history.

The worker provides an in-process `ExecutionRequest.collaboration` port with `delegate`, `history`, `wait`, `note`, and `report`. Closures capture the lease and abort signal, select only allowed inputs, and namespace command identities by execution owner. Native remote tools use these callbacks instead of a local ledger that does not contain the coordinator's task. `taskWait` returns an immediate bounded settlement view; any bounded polling is owned by the native tool. Delegation preserves core scope/resource/depth/fanout/capacity rules, and core success/partial settlement waits for descendants. Global task-intent creation remains a planner operation.

Task notes append under the selected subtree task without waking an active run. The core transfers pending notes into the next created run's `contextNotes` atomically. The claim retains those notes for native execution. Scoped reports append independently of final settlement and may include generic structured data. None of these operations expands filesystem or tool authority.

## Observe-only cross-device intake

`observe` accepts only `workspaceId`, `sessionId`, `sourceRevision`, `title`, an at-most-8000-character `body`, ISO `observedAt`, and boolean `truncated`. The peer's operation and workspace grants are checked. The gateway derives an unambiguous source namespace from the authenticated node, workspace, and session; a peer cannot provide actor/source/task/run identities or execution authority. It calls only `captureObservation`, producing a pending candidate. Planner-side typed admission decides whether that evidence belongs in task/report history. Observation intake never creates or dispatches a run.

`observationForwarding.workspaceId` must select this node's explicit `workspaces` binding and cannot coexist with local `autoAdmitObservations`. The native observation subscription captures immutable `session.header.cwd`. Before any transmission, `observationForwarder(remote, binding)` resolves that path, the binding path, and the allowed root; the source must be inside both. Missing, unavailable, outside, and symlink-escaping sources remain local and return a `local-only` diagnostic. Historical observations without captured cwd are not forwarded. The raw cwd is omitted from the wire. This is a real workspace filter, not a label attached to all host sessions.

Observation deliveries use stable IDs and the existing durable client journal. `RemoteLedgerClient.observe`/`captureObservation` submit bounded observations; `recoverObservations(limit, {signal})` retries only previously journalled observation IDs and payloads to their original node/audience/endpoint. No new effect IDs are invented to resolve uncertainty. Native replay can call the same forwarder again, yielding the same command and candidate. Unload detaches the subscription, aborts queued/in-flight client requests, and drains owned work before closing the journal.

Recovery does not claim exactly-once execution. Persistent receipts and idempotent ledger commands prevent supported replays; external side effects can remain unknown. Coordinator clocks define leases; worker/coordinator clocks need bounded skew. The store is an application recovery journal, not a replacement for the task ledger. Run `recoverResults()` only while the worker is idle, before admitting new work.

## Verification

From the repository root:

```sh
npm run build --workspace @dsh-task/task-system
npm run test --workspace @dsh-task/task-system
```

Tests label mocked ledger/provider/HTTP boundaries. They exercise real Ed25519 and SQLite, authenticated health TTL and recovery, bounded witnessed retry transitions (with native evidence explicitly mocked in the package fixture), malicious payloads, least privilege, replay/reordering, physical symlink escape, stale leases, cancellation, intent/result crash recovery, and lost acknowledgments. One connected fixture uses the real TaskLedger, signed discovery and every execution lifecycle transition with only provider/network boundaries mocked. A separate test mounts and unloads the real pinned Cordis plugin while substituting only the ledger boundary. Trusted-network tests add real IPv4/IPv6 loopback HTTP, distinct source addresses, mode confusion, header forgery, peer and scope denial, replay/expiry, redirect refusal, authentication-bound recovery, and disconnect/lost-ACK restart coverage. An additional real loopback TLS carrier test uses a disposable certificate, rejects an untrusted certificate and spoofed forwarded headers, and carries signed commands through the actual HTTP handler and TaskLedger. Certificate verification remains enabled; the fixture CA is scoped to that test client. These tests do not establish live cross-device TLS, live model execution, Windows supervision, production credentials, or real network reliability. No public repository, production host, or live messaging destination is created or contacted.

The TaskLedger command bound is additionally 2,000,000 canonical JSON characters per operation. The 16 MiB transport ceiling is not a guarantee that an equally large task command can commit; apply both limits and split large historical imports.
