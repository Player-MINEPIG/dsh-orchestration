import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskLedger } from "../dist/ledger.js";
import { ProgramRegistry } from "../dist/workflow-programs.js";
import { WorkflowRuntime } from "../dist/workflows.js";
import { ExecutorWorker } from "../dist/remote/worker.js";
import { RecoveryStore } from "../dist/remote/store.js";
let counter = 0;
const id = () => `test-${++counter}`;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "workflow-test-")),
    file = join(dir, "ledger.sqlite");
  let ledger = TaskLedger.open(file, {
    role: "both",
    nodeId: "vps",
    requireFreshHeartbeat: true,
  });
  const registries = {
    vps: new ProgramRegistry("vps"),
    mbp: new ProgramRegistry("mbp"),
  };
  const stores = [],
    workers = [];
  let runtime = new WorkflowRuntime(ledger, registries.vps);
  for (const nodeId of ["vps", "mbp"]) {
    ledger.registerNode(id(), {
      nodeId,
      roles: ["both"],
      capabilities: [],
      models: [{ provider: "test", model: "model", reasoningEfforts: [] }],
      workspaceIds: [`${nodeId}-ws`],
      enabled: true,
      lastSeenAt: new Date().toISOString(),
      maxConcurrent: 4,
    });
    ledger.registerWorkspace(id(), {
      workspaceId: `${nodeId}-ws`,
      nodeId,
      path: dir,
      label: nodeId,
      state: "ready",
      createdAt: new Date().toISOString(),
    });
  }
  const f = {
    dir,
    registries,
    get ledger() {
      return ledger;
    },
    get runtime() {
      return runtime;
    },
    heartbeat(nodeId, ready = true) {
      ledger.recordNodeHeartbeat(id(), {
        nodeId,
        sampledAt: Date.now() + counter,
        runtimeReady: ready,
        activeExecutions: 0,
        providerStatus: {
          state: "not-probed",
          providers: [],
          programs: registries[nodeId].catalog(),
        },
        source: "host-local",
      });
    },
    register(nodeId, programId, execute) {
      registries[nodeId].register({
        programId,
        version: "1",
        title: programId,
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        execute,
      });
      f.heartbeat(nodeId);
    },
    worker(nodeId, fallback) {
      const store = new RecoveryStore(join(dir, `worker-${id()}.sqlite`));
      stores.push(store);
      const worker = new ExecutorWorker({
        ledger,
        store,
        provider: registries[nodeId].provider(fallback),
        policy: {
          role: "both",
          nodeId,
          capabilities: [],
          workspaces: [
            {
              nodeId,
              workspaceId: `${nodeId}-ws`,
              path: dir,
              allowedRoot: dir,
            },
          ],
        },
        taskSessions: true,
        chooseSession: () => {
          throw new Error("program must not choose an Agent session");
        },
      });
      workers.push(worker);
      return worker;
    },
    reopen() {
      ledger.close();
      ledger = TaskLedger.open(file, {
        role: "both",
        nodeId: "vps",
        requireFreshHeartbeat: true,
      });
      runtime = new WorkflowRuntime(ledger, registries.vps);
    },
    async close() {
      await Promise.all(workers.map((worker) => worker.dispose()));
      stores.forEach((store) => store.close());
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return f;
}
const programStep = (
  stepId,
  nodeId,
  programId,
  dependsOn = [],
  inputs = {},
) => ({
  stepId,
  nodeId,
  workspaceId: `${nodeId}-ws`,
  title: stepId,
  dependsOn,
  inputs,
  execution: { kind: "program", programId, version: "1" },
  maxRetries: 0,
});
const definition = (steps) => ({
  workflowId: "daily",
  revision: 0,
  title: "Daily workflow",
  description: "Test",
  steps,
});
const save = (f, d) =>
  f.runtime.save({ commandId: id(), expectedRevision: 0, definition: d });
const start = (f, input = {}) =>
  f.runtime.start({ commandId: id(), workflowId: "daily", input });
const view = (f, run) =>
  f.runtime
    .snapshot()
    .runs.find((item) => item.workflowRunId === run.workflowRunId);

test("durable admission and pinned inputs survive restart and repeated ticks", async () => {
  const f = fixture();
  try {
    f.register("mbp", "collect", () => ({
      data: { items: ["evidence"] },
      summary: "Collected",
    }));
    save(
      f,
      definition([
        programStep("collect", "mbp", "collect", [], {
          window: { kind: "workflow-input", path: ["window"] },
        }),
      ]),
    );
    const command = {
      commandId: id(),
      workflowId: "daily",
      input: { window: "original" },
    };
    const run = f.runtime.start(command);
    f.runtime.tick();
    const admitted = view(f, run).steps[0];
    assert.ok(admitted.runId);
    assert.equal(
      f.ledger.getRun(admitted.runId).configuration.workflow.workflowRunId,
      run.workflowRunId,
    );
    f.reopen();
    assert.deepEqual(f.runtime.start(command), run);
    f.runtime.save({
      commandId: id(),
      expectedRevision: 1,
      definition: {
        ...definition([
          programStep("collect", "mbp", "collect", [], {
            window: { kind: "literal", value: "changed" },
          }),
        ]),
        revision: 1,
      },
    });
    f.runtime.tick();
    f.runtime.tick();
    assert.equal(f.ledger.snapshot().tasks.length, 1);
    assert.equal(f.ledger.snapshot().runs.length, 1);
    assert.deepEqual(f.ledger.getRun(admitted.runId).configuration.input, {
      window: "original",
    });
    assert.equal(view(f, run).definitionRevision, 1);
  } finally {
    await f.close();
  }
});

test("programs use existing worker with no Agent session and route outputs across devices", async () => {
  const f = fixture();
  try {
    let calls = 0;
    f.register("mbp", "collect", ({ input, executionId }) => {
      calls++;
      assert.ok(executionId);
      return {
        data: { items: [input.seed] },
        summary: "Collected",
        outcome: "partial",
      };
    });
    f.register("vps", "render", ({ input }) => {
      calls++;
      assert.deepEqual(input.collection, { items: ["work"] });
      return { data: { rendered: true }, summary: "Rendered" };
    });
    save(
      f,
      definition([
        programStep("collect", "mbp", "collect", [], {
          seed: { kind: "literal", value: "work" },
        }),
        programStep("render", "vps", "render", ["collect"], {
          collection: { kind: "step-output", stepId: "collect", path: [] },
        }),
      ]),
    );
    const run = start(f);
    f.runtime.tick();
    const mbp = f.worker("mbp");
    const result = await mbp.pollOnce();
    assert.equal(result[0].value.state, "acknowledged");
    f.runtime.tick();
    assert.equal(view(f, run).steps[1].state, "queued");
    const vps = f.worker("vps");
    await vps.pollOnce();
    f.runtime.tick();
    assert.equal(calls, 2);
    assert.equal(view(f, run).state, "partial");
    assert.ok(
      f.ledger.snapshot().runs.every((run) => run.sessionIds.length === 0),
    );
    assert.deepEqual(view(f, run).steps[1].output, { rendered: true });
  } finally {
    await f.close();
  }
});

test("offline devices block admission and recover without duplicate tasks", async () => {
  const f = fixture();
  try {
    f.register("mbp", "collect", () => ({ data: {}, summary: "ok" }));
    save(f, definition([programStep("collect", "mbp", "collect")]));
    f.heartbeat("mbp", false);
    const run = start(f);
    f.runtime.tick();
    assert.equal(view(f, run).steps[0].state, "waiting_device");
    assert.equal(f.ledger.snapshot().tasks.length, 0);
    f.heartbeat("mbp");
    f.runtime.tick();
    f.runtime.tick();
    assert.equal(view(f, run).steps[0].state, "queued");
    assert.equal(f.ledger.snapshot().tasks.length, 1);
  } finally {
    await f.close();
  }
});

test("invalid DAG, bindings, model routes, schemas and concurrent edits are rejected", async () => {
  const f = fixture();
  try {
    f.register("mbp", "collect", () => ({ data: {}, summary: "ok" }));
    const step = programStep("collect", "mbp", "collect");
    assert.throws(
      () => save(f, definition([{ ...step, dependsOn: ["collect"] }])),
      /cycle/,
    );
    assert.throws(
      () =>
        save(
          f,
          definition([
            {
              ...step,
              inputs: {
                bad: { kind: "step-output", stepId: "missing", path: [] },
              },
            },
          ]),
        ),
      /dependency/,
    );
    assert.throws(
      () =>
        save(
          f,
          definition([
            {
              ...step,
              execution: {
                kind: "agent",
                provider: "missing",
                model: "bad",
                instructions: "go",
                allowedTools: [],
              },
            },
          ]),
        ),
      /Model/,
    );
    assert.throws(() =>
      f.registries.mbp.register({
        programId: "bad",
        version: "1",
        title: "Bad",
        inputSchema: { type: "unknown-type" },
        execute: () => ({ data: {}, summary: "x" }),
      }),
    );
    const saved = save(f, definition([step]));
    assert.equal(saved.revision, 1);
    assert.throws(() => save(f, definition([step])), /changed/);
  } finally {
    await f.close();
  }
});

test("unknown crashed programs are not replayed or manually retried", async () => {
  const f = fixture();
  try {
    f.register("mbp", "collect", () => {
      throw new Error("should not execute");
    });
    save(f, definition([programStep("collect", "mbp", "collect")]));
    const run = start(f);
    f.runtime.tick();
    const step = view(f, run).steps[0];
    const claim = f.ledger.claim(id(), {
      runId: step.runId,
      nodeId: "mbp",
      ttlMs: 100,
    }).value;
    f.ledger.markRunning(id(), {
      runId: step.runId,
      attemptId: claim.attempt.attemptId,
      nodeId: "mbp",
      fence: claim.attempt.fence,
      executionId: "crashed-effect",
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    f.ledger.recoverExpired(id());
    f.runtime.tick();
    assert.equal(view(f, run).steps[0].state, "uncertain");
    assert.throws(
      () =>
        f.runtime.retry({
          commandId: id(),
          workflowRunId: run.workflowRunId,
          stepId: "collect",
        }),
      /proven terminal/,
    );
    assert.equal((await f.worker("mbp").pollOnce()).length, 0);
  } finally {
    await f.close();
  }
});

test("manual retry of failed program resumes dependencies without rerunning successful upstream", async () => {
  const f = fixture();
  try {
    let collect = 0,
      render = 0;
    f.register("mbp", "collect", () => ({
      data: { count: ++collect },
      summary: "collected",
    }));
    f.register("vps", "render", () => {
      if (++render === 1) throw new Error("render error");
      return { data: { ok: true }, summary: "rendered" };
    });
    save(
      f,
      definition([
        programStep("collect", "mbp", "collect"),
        programStep("render", "vps", "render", ["collect"], {
          source: { kind: "step-output", stepId: "collect", path: [] },
        }),
      ]),
    );
    const run = start(f);
    const mbp = f.worker("mbp"),
      vps = f.worker("vps");
    f.runtime.tick();
    await mbp.pollOnce();
    f.runtime.tick();
    await vps.pollOnce();
    f.runtime.tick();
    assert.equal(view(f, run).steps[1].state, "failed");
    f.runtime.retry({
      commandId: id(),
      workflowRunId: run.workflowRunId,
      stepId: "render",
    });
    f.runtime.tick();
    await vps.pollOnce();
    f.runtime.tick();
    assert.equal(view(f, run).state, "succeeded");
    assert.equal(collect, 1);
    assert.equal(render, 2);
  } finally {
    await f.close();
  }
});

test("signed existing protocol advertises and executes remote program without session grants", async () => {
  const f = fixture();
  const resources = [];
  try {
    const { generateKeyPairSync } = await import("node:crypto");
    const {
      RemoteGateway,
      RemoteClient,
      RemoteLedgerClient,
      IdentityVerifier,
    } = await import("../dist/remote/api.js");
    const keys = generateKeyPairSync("ed25519");
    f.register("mbp", "collect", ({ input }) => ({
      data: { echo: input.value },
      summary: "remote result",
    }));
    const serverStore = new RecoveryStore(join(f.dir, "server.sqlite"));
    resources.push(serverStore);
    const gateway = new RemoteGateway({
      role: "both",
      nodeId: "vps",
      ledger: f.ledger,
      store: serverStore,
      verifier: new IdentityVerifier({
        audience: "vps",
        peers: [
          {
            keyId: "test",
            nodeId: "mbp",
            audience: "vps",
            publicKey: keys.publicKey,
            operations: [
              "heartbeat",
              "listWork",
              "claim",
              "markRunning",
              "renew",
              "submit",
              "getRun",
              "getAttempt",
              "receipt",
            ],
            workspaces: ["mbp-ws"],
            capabilities: [],
          },
        ],
      }),
    });
    resources.push(gateway);
    const store = new RecoveryStore(join(f.dir, "remote.sqlite"));
    resources.push(store);
    const client = new RemoteClient({
      endpoint: "https://fixture.invalid/commands",
      nodeId: "mbp",
      audience: "vps",
      keyId: "test",
      privateKey: keys.privateKey,
      store,
      fetch: async (_url, options) =>
        new Response(JSON.stringify(await gateway.handle(options.body))),
    });
    resources.push(client);
    const remote = new RemoteLedgerClient(client, "mbp");
    await remote.recordNodeHeartbeat(id(), {
      nodeId: "mbp",
      sampledAt: Date.now() + counter,
      runtimeReady: true,
      activeExecutions: 0,
      providerStatus: {
        state: "not-probed",
        providers: [],
        programs: f.registries.mbp.catalog(),
      },
    });
    save(
      f,
      definition([
        programStep("collect", "mbp", "collect", [], {
          value: { kind: "literal", value: "authenticated" },
        }),
      ]),
    );
    const run = start(f);
    f.runtime.tick();
    const worker = new ExecutorWorker({
      ledger: remote,
      store,
      provider: f.registries.mbp.provider(),
      policy: {
        role: "executor",
        nodeId: "mbp",
        capabilities: [],
        workspaces: [
          {
            nodeId: "mbp",
            workspaceId: "mbp-ws",
            path: f.dir,
            allowedRoot: f.dir,
          },
        ],
      },
      taskSessions: true,
    });
    resources.push(worker);
    const results = await worker.pollOnce();
    assert.equal(results[0].value.state, "acknowledged");
    f.runtime.tick();
    assert.equal(view(f, run).state, "succeeded");
    assert.deepEqual(view(f, run).steps[0].output, { echo: "authenticated" });
  } finally {
    for (const resource of resources.reverse())
      await (resource.dispose?.() ?? resource.close?.());
    await f.close();
  }
});

test("workflow Agent route keeps native execution and structured input", async () => {
  const { createNativeHarness } = await import(
    "../../../tests/dsh/native-harness.mjs"
  );
  const h = await createNativeHarness({
    script: [
      { name: "workflow_input_read", args: { path: ["collection"] } },
      {
        name: "task_settle",
        args: {
          outcome: "success",
          summary: "Semantic result",
          reportTitle: "Digest",
          reportBody: "Done",
          reportData: { work: ["merged"] },
        },
      },
    ],
  });
  try {
    h.ledger.registerNode(id(), {
      nodeId: "local",
      roles: ["both"],
      models: [
        { provider: "test-offline", model: "script", reasoningEfforts: [] },
      ],
      capabilities: [],
      workspaceIds: ["local-ws"],
      enabled: true,
      lastSeenAt: new Date().toISOString(),
    });
    h.ledger.registerWorkspace(id(), {
      workspaceId: "local-ws",
      nodeId: "local",
      path: h.dir,
      label: "Local",
      state: "ready",
      createdAt: new Date().toISOString(),
    });
    h.ledger.recordNodeHeartbeat(id(), {
      nodeId: "local",
      sampledAt: Date.now(),
      runtimeReady: true,
      activeExecutions: 0,
      source: "host-local",
    });
    const service = h.ctx.taskSystem;
    service.workflows.save({
      commandId: id(),
      expectedRevision: 0,
      definition: definition([
        {
          stepId: "digest",
          title: "Digest",
          nodeId: "local",
          workspaceId: "local-ws",
          dependsOn: [],
          inputs: { collection: { kind: "workflow-input", path: [] } },
          execution: {
            kind: "agent",
            provider: "test-offline",
            model: "script",
            instructions:
              "Summarize input and submit structured reportData via task_settle.",
            inputExposure: "tools",
            allowedTools: ["task_settle", "workflow_input_read"],
          },
          maxRetries: 0,
        },
      ]),
    });
    const run = service.workflows.start({
      commandId: id(),
      workflowId: "daily",
      input: { evidence: "source-marker-work" },
    });
    service.workflows.tick();
    const step = service.workflows.snapshot().runs[0].steps[0];
    const claim = h.ledger.claim(id(), {
      runId: step.runId,
      nodeId: "local",
      ttlMs: 10000,
    }).value;
    assert.deepEqual(claim.run.configuration.input, {
      collection: { evidence: "source-marker-work" },
    });
    await service.native.execute(claim);
    service.workflows.tick();
    const result = service.workflows.snapshot().runs[0];
    assert.equal(result.state, "succeeded");
    assert.deepEqual(result.steps[0].output, { work: ["merged"] });
    assert.ok(h.adapter.requests.length > 1);
    assert.ok(
      !JSON.stringify(h.adapter.requests[0]).includes("source-marker-work"),
    );
    assert.ok(
      JSON.stringify(h.adapter.requests.at(-1)).includes("source-marker-work"),
    );
  } finally {
    await h.dispose();
  }
});

test("workflow schedule uses durable slots and pins calendar input", async () => {
  const f = fixture();
  try {
    f.register("mbp", "collect", () => ({ data: {}, summary: "ok" }));
    save(f, {
      ...definition([
        programStep("collect", "mbp", "collect", [], {
          windowStart: { kind: "workflow-input", path: ["windowStart"] },
        }),
      ]),
      schedule: {
        enabled: true,
        cron: "0 7 * * *",
        timeZone: "Asia/Shanghai",
        dayOffset: -1,
      },
    });
    const due = "2026-01-02T23:00:00.000Z";
    f.ledger
      .managementDatabase()
      .prepare("UPDATE workflow_definitions SET next_due=?")
      .run(due);
    f.runtime.tick({ scheduleEnabled: false });
    assert.equal(f.runtime.snapshot().runs.length, 0);
    f.runtime.tick();
    const first = f.runtime.snapshot().runs[0];
    assert.deepEqual(first.input, {
      windowStart: "2026-01-01T16:00:00.000Z",
      windowEnd: "2026-01-02T16:00:00.000Z",
      timeZone: "Asia/Shanghai",
    });
    f.ledger
      .managementDatabase()
      .prepare("UPDATE workflow_definitions SET next_due=?")
      .run(due);
    f.runtime.tick();
    assert.equal(
      f.runtime
        .snapshot()
        .runs.filter((run) => run.input.windowStart === first.input.windowStart)
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("TaskSystemService tick executes local programs without entering native Agent loop", async () => {
  const { createNativeHarness } = await import(
    "../../../tests/dsh/native-harness.mjs"
  );
  const dir = mkdtempSync(join(tmpdir(), "workflow-local-host-"));
  const h = await createNativeHarness({
    dir,
    config: {
      workspaceRoots: [
        { id: "root", path: dir, allowCreate: false },
      ],
      maintenanceIntervalMs: 1000,
    },
  });
  try {
    const service = h.ctx.taskSystem;
    service.programs.register({
      programId: "local-render",
      version: "1",
      title: "Local render",
      execute: () => ({ data: { rendered: true }, summary: "Done" }),
    });
    h.ledger.registerNode(id(), {
      nodeId: "local",
      roles: ["both"],
      models: [],
      capabilities: [],
      workspaceIds: ["local-ws", "missing-authorized-ws"],
      enabled: true,
      lastSeenAt: new Date().toISOString(),
      maxConcurrent: 1,
    });
    h.ledger.registerWorkspace(id(), {
      workspaceId: "local-ws",
      nodeId: "local",
      path: h.dir,
      label: "Local",
      state: "ready",
      createdAt: new Date().toISOString(),
    });
    for (const [workspaceId, state] of [
      ["planned-ws", "planned"],
      ["unavailable-ws", "ready"],
      ["missing-authorized-ws", "ready"],
    ]) {
      h.ledger.registerWorkspace(id(), {
        workspaceId,
        nodeId: "local",
        path: join(h.dir, workspaceId),
        label: workspaceId,
        state,
        createdAt: new Date().toISOString(),
      });
    }
    h.ledger.recordNodeHeartbeat(id(), {
      nodeId: "local",
      sampledAt: Date.now(),
      runtimeReady: true,
      activeExecutions: 0,
      providerStatus: {
        state: "not-probed",
        providers: [],
        programs: service.programs.catalog(),
      },
      source: "host-local",
    });
    service.workflows.save({
      commandId: id(),
      expectedRevision: 0,
      definition: definition([programStep("render", "local", "local-render")]),
    });
    service.workflows.start({
      commandId: id(),
      workflowId: "daily",
      input: {},
    });
    service.tick();
    for (
      let i = 0;
      i < 200 && h.ledger.snapshot().runs[0]?.state !== "succeeded";
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    service.workflows.tick();
    assert.equal(service.workflows.snapshot().runs[0].state, "succeeded");
    assert.equal(h.adapter.requests.length, 0);
  } finally {
    await h.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancel prevents downstream admission and manual retry cannot restart cancelled workflow", async () => {
  const f = fixture();
  try {
    f.register("mbp", "collect", () => ({ data: {}, summary: "ok" }));
    f.register("vps", "render", () => ({ data: {}, summary: "ok" }));
    save(
      f,
      definition([
        programStep("collect", "mbp", "collect"),
        programStep("render", "vps", "render", ["collect"]),
      ]),
    );
    const run = start(f);
    f.runtime.tick();
    f.runtime.cancel({ commandId: id(), workflowRunId: run.workflowRunId });
    f.runtime.tick();
    assert.equal(view(f, run).state, "cancelled");
    assert.ok(view(f, run).steps.every((step) => step.state === "cancelled"));
    assert.equal(f.ledger.snapshot().runs.length, 1);
    assert.throws(
      () =>
        f.runtime.retry({
          commandId: id(),
          workflowRunId: run.workflowRunId,
          stepId: "collect",
        }),
      /cannot resume/,
    );
  } finally {
    await f.close();
  }
});

test("Agent failure retries are bounded while unknown outcomes never retry", async () => {
  const f = fixture();
  try {
    f.heartbeat("vps");
    const step = {
      ...programStep("digest", "vps", "unused"),
      execution: {
        kind: "agent",
        provider: "test",
        model: "model",
        instructions: "Summarize",
        allowedTools: ["task_settle"],
      },
      maxRetries: 2,
    };
    save(f, definition([step]));
    const run = start(f);
    f.runtime.tick();
    for (let i = 0; i < 3; i++) {
      const current = view(f, run).steps[0];
      const claim = f.ledger.claim(id(), {
        runId: current.runId,
        nodeId: "vps",
        ttlMs: 10000,
      }).value;
      const ref = {
        runId: current.runId,
        attemptId: claim.attempt.attemptId,
        nodeId: "vps",
        fence: claim.attempt.fence,
        executionId: id(),
      };
      f.ledger.markRunning(id(), ref);
      f.ledger.submit(id(), {
        ...ref,
        outcome: "failure",
        summary: "Stopped failure",
      });
      f.runtime.tick();
    }
    const final = view(f, run);
    assert.equal(final.steps[0].attemptCount, 3);
    assert.equal(final.steps[0].state, "failed");
    assert.equal(final.state, "needs_attention");
    assert.equal(f.ledger.snapshot().runs.length, 3);
  } finally {
    await f.close();
  }
});

test("native Agent retry reuses its task session and receives only the failure diagnosis", async () => {
  const { createNativeHarness } = await import(
    "../../../tests/dsh/native-harness.mjs"
  );
  const h = await createNativeHarness({
    script: [
      {
        name: "task_settle",
        args: { outcome: "success", summary: "Forgot structured output" },
      },
      {
        name: "task_settle",
        args: {
          outcome: "success",
          summary: "Corrected",
          reportTitle: "Digest",
          reportBody: "Done",
          reportData: null,
        },
      },
    ],
  });
  try {
    h.ledger.registerNode(id(), {
      nodeId: "local",
      roles: ["both"],
      models: [
        { provider: "test-offline", model: "script", reasoningEfforts: [] },
      ],
      capabilities: [],
      workspaceIds: ["local-ws"],
      enabled: true,
      lastSeenAt: new Date().toISOString(),
    });
    h.ledger.registerWorkspace(id(), {
      workspaceId: "local-ws",
      nodeId: "local",
      path: h.dir,
      label: "Local",
      state: "ready",
      createdAt: new Date().toISOString(),
    });
    h.ledger.recordNodeHeartbeat(id(), {
      nodeId: "local",
      sampledAt: Date.now(),
      runtimeReady: true,
      activeExecutions: 0,
      source: "host-local",
    });
    const service = h.ctx.taskSystem;
    service.workflows.save({
      commandId: id(),
      expectedRevision: 0,
      definition: definition([
        {
          stepId: "digest",
          title: "Digest",
          nodeId: "local",
          workspaceId: "local-ws",
          dependsOn: [],
          inputs: {},
          execution: {
            kind: "agent",
            provider: "test-offline",
            model: "script",
            instructions: "Submit the task result.",
            allowedTools: ["task_settle"],
          },
          maxRetries: 1,
        },
      ]),
    });
    service.workflows.start({
      commandId: id(),
      workflowId: "daily",
      input: {},
    });
    service.workflows.tick();
    const first = service.workflows.snapshot().runs[0].steps[0];
    await service.native.execute(
      h.ledger.claim(id(), {
        runId: first.runId,
        nodeId: "local",
        ttlMs: 10000,
      }).value,
    );
    assert.equal(h.ledger.getRun(first.runId).state, "failed");
    assert.equal(
      h.ledger.getRun(first.runId).resultValidationFailure.code,
      "RESULT_VALIDATION",
    );
    const session = h.ledger.getRun(first.runId).sessionIds[0];
    assert.ok(session);
    service.workflows.tick();
    const second = service.workflows.snapshot().runs[0].steps[0];
    assert.notEqual(second.runId, first.runId);
    assert.equal(second.taskId, first.taskId);
    const claim = h.ledger.claim(id(), {
      runId: second.runId,
      nodeId: "local",
      ttlMs: 10000,
    }).value;
    assert.deepEqual(claim.run.configuration.workflow.retry, {
      previousRunId: first.runId,
      reason:
        "Workflow step requires structured report.data for success or partial; submit reportData through task_settle.",
    });
    await service.native.execute(claim);
    service.workflows.tick();
    assert.equal(service.workflows.snapshot().runs[0].state, "succeeded");
    assert.deepEqual(h.ledger.getRun(second.runId).sessionIds, [session]);
  } finally {
    await h.dispose();
  }
});

test("tool-exposed Agent input is not inserted into prompt and remains fully pageable", async () => {
  const { workflowInputPage, workflowPromptConfiguration } = await import(
    "../dist/workflow-input.js"
  );
  const input = {
    collection: {
      source: "secret-marker-" + "x".repeat(50000),
      items: Array.from({ length: 35 }, (_, i) => ({
        id: i,
        text: "evidence",
      })),
    },
  };
  const configuration = {
    input,
    workflow: {
      workflowRunId: "occurrence",
      workflowId: "daily",
      definitionRevision: 1,
      stepId: "digest",
      inputExposure: "tools",
    },
  };
  const prompt = workflowPromptConfiguration(configuration);
  assert.ok(!JSON.stringify(prompt).includes("secret-marker"));
  assert.deepEqual(prompt.input.keys, ["collection"]);
  let offset = 0,
    text = "";
  do {
    const page = workflowInputPage(input, {
      path: ["collection", "source"],
      offset,
    });
    text += page.text;
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(text, input.collection.source);
  const first = workflowInputPage(input, {
      path: ["collection", "items"],
      offset: 0,
      limit: 20,
    }),
    second = workflowInputPage(input, {
      path: ["collection", "items"],
      offset: first.nextOffset,
      limit: 20,
    });
  assert.equal(first.entries.length + second.entries.length, 35);
  assert.equal(second.nextOffset, null);
  assert.throws(
    () => workflowInputPage(input, { path: ["__proto__"] }),
    /not found/,
  );
  assert.deepEqual(workflowPromptConfiguration({ input }), { input });
});

test("cancelling an underlying terminal step marks workflow as needing attention", async () => {
  const f = fixture();
  try {
    f.register("vps", "one", () => ({ data: {}, summary: "done" }));
    save(f, definition([programStep("one", "vps", "one")]));
    const run = start(f);
    f.runtime.tick();
    const step = view(f, run).steps[0];
    f.ledger.cancel(id(), {
      taskId: step.taskId,
      runId: step.runId,
      reason: "User cancelled task",
    });
    f.runtime.tick();
    assert.equal(view(f, run).steps[0].state, "cancelled");
    assert.equal(view(f, run).state, "needs_attention");
  } finally {
    await f.close();
  }
});

test("heartbeat budgets the complete status and preserves registered program catalog", async () => {
  const { Context } = await import("@deepseek-ai/cordis");
  const plugin = await import("../dist/remote/index.js");
  const ctx = new Context();
  const programs = new ProgramRegistry("worker");
  programs.register({
    programId: "collect",
    version: "1",
    title: "Collect",
    description: "x".repeat(1500),
    execute: () => ({ data: {}, summary: "done" }),
  });
  await ctx.plugin({
    apply(ctx) {
      ctx.provide("taskSystem", { programs });
    },
  });
  const config = plugin.Config({
    role: "executor",
    nodeId: "worker",
    coordinator: {
      endpoint: "https://fixture.invalid",
      audience: "planner",
      nativeRoutes: [
        {
          provider: "test",
          models: Array.from({ length: 100 }, (_, i) => ({
            model: `model-${i}`,
            reasoningEfforts: [],
          })),
        },
      ],
    },
  });
  const store = new RecoveryStore(":memory:");
  const service = new plugin.RemoteExecutionService(ctx, config, {}, store);
  let captured;
  service.coordinatorLedger = {
    recordNodeHeartbeat: async (_id, input) => {
      captured = input;
      return { value: {} };
    },
  };
  try {
    await service.heartbeatNow();
    assert.ok(
      Buffer.byteLength(JSON.stringify(captured.providerStatus)) <= 8192,
    );
    assert.deepEqual(captured.providerStatus.programs, programs.catalog());
    assert.ok(captured.providerStatus.executionRoutes.length < 100);
    assert.equal(captured.runtimeReady, true);
  } finally {
    await service.dispose();
    await ctx.fiber.dispose();
  }
});
