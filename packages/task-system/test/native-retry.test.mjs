import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  NativeRetryObservation,
  nativeToolFingerprint,
} from "../dist/native-retry.js";

const facts = { aborted: false, persisted: true, disposed: true };
function fixture(options = {}) {
  const listeners = new Map();
  const ctx = { on: (name, callback) => listeners.set(name, callback) };
  const session = { id: "session-fixture", seq: 7 };
  // Accessing historical logs would invalidate the intended live-only proof.
  Object.defineProperty(session, "events", {
    get() {
      throw new Error("No historical reconstruction");
    },
  });
  const agent = { id: session.id, session, status: "idle" };
  const observation = new NativeRetryObservation(ctx, agent, options);
  function event(type, data, fields = {}, source = session) {
    const value = { seq: source.seq, type, data, ...fields };
    source.seq = value.seq + 1;
    listeners.get("session/event")(source, value);
    return value;
  }
  function step(turn = 1, step = 1) {
    event("step/start", { turn, step });
  }
  function call(
    callId = "call-1",
    args = { path: "result.txt", value: "done" },
    fields = {},
  ) {
    return event("tool/call", {
      turn: 1,
      step: 1,
      callId,
      name: "write",
      arguments: JSON.stringify(args),
      ...fields,
    });
  }
  function dispatch(
    callId = "call-1",
    args = { path: "result.txt", value: "done" },
    fields = {},
  ) {
    observation.dispatchObserved({
      callId,
      name: "write",
      arguments: args,
      agent,
      signal: new AbortController().signal,
      ...fields,
    });
  }
  function result(call, changes = {}, fields = {}) {
    return event(
      "tool/result",
      {
        turn: call.data.turn,
        step: call.data.step,
        message: {
          role: "tool",
          toolCallId: call.data.callId,
          content: [{ type: "text", text: "Complete" }],
        },
        ...changes,
      },
      { surfaceOp: "append", sourceEventSeqs: [call.seq], ...fields },
    );
  }
  async function error(code = "RATE_LIMIT", fields = {}) {
    const marker = {};
    const returned = await listeners.get("agent/request-error")(
      { agent, turn: 1, step: 2, failure: { code }, ...fields },
      async () => marker,
    );
    assert.equal(
      returned,
      marker,
      "native request-error policy authority is preserved",
    );
  }
  async function finish(code = "RATE_LIMIT") {
    step(1, 2);
    event("assistant/attempt", { turn: 1, step: 2 });
    await error(code);
    event("step/end", { turn: 1, step: 2 });
    event("turn/end", { turn: 1, reason: { kind: "error", error: { code } } });
  }
  function witness(extra = {}) {
    return observation.witness({ ...facts, ...extra });
  }
  return {
    agent,
    session,
    observation,
    event,
    step,
    call,
    dispatch,
    result,
    error,
    finish,
    witness,
  };
}

test("zero-tool live retry proof retains its original closed shape", async () => {
  const f = fixture();
  await f.finish();
  assert.deepEqual(f.witness(), {
    kind: "dsh-owned-zero-tools-v1",
    sessionId: "session-fixture",
    fromSeq: 7,
    toSeq: 11,
    terminalSeq: 10,
    turn: 1,
    code: "RATE_LIMIT",
    toolCallCount: 0,
    toolDispatchCount: 0,
    complete: true,
    quiescent: true,
    persisted: true,
    disposed: true,
  });
});

test("completed-tool proof requires operator allowlist and retains only canonical fingerprints", async () => {
  for (const enabled of [false, true]) {
    const f = fixture({ resumableTools: enabled ? ["write"] : [] });
    f.step();
    const call = f.call();
    f.dispatch();
    f.result(call);
    await f.finish("TRANSPORT");
    const witness = f.witness();
    if (!enabled) {
      assert.equal(witness, undefined);
      continue;
    }
    assert.equal(witness.kind, "dsh-owned-completed-tools-v1");
    assert.equal(witness.code, "TRANSPORT");
    assert.equal(witness.toolCallCount, 1);
    assert.equal(witness.toolDispatchCount, 1);
    assert.equal(witness.toolResultCount, 1);
    assert.deepEqual(witness.completedTools, [
      nativeToolFingerprint("write", { value: "done", path: "result.txt" }),
    ]);
    assert.ok(!JSON.stringify(witness).includes("result.txt"));
    witness.completedTools[0].name = "mutated";
    assert.equal(f.witness().completedTools[0].name, "write");
  }
});

test("every call requires one matching successful append result and one dispatch", async () => {
  const mutations = [
    (f, call) => {},
    (f, call) => f.result(call, { turn: 2 }),
    (f, call) => f.result(call, { step: 2 }),
    (f, call) =>
      f.result(call, { message: { role: "tool", toolCallId: "foreign-call" } }),
    (f, call) =>
      f.result(call, {
        message: { role: "tool", toolCallId: call.data.callId, isError: true },
      }),
    (f, call) =>
      f.result(call, {
        error: { code: "TOOL_ABORTED_BEFORE_DISPATCH", name: "AbortError" },
      }),
    (f, call) => f.result(call, {}, { sourceEventSeqs: [] }),
    (f, call) => f.result(call, {}, { sourceEventSeqs: undefined }),
    (f, call) => f.result(call, {}, { sourceEventSeqs: [call.seq - 1] }),
    (f, call) =>
      f.result(call, {}, { sourceEventSeqs: [call.seq, call.seq - 1] }),
    (f, call) => f.result(call, {}, { surfaceOp: "replace" }),
    (f, call) => {
      f.result(call);
      f.result(call);
    },
  ];
  for (const mutate of mutations) {
    const f = fixture({ resumableTools: ["write"] });
    f.step();
    const call = f.call();
    f.dispatch();
    mutate(f, call);
    await f.finish();
    assert.equal(f.witness(), undefined, mutate.toString());
  }
});

test("unmatched, duplicate, nested, cancelled or changed-argument dispatches are not resumable", async () => {
  const mutations = [
    (f) => {},
    (f) => {
      f.dispatch();
      f.dispatch();
    },
    (f) => f.dispatch("different-call"),
    (f) => f.dispatch("call-1", { path: "other.txt", value: "done" }),
    (f) => f.dispatch("call-1", undefined, { name: "edit" }),
    (f) => f.dispatch("call-1", undefined, { agent: { ...f.agent } }),
    (f) => f.dispatch("call-1", undefined, { parent: Symbol("nested") }),
    (f) => f.dispatch("call-1", undefined, { rootCallId: "outer-call" }),
    (f) => f.dispatch("call-1", undefined, { signal: AbortSignal.abort() }),
  ];
  for (const mutate of mutations) {
    const f = fixture({ resumableTools: ["write"] });
    f.step();
    const call = f.call();
    mutate(f);
    f.result(call);
    await f.finish();
    assert.equal(f.witness(), undefined, mutate.toString());
  }
});

test("proof fails closed for gaps, unfinished sessions, non-transient or mismatched terminal errors", async () => {
  for (const change of [
    (f) =>
      f.event("step/start", { turn: 1, step: 1 }, { seq: f.session.seq + 1 }),
    (f) =>
      f.event("tool/result", {
        turn: 1,
        step: 1,
        message: { role: "tool", toolCallId: "unknown" },
      }),
  ]) {
    const f = fixture();
    change(f);
    await f.finish();
    assert.equal(f.witness(), undefined);
  }
  const f = fixture();
  await f.finish();
  for (const bad of [
    { aborted: true },
    { persisted: false },
    { disposed: false },
  ])
    assert.equal(f.witness(bad), undefined);
  f.agent.status = "running";
  assert.equal(f.witness(), undefined);
  f.agent.status = "idle";
  f.session.seq++;
  assert.equal(f.witness(), undefined);
  const after = fixture();
  await after.finish();
  after.event("user/message", {});
  assert.equal(after.witness(), undefined);
  for (const code of ["UNKNOWN", "INVALID_ARGS", "AUTH"]) {
    const permanent = fixture();
    await permanent.finish(code);
    assert.equal(permanent.witness(), undefined);
  }
  for (const mismatch of [
    { turn: 2 },
    { step: 3 },
    { failure: { code: "SERVER" } },
  ]) {
    const bad = fixture();
    bad.step(1, 2);
    await bad.error("RATE_LIMIT", mismatch);
    bad.event("turn/end", {
      turn: 1,
      reason: { kind: "error", error: { code: "RATE_LIMIT" } },
    });
    assert.equal(bad.witness(), undefined);
  }
});

test("live public session identity excludes lookalike sessions and agents", async () => {
  const f = fixture();
  f.event(
    "tool/call",
    { turn: 1, step: 1, callId: "foreign", name: "write", arguments: "{}" },
    {},
    { id: f.session.id, seq: f.session.seq },
  );
  await f.finish();
  assert.equal(f.witness().kind, "dsh-owned-zero-tools-v1");
  const bad = fixture();
  bad.step(1, 2);
  await bad.error("RATE_LIMIT", { agent: { ...bad.agent } });
  bad.event("turn/end", {
    turn: 1,
    reason: { kind: "error", error: { code: "RATE_LIMIT" } },
  });
  assert.equal(bad.witness(), undefined);
});

test("completed calls are bounded at 32 and duplicate fingerprints retain each causal call", async () => {
  for (const count of [2, 32, 33]) {
    const f = fixture({ resumableTools: ["write"] });
    f.step();
    for (let i = 0; i < count; i++) {
      const callId = `call-${i}`;
      const call = f.call(callId);
      f.dispatch(callId);
      f.result(call);
    }
    await f.finish();
    const witness = f.witness();
    if (count === 33) assert.equal(witness, undefined);
    else {
      assert.equal(witness.completedTools.length, count);
      assert.equal(witness.toolCallCount, count);
      assert.deepEqual(witness.completedTools[0], witness.completedTools[1]);
    }
    assert.ok(f.observation.calls.size <= 32);
  }
});

test("completed results must precede the observed final request failure", async () => {
  const f = fixture({ resumableTools: ["write"] });
  f.step(1, 2);
  await f.error();
  const call = f.call("call-1", undefined, { step: 2 });
  f.dispatch();
  f.result(call);
  f.event("turn/end", {
    turn: 1,
    reason: { kind: "error", error: { code: "RATE_LIMIT" } },
  });
  assert.equal(f.witness(), undefined);
});

test("fingerprints match canonical {name,arguments} and reject unsafe or oversized JSON", () => {
  const expected = createHash("sha256")
    .update('{"arguments":{"a":1,"b":2},"name":"write"}')
    .digest("hex");
  assert.deepEqual(nativeToolFingerprint("write", { b: 2, a: 1 }), {
    name: "write",
    argumentsDigest: expected,
  });
  for (const invalid of [
    undefined,
    NaN,
    Infinity,
    BigInt(1),
    new Date(),
    [undefined],
    new Array(100001),
    "x".repeat(1_000_001),
  ])
    assert.equal(nativeToolFingerprint("write", invalid), undefined);
  const cycle = {};
  cycle.self = cycle;
  assert.equal(nativeToolFingerprint("write", cycle), undefined);
  let read = false;
  const getter = {
    get value() {
      read = true;
      return "private";
    },
  };
  assert.equal(nativeToolFingerprint("write", getter), undefined);
  assert.equal(read, false);
  let deep = {};
  for (let i = 0; i < 70; i++) deep = { nested: deep };
  assert.equal(nativeToolFingerprint("write", deep), undefined);
  assert.equal(nativeToolFingerprint("invalid name", {}), undefined);
});
