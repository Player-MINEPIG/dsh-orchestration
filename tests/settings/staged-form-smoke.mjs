/** Exercises the plugin controller against the actual rc.2 SettingsFormModel,
 * extracted as a pure unit because the published ui-primitives entry imports CSS.
 * Only its tiny snapshot-store adapter is in-memory; no DOM or browser is used.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
const runtime = process.env.DSH_OFFICIAL_ROOT;
assert.ok(runtime, "Set DSH_OFFICIAL_ROOT");
const source = readFileSync(
  join(
    runtime,
    "node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js",
  ),
  "utf8",
);
const start = source.indexOf("var SettingsFormModel = class {"),
  end = source.indexOf("//#endregion", start);
assert.ok(start > 0 && end > start);
const modelScope = {
  createSnapshotStore(value) {
    const listeners = new Set();
    return {
      getSnapshot: () => value,
      set(next) {
        value = next;
        for (const f of listeners) f();
      },
      subscribe(f) {
        listeners.add(f);
        return () => listeners.delete(f);
      },
    };
  },
};
vm.runInNewContext(
  source.slice(start, end) + "\nglobalThis.Model=SettingsFormModel;",
  modelScope,
);
let ui;
vm.runInNewContext(
  readFileSync(
    new URL(
      "../../packages/task-system/dist/settings-client.js",
      import.meta.url,
    ),
    "utf8",
  ),
  {
    window: {
      __ModuleLoader__: {
        load(row) {
          ui = row.factory((name) =>
            name === "react" ? {} : { SettingsFormModel: modelScope.Model },
          );
        },
      },
    },
  },
);
const base = {
  schedulerEnabled: false,
  autoExecute: false,
  maxConcurrent: 1,

  healthAlerts: false,
  localHeartbeatIntervalMs: 30000,
};
let snapshot = {
    status: "ready",
    writable: true,
    revision: 1,
    value: { ...base },
    base,
    user: {},
  },
  writes = [],
  delay,
  reject = false;
const listeners = new Set(),
  notify = () => {
    for (const f of listeners) f();
  };
const scope = {
  getSnapshot: () => snapshot,
  subscribe(f) {
    listeners.add(f);
    return () => listeners.delete(f);
  },
  async mutate(ops, revision) {
    writes.push({ ops, revision });
    if (delay) await delay;
    if (reject || revision !== snapshot.revision) return false;
    const user = { ...snapshot.user };
    for (const op of ops) {
      if (op.op === "set") user[op.path[0]] = op.value;
      else delete user[op.path[0]];
    }
    snapshot = {
      ...snapshot,
      user,
      value: { ...base, ...user },
      revision: snapshot.revision + 1,
    };
    notify();
    return true;
  },
};
const controller = new ui.Controller(scope),
  form = controller.form,
  actions = form.actions();
actions.edit("maxConcurrent", "3");
assert.equal(writes.length, 0);
assert.equal(form.shell().dirty, true);
assert.equal(snapshot.value.maxConcurrent, 1);
await form.save();
assert.equal(snapshot.value.maxConcurrent, 3);
assert.equal(writes[0].revision, 1);
assert.equal(form.shell().dirty, false);
console.log("PASS staged numeric edit and revision-fenced Save");
actions.edit("maxConcurrent", "33");
assert.equal(form.shell().invalid, true);
await form.save();
assert.equal(writes.length, 1);
assert.equal(form.field("maxConcurrent").text, "33");
actions.discard();
assert.equal(form.field("maxConcurrent").text, "3");
console.log(
  "PASS invalid limits prevent writes; discard restores effective value",
);
actions.edit("autoExecute", "true");
assert.equal(snapshot.value.autoExecute, false);
let release;
delay = new Promise((r) => (release = r));
const saving = form.save();
assert.equal(form.shell().saving, true);
await form.save();
assert.equal(writes.length, 2);
release();
await saving;
delay = undefined;
assert.equal(snapshot.value.autoExecute, true);
console.log("PASS boolean staging and repeated Save coalescing while pending");
actions.edit("maxConcurrent", "4");
snapshot = { ...snapshot, revision: snapshot.revision + 1 };
notify();
await form.save();
assert.equal(snapshot.value.maxConcurrent, 3);
assert.equal(form.field("maxConcurrent").text, "4");
assert.equal(form.shell().failed, true);
actions.discard();
assert.equal(form.field("maxConcurrent").text, "3");
console.log(
  "PASS concurrent revision refusal keeps the user draft and shows failure",
);
actions.edit("maxConcurrent", "");
await form.save();
assert.equal(snapshot.value.maxConcurrent, 1);
assert.equal(writes.at(-1).ops[0].op, "unset");
actions.resetField("autoExecute");
await form.save();
assert.equal(snapshot.value.autoExecute, false);
console.log(
  "PASS field Reset and blank numeric reset restore inherited values",
);
actions.edit("maxConcurrent", "2");
snapshot = { ...snapshot, writable: false };
notify();
await form.save();
assert.equal(snapshot.value.maxConcurrent, 1);
assert.equal(form.shell().writable, false);
controller.dispose();
assert.equal(listeners.size, 0);
console.log(
  "PASS read-only state prevents writes and companion teardown releases its subscription",
);
console.log(
  JSON.stringify({
    ok: true,
    checks: 6,
    ui: "actual official SettingsFormModel with a synthetic scope; no rendered browser pass claimed",
    credentials: "none",
  }),
);
