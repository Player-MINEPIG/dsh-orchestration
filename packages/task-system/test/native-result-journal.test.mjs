import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { NativeResultJournal } from "../dist/native-result-journal.js";
import { TaskLedger } from "../dist/ledger.js";

const E = (code) => (error) => error.code === code;
const readyAt = Date.parse("2026-10-01T12:00:01Z");
const journalModule = new URL(
  "../dist/native-result-journal.js",
  import.meta.url,
).href;
const ledgerModule = new URL("../dist/ledger.js", import.meta.url).href;
function ready(n = 1, extra = {}) {
  const ref = {
    runId: `run-${n}`,
    attemptId: `attempt-${n}`,
    nodeId: "local",
    fence: 1,
    executionId: `execution-${n}`,
  };
  return {
    commandId: `terminal-${n}`,
    ref,
    sessionId: `session-${n}`,
    readyAt,
    settlement: {
      ...ref,
      outcome: "success",
      summary: "Finished after native agent disposal and session flush",
      report: {
        title: "Result",
        body: "Exact terminal result",
        data: { b: 2, a: 1 },
      },
    },
    quiescent: true,
    sessionPersisted: true,
    ...extra,
  };
}
function receipt(input) {
  return {
    commandId: input.commandId,
    acceptedAt: new Date(readyAt + 100).toISOString(),
    value: { runId: input.ref.runId, state: "succeeded" },
  };
}
function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-native-journal-"));
  const path = join(dir, "private", "results.sqlite");
  let journal = NativeResultJournal.open(path, options);
  return {
    dir,
    path,
    get journal() {
      return journal;
    },
    reopen() {
      journal.close();
      journal = NativeResultJournal.open(path, options);
    },
    close() {
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function prepareAuthority(path) {
  const ledger = TaskLedger.open(path, { now: () => readyAt });
  ledger.registerNode("node", {
    nodeId: "local",
    roles: ["executor"],
    capabilities: ["text"],
    models: [
      { provider: "fixture", model: "fixture", reasoningEfforts: ["low"] },
    ],
    workspaceIds: [],
    enabled: true,
    lastSeenAt: new Date(readyAt).toISOString(),
  });
  const task = ledger.createTask("task", {
    title: "Durable terminal result",
  }).value;
  const run = ledger.createRun("run", {
    taskId: task.taskId,
    route: {
      nodeId: "local",
      provider: "fixture",
      model: "fixture",
      reasoningEffort: "low",
      requiredCapabilities: ["text"],
    },
  }).value;
  const claim = ledger.claim("claim", {
    runId: run.runId,
    nodeId: "local",
    ttlMs: 60000,
  }).value;
  const ref = {
    runId: run.runId,
    attemptId: claim.attempt.attemptId,
    nodeId: "local",
    fence: claim.attempt.fence,
    executionId: "execution-real",
  };
  ledger.markRunning("running", ref);
  ledger.bindSession("bind", { ...ref, sessionId: "session-real" });
  const input = ready(1, {
    ref,
    sessionId: "session-real",
    settlement: {
      ...ref,
      outcome: "success",
      summary: "Exact completed result",
      report: { title: "Exact result", body: "Persist this only once" },
    },
  });
  ledger.close();
  return { input, taskId: task.taskId };
}
function crashScript(code, args) {
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code, ...args],
    {
      encoding: "utf8",
      timeout: 15000,
    },
  );
  assert.equal(child.status, 73, child.stderr || child.error?.message);
}

test("ready receipts are canonical, immutable and idempotent across reopen", () => {
  const f = fixture();
  try {
    const input = ready();
    const first = f.journal.ready(input);
    assert.match(first.digest, /^[a-f0-9]{64}$/);
    assert.equal(first.state, "ready");
    const reordered = structuredClone(input);
    reordered.settlement.report.data = { a: 1, b: 2 };
    reordered.settlement.notifications = undefined;
    assert.deepEqual(f.journal.ready(reordered), first);
    input.settlement.report.body = "Caller mutation is not persisted";
    first.settlement.report.body = "Returned object mutation is not persisted";
    f.reopen();
    assert.equal(
      f.journal.pending()[0].settlement.report.body,
      "Exact terminal result",
    );
    assert.throws(() => f.journal.ready(input), E("CONFLICT"));
    assert.throws(
      () => f.journal.ready({ ...ready(), commandId: "other-command" }),
      E("CONFLICT"),
    );
    assert.throws(
      () => f.journal.ready({ ...ready(), sessionId: "other-session" }),
      E("CONFLICT"),
    );
    assert.equal(f.journal.pending().length, 1);
  } finally {
    f.close();
  }
});

test("staged, unflushed and mismatched terminal values never become replayable", () => {
  const f = fixture();
  try {
    for (const extra of [
      { quiescent: false },
      { quiescent: undefined },
      { sessionPersisted: false },
      { sessionPersisted: undefined },
    ])
      assert.throws(() => f.journal.ready(ready(1, extra)), E("NOT_READY"));
    const missingExecution = ready();
    delete missingExecution.ref.executionId;
    assert.throws(() => f.journal.ready(missingExecution), E("INVALID"));
    const mismatched = ready();
    mismatched.settlement.executionId = "different-execution";
    assert.throws(() => f.journal.ready(mismatched), E("INVALID"));
    assert.throws(
      () => f.journal.ready(ready(1, { accessToken: "unexpected-field" })),
      E("INVALID"),
    );
    f.reopen();
    assert.deepEqual(f.journal.pending(), []);
  } finally {
    f.close();
  }
});

test("held results remain retryable and terminal transitions survive restart", () => {
  const f = fixture();
  try {
    const input = ready();
    f.journal.ready(input);
    const held = f.journal.hold(input.commandId, "SQLITE_BUSY");
    assert.equal(held.state, "held");
    assert.deepEqual(f.journal.hold(input.commandId, "SQLITE_BUSY"), held);
    f.reopen();
    assert.deepEqual(f.journal.pending(), [held]);
    const committed = f.journal.markCommitted(input.commandId, receipt(input));
    assert.equal(committed.state, "committed");
    assert.equal(committed.reasonCode, undefined);
    assert.deepEqual(committed.receipt, receipt(input));
    f.reopen();
    assert.deepEqual(f.journal.pending(), []);
    assert.deepEqual(
      f.journal.markCommitted(input.commandId, receipt(input)),
      committed,
    );
    assert.deepEqual(f.journal.ready(input), committed);
    assert.throws(
      () => f.journal.reject(input.commandId, "STALE_LEASE"),
      E("CONFLICT"),
    );
    assert.throws(
      () =>
        f.journal.markCommitted(input.commandId, {
          ...receipt(input),
          acceptedAt: new Date(readyAt).toISOString(),
        }),
      E("CONFLICT"),
    );
    f.journal.ready(ready(2));
    f.journal.hold("terminal-2", "SQLITE_BUSY");
    const rejected = f.journal.reject("terminal-2", "CANCELLED");
    f.reopen();
    assert.deepEqual(f.journal.get("terminal-2"), rejected);
    assert.deepEqual(f.journal.reject("terminal-2", "CANCELLED"), rejected);
    assert.deepEqual(f.journal.pending(), []);
    assert.throws(
      () => f.journal.markCommitted("terminal-2", receipt(ready(2))),
      E("CONFLICT"),
    );
  } finally {
    f.close();
  }
});

test("journal stores sanitized codes and verifies authoritative receipt identity", () => {
  const f = fixture();
  try {
    const input = ready();
    f.journal.ready(input);
    assert.throws(
      () =>
        f.journal.hold(input.commandId, "error at /private/credential.json"),
      E("INVALID"),
    );
    assert.throws(
      () =>
        f.journal.markCommitted(input.commandId, {
          ...receipt(input),
          commandId: "wrong-command",
        }),
      E("INVALID"),
    );
    assert.throws(
      () =>
        f.journal.markCommitted(input.commandId, {
          ...receipt(input),
          value: { runId: "wrong-run" },
        }),
      E("INVALID"),
    );
    assert.equal(f.journal.get(input.commandId).state, "ready");
    assert.throws(() => f.journal.hold("missing", "BUSY"), E("NOT_FOUND"));
  } finally {
    f.close();
  }
});

test("retained entry and byte limits fail closed without eviction", () => {
  const entries = fixture({ maxEntries: 1 });
  try {
    entries.journal.ready(ready());
    entries.journal.markCommitted("terminal-1", receipt(ready()));
    assert.throws(() => entries.journal.ready(ready(2)), E("FULL"));
    assert.equal(entries.journal.get("terminal-1").state, "committed");
  } finally {
    entries.close();
  }
  const bytes = fixture({ maxBytes: 1024, maxEntryBytes: 1024 });
  try {
    const larger = ready();
    larger.settlement.report.body += "x".repeat(300);
    bytes.journal.ready(larger);
    assert.throws(() => bytes.journal.ready(ready(2)), E("FULL"));
    const hugeReceipt = receipt(ready());
    hugeReceipt.value.configuration = { data: "x".repeat(850) };
    assert.throws(
      () => bytes.journal.markCommitted("terminal-1", hugeReceipt),
      E("FULL"),
    );
    bytes.reopen();
    assert.equal(bytes.journal.pending().length, 1);
    assert.equal(bytes.journal.pending()[0].state, "ready");
  } finally {
    bytes.close();
  }
});

test("UTF-8 payloads, recursion, non-JSON values and getters are bounded", () => {
  const f = fixture({ maxBytes: 8192, maxEntryBytes: 1024 });
  try {
    const unicode = ready();
    unicode.settlement.report.body = "\u{1F512}".repeat(300);
    assert.throws(() => f.journal.ready(unicode), E("TOO_LARGE"));
    const cycle = ready();
    cycle.settlement.report.data = cycle;
    assert.throws(() => f.journal.ready(cycle), E("INVALID"));
    for (const invalid of [
      NaN,
      Infinity,
      () => {},
      new Date(),
      BigInt(1),
      [undefined],
    ]) {
      const input = ready();
      input.settlement.report.data = invalid;
      assert.throws(() => f.journal.ready(input), E("INVALID"));
    }
    const getter = ready();
    let read = false;
    Object.defineProperty(getter, "secret", {
      enumerable: true,
      get() {
        read = true;
        return "do-not-read";
      },
    });
    assert.throws(() => f.journal.ready(getter), E("INVALID"));
    assert.equal(read, false);
    let deep = {};
    for (let i = 0; i < 70; i++) deep = { a: deep };
    const nested = ready();
    nested.settlement.report.data = deep;
    assert.throws(() => f.journal.ready(nested), E("TOO_LARGE"));
    assert.deepEqual(f.journal.pending(), []);
  } finally {
    f.close();
  }
});

test("SQLite FULL/WAL journal uses private files and creates no log or credential files", () => {
  const f = fixture();
  try {
    f.journal.ready(ready());
    assert.equal(statSync(join(f.dir, "private")).mode & 0o777, 0o700);
    const files = readdirSync(join(f.dir, "private")).sort();
    assert.deepEqual(files, [
      "results.sqlite",
      "results.sqlite-shm",
      "results.sqlite-wal",
    ]);
    for (const file of files)
      assert.equal(statSync(join(f.dir, "private", file)).mode & 0o777, 0o600);
    // synchronous is connection-local, so inspect the writer, not a new reader.
    assert.equal(
      f.journal.db.prepare("PRAGMA synchronous").get().synchronous,
      2,
    );
    const observer = new DatabaseSync(f.path, { readOnly: true });
    try {
      assert.equal(
        observer.prepare("PRAGMA journal_mode").get().journal_mode,
        "wal",
      );
      assert.equal(
        observer.prepare("SELECT state FROM native_results").get().state,
        "ready",
      );
    } finally {
      observer.close();
    }
    assert.throws(() => NativeResultJournal.open(":memory:"), E("INVALID"));
    const link = join(f.dir, "symlink.sqlite");
    symlinkSync(f.path, link);
    assert.throws(() => NativeResultJournal.open(link), E("INVALID"));
  } finally {
    f.close();
  }
});

test("an exclusive authority write lock cannot prevent independent ready persistence", () => {
  const f = fixture();
  const authorityPath = join(f.dir, "authority.sqlite");
  const { input } = prepareAuthority(authorityPath);
  const locker = new DatabaseSync(authorityPath);
  const blocked = new DatabaseSync(authorityPath);
  try {
    locker.exec("BEGIN IMMEDIATE");
    assert.throws(
      () => blocked.exec("BEGIN IMMEDIATE"),
      (error) => /locked/.test(error.message),
    );
    f.journal.ready(input);
    f.reopen();
    assert.deepEqual(f.journal.pending()[0].settlement, input.settlement);
    locker.exec("ROLLBACK");
    const ledger = TaskLedger.open(authorityPath, { now: () => readyAt });
    try {
      const accepted = ledger.submit(input.commandId, input.settlement);
      f.journal.markCommitted(input.commandId, accepted);
      assert.equal(ledger.getRun(input.ref.runId).state, "succeeded");
    } finally {
      ledger.close();
    }
  } finally {
    try {
      locker.exec("ROLLBACK");
    } catch {}
    locker.close();
    blocked.close();
    f.close();
  }
});

test("process exit before ready creates no replayable staged result; after ready retains exact input", () => {
  const f = fixture();
  try {
    f.journal.close();
    for (const write of [false, true]) {
      crashScript(
        `
        import { NativeResultJournal } from ${JSON.stringify(journalModule)};
        const journal = NativeResultJournal.open(process.argv[1]);
        const pending = JSON.parse(process.argv[2]);
        if (${write}) journal.ready(pending);
        process.exit(73);
      `,
        [f.path, JSON.stringify(ready())],
      );
      f.reopen();
      assert.equal(f.journal.pending().length, write ? 1 : 0);
      if (write)
        assert.deepEqual(f.journal.pending()[0].settlement, ready().settlement);
      f.journal.close();
    }
  } finally {
    f.close();
  }
});

test("process exit after authority commit replays the exact receipt without duplicate report or effect", () => {
  const f = fixture();
  const authorityPath = join(f.dir, "authority.sqlite");
  const { input, taskId } = prepareAuthority(authorityPath);
  try {
    f.journal.close();
    crashScript(
      `
      import { NativeResultJournal } from ${JSON.stringify(journalModule)};
      import { TaskLedger } from ${JSON.stringify(ledgerModule)};
      const input = JSON.parse(process.argv[3]);
      const journal = NativeResultJournal.open(process.argv[1]);
      journal.ready(input);
      const ledger = TaskLedger.open(process.argv[2], { now: () => input.readyAt });
      ledger.submit(input.commandId, input.settlement);
      process.exit(73);
    `,
      [f.path, authorityPath, JSON.stringify(input)],
    );
    f.reopen();
    const stored = f.journal.pending()[0];
    assert.deepEqual(stored.settlement, input.settlement);
    const ledger = TaskLedger.open(authorityPath, {
      now: () => readyAt + 120000,
    });
    try {
      // Same original submit digest returns the already committed receipt even
      // after the old lease expires. No agent, provider or model is called.
      const accepted = ledger.submit(stored.commandId, stored.settlement);
      const recovered = ledger.recoverSettlement(stored.commandId, {
        ...stored.settlement,
        recovery: {
          readyAt: new Date(stored.readyAt).toISOString(),
          sessionId: stored.sessionId,
          quiescent: true,
          sessionPersisted: true,
        },
      });
      assert.deepEqual(recovered, accepted);
      f.journal.markCommitted(stored.commandId, recovered);
      assert.equal(ledger.history(taskId).reports.length, 1);
      assert.equal(
        ledger
          .history(taskId)
          .events.filter((event) => event.type === "run.settled").length,
        1,
      );
      assert.equal(ledger.getRun(stored.ref.runId).state, "succeeded");
      f.reopen();
      assert.deepEqual(f.journal.pending(), []);
      assert.deepEqual(f.journal.get(stored.commandId).receipt, accepted);
    } finally {
      ledger.close();
    }
  } finally {
    f.close();
  }
});

test("process exit after journal commit never schedules another recovery", () => {
  const f = fixture();
  try {
    f.journal.close();
    crashScript(
      `
      import { NativeResultJournal } from ${JSON.stringify(journalModule)};
      const input = JSON.parse(process.argv[2]);
      const journal = NativeResultJournal.open(process.argv[1]);
      journal.ready(input);
      journal.markCommitted(input.commandId, JSON.parse(process.argv[3]));
      process.exit(73);
    `,
      [f.path, JSON.stringify(ready()), JSON.stringify(receipt(ready()))],
    );
    f.reopen();
    assert.deepEqual(f.journal.pending(), []);
    assert.deepEqual(f.journal.get("terminal-1").receipt, receipt(ready()));
  } finally {
    f.close();
  }
});
