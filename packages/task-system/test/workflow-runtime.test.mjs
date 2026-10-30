import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRuntime } from "../dist/project-runtime.js";
import { ScheduledPlans } from "../dist/scheduled-plans.js";
import { Workbench } from "../dist/workbench.js";
import { TaskLedger } from "../dist/ledger.js";
import { ProgramRegistry } from "../dist/workflow-programs.js";
import { WorkflowStep } from "../dist/workflow-contracts.js";
import { WorkflowRuntime } from "../dist/workflows.js";
import { ExecutorWorker } from "../dist/remote/worker.js";
import { RecoveryStore } from "../dist/remote/store.js";

test('program workload start is recorded after input validation and before user code',async()=>{
 const registry=new ProgramRegistry('worker'),order=[];
 registry.register({programId:'bounded',version:'1',title:'Bounded program',inputSchema:{type:'object',required:['ok'],properties:{ok:{const:true}}},execute:()=>{order.push('execute');return {summary:'Done',data:{}};}});
 const request={claim:{task:{taskId:'task'},attempt:{executionId:'execution'},run:{runId:'run',route:{nodeId:'worker',execution:{kind:'program',programId:'bounded',version:'1'}},configuration:{input:{}}}},signal:new AbortController().signal,workspacePath:'/fixture',executionStarted:async()=>{order.push('started');}};
 assert.equal((await registry.execute(request)).outcome,'failure');assert.deepEqual(order,[]);
 request.claim.run.configuration.input={ok:true};assert.equal((await registry.execute(request)).outcome,'success');assert.deepEqual(order,['started','execute']);
});
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
  new Workbench(ledger).manage(id(),'create_project',{projectId:'project',title:'Project',goal:'Test',description:''});
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
  projectId: "project",
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
    assert.equal(f.ledger.snapshot().tasks.length, 2);
    assert.equal(f.ledger.snapshot().runs.length, 2);
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
    const hostConfig={nodeDisplayName:'aws-vps'};
    const projects=new ProjectRuntime({get:key=>key==='taskSystem'?{workflows:f.runtime,config:hostConfig}:undefined},f.ledger,'vps','both');
    const snapshot=projects.snapshot(),card=snapshot.tasks.find(task=>task.runId===run.runId);
    assert.equal(card.status,'error','partial still requires attention');
    assert.equal(card.runState,'partial');
    assert.equal(card.stateLabel,'部分完成 · 报告已生成');
    assert.ok(card.reportId);
    assert.equal(snapshot.nodes.find(node=>node.nodeId==='vps').displayName,'aws-vps');
    assert.equal(snapshot.nodes.find(node=>node.nodeId==='mbp').displayName,'mbp');
    hostConfig.nodeDisplayName='  ';
    assert.equal(projects.snapshot().nodes.find(node=>node.nodeId==='vps').displayName,'vps');
    const noReport=start(f);
    f.ledger.updateWorkflowRoot(noReport.runId,'partial');
    const withoutReport=projects.snapshot().tasks.find(task=>task.runId===noReport.runId);
    assert.equal(withoutReport.stateLabel,'部分完成');
    assert.equal(withoutReport.reportId,null);
    assert.equal(f.ledger.getRun(noReport.runId).state,'partial');

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
    assert.equal(f.ledger.snapshot().tasks.length, 1);
    f.heartbeat("mbp");
    f.runtime.tick();
    f.runtime.tick();
    assert.equal(view(f, run).steps[0].state, "queued");
    assert.equal(f.ledger.snapshot().tasks.length, 2);
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
    assert.equal(view(f,run).dispatches.length,3);
    assert.equal(new Set(view(f,run).dispatches.map(receipt=>receipt.runId)).size,3);
    assert.equal(f.ledger.getRun(view(f,run).dispatches[1].runId).state,'failed');
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
        name: "task_submit_result",
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
    new Workbench(h.ledger).manage(id(),'create_project',{projectId:'project',title:'Project',goal:'Test',description:''});
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
              "Summarize input and submit structured reportData via task_submit_result.",
            inputExposure: "tools",
            allowedTools: ["task_submit_result", "workflow_input_read"],
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
        enabled: false,
        cron: "0 7 * * *",
        timeZone: "Asia/Shanghai",
        dayOffset: -1,
      },
    });
    const legacy = f.runtime.snapshot().definitions[0];
    legacy.schedule.enabled = true;
    f.ledger.managementDatabase().prepare('UPDATE workflow_definitions SET data=?').run(JSON.stringify(legacy));
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
    new Workbench(h.ledger).manage(id(),'create_project',{projectId:'project',title:'Project',goal:'Test',description:''});
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
    assert.equal(f.ledger.snapshot().runs.length, 2);
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
        allowedTools: ["task_submit_result"],
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
    assert.equal(f.ledger.snapshot().runs.length, 4);
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
        name: "task_submit_result",
        args: { outcome: "success", summary: "Forgot structured output" },
      },
      {
        name: "task_submit_result",
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
    new Workbench(h.ledger).manage(id(),'create_project',{projectId:'project',title:'Project',goal:'Test',description:''});
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
            allowedTools: ["task_submit_result"],
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
        "Workflow step requires structured report.data for success or partial; submit reportData through task_submit_result.",
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
    assert.equal(Object.hasOwn(captured.providerStatus,'executionRoutes'),false,'model catalogs use their bounded request/response protocol');
    assert.equal(captured.runtimeReady, true);
  } finally {
    await service.dispose();
    await ctx.fiber.dispose();
  }
});

test('project stages call concrete steps across VPS to MBP to VPS without input bindings', async () => {
  const f=fixture();
  try {
    const executed=[];
    for (const [node,program] of [['vps','first'],['mbp','second'],['vps','third']])
      f.register(node,program,() => {executed.push(program);return {summary:program,data:{ok:true}}});
    const stages=[['a','vps'],['b','mbp'],['c','vps']].map(([stageId,nodeId],i)=>({stageId,nodeId,title:stageId,position:{x:i*340,y:90}}));
    const steps=[programStep('first','vps','first'),programStep('second','mbp','second'),programStep('third','vps','third')].map((step,i)=>({...step,stageId:stages[i].stageId,position:{x:90,y:80}}));
    const saved=save(f,{...definition(steps),stages,calls:[{fromStepId:'first',toStepId:'second'},{fromStepId:'second',toStepId:'third'}]});
    assert.deepEqual(saved.steps.map(step=>step.dependsOn),[[],['first'],['second']]);
    const binding=f.runtime.configureTask({commandId:id(),projectId:'project',workflowId:'daily',input:{window:'one'}});
    const request={commandId:id(),taskId:binding.taskId};
    const run=f.runtime.start(request);
    assert.equal(f.ledger.getRun(run.runId).route,undefined);
    assert.equal(f.ledger.isWorkflowInvocation(f.ledger.getRun(run.runId)),true);
    assert.throws(()=>f.ledger.claim(id(),{runId:run.runId,nodeId:'vps',ttlMs:1000}),/cannot be claimed/);
    assert.throws(()=>f.ledger.createRun(id(),{taskId:binding.taskId}),/configured workflow/);
    assert.equal(f.ledger.taskActionState(binding.taskId).canRetry,false);
    const cold=TaskLedger.open(join(f.dir,'ledger.sqlite'));
    try {assert.throws(()=>cold.createRun(id(),{taskId:binding.taskId}),/configured workflow/)} finally {cold.close()}
    const vps=f.worker('vps'),mbp=f.worker('mbp');
    f.runtime.tick();await vps.pollOnce();f.runtime.tick();
    assert.deepEqual(executed,['first']);
    await mbp.pollOnce();f.runtime.tick();await vps.pollOnce();f.runtime.tick();
    assert.deepEqual(executed,['first','second','third']);
    const done=view(f,run);assert.equal(done.state,'succeeded');assert.equal(done.dispatches.length,3);
    for(const receipt of done.dispatches){
      assert.equal(f.ledger.getTask(receipt.taskId).parentTaskId,binding.taskId);
      assert.equal(f.ledger.getRun(receipt.runId).parentRunId,run.runId);
    }
    const updated={...saved,title:'Changed',stages:saved.stages.map(stage=>({...stage,position:{x:stage.position.x+80,y:400}}))};
    f.runtime.save({commandId:id(),expectedRevision:saved.revision,definition:updated});
    f.runtime.configureTask({commandId:id(),projectId:'project',taskId:binding.taskId,workflowId:'daily',input:{window:'two'},expectedRevision:1});
    assert.deepEqual(f.runtime.start(request),run);
    const second=f.runtime.start({commandId:id(),taskId:binding.taskId});
    assert.equal(second.taskId,run.taskId);assert.notEqual(second.runId,run.runId);
    assert.equal(second.input.window,'two');assert.equal(view(f,run).input.window,'one');
    assert.deepEqual(view(f,run).definition.stages,saved.stages);
    assert.equal(f.ledger.history(binding.taskId).runs.length,2);
    f.ledger.recoverExpired(id());assert.equal(f.ledger.getRun(second.runId).state,'running');
    assert.ok(!f.ledger.pendingRuns('vps').some(item=>item.runId===second.runId));
    f.reopen();assert.deepEqual(f.runtime.snapshot().definitions[0].stages,updated.stages);
    assert.equal(f.runtime.snapshot().taskBindings[0].revision,2);
  } finally {await f.close()}
});

test('calls are authoritative including empty and invalid binding removal is rejected', async()=>{
  const f=fixture();try{
    f.register('mbp','work',()=>({summary:'ok',data:{}}));
    const steps=[programStep('a','mbp','work'),programStep('b','mbp','work',['a'])];
    const first=save(f,{...definition(steps),calls:[]});
    assert.deepEqual(first.steps[1].dependsOn,[]);
    assert.throws(()=>f.runtime.save({commandId:id(),expectedRevision:1,definition:{...first,calls:[{fromStepId:'a',toStepId:'missing'}]}}),/Invalid/);
    assert.throws(()=>f.runtime.save({commandId:id(),expectedRevision:1,definition:{...first,calls:[{fromStepId:'a',toStepId:'b'},{fromStepId:'b',toStepId:'a'}]}}),/cycle/);
    const connected=f.runtime.save({commandId:id(),expectedRevision:1,definition:{...first,calls:[{fromStepId:'a',toStepId:'b'}],steps:first.steps.map(step=>step.stepId==='b'?{...step,inputs:{source:{kind:'step-output',stepId:'a',path:[]}}}:step)}});
    assert.throws(()=>f.runtime.save({commandId:id(),expectedRevision:2,definition:{...connected,calls:[]}}),/explicit dependency/);
    assert.throws(()=>save(f,{...definition(steps),workflowId:'unowned',projectId:undefined}),/require a Project/);
    new Workbench(f.ledger).manage(id(),'create_project',{projectId:'other',title:'Other',goal:'Test',description:''});
    assert.throws(()=>f.runtime.configureTask({commandId:id(),projectId:'other',workflowId:'daily',input:{}}),/another Project/);
  }finally{await f.close()}
});

test('ordinary root cancellation reaches children and uncertain roots cannot be bypassed',async()=>{
  const f=fixture();try{
    f.register('mbp','work',()=>({summary:'ok',data:{}}));
    save(f,definition([programStep('a','mbp','work'),programStep('b','mbp','work',['a'])]));
    const root=start(f);f.runtime.tick();
    const leaf=view(f,root).steps[0];
    f.ledger.cancel(id(),{taskId:root.taskId,runId:root.runId,reason:'Cancel root'});
    f.runtime.tick();
    assert.equal(f.ledger.getRun(leaf.runId).state,'cancelled');
    assert.equal(view(f,root).steps[1].state,'cancelled');
    assert.equal(f.ledger.getRun(root.runId).state,'cancelled');
    assert.equal((await f.worker('mbp').pollOnce()).length,0);
    const uncertain=f.runtime.start({commandId:id(),taskId:root.taskId});f.runtime.tick();
    const step=view(f,uncertain).steps[0];
    const claim=f.ledger.claim(id(),{runId:step.runId,nodeId:'mbp',ttlMs:100}).value;
    f.ledger.markRunning(id(),{runId:step.runId,attemptId:claim.attempt.attemptId,nodeId:'mbp',fence:claim.attempt.fence,executionId:'unknown-effect'});
    await new Promise(resolve=>setTimeout(resolve,120));f.ledger.recoverExpired(id());f.runtime.tick();
    assert.equal(f.ledger.getRun(uncertain.runId).state,'uncertain');
    assert.throws(()=>f.runtime.start({commandId:id(),taskId:root.taskId}),/uncertain prior/);
    assert.throws(()=>f.ledger.resolveUncertain(id(),{runId:uncertain.runId,outcome:'failed',reason:'bypass'}),/underlying workflow step/);
    assert.throws(()=>f.runtime.retry({commandId:id(),workflowRunId:uncertain.workflowRunId,stepId:'a'}),/proven terminal/);
  }finally{await f.close()}
});

test('fork and join wait for both real worker branches',async()=>{
  const f=fixture();try{
    const calls=[];
    for(const name of ['fork','left','right','join']) f.register('mbp',name,()=>{calls.push(name);return {summary:name,data:{name}}});
    save(f,definition([programStep('fork','mbp','fork'),programStep('left','mbp','left',['fork']),programStep('right','mbp','right',['fork']),programStep('join','mbp','join',['left','right'])]));
    const root=start(f),worker=f.worker('mbp');f.runtime.tick();await worker.pollOnce();f.runtime.tick();
    assert.deepEqual(view(f,root).steps.map(step=>step.state),['succeeded','queued','queued','pending']);
    await worker.pollOnce();f.runtime.tick();
    if(view(f,root).steps[2].state==='queued'){assert.equal(view(f,root).steps[3].state,'pending');await worker.pollOnce();f.runtime.tick()}
    await worker.pollOnce();f.runtime.tick();
    assert.equal(calls[0],'fork');assert.equal(calls.at(-1),'join');assert.equal(view(f,root).state,'succeeded');
  }finally{await f.close()}
});

test('Task workflow schedules create atomic occurrences and several Runs on one Task',async()=>{
  const f=fixture();try{
    f.register('mbp','work',()=>({summary:'done',data:{ok:true}}));save(f,definition([programStep('a','mbp','work')]));
    const plans=new ScheduledPlans(f.ledger);
    const request={commandId:id(),title:'Recurring',description:'Workflow schedule',projectId:'project',execution:{kind:'workflow',workflowId:'daily',input:{seed:'initial'}},cadence:{mode:'interval',minutes:1}};
    const created=plans.create(request);
    assert.deepEqual(plans.create(request),created);
    assert.equal(plans.options().workflows[0].projectId,'project');
    let schedule=f.ledger.getSchedule(created.scheduleId);assert.equal(schedule.execution.kind,'workflow');assert.equal(schedule.route,undefined);
    const forceDue=()=>{schedule=f.ledger.getSchedule(created.scheduleId);schedule.nextDueAt=new Date(Date.now()-1).toISOString();f.ledger.managementDatabase().prepare("UPDATE entities SET data=? WHERE kind='schedule' AND id=?").run(JSON.stringify(schedule),schedule.scheduleId);return schedule.nextDueAt};
    const slot=forceDue();
    const admit=f.ledger.workflowRunAdmission;
    f.ledger.workflowRunAdmission=()=>{throw new Error('Injected admission interruption')};
    assert.throws(()=>f.ledger.fireSchedule(id(),{scheduleId:created.scheduleId,occurrenceAt:slot}),/Injected/);
    assert.equal(f.ledger.history(created.taskId).runs.length,0);assert.equal(f.ledger.scheduleHistory(created.scheduleId).length,0);
    assert.equal(f.ledger.getSchedule(created.scheduleId).nextDueAt,slot);assert.equal(f.runtime.snapshot().runs.length,0);
    f.ledger.workflowRunAdmission=admit;
    const occurrence=f.ledger.fireSchedule(id(),{scheduleId:created.scheduleId,occurrenceAt:slot}).value;
    assert.deepEqual(f.ledger.fireSchedule(id(),{scheduleId:created.scheduleId,occurrenceAt:slot}).value,occurrence);
    assert.equal(f.runtime.snapshot().runs.length,1);assert.equal(f.runtime.snapshot().runs[0].runId,occurrence.runId);
    assert.equal(f.ledger.getRun(occurrence.runId).configuration.trigger.scheduledFor,slot);
    const worker=f.worker('mbp');f.runtime.tick();await worker.pollOnce();f.runtime.tick();
    f.runtime.configureTask({commandId:id(),projectId:'project',taskId:created.taskId,workflowId:'daily',input:{seed:'changed'},expectedRevision:1});
    const next=forceDue();const second=f.ledger.fireSchedule(id(),{scheduleId:created.scheduleId,occurrenceAt:next}).value;
    assert.notEqual(second.runId,occurrence.runId);assert.equal(f.ledger.history(created.taskId).runs.length,2);
    assert.equal(f.runtime.snapshot().runs.find(run=>run.runId===second.runId).input.seed,'changed');
    assert.equal(f.runtime.snapshot().runs.find(run=>run.runId===occurrence.runId).input.seed,'initial');
  }finally{await f.close()}
});

test('adoption reuses the original Schedule and Task history and preserves exact legacy next_due',async()=>{
  const f=fixture();try{
    f.register('mbp','work',()=>({summary:'done',data:{ok:true}}));const saved=save(f,definition([programStep('a','mbp','work')]));
    const historic=start(f);f.runtime.tick();await f.worker('mbp').pollOnce();f.runtime.tick();
    const frozen=structuredClone(view(f,historic).definition);
    const task=f.ledger.createTask(id(),{taskId:'prod-daily-agent-dsh-codex',title:'Original Agent daily',kind:'scheduled',requiresConfirmation:false}).value;
    const oldRuns=[];
    for(let i=0;i<4;i++){
      const run=f.ledger.createRun(id(),{taskId:task.taskId,route:{nodeId:'mbp',workspaceId:'mbp-ws',provider:'test',model:'model',requiredCapabilities:[]}}).value;
      const claim=f.ledger.claim(id(),{runId:run.runId,nodeId:'mbp',ttlMs:1000}).value;
      f.ledger.submit(id(),{runId:run.runId,attemptId:claim.attempt.attemptId,nodeId:'mbp',fence:claim.attempt.fence,outcome:'success',summary:'Original'});oldRuns.push(run.runId);
    }
    f.ledger.updateTemplate(id(),{templateId:'old-daily',version:1,name:'Original',description:'',inputSchema:{},defaults:{},resultContract:{}});
    f.ledger.createSchedule(id(),{scheduleId:task.taskId,taskId:task.taskId,templateId:'old-daily',templateVersion:1,enabled:false,revision:4,cron:'0 7 * * *',timeZone:'Asia/Shanghai',nextDueAt:'2026-10-16T23:00:00.000Z',overlap:'queue',misfire:'once',input:{},route:{nodeId:'mbp',workspaceId:'mbp-ws',provider:'test',model:'model',requiredCapabilities:[]}});
    const legacy={...saved};delete legacy.projectId;legacy.schedule={enabled:true,cron:'0 7 * * *',timeZone:'Asia/Shanghai',dayOffset:-1};
    const due='2026-01-02T23:00:00.000Z';f.ledger.managementDatabase().prepare('UPDATE workflow_definitions SET data=?,next_due=?').run(JSON.stringify(legacy),due);
    const request={commandId:id(),workflowId:'daily',projectId:'project',taskId:task.taskId};const mapping=f.runtime.adopt(request);
    assert.deepEqual(f.runtime.adopt(request),mapping);assert.equal(mapping.scheduleId,task.taskId);assert.ok(mapping.workflowRunIds.includes(historic.workflowRunId));
    const adopted=f.ledger.getSchedule(task.taskId);assert.equal(adopted.enabled,true);assert.equal(adopted.overlap,'queue');assert.equal(adopted.misfire,'once');assert.equal(adopted.nextDueAt,due);assert.equal(adopted.route,undefined);assert.deepEqual(adopted.calendarWindow,{timeZone:'Asia/Shanghai',dayOffset:-1});
    assert.equal(f.ledger.snapshot().schedules.length,1);assert.deepEqual(f.ledger.history(task.taskId).runs.map(run=>run.runId),oldRuns);
    assert.deepEqual(view(f,historic).definition,frozen);
    assert.equal(f.runtime.snapshot().definitions[0].schedule.enabled,false);
    const occurrence=f.ledger.fireSchedule(id(),{scheduleId:task.taskId,occurrenceAt:due}).value;
    assert.equal(f.ledger.getRun(occurrence.runId).route,undefined);
    const newest=f.runtime.snapshot().runs.find(run=>run.runId===occurrence.runId);assert.equal(newest.taskId,task.taskId);
    assert.deepEqual(newest.input,{windowStart:'2026-01-01T16:00:00.000Z',windowEnd:'2026-01-02T16:00:00.000Z',timeZone:'Asia/Shanghai'});
    assert.equal(f.ledger.history(task.taskId).runs.length,5);
    assert.equal(f.ledger.managementDatabase().prepare('SELECT next_due FROM workflow_definitions').get().next_due,null);
  }finally{await f.close()}
});

test('workflow maintenance preserves whole-Task cancellation while single-Run cancellation allows continuation',async()=>{
  const {createNativeHarness}=await import('../../../tests/dsh/native-harness.mjs');
  const h=await createNativeHarness();
  try{
    const ledger=h.ledger,service=h.ctx.taskSystem,runtime=service.workflows;
    new Workbench(ledger).manage('cancel-project','create_project',{projectId:'p',title:'Cancellation',goal:'Test'});
    service.programs.register({programId:'work',version:'1',title:'Work',execute:()=>({summary:'Done',data:{}})});
    ledger.registerWorkspace('cancel-workspace',{workspaceId:'ws',nodeId:'local',path:h.dir,label:'Local',state:'ready',createdAt:new Date().toISOString()});
    ledger.registerNode('cancel-node',{nodeId:'local',roles:['both'],enabled:true,models:[],capabilities:[],workspaceIds:['ws'],lastSeenAt:new Date().toISOString()});
    ledger.recordNodeHeartbeat('cancel-heartbeat',{nodeId:'local',runtimeReady:true,activeExecutions:0,source:'host-local',sampledAt:Date.now(),providerStatus:{programs:service.programs.catalog()}});
    runtime.save({commandId:'cancel-flow',expectedRevision:0,definition:{workflowId:'flow',projectId:'p',revision:0,title:'Flow',description:'',steps:[{stepId:'work',title:'Work',nodeId:'local',workspaceId:'ws',dependsOn:[],inputs:{},execution:{kind:'program',programId:'work',version:'1'},maxRetries:0}]}});
    const binding=runtime.configureTask({commandId:'cancel-bind',projectId:'p',workflowId:'flow',input:{}});
    const first=runtime.start({commandId:'cancel-first',taskId:binding.taskId});runtime.tick();
    ledger.cancel('cancel-single-run',{taskId:binding.taskId,runId:first.runId,reason:'Stop one invocation'});
    runtime.tick();
    assert.equal(ledger.getRun(first.runId).state,'cancelled');assert.notEqual(ledger.getTask(binding.taskId).state,'cancelled');
    const second=runtime.start({commandId:'cancel-second',taskId:binding.taskId});runtime.tick();
    const child=runtime.snapshot().runs.find(run=>run.runId===second.runId).steps[0];
    assert.ok(child.runId,JSON.stringify(child));
    ledger.cancel('cancel-whole-task',{taskId:binding.taskId,reason:'Stop continuing work'});
    assert.equal(ledger.getTask(binding.taskId).state,'cancelled');
    runtime.tick();runtime.tick();
    assert.equal(ledger.getRun(child.runId).state,'cancelled');assert.equal(ledger.getRun(second.runId).state,'cancelled');
    assert.equal(ledger.getTask(binding.taskId).state,'cancelled');
    assert.throws(()=>runtime.start({commandId:'cancel-no-reopen',taskId:binding.taskId}),/Explicitly reopen/);
    const archived=runtime.configureTask({commandId:'archive-bind',projectId:'p',workflowId:'flow',input:{}});
    runtime.start({commandId:'archive-start',taskId:archived.taskId});runtime.tick();
    ledger.updateTask('archive-task',{taskId:archived.taskId,expectedRevision:ledger.getTask(archived.taskId).revision??1,state:'archived'});
    runtime.tick();assert.equal(ledger.getTask(archived.taskId).state,'archived');
    assert.throws(()=>runtime.start({commandId:'archive-no-reopen',taskId:archived.taskId}),/Explicitly reopen/);
  }finally{await h.dispose()}
});

test('restricted existing Task scope rejects configuration and adoption before changing schedules or history',async()=>{
  const f=fixture();try{
    f.register('mbp','collect',()=>({summary:'Collected',data:{}}));
    const digest={...programStep('digest','vps','unused',['collect']),execution:{kind:'agent',provider:'test',model:'model',instructions:'Digest',allowedTools:['task_submit_result','digest_read'],inputExposure:'tools'}};
    const saved=save(f,definition([programStep('collect','mbp','collect'),digest]));
    const task=f.ledger.createTask(id(),{taskId:'restricted-daily',title:'Existing daily',kind:'scheduled',requiresConfirmation:false,policy:{allowedNodeIds:['mbp'],allowedWorkspaceIds:['mbp-ws'],allowedTools:['old-source-read'],allowedBackends:[]}}).value;
    const wb=new Workbench(f.ledger);wb.manage(id(),'create_backlog',{backlogId:'restricted-backlog',projectId:'project',title:'Existing work',goal:'Daily'});wb.manage(id(),'link_backlog_task',{backlogId:'restricted-backlog',taskId:task.taskId});
    const oldRun=f.ledger.createRun(id(),{taskId:task.taskId,route:{nodeId:'mbp',workspaceId:'mbp-ws',provider:'test',model:'model',requiredCapabilities:[]}}).value;
    const claimed=f.ledger.claim(id(),{runId:oldRun.runId,nodeId:'mbp',ttlMs:1000}).value.attempt;
    f.ledger.submit(id(),{runId:oldRun.runId,attemptId:claimed.attemptId,nodeId:'mbp',fence:claimed.fence,outcome:'success',summary:'Original evidence'});
    f.ledger.updateTemplate(id(),{templateId:'restricted-old',version:1,name:'Original',description:'',inputSchema:{},defaults:{},resultContract:{}});
    f.ledger.createSchedule(id(),{scheduleId:task.taskId,taskId:task.taskId,templateId:'restricted-old',templateVersion:1,enabled:false,revision:4,cron:'0 7 * * *',timeZone:'Asia/Shanghai',nextDueAt:'2026-10-16T23:00:00.000Z',overlap:'queue',misfire:'once',input:{},route:oldRun.route});
    const db=f.ledger.managementDatabase(),history=structuredClone(f.ledger.history(task.taskId)),schedule=structuredClone(f.ledger.getSchedule(task.taskId));
    const definitionRow=()=>db.prepare('SELECT data,next_due FROM workflow_definitions WHERE id=?').get('daily');
    const initial=definitionRow();
    const checkScope=error=>error.code==='WORKFLOW_SCOPE'&&/allowedNodeIds: vps/.test(error.message)&&/allowedWorkspaceIds: vps-ws/.test(error.message)&&/allowedTools: digest_read, task_submit_result, workflow_input_read/.test(error.message);
    assert.throws(()=>f.runtime.configureTask({commandId:'restricted-configure',projectId:'project',taskId:task.taskId,workflowId:'daily',input:{}}),checkScope);
    assert.deepEqual(definitionRow(),initial);assert.deepEqual(f.ledger.getSchedule(task.taskId),schedule);assert.deepEqual(f.ledger.history(task.taskId),history);assert.equal(f.runtime.snapshot().taskBindings.length,0);
    const legacy={...saved,schedule:{enabled:true,cron:'0 7 * * *',timeZone:'Asia/Shanghai',dayOffset:-1}};delete legacy.projectId;
    db.prepare('UPDATE workflow_definitions SET data=?,next_due=? WHERE id=?').run(JSON.stringify(legacy),'2026-10-16T23:00:00.000Z','daily');
    const beforeAdoption=definitionRow(),adoption={commandId:'restricted-adopt',workflowId:'daily',projectId:'project',taskId:task.taskId};
    assert.throws(()=>f.runtime.adopt(adoption),checkScope);
    assert.deepEqual(definitionRow(),beforeAdoption);assert.deepEqual(f.ledger.getSchedule(task.taskId),schedule);assert.deepEqual(f.ledger.history(task.taskId),history);assert.equal(f.runtime.snapshot().taskBindings.length,0);
    assert.equal(f.ledger.commandReceipt('restricted-adopt'),undefined);assert.equal(db.prepare('SELECT count(*) AS count FROM workflow_adoptions').get().count,0);
    const priorPolicy=f.ledger.getTask(task.taskId).policy,nextPolicy={...priorPolicy,allowedNodeIds:['mbp','vps'],allowedWorkspaceIds:['mbp-ws','vps-ws'],allowedTools:['digest_read','task_submit_result','workflow_input_read'],allowedBackends:[]};
    f.ledger.managementCommand('explicit-minimal-workflow-grant','authorized-scope',{taskId:task.taskId,priorPolicy,nextPolicy},()=>{
      const stored=JSON.parse(db.prepare("SELECT data FROM entities WHERE kind='task' AND id=?").get(task.taskId).data);
      stored.policy=nextPolicy;db.prepare("UPDATE entities SET data=? WHERE kind='task' AND id=?").run(JSON.stringify(stored),task.taskId);
    });
    const adopted=f.runtime.adopt(adoption);assert.equal(adopted.taskId,task.taskId);assert.equal(adopted.scheduleId,task.taskId);
    assert.deepEqual(f.ledger.getTask(task.taskId).policy,nextPolicy);assert.deepEqual(f.ledger.history(task.taskId).runs,history.runs);assert.equal(f.ledger.getSchedule(task.taskId).enabled,true);
    const run=f.runtime.start({commandId:id(),taskId:task.taskId});f.runtime.tick();
    assert.equal(view(f,run).steps[0].state,'queued');assert.equal(view(f,run).steps[1].state,'pending');
    await f.worker('mbp').pollOnce();f.heartbeat('vps');f.runtime.tick();
    assert.equal(view(f,run).steps[1].state,'queued');assert.equal(view(f,run).steps[1].reason,undefined);
  }finally{await f.close()}
});

test('root admission rechecks scopes introduced by later workflow edits without creating a partial Run',async()=>{
  const f=fixture();try{
    f.register('mbp','collect',()=>({summary:'Collected',data:{}}));
    const saved=save(f,definition([programStep('collect','mbp','collect')]));
    const task=f.ledger.createTask(id(),{title:'Restricted task',requiresConfirmation:false,policy:{allowedNodeIds:['mbp'],allowedWorkspaceIds:['mbp-ws'],allowedTools:[],allowedBackends:[]}}).value;
    const wb=new Workbench(f.ledger);wb.manage(id(),'create_backlog',{backlogId:'scope-backlog',projectId:'project',title:'Scope',goal:'Test'});wb.manage(id(),'link_backlog_task',{backlogId:'scope-backlog',taskId:task.taskId});
    f.runtime.configureTask({commandId:id(),projectId:'project',taskId:task.taskId,workflowId:'daily',input:{}});
    const first=f.runtime.start({commandId:id(),taskId:task.taskId});f.runtime.tick();await f.worker('mbp').pollOnce();f.runtime.tick();
    const digest={...programStep('digest','vps','unused',['collect']),stageId:'vps-digest',position:{x:0,y:0},execution:{kind:'agent',provider:'test',model:'model',instructions:'Digest',allowedTools:['task_submit_result'],inputExposure:'tools'}};
    f.runtime.save({commandId:id(),expectedRevision:1,definition:{...saved,stages:[...saved.stages,{stageId:'vps-digest',title:'VPS',nodeId:'vps',position:{x:400,y:0}}],calls:[{fromStepId:'collect',toStepId:'digest'}],steps:[...saved.steps,digest]}});
    assert.throws(()=>f.runtime.start({commandId:'scope-edited-start',taskId:task.taskId}),error=>error.code==='WORKFLOW_SCOPE'&&/workflow_input_read/.test(error.message)&&/allowedNodeIds: vps/.test(error.message));
    assert.equal(f.ledger.history(task.taskId).runs.length,1);assert.equal(f.runtime.snapshot().runs.length,1);assert.equal(f.ledger.commandReceipt('scope-edited-start'),undefined);
    assert.deepEqual(view(f,first).definition,saved);assert.equal(view(f,first).state,'succeeded');
    assert.deepEqual(f.ledger.getTask(task.taskId).policy.allowedNodeIds,['mbp']);
  }finally{await f.close()}
});

test("terminal workflow maintenance does not reread historical step reports and snapshots sample availability once", async () => {
  const f = fixture();
  try {
    f.register("mbp", "collect", () => ({
      data: { evidence: "x".repeat(32000) },
      summary: "Collected",
    }));
    save(f, definition([programStep("collect", "mbp", "collect")]));
    const completed = start(f);
    f.runtime.tick({ scheduleEnabled: false });
    await f.worker("mbp").pollOnce();
    f.runtime.tick({ scheduleEnabled: false });
    assert.equal(view(f, completed).state, "succeeded");
    const cancelled = start(f);
    f.runtime.cancel({
      commandId: id(),
      workflowRunId: cancelled.workflowRunId,
    });
    assert.equal(view(f, cancelled).state, "cancelled");
    const originalHistory = f.ledger.history.bind(f.ledger);
    f.ledger.history = () => {
      throw Error("terminal workflow reread historical reports");
    };
    f.runtime.tick({ scheduleEnabled: false });
    f.ledger.history = originalHistory;
    const statuses = f.ledger.nodeStatuses.bind(f.ledger);
    let samples = 0;
    f.ledger.nodeStatuses = (...args) => {
      samples++;
      return statuses(...args);
    };
    const snapshot = f.runtime.snapshot();
    assert.equal(samples, 1);
    assert.equal(
      snapshot.runs.find((row) => row.workflowRunId === completed.workflowRunId)
        .steps[0].output.evidence.length,
      32000,
    );
    assert.equal(
      snapshot.runs.find((row) => row.workflowRunId === cancelled.workflowRunId)
        .state,
      "cancelled",
    );
  } finally {
    await f.close();
  }
});

test("cancelled workflow keeps observing an uncertain step until authoritative reconciliation", async () => {
  const f = fixture();
  try {
    f.register("mbp", "collect", () => ({ data: {}, summary: "unused" }));
    save(f, definition([programStep("collect", "mbp", "collect")]));
    const execution = start(f);
    f.runtime.tick({ scheduleEnabled: false });
    const step = view(f, execution).steps[0],
      claim = f.ledger.claim(id(), {
        runId: step.runId,
        nodeId: "mbp",
        ttlMs: 60000,
      }).value;
    const lease = {
      runId: step.runId,
      attemptId: claim.attempt.attemptId,
      nodeId: "mbp",
      fence: claim.attempt.fence,
      executionId: "uncertain-cancel-fixture",
    };
    f.ledger.markRunning(id(), lease);
    f.ledger.submit(id(), {
      ...lease,
      outcome: "unknown",
      summary: "Provider outcome requires reconciliation",
    });
    f.runtime.tick({ scheduleEnabled: false });
    f.runtime.cancel({
      commandId: id(),
      workflowRunId: execution.workflowRunId,
    });
    f.runtime.tick({ scheduleEnabled: false });
    assert.equal(view(f, execution).steps[0].state, "uncertain");
    f.ledger.resolveUncertain(id(), {
      runId: step.runId,
      outcome: "failed",
      reason: "Verified provider stopped",
    });
    f.runtime.tick({ scheduleEnabled: false });
    assert.equal(view(f, execution).steps[0].state, "failed");
    assert.equal(f.ledger.getRun(execution.runId).state, "cancelled");
  } finally {
    await f.close();
  }
});

async function settlePrograms(f, root, worker) {
  for (let n = 0; n < 8 && !['succeeded','partial'].includes(view(f, root).state); n++) {
    f.runtime.tick(); await worker.pollOnce(); f.runtime.tick();
  }
  assert.ok(['succeeded','partial'].includes(view(f,root).state));
}
function rootResults(f, root) {
  return f.ledger.history(root.taskId).reports.filter(r => r.runId === root.runId && r.kind === 'result');
}
test('root Run exposes its own final output once and never borrows an older Run report', async () => {
  const f=fixture();
  try {
    f.register('vps','render',({input})=>({data:{text:input.text},body:'Report '+input.text,summary:'Rendered '+input.text}));
    save(f,definition([programStep('render','vps','render',[],{text:{kind:'workflow-input',path:['text']}})]));
    const worker=f.worker('vps'),first=start(f,{text:'first'});
    await settlePrograms(f,first,worker);
    const source=view(f,first).steps[0],result=rootResults(f,first)[0];
    assert.equal(result.body,'Report first');assert.deepEqual(result.data,{text:'first'});
    assert.deepEqual(result.workflowOutputs,[{stepId:'render',taskId:source.taskId,runId:source.runId,reportId:source.reportId}]);
    const again=f.runtime.reconcileResultReport(first.runId);assert.equal(again.reportId,result.reportId);
    f.runtime.tick();assert.equal(rootResults(f,first).length,1);
    const second=start(f,{text:'second'});assert.equal(rootResults(f,second).length,0);
    assert.equal(f.runtime.reconcileResultReport(second.runId),null);
    await settlePrograms(f,second,worker);
    assert.equal(rootResults(f,second)[0].body,'Report second');assert.equal(rootResults(f,first)[0].body,'Report first');
    assert.notEqual(rootResults(f,second)[0].workflowOutputs[0].runId,source.runId);
    assert.throws(()=>f.ledger.appendReport(id(),{taskId:second.taskId,runId:second.runId,kind:'result',title:'Cross-Run',body:'invalid',workflowOutputs:result.workflowOutputs}),/this workflow Run/);
  } finally {await f.close();}
});
test('all terminal outputs are included deterministically and explicit final output selection is respected', async () => {
  for (const selected of [undefined,['left']]) {
    const f=fixture();
    try {
      f.register('vps','leaf',({input})=>({data:{name:input.name},body:'Output '+input.name,summary:input.name}));
      const d=definition(['left','right'].map(name=>programStep(name,'vps','leaf',[],{name:{kind:'literal',value:name}})));
      if(selected)d.resultStepIds=selected;
      save(f,d);const root=start(f);await settlePrograms(f,root,f.worker('vps'));
      const report=rootResults(f,root)[0];
      assert.deepEqual(report.workflowOutputs.map(r=>r.stepId),selected??['left','right']);
      assert.match(report.body,/Output left/);assert.equal(report.body.includes('Output right'),!selected);
      assert.throws(()=>f.runtime.save({commandId:id(),expectedRevision:1,definition:{...d,revision:1,resultStepIds:['missing']}}),/Final output/);
    } finally {await f.close();}
  }
});
test('legacy completed workflow report repair is idempotent and preserves frozen execution and original evidence', async () => {
  const f=fixture();
  try {
    f.register('vps','leaf',()=>({data:{final:true},body:'Legacy report',summary:'done'}));
    save(f,definition([programStep('leaf','vps','leaf')]));const root=start(f);
    // Model the previously deployed completion path, which only updated root state.
    f.runtime.publishResultReport=()=>null;
    await settlePrograms(f,root,f.worker('vps'));assert.equal(rootResults(f,root).length,0);
    const frozen=JSON.stringify(view(f,root)),child=view(f,root).steps[0],original=f.ledger.history(child.taskId).reports;
    f.reopen();
    assert.throws(()=>f.ledger.workflowAtomic(()=>{
      f.runtime.reconcileResultReport(root.runId);
      throw new Error('simulated interrupted completion');
    }),/simulated interrupted completion/);
    assert.equal(rootResults(f,root).length,0);
    const repaired=f.runtime.reconcileResultReport(root.runId);
    assert.equal(repaired.body,'Legacy report');assert.equal(rootResults(f,root).length,1);
    assert.equal(f.runtime.reconcileResultReport(root.runId).reportId,repaired.reportId);
    assert.equal(JSON.stringify(view(f,root)),frozen);assert.deepEqual(f.ledger.history(child.taskId).reports,original);
    const cancelled=start(f);f.runtime.cancel({commandId:id(),workflowRunId:cancelled.runId});
    assert.equal(f.runtime.reconcileResultReport(cancelled.runId),null);assert.equal(rootResults(f,cancelled).length,0);
  } finally {await f.close();}
});


test("abstract steps save without a workspace while bound step schemas retain required routes", () => {
  const abstract = { ...programStep("plan", "mbp", "work"), execution: { kind: "unbound" } };
  delete abstract.workspaceId;
  assert.equal(WorkflowStep.parse(abstract).execution.kind, "unbound");
  assert.equal(WorkflowStep.safeParse({ ...abstract, execution: { kind: "unbound", programId: "fake" } }).success, false);
  assert.equal(WorkflowStep.safeParse({ ...abstract, execution: { kind: "program", programId: "work", version: "1" } }).success, false);
  assert.equal(WorkflowStep.safeParse({ ...abstract, workspaceId: "", execution: { kind: "program", programId: "work", version: "1" } }).success, false);
  assert.equal(WorkflowStep.safeParse({ ...abstract, execution: { kind: "agent", provider: "test", model: "model", instructions: "Work", allowedTools: [] } }).success, false);
});

test("abstract definitions reject start and configuration before creating Tasks or Runs", async () => {
  const f = fixture();
  try {
    const step = { ...programStep("outline", "mbp", "work"), execution: { kind: "unbound" } };
    delete step.workspaceId;
    const saved = save(f, definition([step]));
    assert.equal(saved.steps[0].workspaceId, undefined);
    const before = f.ledger.snapshot();
    const rejectsUnbound = error => error.code === "WORKFLOW_UNBOUND" && /outline/.test(error.message);
    assert.throws(() => start(f), rejectsUnbound);
    assert.throws(() => f.runtime.configureTask({ commandId: id(), projectId: "project", workflowId: "daily", input: {} }), rejectsUnbound);
    assert.throws(() => new ScheduledPlans(f.ledger).create({ commandId: id(), title: "Abstract", description: "Plan", projectId: "project", execution: { kind: "workflow", workflowId: "daily", input: {} }, cadence: { mode: "interval", minutes: 1 } }), rejectsUnbound);
    const after = f.ledger.snapshot();
    for (const field of ["tasks", "runs", "reports", "schedules"]) assert.deepEqual(after[field], before[field]);
    assert.equal(f.runtime.snapshot().taskBindings.length, 0);
    assert.equal(f.runtime.snapshot().runs.length, 0);
  } finally { await f.close(); }
});

test("an existing scheduled Task rejects an unbound revision atomically and resumes after binding", async () => {
  const f = fixture();
  try {
    let effects = 0;
    f.register("mbp", "work", () => { effects++; return { summary: "Done", data: { ok: true } }; });
    const saved = save(f, definition([programStep("outline", "mbp", "work")]));
    const created = new ScheduledPlans(f.ledger).create({ commandId: id(), title: "Scheduled", description: "Plan", projectId: "project", execution: { kind: "workflow", workflowId: "daily", input: {} }, cadence: { mode: "interval", minutes: 1 } });
    const schedule = f.ledger.getSchedule(created.scheduleId);
    schedule.nextDueAt = new Date(Date.now() - 1000).toISOString();
    f.ledger.managementDatabase().prepare("UPDATE entities SET data=? WHERE kind='schedule' AND id=?").run(JSON.stringify(schedule), schedule.scheduleId);
    const abstract = structuredClone(saved);
    abstract.steps[0].execution = { kind: "unbound" };
    delete abstract.steps[0].workspaceId;
    const draft = f.runtime.save({ commandId: id(), expectedRevision: saved.revision, definition: abstract });
    const before = f.ledger.snapshot();
    assert.throws(() => f.runtime.start({ commandId: id(), taskId: created.taskId }), error => error.code === "WORKFLOW_UNBOUND");
    assert.throws(() => f.ledger.fireSchedule(id(), { scheduleId: created.scheduleId, occurrenceAt: schedule.nextDueAt }), error => error.code === "WORKFLOW_UNBOUND");
    for (const field of ["tasks", "runs", "reports", "schedules"]) assert.deepEqual(f.ledger.snapshot()[field], before[field]);
    assert.equal(f.ledger.scheduleHistory(created.scheduleId).length, 0);
    assert.equal(f.runtime.snapshot().runs.length, 0);
    assert.equal(effects, 0);
    f.runtime.save({ commandId: id(), expectedRevision: draft.revision, definition: { ...saved, revision: draft.revision } });
    const occurrence = f.ledger.fireSchedule(id(), { scheduleId: created.scheduleId, occurrenceAt: schedule.nextDueAt }).value;
    const worker = f.worker("mbp");
    f.runtime.tick({ scheduleEnabled: false }); await worker.pollOnce(); f.runtime.tick({ scheduleEnabled: false });
    assert.equal(effects, 1);
    assert.equal(f.runtime.getRun(occurrence.runId).definitionRevision, 3);
  } finally { await f.close(); }
});

test("a later abstract plan keeps historical revision and exact task Run report associations", async () => {
  const f = fixture();
  try {
    f.register("mbp", "work", () => ({ summary: "Original report", data: { revision: 1 } }));
    const saved = save(f, definition([programStep("report", "mbp", "work")]));
    const execution = start(f), worker = f.worker("mbp");
    f.runtime.tick(); await worker.pollOnce(); f.runtime.tick();
    const original = f.runtime.getRun(execution.workflowRunId);
    assert.ok(original.steps[0].taskId && original.steps[0].runId && original.steps[0].reportId);
    const changed = structuredClone(saved);
    changed.steps[0].execution = { kind: "unbound" };
    delete changed.steps[0].workspaceId;
    f.runtime.save({ commandId: id(), expectedRevision: 1, definition: changed });
    f.reopen();
    const history = f.runtime.getRun(execution.workflowRunId);
    assert.deepEqual(history.definition, original.definition);
    assert.equal(history.definitionRevision, 1);
    assert.deepEqual(history.steps, original.steps);
    const report = f.ledger.snapshot().reports.find(report => report.reportId === history.steps[0].reportId);
    assert.equal(report.runId, history.steps[0].runId);
    assert.equal(report.taskId, history.steps[0].taskId);
  } finally { await f.close(); }
});


test("exact workflow views retrieve Runs outside the latest twenty with no latest fallback", async () => {
  const f = fixture();
  try {
    let ordinal = 0;
    f.register("mbp", "work", () => ({ summary: `Result ${++ordinal}`, data: { ordinal } }));
    save(f, definition([programStep("report", "mbp", "work")]));
    const worker = f.worker("mbp");
    let first;
    for (let index = 0; index < 21; index++) {
      const execution = start(f);
      f.runtime.tick(); await worker.pollOnce(); f.runtime.tick();
      if (!first) first = f.runtime.getRunView(execution.workflowRunId);
    }
    assert.equal(f.runtime.snapshot().runs.length, 20);
    assert.equal(f.runtime.snapshot().runs.some(run => run.workflowRunId === first.workflowRunId), false);
    const exact = f.runtime.getRunView(first.workflowRunId);
    assert.deepEqual(exact, first);
    assert.equal(exact.steps[0].summary, "Result 1");
    assert.ok(exact.steps[0].taskId && exact.steps[0].runId && exact.steps[0].reportId);
    assert.throws(() => f.runtime.getRunView("unknown-history"), error => error.code === "NOT_FOUND");
    const alias = { ...exact, workflowRunId: "imported-history" };
    f.ledger.managementDatabase().prepare("UPDATE workflow_runs SET id=?,data=? WHERE id=?").run(alias.workflowRunId, JSON.stringify(alias), exact.workflowRunId);
    assert.deepEqual(f.runtime.getRunView(exact.runId), alias);
    assert.deepEqual(f.runtime.getRunView(alias.workflowRunId), alias);
  } finally { await f.close(); }
});

test("read-only exact views retain legacy adoption ownership without changing frozen records", async () => {
  const f = fixture();
  try {
    const legacy = { workflowRunId: "legacy-history", workflowId: "legacy-flow", definitionRevision: 1, title: "Legacy", definition: definition([programStep("a", "mbp", "work")]), input: { original: true }, createdAt: "2026-01-01", updatedAt: "2026-01-01", state: "succeeded", steps: [] };
    const db = f.ledger.managementDatabase();
    db.prepare("INSERT INTO workflow_runs(id,data) VALUES(?,?)").run(legacy.workflowRunId, JSON.stringify(legacy));
    db.prepare("INSERT INTO workflow_adoptions(workflow_id,data) VALUES(?,?)").run(legacy.workflowId, JSON.stringify({ taskId: "adopted-task", projectId: "project" }));
    const before = db.prepare("SELECT data FROM workflow_runs WHERE id=?").get(legacy.workflowRunId).data;
    const view = f.runtime.getRunView(legacy.workflowRunId);
    assert.equal(view.taskId, "adopted-task");
    assert.equal(view.projectId, "project");
    assert.deepEqual(view.dispatches, []);
    assert.deepEqual(view.input, legacy.input);
    assert.equal(view.definitionRevision, 1);
    assert.deepEqual(f.runtime.snapshot().runs[0], view);
    assert.equal(db.prepare("SELECT data FROM workflow_runs WHERE id=?").get(legacy.workflowRunId).data, before);
  } finally { await f.close(); }
});

test('script workflows pin operator argv, bind upstream JSON and execute in the selected workspace without Agent sessions', async () => {
  const { Context } = await import('@deepseek-ai/cordis');
  const { default: LocalSubprocessRuntime } = await import('@deepseek-ai/dsh-subprocess-local');
  const { registerWorkflowScripts } = await import('../dist/workflow-scripts.js');
  const ctx = new Context(); await ctx.plugin(LocalSubprocessRuntime);
  const f = fixture();
  try {
    registerWorkflowScripts(f.registries.mbp, ctx.subprocess, ['mbp-ws']); f.heartbeat('mbp');
    registerWorkflowScripts(f.registries.vps, ctx.subprocess, ['vps-ws']); f.heartbeat('vps');
    const code = `let raw='';process.stdin.on('data',chunk=>raw+=chunk);process.stdin.on('end',()=>{const request=JSON.parse(raw);process.stdout.write(JSON.stringify({summary:'Script done',data:{input:request.input,cwd:process.cwd(),request,arg:process.argv[1]}}));});`;
    const step = {...programStep('collect','mbp','unused'), execution:{kind:'script',executable:process.execPath,args:['-e',code,'$(touch not-a-shell)']},inputs:{seed:{kind:'workflow-input',path:['seed']},script:{kind:'workflow-input',path:['script']}}};
    const render = {...programStep('render','vps','unused',['collect'],{upstream:{kind:'step-output',stepId:'collect',path:[]}}),execution:{kind:'script',executable:process.execPath,args:['-e',code,'render']}};
    const saved = save(f,definition([step,render]));
    const attack = {kind:'script',executable:'definitely-not-executed',args:[]};
    const run = start(f,{seed:'fixed input',script:attack});
    f.runtime.save({commandId:id(),expectedRevision:1,definition:{...saved,steps:saved.steps.map(item=>item.stepId==='collect'?{...item,execution:{...step.execution,args:['-e',"throw Error('new definition must not execute')"]}}:item)}});
    f.runtime.tick();
    const admitted=f.ledger.getRun(view(f,run).steps[0].runId);
    assert.deepEqual(admitted.workflowScript,step.execution);
    assert.equal(admitted.configuration.script,undefined);
    f.reopen();
    const result=await f.worker('mbp').pollOnce();assert.equal(result[0].value.state,'acknowledged');
    f.runtime.tick();await f.worker('vps').pollOnce();f.runtime.tick();
    const final=view(f,run);assert.equal(final.state,'succeeded');
    const collected=final.steps[0].output;
    assert.equal(collected.input.seed,'fixed input');assert.deepEqual(collected.input.script,attack);
    assert.equal(collected.cwd,realpathSync(f.dir));assert.equal(collected.request.workspacePath,realpathSync(f.dir));
    assert.equal(collected.request.nodeId,'mbp');assert.ok(collected.request.executionId);assert.equal(collected.request.taskId,final.steps[0].taskId);assert.equal(collected.request.runId,final.steps[0].runId);
    assert.equal(collected.request.script,undefined);assert.equal(collected.arg,'$(touch not-a-shell)');
    assert.deepEqual(final.steps[1].output.input.upstream,collected);
    assert.ok(f.ledger.snapshot().runs.every(item=>item.sessionIds.length===0));
  } finally { await f.close(); await ctx.fiber.dispose(); }
});

test('script workspace grants are explicit and ordinary dispatch configuration cannot authorize a command',async()=>{
  const { Context }=await import('@deepseek-ai/cordis');const {default:LocalSubprocessRuntime}=await import('@deepseek-ai/dsh-subprocess-local');
  const {registerWorkflowScripts}=await import('../dist/workflow-scripts.js');
  const {SCRIPT_PROGRAM}=await import('../dist/workflow-programs.js');
  const ctx=new Context();await ctx.plugin(LocalSubprocessRuntime);const f=fixture();
  try {
    const step={...programStep('script','mbp','unused'),execution:{kind:'script',executable:process.execPath,args:['-e',"throw Error('must not execute')"]}};
    assert.throws(()=>save(f,definition([step])),/scriptExecutionWorkspaces/);
    assert.throws(()=>registerWorkflowScripts(f.registries.mbp,ctx.subprocess,[]),/explicit workspace grant/);
    registerWorkflowScripts(f.registries.mbp,ctx.subprocess,['other-ws']);f.heartbeat('mbp');
    assert.throws(()=>save(f,definition([step])),/scriptExecutionWorkspaces/);
    const registry=new ProgramRegistry('mbp');registerWorkflowScripts(registry,ctx.subprocess,['mbp-ws']);
    const route={nodeId:'mbp',workspaceId:'mbp-ws',provider:'registered-program',model:SCRIPT_PROGRAM.programId,requiredCapabilities:[],execution:{kind:'program',...SCRIPT_PROGRAM}};
    assert.equal(registry.supports({...route,workspaceId:'other-ws'}),false);
    assert.equal(registry.supports(route),true);
    const forged=f.ledger.createTask(id(),{taskId:'forged-script',title:'Forged script',description:'Test',requiresConfirmation:false}).value;
    f.ledger.recordNodeHeartbeat(id(),{nodeId:'mbp',sampledAt:Date.now()+counter,runtimeReady:true,activeExecutions:0,providerStatus:{programs:registry.catalog()},source:'host-local'});
    assert.throws(()=>f.ledger.createRun(id(),{taskId:forged.taskId,route,configuration:{input:{},script:step.execution}}),/Unsupported Run configuration/);
    const created=f.ledger.createRun(id(),{taskId:forged.taskId,route,workflowScript:step.execution,configuration:{input:{script:step.execution},workflow:{workflowRunId:'forged',workflowId:'forged',stepId:'forged',definitionRevision:1}}}).value;
    assert.equal(created.workflowScript,undefined);
    const result=await registry.execute({claim:{task:forged,run:created,attempt:{executionId:'forged'}},workspacePath:f.dir,signal:new AbortController().signal});
    assert.equal(result.outcome,'failure');assert.match(result.summary,/Program stopped with error/);
    assert.throws(()=>f.ledger.validateRoute({...route,workspaceId:'vps-ws'}),/not advertised/);
  } finally {await f.close();await ctx.fiber.dispose();}
});

test('real script stdout, result contract and nonzero errors remain visible while bounded output stops the child',async()=>{
  const {Context}=await import('@deepseek-ai/cordis');const {default:LocalSubprocessRuntime}=await import('@deepseek-ai/dsh-subprocess-local');const {registerWorkflowScripts}=await import('../dist/workflow-scripts.js');const {SCRIPT_PROGRAM}=await import('../dist/workflow-programs.js');
  const ctx=new Context();await ctx.plugin(LocalSubprocessRuntime);const registry=new ProgramRegistry('worker');registerWorkflowScripts(registry,ctx.subprocess,['ws']);
  try {
    for(const [code,pattern] of [["console.error('specific diagnostic');process.exit(7)",/exited with 7: specific diagnostic/],["process.stdout.write('not json')",/one JSON ProgramResult/],["console.log(JSON.stringify({data:{}}))",/summary/],["process.stdout.write('x'.repeat(2100000));setInterval(()=>{},1000)",/stdout exceeds 2 MB/]]) {
      const result=await registry.execute({claim:{task:{taskId:'task'},attempt:{executionId:'execution'},run:{runId:'run',route:{nodeId:'worker',workspaceId:'ws',execution:{kind:'program',...SCRIPT_PROGRAM}},workflowScript:{kind:'script',executable:process.execPath,args:['-e',code]},configuration:{input:{}}}},workspacePath:process.cwd(),signal:new AbortController().signal});
      assert.equal(result.outcome,'failure');assert.match(result.summary,pattern);
    }
  } finally {await ctx.fiber.dispose();}
});

test('workflow cancellation terminates the real script process before acknowledging cancellation',async()=>{
  const {Context}=await import('@deepseek-ai/cordis');const {default:LocalSubprocessRuntime}=await import('@deepseek-ai/dsh-subprocess-local');const {registerWorkflowScripts}=await import('../dist/workflow-scripts.js');const {existsSync,readFileSync}=await import('node:fs');
  const ctx=new Context();await ctx.plugin(LocalSubprocessRuntime);const f=fixture();
  try {
    registerWorkflowScripts(f.registries.mbp,ctx.subprocess,['mbp-ws']);f.heartbeat('mbp');
    const ready=join(f.dir,'pid');const code=`require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`;
    save(f,definition([{...programStep('script','mbp','unused'),execution:{kind:'script',executable:process.execPath,args:['-e',code]}}]));
    const run=start(f);f.runtime.tick();const worker=f.worker('mbp');const pending=worker.pollOnce();
    for(let i=0;i<200&&!existsSync(ready);i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(existsSync(ready));const pid=Number(readFileSync(ready,'utf8'));
    f.runtime.cancel({commandId:id(),workflowRunId:run.workflowRunId});
    await worker.cancel(view(f,run).steps[0].runId);await pending;f.runtime.tick();
    assert.equal(view(f,run).state,'cancelled');assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
  } finally {await f.close();await ctx.fiber.dispose();}
});

test('host only advertises script execution after both explicit workspace authorization and subprocess availability',async()=>{
  const {createNativeHarness}=await import('../../../tests/dsh/native-harness.mjs');const {default:LocalSubprocessRuntime}=await import('@deepseek-ai/dsh-subprocess-local');
  for(const granted of [false,true]) {
    const h=await createNativeHarness({config:{scriptExecutionWorkspaces:granted?['local-ws']:[],executionTools:[]}});
    try {
      assert.equal(h.ctx.taskSystem.programs.catalog().some(item=>item.programId==='dsh.workflow-script'),false);
      await h.ctx.plugin(LocalSubprocessRuntime);
      const builtin=h.ctx.taskSystem.programs.catalog().find(item=>item.programId==='dsh.workflow-script');
      assert.equal(!!builtin,granted);if(granted)assert.deepEqual(builtin.workspaceIds,['local-ws']);
    } finally {await h.dispose();}
  }
});
