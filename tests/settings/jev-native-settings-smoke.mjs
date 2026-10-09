import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const runtime = process.env.DSH_OFFICIAL_ROOT;
assert.ok(runtime, "Set DSH_OFFICIAL_ROOT to an official DSH installation");
const req = createRequire(realpathSync(join(runtime, "package.json")));
const { boot, initProfile, readProfilePatches } = await import(
  pathToFileURL(req.resolve("@deepseek-ai/dsh-app-boot")).href
);
const tmp = mkdtempSync(join(tmpdir(), "jev-native-settings-")),
  home = join(tmp, "home"),
  dir = join(home, "profiles", "fixture");
mkdirSync(home, { recursive: true });
initProfile(dir, []);
symlinkSync(resolve("node_modules"), join(dir, "node_modules"), "dir");
const profile = {
  name: "fixture",
  dir,
  patchPath: join(dir, "cordis.patch.yml"),
  installAnchor: realpathSync(join(runtime, "package.json")),
  cwd: tmp,
  home,
  startedBundles: [],
  overlays: [],
  telemetryDisabledEnv: "1",
};
const config = {
  provider: "native",
  nativeProvider: "test-offline",
  model: "script",
  reasoningEffort: "low",
  baseUrl: "",
  dataDir: join(tmp, "ledger"),
  profiles: [
    { id: "preserved", provider: "custom", credential: "FIXTURE_REF" },
  ],
  timeoutMs: 12345,
};
const rows = [
  ["config-editor", "@deepseek-ai/dsh-config-editor"],
  ["settings", "@deepseek-ai/dsh-settings"],
].map(([id, p]) => ({ id, name: pathToFileURL(req.resolve(p)).href }));
rows.push({
  id: "jev",
  name: pathToFileURL(resolve("packages/jev/lib/index.js")).href,
  config,
});
writeFileSync(profile.patchPath, JSON.stringify([{ insert: rows }]));
const root = join(dir, "cordis.yml");
writeFileSync(root, "[]\n");
const start = () =>
  boot(
    "jev-settings-smoke",
    root,
    readProfilePatches("jev-settings-smoke", profile),
    (ctx) => ctx.provide("profileContext", profile),
  );
let ctx;
try {
  ctx = await start();
  const settings = ctx.get("settings"),
    service = ctx.get("decisionModels");
  assert.ok(service);
  const descriptor = () =>
    ctx
      .get("settings")
      .describe()
      .find((row) => row.ns === "jev");
  const first = descriptor();
  assert.ok(first);
  const fiber = ctx
    .get("configEditor")
    .entries()
    .find((entry) => entry.options.id === "jev").fiber;
  assert.deepEqual(Object.keys(first.value).sort(), [
    "baseUrl",
    "enabled",
    "model",
    "nativeProvider",
    "provider",
    "reasoningEffort",
  ]);
  console.log(
    "PASS official settings exposes every JEV browser field as live editable",
  );
  await settings.mutate(
    "jev",
    [
      { op: "set", path: ["provider"], value: "typesafe" },
      { op: "set", path: ["model"], value: "" },
      { op: "set", path: ["baseUrl"], value: "" },
      { op: "set", path: ["nativeProvider"], value: "" },
      { op: "set", path: ["reasoningEffort"], value: "" },
      { op: "set", path: ["enabled"], value: true },
    ],
    first.revision,
  );
  assert.equal(
    ctx
      .get("configEditor")
      .entries()
      .find((entry) => entry.options.id === "jev").fiber,
    fiber,
  );
  assert.equal(service.config().provider, "typesafe");
  assert.equal(service.config().model, "");
  assert.equal(service.config().timeoutMs, 12345);
  assert.deepEqual(service.config().profiles, config.profiles);
  console.log(
    "PASS official mutate persists selected provider and hot updates the shared service without remount",
  );
  await assert.rejects(
    settings.mutate(
      "jev",
      [{ op: "set", path: ["dataDir"], value: join(tmp, "other") }],
      descriptor().revision,
    ),
    /not volatile/,
  );
  await assert.rejects(
    settings.mutate(
      "jev",
      [{ op: "set", path: ["provider"], value: "custom" }],
      first.revision,
    ),
    (error) => error.code === "SETTINGS_CONFLICT",
  );
  console.log("PASS stale revisions and noneditable paths are rejected");
  await ctx.fiber.dispose();
  ctx = await start();
  assert.equal(ctx.get("decisionModels").config().provider, "typesafe");
  assert.equal(descriptor().value.provider, "typesafe");
  console.log("PASS saved JEV provider survives official host restart");
} finally {
  if (ctx) await ctx.fiber.dispose();
  rmSync(tmp, { recursive: true, force: true });
}
