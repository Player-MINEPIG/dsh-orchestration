import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionModels } from "../dist/execution-models.js";
import { ExecutionModelInventory } from "../dist/executor-models.js";

const model = {
  provider: "installed",
  model: "three",
  reasoningEffort: "high",
  kind: "native-dsh",
  resume: true,
};
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  let now = 10000;
  const catalog = new ExecutionModels(db, { now: () => now });
  t.after(() => db.close());
  const request = (id = "request") =>
    catalog.request(id, { nodeId: "worker" }).catalog.request;
  const complete = (request, result, id = "complete") =>
    catalog.complete(id, {
      nodeId: "worker",
      requestId: request.requestId,
      generation: request.generation,
      result,
    });
  const success = (models = [model], complete = true) => ({
    state: "success",
    observedAt: now,
    complete,
    models,
  });
  return {
    catalog,
    request,
    complete,
    success,
    setNow: (value) => {
      now = value;
    },
  };
}

test("concurrent callers coalesce to one authority request and accept only its node and generation", (t) => {
  const f = fixture(t),
    first = f.request("settings"),
    second = f.request("tools");
  assert.equal(first.requestId, second.requestId);
  assert.equal(f.catalog.pending("worker").length, 1);
  assert.throws(
    () =>
      f.catalog.complete("wrong-node", {
        nodeId: "other",
        requestId: first.requestId,
        generation: first.generation,
        result: f.success(),
      }),
    { code: "EXECUTION_CATALOG_REQUEST_MISMATCH" },
  );
  assert.equal(f.catalog.view("worker").catalog.snapshot, undefined);
  const view = f.complete(first, f.success());
  assert.equal(view.catalog.state, "fresh");
  assert.deepEqual(view.catalog.snapshot.models, [model]);
});

test("partial and timeout preserve last good models and the configured default", (t) => {
  const f = fixture(t),
    first = f.request();
  const ready = f.complete(first, f.success());
  f.catalog.setDefault("default", {
    nodeId: "worker",
    expectedRevision: 0,
    expectedCatalogRevision: ready.catalog.snapshot.revision,
    choice: model,
  });
  const partial = f.request("partial");
  f.complete(partial, f.success([], false), "partial-result");
  assert.equal(f.catalog.view("worker").catalog.state, "stale");
  assert.deepEqual(f.catalog.view("worker").catalog.snapshot.models, [model]);
  const failure = f.request("failure");
  f.complete(failure, { state: "failure", code: "TIMEOUT" }, "failure-result");
  const view = f.catalog.view("worker");
  assert.equal(view.catalog.state, "stale");
  assert.deepEqual(view.policy.choice, model);
  assert.deepEqual(view.catalog.snapshot.models, [model]);
});

test("pagination publishes atomically and exact replay cannot roll back a newer snapshot", (t) => {
  const f = fixture(t),
    request = f.request();
  const page = (index, models, id) =>
    f.catalog.complete(id, {
      nodeId: "worker",
      requestId: request.requestId,
      generation: request.generation,
      page: { index, total: 2 },
      result: f.success(models),
    });
  const first = page(0, [model], "page-0");
  assert.equal(first.catalog.snapshot, undefined);
  assert.equal(first.catalog.state, "pending");
  const second = page(1, [{ ...model, model: "four" }], "page-1");
  assert.equal(second.catalog.snapshot.models.length, 2);
  const newer = f.request("newer");
  f.complete(newer, f.success([{ ...model, model: "newer" }]), "newer-result");
  page(1, [{ ...model, model: "four" }], "page-1");
  assert.equal(
    f.catalog.view("worker").catalog.snapshot.models[0].model,
    "newer",
  );
});

test("default changes require the same complete fresh snapshot and compare policy revisions", (t) => {
  const f = fixture(t),
    request = f.request(),
    view = f.complete(request, f.success());
  assert.throws(
    () =>
      f.catalog.setDefault("bad", {
        nodeId: "worker",
        expectedRevision: 0,
        expectedCatalogRevision: "different",
        choice: model,
      }),
    { code: "EXECUTION_CATALOG_STALE" },
  );
  const saved = f.catalog.setDefault("good", {
    nodeId: "worker",
    expectedRevision: 0,
    expectedCatalogRevision: view.catalog.snapshot.revision,
    choice: {
      provider: model.provider,
      model: model.model,
      reasoningEffort: model.reasoningEffort,
      resume: false,
    },
  });
  assert.equal(saved.policy.revision, 1);
  assert.equal(
    saved.policy.choice.resume,
    true,
    "metadata comes from catalog, not UI arguments",
  );
  assert.throws(
    () =>
      f.catalog.setDefault("conflict", {
        nodeId: "worker",
        expectedRevision: 0,
        choice: null,
      }),
    { code: "EXECUTION_MODEL_POLICY_CONFLICT" },
  );
  f.setNow(80000);
  assert.equal(f.catalog.view("worker").catalog.state, "stale");
  assert.deepEqual(f.catalog.view("worker").policy.choice, model);
});

test("read-only legacy ledgers without catalog tables open and remain resource-free", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-model-readonly-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "legacy.sqlite");
  const writer = new DatabaseSync(file);
  writer.exec("CREATE TABLE old_data(id TEXT)");
  writer.close();
  const db = new DatabaseSync(file, { readOnly: true });
  t.after(() => db.close());
  const catalog = new ExecutionModels(db, { readOnly: true });
  assert.equal(catalog.view("worker").catalog.state, "unavailable");
  assert.deepEqual(catalog.pending("worker"), []);
  assert.throws(() => catalog.request("forbidden", { nodeId: "worker" }), {
    code: "EXECUTION_MODELS_READ_ONLY",
  });
  assert.equal(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='execution_model_nodes'",
      )
      .get(),
    undefined,
  );
});

test("on-demand inventory lists every installed model, with no historical two-model mask", async () => {
  let calls = 0;
  const llm = {
    listProviders: () => [{ id: "installed" }],
    listModels: async () => {
      calls++;
      return ["one", "two", "three", "four"].map((id) => ({ id }));
    },
    resolveModelInfo: async () => ({
      reasoning: { efforts: [{ id: "high" }] },
    }),
  };
  const inventory = new ExecutionModelInventory({
    llm: () => llm,
    nativeReady: () => true,
    officialBackends: () => [],
    officialAvailable: () => false,
    temporaryWorkspaceReady: () => false,
  });
  assert.equal(calls, 0);
  const [first, second] = await Promise.all([
    inventory.collect(),
    inventory.collect(),
  ]);
  assert.equal(calls, 1);
  assert.equal(first.complete, true);
  assert.equal(first.models.length, 8);
  assert.deepEqual(first, second);
  assert.equal(first.temporaryWorkspaceReady, false);
});

test("a timed out adapter does not spawn another hanging catalog query", async () => {
  let calls = 0;
  const llm = {
    listProviders: () => [{ id: "installed" }],
    listModels: () => {
      calls++;
      return new Promise(() => {});
    },
  };
  const inventory = new ExecutionModelInventory({
    llm: () => llm,
    nativeReady: () => true,
    officialBackends: () => [],
    officialAvailable: () => false,
    timeoutMs: 10,
  });
  assert.equal((await inventory.collect()).complete, false);
  assert.equal((await inventory.collect()).complete, false);
  assert.equal(calls, 1);
});

test("refresh after partial keeps failure and exposes fresh positive evidence without restoring absence proof", (t) => {
  const f = fixture(t),
    first = f.request();
  f.complete(first, f.success());
  const partial = f.request("partial-again");
  const view = f.complete(
    partial,
    f.success([{ ...model, model: "flash" }], false),
    "partial-again-result",
  );
  assert.equal(view.catalog.state, "stale");
  assert.equal(view.catalog.positiveSnapshot.models[0].model, "flash");
  const pending = f.request("retry-partial");
  assert.equal(f.catalog.view("worker").catalog.state, "pending");
  assert.equal(f.catalog.view("worker").catalog.reason, "CATALOG_FAILED");
  f.complete(pending, { state: "failure", code: "TIMEOUT" }, "retry-timeout");
  assert.equal(f.catalog.view("worker").catalog.state, "stale");
  assert.equal(
    f.catalog.view("worker").catalog.snapshot.models[0].model,
    "three",
  );
});

test("interrupted catalog pagination retries immutable payload and resumes after acknowledged pages", async () => {
  const { ExecutorModelControl } = await import(
    "../dist/remote/model-control.js"
  );
  const request = {
    requestId: "f599b04d-3544-4b06-b9c0-e6c6e6925096",
    nodeId: "worker",
    generation: 1,
    createdAt: Date.now(),
    expiresAt: Date.now() + 30000,
  };
  let collections = 0;
  const sent = [];
  let interrupted = false;
  const control = new ExecutorModelControl({
    nodeId: "worker",
    client: { executorIdentity: async () => {}, dispose: async () => {} },
    remote: {
      executionModelRequests: async () => [request],
      completeExecutionModels: async (id, input) => {
        sent.push({ id, input: structuredClone(input) });
        if (input.page.index === 1 && !interrupted) {
          interrupted = true;
          throw new Error("lost acknowledgement");
        }
        return { value: { accepted: true } };
      },
    },
    inventory: {
      collect: async () => {
        collections++;
        return {
          state: "success",
          complete: true,
          observedAt: Date.now(),
          models: Array.from({ length: 70 }, (_, index) => ({
            ...model,
            model: `model-${index}`,
          })),
        };
      },
    },
  });
  await control.pollNow();
  await control.pollNow();
  await control.dispose();
  assert.equal(collections, 1);
  assert.deepEqual(
    sent.map((item) => item.input.page.index),
    [0, 1, 1, 2],
  );
  assert.deepEqual(sent[1], sent[2]);
});

test("expired refresh cannot make an older snapshot fresh while positive evidence retains its own TTL", (t) => {
  const f = fixture(t),
    first = f.request();
  f.complete(first, f.success());
  f.catalog.request("expires", { nodeId: "worker", ttlMs: 10000 });
  f.setNow(21000);
  const view = f.catalog.view("worker");
  assert.equal(view.catalog.state, "stale");
  assert.equal(view.catalog.reason, "TIMEOUT");
  assert.ok(view.catalog.positiveSnapshot.expiresAt > 21000);
});

test("partial catalog allows saving a positively confirmed default with its exact revision", (t) => {
  const f = fixture(t),
    request = f.request(),
    view = f.complete(request, f.success([model], false));
  assert.equal(view.catalog.state, "stale");
  const saved = f.catalog.setDefault("partial-default", {
    nodeId: "worker",
    expectedRevision: 0,
    expectedCatalogRevision: view.catalog.positiveSnapshot.revision,
    choice: model,
  });
  assert.deepEqual(saved.policy.choice, model);
  assert.throws(
    () =>
      f.catalog.setDefault("partial-absent", {
        nodeId: "worker",
        expectedRevision: 1,
        expectedCatalogRevision: view.catalog.positiveSnapshot.revision,
        choice: { ...model, model: "missing" },
      }),
    { code: "EXECUTION_MODEL_UNAVAILABLE" },
  );
});

test("catalog delivery survives control restart without rediscovering or changing admitted pages", async () => {
  const { ExecutorModelControl } = await import(
    "../dist/remote/model-control.js"
  );
  const { RecoveryStore } = await import("../dist/remote/store.js");
  const store = new RecoveryStore(":memory:");
  const request = {
    requestId: "36d43d3e-5aa5-45b1-8761-9aaf5585f629",
    nodeId: "worker",
    generation: 1,
    createdAt: Date.now(),
    expiresAt: Date.now() + 30000,
  };
  const sent = [];
  let fail = true,
    collections = 0;
  const options = {
    nodeId: "worker",
    store,
    client: { executorIdentity: async () => {}, dispose: async () => {} },
    remote: {
      executionModelRequests: async () => [request],
      completeExecutionModels: async (id, input) => {
        sent.push(structuredClone(input));
        if (input.page.index === 1 && fail)
          throw new Error("transport disconnected");
        return { value: { accepted: true } };
      },
    },
    inventory: {
      collect: async () => {
        collections++;
        return {
          state: "success",
          observedAt: Date.now(),
          complete: true,
          models: Array.from({ length: 40 }, (_, index) => ({
            ...model,
            model: `restart-${index}`,
          })),
        };
      },
    },
  };
  const first = new ExecutorModelControl(options);
  await first.pollNow();
  await first.dispose();
  fail = false;
  const second = new ExecutorModelControl(options);
  await second.pollNow();
  await second.dispose();
  store.close();
  assert.equal(collections, 1);
  assert.deepEqual(
    sent.map((input) => input.page.index),
    [0, 1, 1],
  );
  assert.deepEqual(sent[1], sent[2]);
});

test("a hung provider does not hide fresh healthy tuples or reopen its outstanding request", async () => {
  let hungCalls = 0,
    healthyCalls = 0;
  const llm = {
    listProviders: () => [{ id: "hung" }, { id: "deepseek-official" }],
    listModels: async (provider) => {
      if (provider === "hung") {
        hungCalls++;
        return new Promise(() => {});
      }
      healthyCalls++;
      return [{ id: "deepseek-flash" }];
    },
    resolveModelInfo: async () => ({
      reasoning: { efforts: [{ id: "high" }] },
    }),
  };
  const inventory = new ExecutionModelInventory({
    llm: () => llm,
    nativeReady: () => true,
    officialBackends: () => [],
    officialAvailable: () => false,
    timeoutMs: 40,
  });
  for (let index = 0; index < 2; index++) {
    const result = await inventory.collect();
    assert.equal(result.state, "success");
    assert.equal(result.complete, false);
    assert.ok(
      result.models.some(
        (choice) =>
          choice.provider === "deepseek-official" &&
          choice.model === "deepseek-flash" &&
          choice.reasoningEffort === "high",
      ),
    );
  }
  assert.equal(hungCalls, 1);
  assert.equal(healthyCalls, 2);
});

for (const clockOffset of [-12000, 120000]) {
  test(`two-page catalog uses authority freshness with executor clock offset ${clockOffset}`, (t) => {
    const f = fixture(t);
    f.setNow(20000);
    const request = f.request();
    const result = {
      ...f.success(),
      observedAt: request.createdAt + clockOffset,
    };
    f.catalog.complete("skew-0", {
      nodeId: "worker",
      requestId: request.requestId,
      generation: request.generation,
      page: { index: 0, total: 2 },
      result,
    });
    f.setNow(22000);
    const view = f.catalog.complete("skew-1", {
      nodeId: "worker",
      requestId: request.requestId,
      generation: request.generation,
      page: { index: 1, total: 2 },
      result: { ...result, models: [{ ...model, model: "four" }] },
    });
    assert.equal(view.catalog.state, "fresh");
    assert.equal(view.catalog.snapshot.receivedAt, 22000);
    assert.equal(view.catalog.snapshot.observedAt, result.observedAt);
    assert.equal(view.catalog.snapshot.models.length, 2);
    f.setNow(82000);
    assert.equal(f.catalog.view("worker").catalog.state, "stale");
  });
}

test("a rejected final page records failure durably and a new request can recover", (t) => {
  const f = fixture(t),
    request = f.request();
  const input = {
    nodeId: "worker",
    requestId: request.requestId,
    generation: request.generation,
    page: { index: 0, total: 2 },
    result: f.success(),
  };
  f.catalog.complete("reject-0", input);
  const rejected = f.catalog.complete("reject-1", {
    ...input,
    page: { index: 1, total: 2 },
  });
  assert.equal(rejected.catalog.state, "unavailable");
  assert.equal(rejected.catalog.reason, "CATALOG_FAILED");
  assert.equal(rejected.catalog.request, undefined);
  assert.equal(
    rejected.catalog.diagnostic.code,
    "EXECUTION_CATALOG_DUPLICATE_MODEL",
  );
  assert.equal(rejected.catalog.diagnostic.requestId, request.requestId);
  assert.equal(rejected.catalog.diagnostic.receivedPages, 1);
  assert.deepEqual(
    f.catalog.complete("reject-1", {
      ...input,
      page: { index: 1, total: 2 },
    }),
    rejected,
  );
  assert.deepEqual(
    f.catalog.view("worker").catalog.diagnostic,
    rejected.catalog.diagnostic,
  );
  const next = f.request("recover");
  assert.equal(next.generation, request.generation + 1);
  assert.equal(f.catalog.view("worker").catalog.reason, "CATALOG_FAILED");
  const recovered = f.complete(next, f.success(), "recovered");
  assert.equal(recovered.catalog.state, "fresh");
  assert.equal(recovered.catalog.diagnostic, undefined);
});

test("executor resumes authority-listed pages without comparing clocks", async () => {
  const { ExecutorModelControl } = await import(
    "../dist/remote/model-control.js"
  );
  const { RecoveryStore } = await import("../dist/remote/store.js");
  const store = new RecoveryStore(":memory:");
  const request = {
    requestId: "36d43d3e-5aa5-45b1-8761-9aaf5585f629",
    nodeId: "worker",
    generation: 1,
    createdAt: 10000,
    expiresAt: 40000,
  };
  let collections = 0,
    fail = true;
  const sent = [];
  const options = {
    nodeId: "worker",
    store,
    client: { executorIdentity: async () => {}, dispose: async () => {} },
    remote: {
      executionModelRequests: async () => [request],
      completeExecutionModels: async (id, input) => {
        sent.push({ id, input: structuredClone(input) });
        if (input.page.index === 1 && fail)
          throw new Error("lost acknowledgement");
        return { value: { accepted: true } };
      },
    },
    inventory: {
      collect: async () => {
        collections++;
        return {
          state: "success",
          observedAt: Date.now(),
          complete: true,
          models: Array.from({ length: 40 }, (_, i) => ({
            ...model,
            model: `clock-${i}`,
          })),
        };
      },
    },
  };
  const first = new ExecutorModelControl(options);
  await first.pollNow();
  await first.dispose();
  fail = false;
  const second = new ExecutorModelControl(options);
  await second.pollNow();
  await second.dispose();
  store.close();
  assert.equal(collections, 1);
  assert.deepEqual(
    sent.map((item) => item.input.page.index),
    [0, 1, 1],
  );
  assert.deepEqual(sent[1], sent[2]);
});

for (const [name, change, code] of [
  [
    "first-page duplicate",
    (input) => {
      input.result.models.push(model);
    },
    "EXECUTION_CATALOG_DUPLICATE_MODEL",
  ],
  [
    "invalid page index",
    (input) => {
      input.page.index = 2;
    },
    "EXECUTION_CATALOG_PAGE_INVALID",
  ],
]) {
  test(`${name} is rejected before storing any page`, (t) => {
    const f = fixture(t),
      request = f.request();
    const input = {
      nodeId: "worker",
      requestId: request.requestId,
      generation: request.generation,
      page: { index: 0, total: 2 },
      result: f.success(),
    };
    change(input);
    const view = f.catalog.complete(name, input);
    assert.equal(view.catalog.diagnostic.code, code);
    assert.equal(view.catalog.diagnostic.receivedPages, 0);
    assert.equal(view.catalog.request, undefined);
    assert.deepEqual(f.catalog.pending("worker"), []);
  });
}

test("page metadata cannot splice different samples into a single request", (t) => {
  const f = fixture(t),
    request = f.request();
  const input = {
    nodeId: "worker",
    requestId: request.requestId,
    generation: request.generation,
    page: { index: 0, total: 2 },
    result: f.success(),
  };
  f.catalog.complete("sample-0", input);
  const view = f.catalog.complete("sample-1", {
    ...input,
    page: { index: 1, total: 2 },
    result: {
      ...f.success([{ ...model, model: "different" }]),
      observedAt: 20000,
    },
  });
  assert.equal(view.catalog.diagnostic.code, "EXECUTION_CATALOG_PAGE_CONFLICT");
  assert.equal(view.catalog.diagnostic.receivedPages, 1);
  assert.equal(view.catalog.snapshot, undefined);
});

test("aggregate page limit is enforced before storing an oversized intermediate page", (t) => {
  const f = fixture(t),
    request = f.request();
  const input = {
    nodeId: "worker",
    requestId: request.requestId,
    generation: request.generation,
    page: { index: 0, total: 3 },
    result: f.success(
      Array.from({ length: 2048 }, (_, index) => ({
        ...model,
        model: `limit-${index}`,
      })),
    ),
  };
  f.catalog.complete("limit-0", input);
  const view = f.catalog.complete("limit-1", {
    ...input,
    page: { index: 1, total: 3 },
    result: f.success(),
  });
  assert.equal(view.catalog.diagnostic.code, "EXECUTION_CATALOG_LIMIT");
  assert.equal(view.catalog.diagnostic.receivedPages, 1);
  assert.equal(view.catalog.snapshot, undefined);
});

test("expired authority request preserves page diagnostics across database reopen and rejects late completion", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-timeout-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "catalog.sqlite");
  let now = 10000;
  let db = new DatabaseSync(file),
    catalog = new ExecutionModels(db, { now: () => now });
  const request = catalog.request("timeout-request", {
    nodeId: "worker",
    ttlMs: 10000,
  }).catalog.request;
  const input = {
    nodeId: "worker",
    requestId: request.requestId,
    generation: request.generation,
    page: { index: 0, total: 2 },
    result: {
      state: "success",
      observedAt: 0,
      complete: true,
      models: [model],
    },
  };
  catalog.complete("timeout-0", input);
  db.close();
  now = 20000;
  db = new DatabaseSync(file);
  t.after(() => db.close());
  catalog = new ExecutionModels(db, { now: () => now });
  const timeout = catalog.view("worker");
  assert.equal(timeout.catalog.state, "unavailable");
  assert.equal(timeout.catalog.reason, "TIMEOUT");
  assert.equal(timeout.catalog.diagnostic.receivedPages, 1);
  assert.equal(timeout.catalog.diagnostic.totalPages, 2);
  assert.equal(timeout.catalog.diagnostic.at, 20000);
  const late = catalog.complete("timeout-1", {
    ...input,
    page: { index: 1, total: 2 },
    result: { ...input.result, models: [{ ...model, model: "late" }] },
  });
  assert.equal(
    late.catalog.diagnostic.code,
    "EXECUTION_CATALOG_REQUEST_EXPIRED",
  );
  assert.equal(late.catalog.snapshot, undefined);
  assert.deepEqual(
    catalog.view("worker").catalog.diagnostic,
    late.catalog.diagnostic,
  );
  assert.equal(
    catalog.request("timeout-retry", { nodeId: "worker" }).catalog.request
      .generation,
    2,
  );
});

test("a durable rejection is not resent by a restarted control until the authority issues another request", async () => {
  const { ExecutorModelControl } = await import(
    "../dist/remote/model-control.js"
  );
  const { RecoveryStore } = await import("../dist/remote/store.js");
  const store = new RecoveryStore(":memory:");
  const request = {
    requestId: "36d43d3e-5aa5-45b1-8761-9aaf5585f629",
    nodeId: "worker",
    generation: 1,
    createdAt: Date.now(),
    expiresAt: Date.now() + 30000,
  };
  let sent = 0,
    collections = 0;
  const options = {
    nodeId: "worker",
    store,
    client: { executorIdentity: async () => {}, dispose: async () => {} },
    remote: {
      executionModelRequests: async () => [request],
      completeExecutionModels: async () => {
        sent++;
        return {
          value: {
            accepted: false,
            catalogError: { code: "EXECUTION_CATALOG_DUPLICATE_MODEL" },
          },
        };
      },
    },
    inventory: {
      collect: async () => {
        collections++;
        return {
          state: "success",
          observedAt: Date.now(),
          complete: true,
          models: [model],
        };
      },
    },
  };
  const first = new ExecutorModelControl(options);
  await first.pollNow();
  await first.dispose();
  assert.equal(store.catalogDelivery("worker").error.kind, "rejected");
  const second = new ExecutorModelControl(options);
  await second.pollNow();
  await second.dispose();
  store.close();
  assert.equal(sent, 1);
  assert.equal(collections, 1);
});
