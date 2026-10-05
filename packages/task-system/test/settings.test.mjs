import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { Config, LIVE_SETTING_KEYS } from "../dist/dsh-plugin.js";
import {
  settingsDescriptor,
  queueDescriptor,
  executorIdentityDescriptor,
  startupDescriptor,
  saveStartupDescriptor,
  hasTaskConfigOverride,
} from "../dist/settings.js";
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
  assert.match(ui.en.remoteHint, /separate pause control/);
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
        assert.equal(contribution.descriptors.length, 5),
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

test("queue and explicit identity-query descriptors match the frozen backend", () => {
  const ui = client();
  for (const [actual, expected] of [
    [ui.queueDescriptor, queueDescriptor],
    [ui.executorIdentityDescriptor, executorIdentityDescriptor],
    [ui.startupDescriptor, startupDescriptor],
  ]) {
    for (const key of ["id", "namespace", "service", "method"])
      assert.equal(actual[key], expected[key]);
    assert.equal(actual.result.typeSymbol, expected.result.typeSymbol);
    assert.equal(actual.parameters.length, 0);
  }
});

test("executor identity is queried only by its explicit button, with no polling or grant mutation", async () => {
  let state = { loading: false },
    action;
  const react = {
    useState: () => [
      state,
      (value) => {
        state = typeof value === "function" ? value(state) : value;
      },
    ],
    useRef: () => ({ current: 0 }),
    useCallback: (callback) => callback,
    useEffect: (callback) => {
      callback();
    },
  };
  const ui = client({ Button: "FixtureButton" }, react);
  let calls = 0;
  const props = {
    t: (key) => key,
    fields: () => ({}),
    remote: {
      endpoint: "https://fixture.invalid/commands",
      executorIdentity: null,
    },
    queryIdentity: async () => {
      calls++;
      return {
        schedulerId: "fixture-scheduler",
        executorId: "fixture-executor",
        nodeId: "fixture-node",
      };
    },
  };
  const rendered = ui.ExecutorIdentity(props);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
  action = rendered.children.find((child) => child?.type === "FixtureButton")
    .props.onClick;
  action();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(state.value.executorId, "fixture-executor");
  const unconfigured = ui.ExecutorIdentity({ ...props, remote: null });
  assert.equal(
    unconfigured.children.find((child) => child?.type === "FixtureButton").props
      .disabled,
    true,
  );
  const paused = ui.ExecutorIdentity({
    ...props,
    remote: { ...props.remote, paused: true },
  });
  const pausedButton = paused.children.find(
    (child) => child?.type === "FixtureButton",
  );
  assert.equal(pausedButton.props.disabled, true);
  assert.equal(pausedButton.props.onClick, undefined);
  assert.equal(calls, 1);
  assert.ok(
    paused.children.some((child) => child?.children?.includes("identityNone")),
  );
});

test("startup drafts contain only approved fields; unchanged values and reset do not create writes", () => {
  const ui = client();
  const values = {
    role: "executor",
    defaultWorkspaceId: "fixture-workspace",
    sessionDecisionEnabled: false,
    nodeId: "must-not-edit",
    credentials: "must-not-copy",
  };
  const draft = ui.startupDraft("task", values);
  assert.deepEqual(Object.keys(draft).sort(), [
    "defaultWorkspaceId",
    "role",
    "sessionDecisionEnabled",
  ]);
  assert.equal(ui.startupChanges("task", values, draft).dirty, false);
  draft.defaultWorkspaceId = "";
  draft.sessionDecisionEnabled = true;
  draft.role = "both";
  const changes = ui.startupChanges("task", values, draft).changes;
  assert.equal(changes.defaultWorkspaceId, null);
  assert.equal(changes.sessionDecisionEnabled, true);
  assert.equal(changes.role, "both");
  assert.equal(changes.nodeId, undefined);
  assert.equal(changes.credentials, undefined);
});

test("connection draft validates limits and excludes identity, auth and grant changes; Task migration is explicit", () => {
  const ui = client();
  const values = {
    role: "executor",
    paused: false,
    endpoint: "http://fixture.invalid:8443/commands",
    audience: "fixture-audience",
    pollIntervalMs: 0,
    concurrency: 1,
    taskSessionsEnabled: false,
    trustedNetworkTarget: {
      address: "fixture.invalid",
      port: 8443,
      localAddress: "fixture.local",
      allowHttp: true,
    },
    nodeId: "must-not-edit",
    authMode: "must-not-edit",
    grants: [],
  };
  const draft = ui.startupDraft("remote", values);
  assert.equal(ui.startupChanges("remote", values, draft).dirty, false);
  assert.equal(
    ui.startupChanges("remote", values, draft).changes.taskSessionsEnabled,
    undefined,
  );
  assert.equal(
    ui.startupChanges("remote", values, draft, true).changes
      .taskSessionsEnabled,
    true,
  );
  for (const invalid of ["", "1.5", "-1", "32"]) {
    assert.ok(
      ui
        .startupChanges("remote", values, { ...draft, concurrency: invalid })
        .invalid.includes("concurrency"),
    );
  }
  assert.ok(
    ui
      .startupChanges("remote", values, { ...draft, pollIntervalMs: "50" })
      .invalid.includes("pollIntervalMs"),
  );
  assert.equal(
    ui.startupChanges("remote", values, { ...draft, pollIntervalMs: "100" })
      .invalid.length,
    0,
  );
  assert.ok(
    ui
      .startupChanges("remote", values, { ...draft, targetPort: "65536" })
      .invalid.includes("targetPort"),
  );
  const changes = ui.startupChanges("remote", values, {
    ...draft,
    audience: "changed-fixture",
    role: "planner",
  }).changes;
  for (const key of ["nodeId", "authMode", "grants", "credentials"])
    assert.equal(changes[key], undefined);
});

test("startup form stages a role edit, sends its exact expected snapshot, reads after save and retains conflicts", async () => {
  const states = [];
  let index = 0;
  const react = {
    useState(initial) {
      const slot = index++;
      if (!(slot in states))
        states[slot] = typeof initial === "function" ? initial() : initial;
      return [
        states[slot],
        (value) => {
          states[slot] =
            typeof value === "function" ? value(states[slot]) : value;
        },
      ];
    },
  };
  const ui = client(
    { Button: "FixtureButton", Switch: "FixtureSwitch" },
    react,
  );
  const row = {
    entryId: "task-system",
    values: {
      role: "executor",
      defaultWorkspaceId: "fixture-workspace",
      sessionDecisionEnabled: false,
    },
  };
  const order = [],
    writes = [];
  let reject = false;
  const props = {
    t: (key) => key,
    target: "task",
    row,
    writable: true,
    saveStartup: async (request) => {
      order.push("save");
      writes.push(request);
      if (reject) throw new Error("fixture conflict");
    },
    onSaved: async () => {
      order.push("read-after-save");
    },
  };
  const render = () => {
    index = 0;
    return ui.StartupRow(props);
  };
  const find = (node, predicate) => {
    if (!node || typeof node !== "object") return;
    if (predicate(node)) return node;
    for (const child of node.children ?? []) {
      const result = find(child, predicate);
      if (result) return result;
    }
  };
  let tree = render();
  const role = find(tree, (node) => node.type === "select");
  role.props.onChange({ target: { value: "planner" } });
  assert.equal(writes.length, 0);
  tree = render();
  const save = find(
    tree,
    (node) =>
      node.type === "FixtureButton" && node.children.includes("startupSave"),
  );
  assert.equal(save.props.disabled, false);
  await save.props.onClick();
  assert.equal(writes[0].target, "task");
  assert.equal(writes[0].expected, row.values);
  assert.deepEqual(Object.keys(writes[0].changes), ["role"]);
  assert.equal(writes[0].changes.role, "planner");
  assert.deepEqual(order, ["save", "read-after-save"]);
  reject = true;
  tree = render();
  find(tree, (node) => node.type === "select").props.onChange({
    target: { value: "both" },
  });
  tree = render();
  await find(
    tree,
    (node) =>
      node.type === "FixtureButton" && node.children.includes("startupSave"),
  ).props.onClick();
  tree = render();
  assert.equal(
    find(tree, (node) => node.type === "select").props.value,
    "both",
  );
  assert.ok(
    find(
      tree,
      (node) =>
        node.props?.role === "alert" &&
        node.children.includes("startupSaveFailed"),
    ),
  );
  props.writable = false;
  tree = render();
  const count = writes.length;
  const readonlySave = find(
    tree,
    (node) =>
      node.type === "FixtureButton" && node.children.includes("startupSave"),
  );
  assert.equal(readonlySave.props.disabled, true);
  await readonlySave.props.onClick();
  assert.equal(writes.length, count);
});

test("startup transport descriptors match the final host and carry only one strict input", async () => {
  const ui = client();
  for (const [actual, expected] of [
    [ui.startupDescriptor, startupDescriptor],
    [ui.saveStartupDescriptor, saveStartupDescriptor],
  ]) {
    for (const key of ["id", "namespace", "service", "method"])
      assert.equal(actual[key], expected[key]);
    assert.equal(actual.result.typeSymbol, expected.result.typeSymbol);
  }
  const parameter = ui.saveStartupDescriptor.parameters[0];
  assert.equal(parameter.wire, saveStartupDescriptor.parameters[0].wire);
  assert.equal(
    parameter.codec.typeSymbol,
    saveStartupDescriptor.parameters[0].codec.typeSymbol,
  );
  const input = {
    target: "task",
    expected: {
      role: "executor",
      defaultWorkspaceId: null,
      sessionDecisionEnabled: false,
    },
    changes: { role: "planner" },
  };
  assert.equal(parameter.codec.create().parse(input), input);
  assert.throws(
    () =>
      parameter.codec
        .create()
        .parse({ ...input, changes: { nodeId: "other" } }),
    /Invalid startup/,
  );
  assert.throws(
    () => parameter.codec.create().parse({ ...input, namespace: "unrelated" }),
    /Invalid startup/,
  );
  const args = [];
  const ctx = {
    get: () => ({
      saveStartup: async (...values) => {
        args.push(values);
        return { ok: true, value: { saved: true, applies: "plugin-restart" } };
      },
    }),
  };
  const result = await ui.readRemote(
    ctx,
    "saveStartup",
    ui.saveStartupDescriptor.result.create(),
    input,
  );
  assert.equal(result.saved, true);
  assert.equal(args[0].length, 1);
  assert.equal(args[0][0], input);
  assert.throws(
    () =>
      ui.saveStartupDescriptor.result
        .create()
        .parse({ saved: false, applies: "plugin-restart" }),
    /Invalid startup save result/,
  );
});

test("unconfigured connection requires explicit source and target and starts with polling off", () => {
  const ui = client(),
    values = {
      role: "executor",
      paused: false,
      endpoint: null,
      audience: null,
      pollIntervalMs: 5000,
      concurrency: 1,
      taskSessionsEnabled: false,
      trustedNetworkTarget: null,
    };
  const draft = ui.startupDraft("remote", values);
  assert.equal(draft.pollIntervalMs, "5000");
  assert.ok(
    ui.startupChanges("remote", values, draft).invalid.includes("targetPort"),
  );
  Object.assign(draft, {
    endpoint: "http://fixture.invalid:8443/commands",
    audience: "fixture-authority",
    targetAddress: "fixture.invalid",
    targetPort: "8443",
    targetLocalAddress: "fixture.local",
  });
  const parsed = ui.startupChanges("remote", values, draft);
  assert.equal(parsed.invalid.length, 0);
  assert.equal(parsed.changes.pollIntervalMs, 0);
  assert.equal(parsed.changes.trustedNetworkTarget.allowHttp, true);
  assert.equal(
    parsed.changes.trustedNetworkTarget.localAddress,
    "fixture.local",
  );
  assert.equal(parsed.changes.nodeId, undefined);
  assert.equal(parsed.changes.authMode, undefined);
});

test("paused remote snapshots retain incomplete connection values and require public loading metadata", () => {
  const ui = client();
  const values = {
    role: "executor",
    paused: true,
    endpoint: null,
    audience: null,
    pollIntervalMs: 5000,
    concurrency: 1,
    taskSessionsEnabled: false,
    trustedNetworkTarget: null,
  };
  const draft = ui.startupDraft("remote", values);
  const unchanged = ui.startupChanges("remote", values, draft);
  assert.equal(unchanged.dirty, false);
  assert.equal(unchanged.invalid.length, 0);
  const edited = ui.startupChanges("remote", values, {
    ...draft,
    concurrency: "2",
  });
  assert.equal(edited.invalid.length, 0);
  assert.deepEqual(Object.keys(edited.changes), ["concurrency"]);
  assert.equal(edited.changes.concurrency, 2);
  const resume = ui.startupChanges("remote", values, {
    ...draft,
    paused: false,
  });
  assert.ok(resume.invalid.includes("endpoint"));
  const partialConnection = ui.startupChanges("remote", values, {
    ...draft,
    endpoint: "http://fixture.invalid:8443/commands",
  });
  assert.ok(partialConnection.invalid.includes("audience"));
  const view = {
    writable: true,
    applies: "plugin-restart",
    task: null,
    remote: {
      entryId: "task-remote-execution",
      loaded: true,
      loaderDisabled: false,
      values,
    },
  };
  const browserSchema = ui.startupDescriptor.result.create(),
    hostSchema = startupDescriptor.result.create();
  assert.equal(browserSchema.parse(view), view);
  assert.equal(hostSchema.parse(view).remote.values.paused, true);
  for (const key of ["loaded", "loaderDisabled"]) {
    const invalid = { ...view, remote: { ...view.remote } };
    delete invalid.remote[key];
    assert.throws(
      () => browserSchema.parse(invalid),
      /Invalid startup remote loading state/,
    );
    assert.throws(() => hostSchema.parse(invalid));
  }
  const request = {
    target: "remote",
    expected: values,
    changes: { paused: false },
  };
  assert.equal(
    ui.saveStartupDescriptor.parameters[0].codec.create().parse(request),
    request,
  );
  assert.equal(
    saveStartupDescriptor.parameters[0].codec.create().parse(request).changes
      .paused,
    false,
  );
  assert.throws(
    () =>
      ui.saveStartupDescriptor.parameters[0].codec
        .create()
        .parse({ ...request, changes: { paused: "false" } }),
    /Invalid startup value/,
  );
});

test("remote pause stages, discards and saves through the loaded configuration; Loader-disabled entries cannot write", async () => {
  const states = [];
  let index = 0;
  const ui = client(
    { Button: "FixtureButton", Switch: "FixtureSwitch" },
    {
      useState(initial) {
        const slot = index++;
        if (!(slot in states))
          states[slot] = typeof initial === "function" ? initial() : initial;
        return [
          states[slot],
          (value) => {
            states[slot] =
              typeof value === "function" ? value(states[slot]) : value;
          },
        ];
      },
    },
  );
  const writes = [],
    order = [];
  const row = {
    entryId: "task-remote-execution",
    loaded: true,
    loaderDisabled: false,
    values: {
      role: "executor",
      paused: true,
      endpoint: "http://fixture.invalid:8443/commands",
      audience: "fixture-authority",
      pollIntervalMs: 0,
      concurrency: 1,
      taskSessionsEnabled: true,
      trustedNetworkTarget: {
        address: "fixture.invalid",
        port: 8443,
        localAddress: "fixture.local",
        allowHttp: true,
      },
    },
  };
  const props = {
    t: (key) => key,
    target: "remote",
    row,
    writable: true,
    saveStartup: async (input) => {
      writes.push(input);
      order.push("save");
    },
    onSaved: async () => order.push("read-after-save"),
  };
  const find = (node, predicate) => {
    if (!node || typeof node !== "object") return;
    if (predicate(node)) return node;
    for (const child of node.children ?? []) {
      const value = find(child, predicate);
      if (value) return value;
    }
  };
  const render = () => {
    index = 0;
    return ui.StartupRow(props);
  };
  const toggle = (tree) =>
    find(
      tree,
      (node) => node.type === "FixtureSwitch" && node.props.label === "paused",
    );
  const button = (tree, label) =>
    find(
      tree,
      (node) => node.type === "FixtureButton" && node.children.includes(label),
    );
  let tree = render();
  assert.equal(toggle(tree).props.checked, true);
  assert.equal(toggle(tree).props.disabled, false);
  toggle(tree).props.onChange(false);
  assert.equal(writes.length, 0);
  tree = render();
  assert.equal(toggle(tree).props.checked, false);
  button(tree, "discardDraft").props.onClick();
  tree = render();
  assert.equal(toggle(tree).props.checked, true);
  assert.equal(writes.length, 0);
  toggle(tree).props.onChange(false);
  tree = render();
  await button(tree, "startupSave").props.onClick();
  assert.equal(writes[0].expected, row.values);
  assert.deepEqual(Object.keys(writes[0].changes), ["paused"]);
  assert.equal(writes[0].changes.paused, false);
  assert.deepEqual(order, ["save", "read-after-save"]);
  for (const metadata of [
    { loaded: false, loaderDisabled: true },
    { loaded: false, loaderDisabled: false },
    { loaded: true, loaderDisabled: true },
  ]) {
    Object.assign(row, metadata);
    tree = render();
    assert.equal(toggle(tree).props.disabled, true);
    assert.equal(button(tree, "startupSave").props.disabled, true);
    assert.ok(
      find(
        tree,
        (node) =>
          node.props?.role === "note" &&
          node.children.includes("startupRemoteDisabled"),
      ),
    );
    await button(tree, "startupSave").props.onClick();
    assert.equal(writes.length, 1);
  }
});
