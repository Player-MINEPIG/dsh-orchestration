import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough, Writable } from "node:stream";
import { apply as mountOfficial } from "@deepseek-ai/dsh-subagent-codex";
import {
  officialProfileConfig,
  installOfficialPermissionGuard,
  executeOfficialSubagent,
  isolatedFeatures,
  verifyOfficialProfile,
  OFFICIAL_RPC_MAX_LINE_BYTES,
  guardOfficialTransport,
} from "../dist/index.js";

function fixture(t, change = {}) {
  const home = mkdtempSync(join(tmpdir(), "codex-permission-")),
    cwd = join(home, "workspace");
  mkdirSync(cwd);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const backend = {
    backend: "codex-luna-low",
    provider: "codex",
    model: "gpt-6-luna",
    reasoningEffort: "low",
    codexHome: home,
    permissionContract: "codex-native",
  };
  writeFileSync(join(home, "config.toml"), officialProfileConfig(backend));
  const config = {
    model: backend.model,
    model_reasoning_effort: "low",
    sandbox_mode: "read-only",
    approval_policy: "never",
    project_root_markers: [],
    features: Object.fromEntries(isolatedFeatures.map((name) => [name, false])),
  };
  const thread = {
    thread: { id: "fixture-thread", ephemeral: true },
    model: backend.model,
    reasoningEffort: "low",
    approvalPolicy: "never",
    sandbox: { type: "readOnly", networkAccess: false },
  };
  const replies = {
    initialize: {},
    "config/read": {
      config,
      layers: [{ name: { type: "user" }, disabledReason: null }],
    },
    "thread/start": thread,
    "experimentalFeature/list": {
      data: isolatedFeatures.map((name) => ({ name, enabled: false })),
      nextCursor: null,
    },
    "mcpServerStatus/list": { data: [], nextCursor: null },
    "turn/start": { turn: { id: "fixture-turn" } },
  };
  change.mutate?.(replies);
  const methods = [],
    audits = [],
    quiescent = Promise.withResolvers(),
    termination = Promise.withResolvers();
  let provider,
    terminated = false,
    observedExit = false;
  const subprocess = {
    spawn() {
      const stdout = new PassThrough(),
        stderr = new PassThrough();
      const emit = (message) => {
        const bytes = Buffer.from(JSON.stringify(message) + "\n");
        // Exercise framing independent of JSON-RPC stream chunk boundaries.
        stdout.write(bytes.subarray(0, 7));
        stdout.write(bytes.subarray(7));
      };
      const stdin = new Writable({
        write(chunk, _, cb) {
          for (const line of String(chunk).trim().split("\n")) {
            const message = JSON.parse(line);
            methods.push(message.method);
            if (message.id !== undefined) {
              if (change.oversizedMethod === message.method) {
                stdout.write(
                  '{"id":' +
                    JSON.stringify(message.id) +
                    ',"result":{"padding":"' +
                    "x".repeat(OFFICIAL_RPC_MAX_LINE_BYTES) +
                    (change.incomplete ? "" : '"}}\n'),
                );
              } else if (change.errorMethod === message.method)
                emit({
                  id: message.id,
                  error: { code: -32601, message: "unsupported" },
                });
              else emit({ id: message.id, result: replies[message.method] });
              if (message.method === "turn/start") {
                emit({
                  method: "item/completed",
                  params: {
                    threadId: "fixture-thread",
                    turnId: "fixture-turn",
                    item: {
                      type: "agentMessage",
                      id: "answer",
                      text: "fixture final",
                      phase: "final_answer",
                    },
                  },
                });
                emit({
                  method: "turn/completed",
                  params: {
                    threadId: "fixture-thread",
                    turn: { id: "fixture-turn", status: "completed" },
                  },
                });
              }
            }
          }
          cb();
        },
      });
      return {
        stdin,
        stdout,
        stderr,
        done: quiescent.promise,
        terminate() {
          terminated = true;
          termination.resolve();
          if (!change.holdExit) {
            stdout.end();
            stderr.end();
            quiescent.resolve({ exitCode: 0, signal: null });
          }
        },
        async waitForExit() {
          await quiescent.promise;
          observedExit = true;
          return true;
        },
      };
    },
  };
  const restore = installOfficialPermissionGuard(subprocess, [backend], (a) =>
    audits.push(a),
  );
  t.after(restore);
  mountOfficial(
    {
      subprocess,
      subagents: {
        registerProvider: (p) => {
          provider = p;
        },
      },
      logger: { warn() {} },
    },
    {
      providerName: backend.backend,
      model: backend.model,
      permissionMode: "never",
      env: { CODEX_HOME: home },
      disposeGraceMs: 10,
    },
  );
  const execute = () =>
    executeOfficialSubagent({
      subagents: {
        getProvider: () => provider,
        start: (_, input) => provider.start(input),
      },
      parent: { session: { header: { cwd } } },
      route: {
        nodeId: "mbp",
        backend: backend.backend,
        provider: "codex",
        model: backend.model,
        reasoningEffort: "low",
      },
      policy: { allowedBackends: [backend.backend] },
      backends: [backend],
      workspacePath: cwd,
      prompt: change.prompt ?? "fixture only",
      signal: new AbortController().signal,
    });
  return {
    execute,
    methods,
    audits,
    config,
    home,
    cwd,
    backend,
    quiescent,
    termination: termination.promise,
    terminated: () => terminated,
    observedExit: () => observedExit,
  };
}

test("actual official provider releases no turn until same-process config, thread flags and empty MCP inventory pass", async (t) => {
  const f = fixture(t);
  const result = await f.execute();
  assert.equal(result.outcome, "success");
  assert.deepEqual(f.methods.slice(0, 7), [
    "initialize",
    "initialized",
    "config/read",
    "thread/start",
    "experimentalFeature/list",
    "mcpServerStatus/list",
    "turn/start",
  ]);
  assert.equal(f.audits[0].mcpServerCount, 0);
  assert.equal(f.audits[0].productThreadId, "fixture-thread");
  assert.equal(f.observedExit(), true);
});

for (const [label, mutate, errorMethod] of [
  [
    "inherited enabled MCP",
    (r) => {
      r["config/read"].config.mcp_servers = { inherited: { enabled: true } };
    },
  ],
  [
    "managed plugins override",
    (r) => {
      r["config/read"].config.features.plugins = true;
    },
  ],
  [
    "active project layer",
    (r) => {
      r["config/read"].layers.push({
        name: { type: "project" },
        disabledReason: null,
      });
    },
  ],
  [
    "runtime plugin flag overrides file",
    (r) => {
      r["experimentalFeature/list"].data[0].enabled = true;
    },
  ],
  [
    "runtime feature missing",
    (r) => {
      r["experimentalFeature/list"].data.pop();
    },
  ],
  [
    "MCP present with no tools / failed handshake",
    (r) => {
      r["mcpServerStatus/list"].data.push({ name: "unreal-mcp", tools: {} });
    },
  ],
  [
    "inventory pagination incomplete",
    (r) => {
      r["mcpServerStatus/list"].nextCursor = "more";
    },
  ],
  [
    "thread native network granted",
    (r) => {
      r["thread/start"].sandbox.networkAccess = true;
    },
  ],
  ["unsupported public audit API", undefined, "experimentalFeature/list"],
])
  test(`permission audit fails closed before inference: ${label}`, async (t) => {
    const f = fixture(t, { mutate, errorMethod });
    const result = await f.execute();
    assert.equal(result.outcome, "failure");
    assert.equal(f.methods.includes("turn/start"), false);
    assert.deepEqual(f.audits, []);
    assert.equal(f.observedExit(), true);
  });

test("audit rejection cannot settle before official provider joins the process range", async (t) => {
  const f = fixture(t, {
    holdExit: true,
    mutate: (r) => {
      r["mcpServerStatus/list"].data.push({ name: "unexpected" });
    },
  });
  let settled = false;
  const pending = f.execute().then((result) => {
    settled = true;
    return result;
  });
  await f.termination;
  assert.equal(f.terminated(), true);
  assert.equal(settled, false);
  assert.equal(f.methods.includes("turn/start"), false);
  f.quiescent.resolve({ exitCode: 0, signal: null });
  assert.equal((await pending).outcome, "failure");
});

test("five-line profiles and cwd config are rejected; fixed project_root_markers prevents parent discovery", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.cwd, ".codex"));
  assert.throws(
    () => verifyOfficialProfile(f.backend, f.cwd),
    /workspace Codex/,
  );
  writeFileSync(
    join(f.home, "config.toml"),
    officialProfileConfig(f.backend).split("project_root_markers")[0],
  );
  assert.throws(() => verifyOfficialProfile(f.backend), /isolation contract/);
});

for (const incomplete of [false, true])
  test(`incoming ${incomplete ? "incomplete" : "complete"} oversized line is rejected before audit/turn`, async (t) => {
    const f = fixture(t, { oversizedMethod: "config/read", incomplete });
    assert.equal((await f.execute()).outcome, "failure");
    assert.equal(f.methods.includes("turn/start"), false);
    assert.equal(f.observedExit(), true);
  });
test("outgoing UTF-8 byte limit rejects a complete oversized task before turn/start", async (t) => {
  const f = fixture(t, {
    prompt: "界".repeat(Math.ceil(OFFICIAL_RPC_MAX_LINE_BYTES / 3)),
  });
  assert.equal((await f.execute()).outcome, "failure");
  assert.equal(f.methods.includes("turn/start"), false);
  assert.equal(f.observedExit(), true);
});
test("guard retains public handle properties even when inherited getters are non-enumerable", () => {
  const rawIn = new PassThrough(),
    rawOut = new PassThrough(),
    stderr = new PassThrough(),
    collected = {},
    control = new PassThrough(),
    done = Promise.resolve({ exitCode: 0, signal: null });
  let terminated = false;
  const child = Object.create(
    Object.defineProperties(
      {},
      {
        stdin: { get: () => rawIn },
        stdout: { get: () => rawOut },
        stderr: { get: () => stderr },
        collected: { get: () => collected },
        control: { get: () => control },
        done: { get: () => done },
      },
    ),
  );
  child.terminate = () => {
    terminated = true;
  };
  child.waitForExit = async () => true;
  const guarded = guardOfficialTransport(child, {}, "/fixture");
  assert.equal(guarded.done, done);
  assert.equal(guarded.stderr, stderr);
  assert.equal(guarded.collected, collected);
  assert.equal(guarded.control, control);
  guarded.terminate();
  assert.equal(terminated, true);
  rawOut.end();
  rawIn.end();
  stderr.end();
  control.end();
});
