import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { Config, LIVE_SETTING_KEYS } from "../dist/dsh-plugin.js";
import { settingsDescriptor, hasTaskConfigOverride } from "../dist/settings.js";
import { RemoteExecutionService } from "../dist/remote/index.js";

function client(primitives = {}, react = {}) {
  let module;
  vm.runInNewContext(
    readFileSync(
      new URL("../dist/settings-client.js", import.meta.url),
      "utf8",
    ),
    {
      window: {
        __ModuleLoader__: {
          load(row) {
            assert.equal(row.id, "@dsh-task/task-system");
            module = row.factory((name) =>
              name === "react"
                ? {
                    createElement: (type, props, ...children) => ({
                      type,
                      props,
                      children,
                    }),
                    ...react,
                  }
                : primitives,
            );
          },
        },
      },
    },
  );
  return module;
}

test("only operation-boundary settings are volatile; boot identity and permission fields remain ordinary", () => {
  const actual = Object.entries(Config.dict)
    .filter(([, s]) => s.meta.volatile)
    .map(([k]) => k);
  assert.deepEqual(actual.sort(), [...LIVE_SETTING_KEYS].sort());
  for (const key of [
    "databasePath",
    "nodeId",
    "role",
    "leaseTtlMs",
    "executionTools",
    "trustedUnconfinedTools",
    "workspaceRoots",
    "safeRetry",
    "requireConfirmation",
    "remoteNodes",
  ])
    assert.equal(!!Config.dict[key].meta.volatile, false, key);
  assert.equal(Config({}).autoExecute.get(), false);
});

test("browser numeric and boolean schemas reject invalid drafts, retain resets and match host limits", () => {
  const ui = client();
  assert.deepEqual([...ui.keys].sort(), [...LIVE_SETTING_KEYS].sort());
  for (const field of ["schedulerEnabled", "autoExecute", "healthAlerts"]) {
    assert.equal(ui.fieldSpec(field).parse("true").value, true);
    assert.equal(ui.fieldSpec(field).parse("false").value, false);
    assert.equal(ui.fieldSpec(field).parse("yes"), undefined);
  }
  for (const field of [
    "maxConcurrent",
    "executionTimeoutMs",
    "localHeartbeatIntervalMs",
  ]) {
    const spec = ui.fieldSpec(field),
      schema = Config.dict[field];
    assert.equal(spec.parse("").kind, "clear");
    assert.equal(spec.parse("NaN"), undefined);
    assert.equal(spec.parse("1.5"), undefined);
    assert.equal(spec.parse(String(schema.meta.min - 1)), undefined);
    assert.equal(spec.parse(String(schema.meta.max + 1)), undefined);
    assert.equal(spec.parse(String(schema.meta.min)).value, schema.meta.min);
    assert.equal(spec.parse(String(schema.meta.max)).value, schema.meta.max);
  }
});

test("both dictionaries state local-vs-remote and restart/override boundaries without offering credential edits", () => {
  const ui = client();
  assert.deepEqual(Object.keys(ui.en).sort(), Object.keys(ui.zh).sort());
  assert.match(ui.en.safety, /does not pause remote claims/);
  assert.match(ui.zh.safety, /不会暂停远程领取/);
  assert.match(ui.en.remoteHint, /no remote-pause switch/);
  assert.match(ui.en.overlayWarning, /entire task-system config/);
  for (const key of ui.keys)
    for (const locale of [ui.en, ui.zh])
      assert.ok(locale[key] && locale[key + "Hint"]);
});

test("read-only wire descriptor exposes one no-argument method and no mutation surface", () => {
  const ui = client();
  for (const field of ["id", "service", "namespace", "method"])
    assert.equal(ui.descriptor[field], settingsDescriptor[field]);
  assert.equal(settingsDescriptor.method, "describe");
  assert.equal(settingsDescriptor.parameters.length, 0);
  const schema = settingsDescriptor.result.create();
  const snapshot = schema.parse({
    schedulerId: "scheduler-fixture",
    defaultWorkspaceId: null,
    sessionDecisionEnabled: false,
    nodeId: "test",
    role: "executor",
    databasePath: "/tmp/tasks.sqlite",
    profilePatch: "/tmp/profile.patch.yml",
    homePatch: null,
    commandLineConfigOverride: false,
    keepAlive: false,
    maintenanceIntervalMs: 1000,
    leaseTtlMs: 60000,
    executionTools: [],
    remote: null,
    password: "must-not-cross",
  });
  assert.equal(snapshot.password, undefined);
});

test("remote read-only projection strips URL user info, query and fragment, and never includes signing material", () => {
  const snapshot = RemoteExecutionService.prototype.settingsSnapshot.call({
    active: true,
    nativeWorker: {},
    config: {
      role: "executor",
      nodeId: "test",
      pollIntervalMs: 5000,
      concurrency: 1,
      authMode: "ed25519",
      coordinator: {
        endpoint:
          "https://user:secret@fixture.invalid/commands?token=secret#secret",
        privateKeyEnv: "SECRET_ENV",
        keyId: "SECRET_KEY",
      },
    },
  });
  assert.equal(snapshot.endpoint, "https://fixture.invalid/commands");
  assert.equal(snapshot.polling, true);
  assert.ok(!JSON.stringify(snapshot).includes("secret"));
  assert.ok(!JSON.stringify(snapshot).includes("SECRET"));
  assert.equal(
    RemoteExecutionService.prototype.settingsSnapshot.call({
      active: true,
      config: {
        role: "executor",
        nodeId: "test",
        pollIntervalMs: 5000,
        concurrency: 1,
      },
    }).polling,
    false,
  );
});

test("browser companion exposes the same served form in Settings and its installed plugin row", async () => {
  class Model {
    constructor() {}
    bind(project) {
      return { getSnapshot: project };
    }
    shell() {
      return {};
    }
    field() {
      return {};
    }
    actions() {
      return {};
    }
    dispose() {}
  }
  const ui = client({ SettingsFormModel: Model }),
    registrations = [],
    disposed = [];
  const effects = [];
  const ctx = {
    locale: { bind: () => (k) => k, register: () => () => {} },
    configForms: {
      get: (id) => (assert.equal(id, "task-system"), {}),
      whileServed: (ids, register) => (
        assert.deepEqual([...ids], ["task-system"]),
        register()
      ),
    },
    remote: {
      $mount: async (contribution) => (
        assert.equal(contribution.descriptors.length, 2),
        () => {}
      ),
    },
    get(name) {
      assert.equal(name, "remote.taskPluginSettings");
      return {
        describe: async () => ({
          ok: true,
          value: {
            nodeId: "fixture",
            databasePath: "/tmp/fixture.sqlite",
            role: "executor",
          },
        }),
      };
    },
    slots: {
      inject: (name, callback) => callback(),
      register: (options, component) => (
        registrations.push({ options, component }),
        () => disposed.push(true)
      ),
    },
    effect(callback) {
      const cleanup = callback();
      effects.push(cleanup);
    },
  };
  await ui.apply(ctx);
  assert.equal(registrations.length, 2);
  const section = registrations.find(
    (r) => r.options.name === "settings.section",
  );
  const row = registrations.find(
    (r) => r.options.name === "plugins.row.config",
  );
  assert.equal((await section.options.inject().read()).nodeId, "fixture");
  assert.equal(section.options.id, "task-system");
  assert.equal(section.options.label(), "title");
  assert.equal(row.options.key, "@dsh-task/task-system#task-system");
  assert.equal(section.component, row.component);
  assert.equal(
    section.options.inject().hooks.taskSettings,
    row.options.inject().hooks.taskSettings,
  );
  for (const cleanup of effects.splice(0).reverse()) cleanup?.();
  assert.equal(disposed.length, 2);
  registrations.length = 0;
  ctx.configForms.whileServed = () => () => {};
  await ui.apply(ctx);
  assert.equal(
    registrations.length,
    0,
    "hide both entries while the Host does not serve task-system settings",
  );
  for (const cleanup of effects.splice(0).reverse()) cleanup?.();
});

test("higher CLI insertion and whole-config override are detected without inspecting credentials", () => {
  assert.equal(
    hasTaskConfigOverride([{ id: "task-system", config: {} }]),
    true,
  );
  assert.equal(
    hasTaskConfigOverride([
      { insert: [{ id: "task-system", config: { role: "executor" } }] },
    ]),
    true,
  );
  assert.equal(
    hasTaskConfigOverride([{ id: "task-remote-execution", config: {} }]),
    false,
  );
  assert.equal(
    hasTaskConfigOverride([{ id: "task-system", disabled: false }]),
    false,
  );
});

test("read-only client consumes the official RemoteResult without inventing a successful or empty snapshot", async () => {
  const ui = client(),
    codec = ui.descriptor.result.create();
  const snapshot = {
    nodeId: "fixture",
    databasePath: "/tmp/fixture.sqlite",
    role: "executor",
  };
  let result = { ok: true, value: snapshot };
  const ctx = { get: () => ({ describe: async () => result }) };
  assert.equal((await ui.readRemote(ctx, "describe", codec)).nodeId, "fixture");
  result = {
    ok: false,
    error: { code: "gateway/internal", message: "fixture failure" },
  };
  await assert.rejects(
    ui.readRemote(ctx, "describe", codec),
    (error) => error === result.error,
  );
  result = snapshot;
  await assert.rejects(
    ui.readRemote(ctx, "describe", codec),
    (error) => error.code === "client/invalid-result",
  );
  await assert.rejects(
    ui.readRemote({ get: () => undefined }, "describe", codec),
    (error) => error.code === "client/service-unavailable",
  );
  result = { ok: true, value: {} };
  await assert.rejects(
    ui.readRemote(ctx, "describe", codec),
    /Invalid task settings snapshot/,
  );
});

test("local queue uses a separate no-argument read and rejects malformed queue snapshots", async () => {
  const ui = client();
  assert.equal(ui.queueDescriptor.namespace, "taskPluginSettings");
  assert.equal(ui.queueDescriptor.method, "queue");
  assert.equal(ui.queueDescriptor.parameters.length, 0);
  const value = {
    sampledAt: "2026-10-05T00:00:00.000Z",
    nodeId: "fixture",
    items: [
      {
        taskId: "task-fixture",
        runId: "run-fixture",
        title: "Fixture task",
        state: "queued",
        sessionId: null,
        workspaceId: "workspace-fixture",
      },
    ],
    truncated: false,
  };
  const methods = [];
  const ctx = {
    get: () => ({
      queue: async (...args) => {
        methods.push(args);
        return { ok: true, value };
      },
    }),
  };
  assert.equal(
    (await ui.readRemote(ctx, "queue", ui.queueDescriptor.result.create()))
      .items[0].runId,
    "run-fixture",
  );
  assert.equal(methods.length, 1);
  assert.equal(methods[0].length, 0);
  assert.throws(
    () =>
      ui.queueDescriptor.result
        .create()
        .parse({ ...value, items: [{ ...value.items[0], taskId: null }] }),
    /Invalid local task queue snapshot/,
  );
  assert.throws(
    () =>
      ui.queueDescriptor.result
        .create()
        .parse({ ...value, items: [{ ...value.items[0], sessionId: {} }] }),
    /Invalid local task queue snapshot/,
  );
});

test("queue failure remains visible, retains the last sample and ignores responses after unmount", async () => {
  let snapshot = { loading: true },
    cleanup;
  const ref = { current: 0 };
  const react = {
    useState: () => [
      snapshot,
      (value) => {
        snapshot = typeof value === "function" ? value(snapshot) : value;
      },
    ],
    useRef: () => ref,
    useCallback: (callback) => callback,
    useEffect: (callback) => {
      cleanup = callback();
    },
  };
  const ui = client({ Button: "FixtureButton" }, react);
  let settle;
  const readQueue = () =>
    new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
  ui.LocalQueue({ t: (key) => key, readQueue });
  await new Promise((resolve) => setImmediate(resolve));
  settle.reject({ code: "gateway/internal" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(snapshot.failed, true);
  assert.equal(snapshot.value, undefined);
  let rendered = ui.LocalQueue({ t: (key) => key, readQueue });
  assert.ok(
    rendered.children.some(
      (child) =>
        child?.props?.role === "alert" &&
        child.children.includes("queueFailed"),
    ),
  );
  const sample = {
    sampledAt: "fixture",
    nodeId: "fixture",
    items: [],
    truncated: false,
  };
  snapshot = { loading: false, value: sample };
  rendered = ui.LocalQueue({ t: (key) => key, readQueue });
  await new Promise((resolve) => setImmediate(resolve));
  settle.reject({ code: "gateway/internal" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(snapshot.value, sample);
  ui.LocalQueue({ t: (key) => key, readQueue });
  await new Promise((resolve) => setImmediate(resolve));
  cleanup();
  const before = snapshot;
  settle.resolve(sample);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(snapshot, before);
});
