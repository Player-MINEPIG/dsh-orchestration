import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { Config, LIVE_SETTING_KEYS, LIVE_STARTUP_KEYS } from "../dist/dsh-plugin.js";
import {
  settingsDescriptor,
  queueDescriptor,
  executorIdentityDescriptor,
  startupDescriptor,
  saveStartupDescriptor,
  checkConnectionDescriptor,
  hasTaskConfigOverride,
  workspaceCatalogDescriptor,
  TaskPluginSettings,
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
      URL,
      document: { createElement: () => ({ style: {} }) },
      window: {
        addEventListener() {},
        removeEventListener() {},
        __ModuleLoader__: {
          load(row) {
            assert.equal(row.id, "@dsh-task/task-system");
            module = row.factory((name) =>
              name === "react"
                ? {
                    useRef: (initial) => ({ current: initial }),
                    useCallback: callback => callback,
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
  assert.deepEqual(actual.sort(), [...LIVE_SETTING_KEYS,...LIVE_STARTUP_KEYS].sort());
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
  assert.match(ui.en.remoteHint, /executor switch controls heartbeats and task reception/);
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
    planningDecisionEnabled: true,
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

test("browser companion registers the shared persistent task settings surface and installed task center", async () => {
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
  const listeners = new Map();
  const ctx = {
    on(name, listener) {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
    locale: { bind: () => (k) => k, register: () => () => {} },
    configForms: {
      get: (id) => (assert.equal(id, "task-system"), {}),
      whileServed: (ids, register) => (
        assert.deepEqual([...ids], ["task-system"]),
        register()
      ),
    },
    remote: {
      $host: { isLoopback: true },
      $mount: async (contribution) => {
        assert.equal(new Set(contribution.descriptors.map(d => d.method)).size, contribution.descriptors.length);
        for (const method of ["sessionTasks", "scheduleOptions", "createScheduledPlan", "controlScheduledPlan", "workflowSnapshot", "workflowPage", "saveWorkflow", "startWorkflow", "retryWorkflowStep", "cancelWorkflow"])
          assert.ok(contribution.descriptors.some(descriptor => descriptor.method === method));
        return () => {};
      },
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
  assert.equal(registrations.length, 6);
  assert.ok(!registrations.some(r => r.options.id === "dsh-task-workflows"));
  assert.ok(registrations.some(r => r.options.name === "conversation.view" && r.options.id === "dsh-session-tasks"));
  assert.ok(listeners.has("command/executed"));
  assert.ok(registrations.some(r => r.options.name === "shell.overlay" && r.options.id === "task-project-command-result"));
  const main = registrations.find(r => r.options.key === "dsh-task-settings");
  const portal = registrations.find(r => r.options.id === "task-settings-surface");
  assert.ok(main && portal);
  assert.equal(main.component, ui.TaskSettingsPanel);
  assert.equal(portal.component, ui.TaskSettingsPortal);
  assert.equal(main.options.inject().surface, portal.options.inject().surface);
  assert.equal((await portal.options.inject().read()).nodeId, "fixture");
  assert.equal(registrations.filter(r => r.options.name === "settings.section" || r.options.name === "plugins.row.config").length, 0);
  for (const cleanup of effects.splice(0).reverse()) cleanup?.();
  assert.equal(disposed.length, 6);
  assert.equal(listeners.size, 0);
  registrations.length = 0;
  ctx.configForms.whileServed = () => () => {};
  await ui.apply(ctx);
  assert.equal(
    registrations.length,
    4,
    "hide the surface and portal while the Host does not serve task-system settings",
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
    databasePath: "/fixture/tasks.sqlite",
    executionAgentPreset: "ptc",
    executionTools: null,
    planningDecisionEnabled: true,
    sessionDecisionEnabled: false,
    nodeId: "must-not-edit",
    credentials: "must-not-copy",
  };
  const draft = ui.startupDraft("task", values);
  assert.deepEqual(Object.keys(draft).sort(), [
    "centralMode",
    "databasePath",
    "executionAgentPreset",
    "executionEnabled",
    "followExecutionPreset",
    "planningDecisionEnabled",
    "role",
  ]);
  assert.equal(ui.startupChanges("task", values, draft).dirty, false);
  draft.executionAgentPreset = "codex";
  draft.sessionDecisionEnabled = true;
  draft.centralMode = "host";
  const changes = ui.startupChanges("task", values, draft).changes;
  assert.equal(changes.executionAgentPreset, "codex");
  assert.equal(changes.defaultWorkspaceId, undefined);
  assert.equal(changes.sessionDecisionEnabled, undefined);
  assert.equal(changes.centralMode, "host");
  assert.equal(changes.executionEnabled, true);
  assert.equal(changes.role, undefined);
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
      .startupChanges("remote", values, { ...draft, connectionTouched: true, connectionPort: "65536" })
      .invalid.includes("connectionPort"),
  );
  const changes = ui.startupChanges("remote", values, {
    ...draft,
    audience: "changed-fixture",
    role: "planner",
  }).changes;
  for (const key of ["nodeId", "authMode", "grants", "credentials"])
    assert.equal(changes[key], undefined);
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
      executionAgentPreset: "ptc",
      executionTools: null,
      planningDecisionEnabled: true,
      sessionDecisionEnabled: false,
    },
    changes: { role: "planner" },
  };
  assert.equal(parameter.codec.create().parse(input), input);
  for (const key of ["planningDecisionEnabled"]) {
    const booleanEdit = { ...input, changes: { [key]: false } };
    assert.equal(parameter.codec.create().parse(booleanEdit), booleanEdit);
    assert.throws(
      () =>
        parameter.codec
          .create()
          .parse({ ...input, changes: { [key]: "false" } }),
      /Invalid startup value/,
    );
  }
  assert.throws(()=>parameter.codec.create().parse({...input,changes:{sessionDecisionEnabled:true}}),/Invalid startup values/);
  const missingPlanning = { ...input, expected: { ...input.expected } };
  delete missingPlanning.expected.planningDecisionEnabled;
  assert.throws(
    () => parameter.codec.create().parse(missingPlanning),
    /Invalid startup values/,
  );
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
    ui.startupChanges("remote", values, draft).invalid.includes("connectionPort"),
  );
  Object.assign(draft, {
    connectionTouched: true,
    connectionProtocol: "http",
    connectionAddress: "127.0.0.2",
    connectionPort: "8443",
    connectionPath: "/commands",
    audience: "fixture-authority",
    targetLocalAddress: "127.0.0.3",
  });
  const parsed = ui.startupChanges("remote", values, draft);
  assert.equal(parsed.invalid.length, 0);
  assert.equal(parsed.changes.pollIntervalMs, 0);
  assert.equal(parsed.changes.trustedNetworkTarget.allowHttp, true);
  assert.equal(
    parsed.changes.trustedNetworkTarget.localAddress,
    "127.0.0.3",
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
    connectionTouched: true,
    connectionAddress: "127.0.0.2",
  });
  assert.equal(partialConnection.invalid.length, 0);
  assert.equal(partialConnection.retainedDirty, true);
  assert.equal(partialConnection.dirty, false);
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

test("workspace directory descriptor reads only metadata and preserves strict local scope", () => {
  const ui = client();
  for (const key of ["id", "namespace", "service", "method"])
    assert.equal(
      ui.workspaceCatalogDescriptor[key],
      workspaceCatalogDescriptor[key],
    );
  assert.equal(workspaceCatalogDescriptor.parameters.length, 0);
  const value = {
    scope: {
      entryId: "task-system",
      nodeId: "local",
      schedulerId: "scheduler",
    },
    source: "official",
    items: [
      {
        workspaceId: "one",
        title: "Project",
        path: "/projects/one",
        available: true,
      },
      {
        workspaceId: "two",
        title: "Project",
        path: "/projects/two",
        available: true,
      },
    ],
  };
  assert.equal(
    ui.workspaceCatalogDescriptor.result.create().parse(value),
    value,
  );
  assert.equal(
    workspaceCatalogDescriptor.result.create().parse(value).items[1].path,
    "/projects/two",
  );
  assert.throws(
    () =>
      ui.workspaceCatalogDescriptor.result
        .create()
        .parse({ ...value, items: [value.items[0], value.items[0]] }),
    /workspace catalog/,
  );
});

test('connection result codec accepts the native identity response and rejects an invalid success', () => {
  const ui=client(),value={connected:true,checkedAt:new Date().toISOString(),endpoint:'http://127.0.0.1:1234/commands',paused:true,code:null,identity:{nodeId:'worker',schedulerId:'scheduler-5b933515-b3ae-43ec-bf5b-e7c6b1bfaebd',executorId:'executor-17bed9a3-a4a3-4db7-916c-a5e45b491ed6'}};
  assert.deepEqual(ui.checkConnectionDescriptor.result.create().parse(value),checkConnectionDescriptor.result.create().parse(value));
  assert.throws(()=>ui.checkConnectionDescriptor.result.create().parse({...value,identity:null}));
  assert.throws(()=>ui.checkConnectionDescriptor.result.create().parse({...value,identity:{nodeId:'worker'}}));
  const failure={...value,connected:false,identity:null,code:'OPERATION_DENIED'};
  assert.equal(ui.checkConnectionDescriptor.result.create().parse(failure).connected,false);
});

test('model settings shortcut uses the official root store seat, sharing the current dialog', () => {
  const ui=client(),selected=[];
  const shell={actions:{openSection:id=>selected.push(id)}};
  const ctx={slots:{entries:key=>{assert.equal(key,'sidebar.settings');return [{options:{id:'unrelated'}},{options:{},store:{create:()=>shell}}];}}};
  assert.equal(ui.openModels(ctx),true);assert.deepEqual(selected,['models']);
  assert.equal(ui.openPlugins(ctx),true);assert.deepEqual(selected,['models','plugins']);
  assert.equal(ui.openModels({slots:{entries:()=>[]}}),false);
  assert.equal(ui.openModels({slots:{entries:()=>[{options:{},store:{create:()=>({actions:{}})}}]}}),false);
});

test('scheduler node capacity draft stays clean and validates each registered node independently',()=>{
  const ui=client(),values={role:'planner',defaultWorkspaceId:null,planningDecisionEnabled:true,sessionDecisionEnabled:false,nodeCapacities:[{nodeId:'a',maxConcurrent:1},{nodeId:'b',maxConcurrent:3}]};
  const draft=ui.startupDraft('task',values);
  assert.equal(ui.startupChanges('task',values,draft).dirty,false);
  draft.nodeCapacities[0].maxConcurrent='2';
  assert.deepEqual(JSON.parse(JSON.stringify(ui.startupChanges('task',values,draft).changes.nodeCapacities)),[{nodeId:'a',maxConcurrent:2},{nodeId:'b',maxConcurrent:3}]);
  for(const value of ['', '0', '1.5', '33', 'NaN']) {
    draft.nodeCapacities[0].maxConcurrent=value;
    assert.ok(ui.startupChanges('task',values,draft).invalid.includes('nodeCapacities'));
  }
});

 test('unified save validates drafts, saves live owners before restart and retains unsaved owners on failure',async()=>{
 const {SettingsSaveCoordinator}=client();const saves=[];const c=new SettingsSaveCoordinator();
 c.register('restart',{meta:{dirty:true,restart:true},save:async()=>{saves.push('restart');return false},discard:()=>saves.push('discard')});
 c.register('live',{meta:{dirty:true,invalid:true,restart:false},save:async()=>{saves.push('live');return true},discard:()=>saves.push('discard-live')});
 assert.equal(await c.saveAll(),false);assert.deepEqual(saves,[]);
 c.update('live',{dirty:true,restart:false});assert.equal(await c.saveAll(),false);assert.deepEqual(saves,['live','restart']);assert.match(c.snapshot().message,/部分/);assert.equal(c.snapshot().busy,false);
 c.discardAll();assert.deepEqual(saves,['live','restart','discard','discard-live']);
 });

 test("directory picker stages only confirmed paths and supports the official native capability", async()=>{
  const values=[],refs=[],changes=[];let cursor=0,refCursor=0;
  const ui=client({Button:"FixtureButton",Modal:"FixtureModal"},{
    useState:initial=>{const i=cursor++;if(!(i in values))values[i]=initial;return [values[i],value=>{values[i]=typeof value==='function'?value(values[i]):value;}];},
    useRef:initial=>{const i=refCursor++;return refs[i]??=( {current:initial} );},useEffect:()=>{},
  });
  const api={list:async()=>({path:'/fixture',crumbs:[{name:'fixture',path:'/fixture'}],entries:[],truncated:false})};
  const props={value:'/fixture',onChange:path=>changes.push(path),directoryApi:api};
  const render=()=>{cursor=0;refCursor=0;return ui.DirectoryField(props);};
  function find(node,label){if(!node||typeof node!=='object')return; if(node.type==='FixtureButton'&&node.children?.includes(label))return node;for(const child of node.children??[]){const found=find(child,label);if(found)return found;}}
  find(render(),'选择目录').props.onClick();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(changes,[]);find(render(),'取消').props.onClick();assert.deepEqual(changes,[]);
  find(render(),'选择目录').props.onClick();await new Promise(resolve=>setImmediate(resolve));
  find(render(),'选择此目录').props.onClick();assert.deepEqual(changes,['/fixture']);
  api.list=async()=>{throw Object.assign(new Error('native required'),{rpcError:{code:'directory-picker/unavailable',details:{capability:'native'}}})};
  let nativeCalls=0;api.pick=async()=>{nativeCalls++;return '/native-picked';};
  find(render(),'选择目录').props.onClick();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(nativeCalls,1);assert.deepEqual(changes,['/fixture','/native-picked']);
  api.pick=async()=>null;find(render(),'选择目录').props.onClick();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(changes.length,2,'native cancellation must retain the previous draft');
 });

test('selecting the same execution preset explicitly clears a legacy mask in one startup request',()=>{
 const ui=client(),values={role:'executor',planningDecisionEnabled:false,sessionDecisionEnabled:false,executionAgentPreset:'ptc',executionTools:['activity_sources_read']};
 const draft=ui.startupDraft('task',values);assert.equal(ui.startupChanges('task',values,draft).dirty,false);
 draft.followExecutionPreset=true;const change=ui.startupChanges('task',values,draft);
 assert.deepEqual(JSON.parse(JSON.stringify(change.changes)),{executionTools:null,executionAgentPreset:'ptc'});
 const descriptor=ui.projectDescriptors.find(x=>x.method==='executionPresets');assert.ok(descriptor);assert.deepEqual(Array.from(descriptor.parameters),[]);
});


test("browser startup codecs accept host deployment fields and reject invalid deployment edits", () => {
  const ui = client(), snapshotCodec = ui.startupDescriptor.result.create();
  const values = { role: "executor", centralMode: "remote", executionEnabled: false,
    nodeId: "ordinary-session-node", executionAgentPreset: "ptc", executionTools: null,
    planningDecisionEnabled: false, sessionDecisionEnabled: false };
  const view = startupDescriptor.result.create().parse({ writable: true, applies: "plugin-restart",
    task: { entryId: "task-system", decisionAvailable: true, values }, remote: null });
  assert.equal(snapshotCodec.parse(view), view);
  assert.equal(ui.startupDraft("task", view.task.values).centralMode, "remote");
  assert.equal(ui.startupDraft("task", view.task.values).executionEnabled, false);
  const browserEdit = ui.saveStartupDescriptor.parameters[0].codec.create();
  const hostEdit = saveStartupDescriptor.parameters[0].codec.create();
  for (const changes of [{ centralMode: "host" }, { executionEnabled: true }]) {
    const input = { target: "task", expected: values, changes };
    assert.equal(browserEdit.parse(input), input);
    assert.deepEqual(hostEdit.parse(input).changes, changes);
  }
  for (const changes of [{ centralMode: "planner" }, { centralMode: null }, { executionEnabled: "false" }, { executionEnabled: 1 }]) {
    assert.throws(() => snapshotCodec.parse({ ...view, task: { ...view.task, values: { ...values, ...changes } } }), /Invalid startup value/);
    assert.throws(() => browserEdit.parse({ target: "task", expected: values, changes }), /Invalid startup value/);
    assert.throws(() => hostEdit.parse({ target: "task", expected: values, changes }));
  }
  const legacy = { ...values }; delete legacy.centralMode; delete legacy.executionEnabled;
  assert.doesNotThrow(() => snapshotCodec.parse({ ...view, task: { ...view.task, values: legacy } }));
});
