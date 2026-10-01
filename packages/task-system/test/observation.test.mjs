import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TaskLedger,
  initialObservationState,
  foldObservation,
} from "../dist/index.js";
const user = (seq, kind = "user") => ({
  type: "user/message",
  seq,
  time: 1000 + seq,
  data: { source: { kind }, content: [] },
});
const assistant = (seq, text) => ({
  type: "assistant/message",
  seq,
  time: 1000 + seq,
  data: {
    turn: 1,
    step: seq,
    message: {
      content: [
        { type: "reasoning", text: "PRIVATE REASONING" },
        { type: "text", text },
      ],
    },
    stream: [{ secret: "not persisted" }],
  },
});
test("observer extracts bounded visible text only and excludes task-owned/subagent inherited events", () => {
  let state = initialObservationState("session", 2);
  state = foldObservation(state, user(1));
  state = foldObservation(state, assistant(2, "not human-owned"));
  assert.equal(state.messages.length, 0);
  state = foldObservation(state, user(3));
  state = foldObservation(state, assistant(4, "Useful visible result"));
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].body, "Useful visible result");
  assert.ok(!JSON.stringify(state).includes("PRIVATE REASONING"));
  state = foldObservation(state, user(5, "dsh-task"));
  state = foldObservation(state, assistant(6, "Owned task output"));
  assert.equal(state.messages.length, 0);
  assert.equal(state.excluded, true);
});
test("bounded catch-up explicitly counts omitted entries rather than silently claiming complete history", () => {
  let state = foldObservation(initialObservationState("s", 0), user(0));
  for (let seq = 1; seq < 5; seq++)
    state = foldObservation(state, assistant(seq, "abcdef"), 2, 3);
  assert.equal(state.dropped, 2);
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[0].body, "abc");
  assert.equal(state.messages[0].truncated, true);
});
test("durable observation admission is separate from capture and never schedules work", () => {
  const l = TaskLedger.open(":memory:");
  try {
    const captured = {
      seq: 5,
      sessionId: "s",
      sourceId: "dsh-session:s",
      sourceRevision: "5",
      title: "Observed result",
      body: "Evidence",
      observedAt: new Date().toISOString(),
      truncated: false,
    };
    const first = l.captureObservation("capture", captured).value;
    assert.equal(l.snapshot().tasks.length, 0);
    assert.equal(l.observationCandidates("pending").length, 1);
    const admitted = l.admitObservation("admit", {
      candidateId: first.candidateId,
      action: "create",
    }).value;
    assert.equal(l.snapshot().runs.length, 0);
    assert.equal(l.getTask(admitted.taskId).kind, "observed");
    assert.equal(
      l.captureObservation("duplicate", captured).value.state,
      "admitted",
    );
    const next = l.captureObservation("another", {
      ...captured,
      sourceRevision: "6",
      sessionId: "different",
    }).value;
    l.admitObservation("attach", {
      candidateId: next.candidateId,
      action: "attach",
      taskId: admitted.taskId,
    });
    assert.equal(l.history(admitted.taskId).reports.length, 2);
  } finally {
    l.close();
  }
});
