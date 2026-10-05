/** Real rc.2 browser Remote mount and Cordis inject rules, with a read-only
 * in-memory carrier. No browser, HTTP, credentials or model calls are used. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
const repo = fileURLToPath(new URL("../..", import.meta.url));
const runtime = process.env.DSH_OFFICIAL_ROOT;
assert.ok(
  runtime,
  "Set DSH_OFFICIAL_ROOT to an installed official rc.2 package anchor",
);
const req = createRequire(join(runtime, "package.json"));
const cordis = req("@deepseek-ai/cordis");
function load(path, require) {
  let value;
  vm.runInNewContext(readFileSync(path, "utf8"), {
    window: {
      __ModuleLoader__: {
        load: (row) => {
          value = row.factory(require);
        },
      },
    },
    AbortController,
    AbortSignal,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    console,
  });
  return value;
}
const gateway = load(
  req.resolve("@deepseek-ai/dsh-api-gateway/client"),
  (name) => {
    assert.equal(name, "@deepseek-ai/cordis");
    return cordis;
  },
);
const ui = load(
  join(repo, "packages/task-system/dist/settings-client.js"),
  () => ({}),
);
const root = new cordis.Context();
const snapshot = {
  nodeId: "fixture",
  databasePath: "/tmp/fixture.sqlite",
  role: "executor",
};
let result = { ok: true, value: snapshot };
const calls = [];
const core = root.plugin({
  apply(ctx) {
    ctx.provide("typert", {
      remotes: { register: () => async () => {} },
      contexts: {},
    });
    ctx.provide("connection", {
      rpc: {
        call: async (path, method, payload) => {
          calls.push({ path, method, payload });
          return result;
        },
        open: () => {},
      },
      registerGenerationSource: () => () => {},
      start: () => () => {},
      generation: { getSnapshot: () => undefined },
      isLoopback: true,
    });
  },
});
await core;
const mountedGateway = root.plugin(gateway);
await mountedGateway;
let consumer;
const mountedConsumer = root.plugin({
  inject: ["remote"],
  async apply(ctx) {
    await ctx.remote.$mount({
      package: "@dsh-task/task-system",
      descriptors: [ui.descriptor, ui.queueDescriptor],
    });
    consumer = ctx;
  },
});
await mountedConsumer;
assert.throws(
  () => consumer.remote.taskPluginSettings.describe(),
  /without inject/,
);
assert.equal(
  (await ui.readRemote(consumer, "describe", ui.descriptor.result.create()))
    .nodeId,
  "fixture",
);
assert.equal(calls.at(-1).path, "/api");
assert.equal(calls.at(-1).method, "taskPluginSettings/describe");
assert.deepEqual(Object.keys(calls.at(-1).payload.args), []);
result = {
  ok: false,
  error: {
    code: "gateway/internal",
    message: "fixture carrier error",
    details: {},
  },
};
await assert.rejects(
  ui.readRemote(consumer, "describe", ui.descriptor.result.create()),
  (e) => e.code === "gateway/internal",
);
result = {
  ok: true,
  value: {
    sampledAt: "2026-10-05T00:00:00.000Z",
    nodeId: "fixture",
    items: [],
    truncated: false,
  },
};
assert.equal(
  (await ui.readRemote(consumer, "queue", ui.queueDescriptor.result.create()))
    .items.length,
  0,
);
assert.equal(calls.at(-1).method, "taskPluginSettings/queue");
assert.deepEqual(Object.keys(calls.at(-1).payload.args), []);
await mountedConsumer.dispose();
await mountedGateway.dispose();
await core.dispose();
console.log(
  "PASS: real official Remote mount reproduces undeclared namespace failure; Context.get and RemoteResult unwrap succeed; carrier failure remains an error; queue uses its no-argument read-only route.",
);
