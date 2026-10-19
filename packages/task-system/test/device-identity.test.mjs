import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { resolveDeviceNodeId } from "../dist/device-identity.js";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "dsh-device-identity-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, file: join(home, "task-system", "device-identity.json") };
}

test("unnamed installations persist one device identity across restarts and ledger locations", (t) => {
  const { home, file } = fixture(t);
  const first = resolveDeviceNodeId(undefined, { home });
  assert.match(first, /^node-[0-9a-f-]{36}$/);
  assert.equal(resolveDeviceNodeId("", { home }), first);
  assert.equal(resolveDeviceNodeId("   ", { home }), first);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).nodeId, first);
});

test("all explicit nonempty node IDs are preserved without touching identity storage", (t) => {
  const { home, file } = fixture(t);
  for (const id of ["local", "MBP", "named device", "  existing-id  "]) {
    assert.equal(resolveDeviceNodeId(id, { home }), id);
  }
  assert.equal(existsSync(file), false);
});

test("simultaneous isolated workers publish exactly one complete identity", async (t) => {
  const { home, file } = fixture(t);
  const shared = new SharedArrayBuffer(4);
  const gate = new Int32Array(shared);
  const moduleUrl = new URL("../dist/device-identity.js", import.meta.url).href;
  const workers = Array.from(
    { length: 12 },
    () =>
      new Worker(
        `
    const { workerData, parentPort } = require('node:worker_threads');
    (async () => {
      const { resolveDeviceNodeId } = await import(workerData.moduleUrl);
      parentPort.postMessage({ ready: true });
      Atomics.wait(new Int32Array(workerData.shared), 0, 0);
      parentPort.postMessage({ nodeId: resolveDeviceNodeId('', { home: workerData.home }) });
    })().catch(error => { throw error; });
  `,
        { eval: true, workerData: { shared, home, moduleUrl } },
      ),
  );
  const ready = workers.map(
    (worker) =>
      new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      }),
  );
  await Promise.all(ready);
  const results = workers.map(
    (worker) =>
      new Promise((resolve, reject) => {
        worker.once("message", (message) => resolve(message.nodeId));
        worker.once("error", reject);
      }),
  );
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0);
  const ids = await Promise.all(results);
  assert.equal(new Set(ids).size, 1);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).nodeId, ids[0]);
  await Promise.all(workers.map((worker) => worker.terminate()));
});

for (const content of [
  "{broken",
  "{}",
  '{"version":1,"nodeId":""}',
  '{"version":2,"nodeId":"node-bad"}',
]) {
  test(`invalid identity fails without replacing it: ${content}`, (t) => {
    const { home, file } = fixture(t);
    mkdirSync(join(home, "task-system"));
    writeFileSync(file, content);
    assert.throws(
      () => resolveDeviceNodeId("", { home }),
      /Cannot load stable.*device identity/,
    );
    assert.equal(readFileSync(file, "utf8"), content);
    assert.equal(resolveDeviceNodeId("explicit", { home }), "explicit");
  });
}

test("identity symlinks fail without following or replacing the target", (t) => {
  const { home, file } = fixture(t);
  mkdirSync(join(home, "task-system"));
  const target = join(home, "other.json");
  writeFileSync(
    target,
    '{"version":1,"nodeId":"node-01440041-97d6-4f02-8aaf-c789bd9bfda1"}',
  );
  symlinkSync(target, file);
  assert.throws(
    () => resolveDeviceNodeId("", { home }),
    /Cannot load stable.*device identity/,
  );
});

test("independent profiles in one home persist different identities", (t) => {
  const { home } = fixture(t);
  const first = { home, profileDir: join(home, "profiles", "first") };
  const second = { home, profileDir: join(home, "profiles", "second") };
  assert.notEqual(
    resolveDeviceNodeId("", first),
    resolveDeviceNodeId("", second),
  );
  assert.equal(
    resolveDeviceNodeId("", first),
    resolveDeviceNodeId(undefined, first),
  );
});

test("a persisted profile identity wins over a newly selected ledger local node", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { home, file } = fixture(t);
  const legacyDatabasePath = join(home, "legacy.sqlite");
  const database = new DatabaseSync(legacyDatabasePath);
  database.exec("CREATE TABLE entities(kind TEXT,id TEXT,data TEXT)");
  const generated = resolveDeviceNodeId("", { home, legacyDatabasePath });
  assert.match(generated, /^node-/);
  database.exec("INSERT INTO entities VALUES('node','local','{}')");
  assert.equal(
    resolveDeviceNodeId("", { home, legacyDatabasePath }),
    generated,
  );
  assert.equal(JSON.parse(readFileSync(file, "utf8")).nodeId, generated);
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM entities").get().count,
    1,
  );
  database.close();
});

test("first upgrade of an authority-only ledger persists local identity across later switches to new ledger databases", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { home, file } = fixture(t);
  const legacyDatabasePath = join(home, "legacy.sqlite");
  const database = new DatabaseSync(legacyDatabasePath);
  database.exec(
    "CREATE TABLE schema_meta(version INTEGER); INSERT INTO schema_meta VALUES(1); CREATE TABLE entities(kind TEXT,id TEXT,data TEXT); INSERT INTO entities VALUES('authority','scheduler','{\"schedulerId\":\"scheduler-01440041-97d6-4f02-8aaf-c789bd9bfda1\"}')",
  );
  database.close();
  assert.equal(resolveDeviceNodeId("", { home, legacyDatabasePath }), "local");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).nodeId, "local");
  assert.equal(
    resolveDeviceNodeId("", {
      home,
      legacyDatabasePath: join(home, "new.sqlite"),
    }),
    "local",
  );
});
