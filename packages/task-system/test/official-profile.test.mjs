import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { apply as mountOfficial } from "@deepseek-ai/dsh-subagent-codex";
import {
  TaskLedger,
  executeOfficialSubagent,
  officialProfileConfig,
} from "../dist/index.js";
import { ExecutorWorker, RecoveryStore } from "../dist/remote/api.js";
const capabilities = {
  agentOptions: false,
  toolFilter: false,
  depthLimit: false,
};
function profile(t) {
  const root = mkdtempSync(join(tmpdir(), "codex-profile-regression-")),
    home = join(root, "profile");
  mkdirSync(home);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(home, "config.toml"),
    officialProfileConfig({ model: "gpt-6-luna", reasoningEffort: "low" }),
  );
  return {
    backend: "codex-luna-low",
    provider: "codex",
    model: "gpt-6-luna",
    reasoningEffort: "low",
    permissionContract: "codex-native",
    codexHome: home,
  };
}
const completed = {
  stopReason: "completed",
  output: [{ type: "text", text: "fixture analysis" }],
};
function invoke(b, subagents, prompt, signal = new AbortController().signal) {
  return executeOfficialSubagent({
    subagents,
    parent: { session: { header: { cwd: b.codexHome } } },
    route: {
      nodeId: "mbp",
      backend: b.backend,
      provider: b.provider,
      model: b.model,
      reasoningEffort: b.reasoningEffort,
    },
    policy: { allowedBackends: [b.backend] },
    backends: [b],
    prompt,
    signal,
  });
}

test("same physical profile waits through disposal, queued abort never starts, other profile stays concurrent", async (t) => {
  const b = profile(t),
    other = profile(t),
    alias = join(b.codexHome, "..", "alias");
  symlinkSync(b.codexHome, alias);
  const disposing = Promise.withResolvers(),
    quiescent = Promise.withResolvers(),
    starts = [];
  const subagents = {
    getProvider: () => ({ capabilities }),
    start: async (_, input) => {
      const prompt = input.prompt[0].text;
      starts.push(prompt);
      return {
        id: prompt,
        result: Promise.resolve(completed),
        dispose: async () => {
          if (prompt === "first") {
            disposing.resolve();
            await quiescent.promise;
          }
        },
      };
    },
  };
  const first = invoke(b, subagents, "first");
  await disposing.promise;
  const second = invoke({ ...b, codexHome: alias }, subagents, "second");
  const cancel = new AbortController(),
    waiting = invoke(b, subagents, "cancelled-waiter", cancel.signal);
  cancel.abort(new Error("fixture deadline"));
  await assert.rejects(waiting, /fixture deadline/);
  await invoke(other, subagents, "other-profile");
  assert.deepEqual(starts, ["first", "other-profile"]);
  quiescent.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(starts, ["first", "other-profile", "second"]);
  // Cancelled queue entries must not leave the profile unavailable for later work.
  await invoke(b, subagents, "after");
  assert.equal(starts.at(-1), "after");
});

test("official rc.2 provider process early exit settles failure only after observed quiescence and releases the profile without replay", async (t) => {
  const b = profile(t),
    teardownEntered = Promise.withResolvers(),
    rangeExited = Promise.withResolvers();
  let provider,
    spawns = 0,
    terminations = 0,
    observedFirstExit = false;
  mountOfficial(
    {
      subagents: {
        registerProvider: (value) => {
          provider = value;
        },
      },
      logger: { warn: () => {} },
      subprocess: {
        spawn: () => {
          const number = ++spawns,
            done = Promise.withResolvers(),
            stdin = new PassThrough(),
            stdout = new PassThrough(),
            stderr = new PassThrough();
          setImmediate(() => {
            done.resolve({ exitCode: 1, signal: null });
            stdout.end();
            stderr.end();
          });
          return {
            stdin,
            stdout,
            stderr,
            done: done.promise,
            terminate: () => {
              terminations++;
              if (number === 1) teardownEntered.resolve();
            },
            waitForExit: async () => {
              if (number === 1) {
                await rangeExited.promise;
                observedFirstExit = true;
              }
              return true;
            },
          };
        },
      },
    },
    {
      providerName: b.backend,
      model: b.model,
      env: { CODEX_HOME: b.codexHome },
      permissionMode: "never",
      disposeGraceMs: 10,
    },
  );
  const subagents = {
    getProvider: () => provider,
    start: (name, input) => {
      assert.equal(name, b.backend);
      return provider.start(input);
    },
  };
  const first = invoke(b, subagents, "first failing startup");
  await teardownEntered.promise;
  const second = invoke(b, subagents, "second independent task");
  await Promise.resolve();
  assert.equal(spawns, 1);
  assert.equal(observedFirstExit, false);
  rangeExited.resolve();
  const results = await Promise.all([first, second]);
  assert.deepEqual(
    results.map((r) => r.outcome),
    ["failure", "failure"],
  );
  assert.equal(observedFirstExit, true);
  assert.equal(spawns, 2);
  assert.equal(terminations, 2);
  const ledger = TaskLedger.open(join(b.codexHome, "authority.sqlite"), {
      role: "both",
      nodeId: "mbp",
    }),
    store = new RecoveryStore(join(b.codexHome, "worker.sqlite"));
  const now = new Date().toISOString();
  ledger.registerWorkspace("workspace", {
    workspaceId: "w",
    nodeId: "mbp",
    path: b.codexHome,
    label: "fixture",
    state: "ready",
    createdAt: now,
  });
  ledger.registerNode("node", {
    nodeId: "mbp",
    roles: ["both"],
    capabilities: [],
    models: [
      {
        provider: b.provider,
        model: b.model,
        reasoningEfforts: [b.reasoningEffort],
      },
    ],
    workspaceIds: ["w"],
    enabled: true,
    maxConcurrent: 1,
    lastSeenAt: now,
  });
  const task = ledger.createTask("task", {
    title: "Early exit convergence",
    workspaceId: "w",
    policy: { allowedBackends: [b.backend] },
  }).value;
  const run = ledger.createRun("run", {
    taskId: task.taskId,
    route: {
      nodeId: "mbp",
      provider: b.provider,
      model: b.model,
      reasoningEffort: b.reasoningEffort,
      backend: b.backend,
      workspaceId: "w",
      requiredCapabilities: [],
    },
  }).value;
  const worker = new ExecutorWorker({
    ledger,
    store,
    provider: {
      id: "official-process-fixture",
      capabilities: [],
      supports: () => true,
      execute: (request) =>
        invoke(b, subagents, "third independent task", request.signal),
    },
    policy: {
      role: "executor",
      nodeId: "mbp",
      capabilities: [],
      workspaces: [
        {
          workspaceId: "w",
          nodeId: "mbp",
          path: b.codexHome,
          allowedRoot: b.codexHome,
        },
      ],
    },
  });
  try {
    const delivered = await worker.execute(run.runId, "claim");
    assert.equal(delivered.state, "acknowledged");
    assert.equal(ledger.getRun(run.runId).state, "failed");
    assert.equal(ledger.getAttempt(delivered.attemptId).state, "settled");
    await worker.recoverResults();
    assert.equal(spawns, 3);
    assert.equal(terminations, 3);
  } finally {
    await worker.dispose();
    store.close();
    ledger.close();
  }
});

test("unconfirmed official teardown blocks another same-profile launch and never returns a successful result", async (t) => {
  const b = profile(t);
  let starts = 0;
  const subagents = {
    getProvider: () => ({ capabilities }),
    start: async () => {
      starts++;
      return {
        id: "unconfirmed-range",
        result: Promise.resolve(completed),
        dispose: async () => {
          throw new Error("fixture exit observation failed");
        },
      };
    },
  };
  await assert.rejects(
    invoke(b, subagents, "first"),
    /fixture exit observation failed/,
  );
  await assert.rejects(
    invoke(b, subagents, "next"),
    /did not confirm quiescence/,
  );
  assert.equal(starts, 1);
});
