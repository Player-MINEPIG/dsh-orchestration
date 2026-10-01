import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { TaskLedger, readLegacyHermes } from "../dist/index.js";
test("read-only legacy import keeps multiple reports and unresolved history without dispatching old runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-import-"));
  const file = join(dir, "source.sqlite");
  let source = new DatabaseSync(file);
  source.exec(
    `CREATE TABLE task_instances(task_id TEXT,title TEXT,status TEXT,created_at TEXT,updated_at TEXT);INSERT INTO task_instances VALUES('t','Existing goal','running','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z');CREATE TABLE task_runs(run_id TEXT,task_id TEXT,status TEXT,result_summary TEXT);INSERT INTO task_runs VALUES('r','t','running','Partial evidence');CREATE TABLE task_result_submissions(submission_id TEXT,task_id TEXT,run_id TEXT,payload_json TEXT,result_kind TEXT,status TEXT);INSERT INTO task_result_submissions VALUES('a','t','r','{"text":"report one"}','freeform','accepted');INSERT INTO task_result_submissions VALUES('b','t','r','{"text":"report two"}','freeform','accepted');INSERT INTO task_result_submissions VALUES('c','missing','r','{"text":"orphan evidence"}','freeform','rejected');CREATE TABLE report_artifacts(artifact_id TEXT,root_task_id TEXT,report_kind TEXT,sha256 TEXT,byte_length INTEGER);CREATE TABLE events(event_id TEXT,task_id TEXT,event_type TEXT);`,
  );
  source.close();
  const before = createHash("sha256").update(readFileSync(file)).digest("hex");
  const { snapshot, warnings } = readLegacyHermes(file, {
    observedAt: "2026-10-01T00:00:00Z",
  });
  const l = TaskLedger.open(join(dir, "target.sqlite"));
  try {
    l.importSnapshot("import", snapshot);
    assert.equal(l.snapshot().tasks.length, 2);
    assert.equal(l.snapshot().reports.length, 6);
    assert.equal(l.snapshot().runs[0].state, "uncertain");
    assert.equal(l.pendingRuns("any").length, 0);
    assert.ok(warnings.some((x) => x.includes("Missing task definition")));
    assert.equal(
      createHash("sha256").update(readFileSync(file)).digest("hex"),
      before,
    );
    assert.throws(
      () => l.createRun("dispatch", { taskId: snapshot.tasks[0].taskId }),
      (e) => e.code === "OBSERVE_ONLY",
    );
  } finally {
    l.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upgraded Hermes sessions, payloads and configuration remain inspectable without activation", () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-evidence-"));
  const file = join(dir, "source.sqlite"),
    db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE task_instances(task_id TEXT,title TEXT,status TEXT,metadata_json TEXT,depends_on_task_ids_json TEXT,conversation_session_id TEXT);
    INSERT INTO task_instances VALUES('t','History','completed','{"custom":"keep"}','["prior"]','conversation-a');
    CREATE TABLE task_runs(run_id TEXT,task_id TEXT,status TEXT,serve_runtime_session_id TEXT,serve_stored_session_id TEXT,result_payload_json TEXT,task_result_json TEXT,usage_json TEXT);
    INSERT INTO task_runs VALUES('r','t','completed','runtime-a','stored-a','{"full":"result"}','{"accepted":true}','{"tokens":12}');
    CREATE TABLE task_result_submissions(submission_id TEXT,task_id TEXT,run_id TEXT,payload_json TEXT,validation_json TEXT);
    INSERT INTO task_result_submissions VALUES('s','t','r','malformed-original-json','{"valid":false}');
    CREATE TABLE report_artifacts(artifact_id TEXT,root_task_id TEXT,payload_json TEXT,metadata_json TEXT,sha256 TEXT,byte_length INTEGER);
    INSERT INTO report_artifacts VALUES('a','t','{"report":"stored inline"}','{"builder":"v1"}','digest',25);
    CREATE TABLE events(event_id TEXT,task_id TEXT,run_id TEXT,event_type TEXT,payload_json TEXT,metadata_json TEXT);
    INSERT INTO events VALUES('e','t','r','done','{"causal":"detail"}','{"trace":"original"}');
  `);
  db.close();
  try {
    const { snapshot } = readLegacyHermes(file, {
      observedAt: "2026-10-01T00:00:00Z",
    });
    assert.deepEqual(snapshot.runs[0].sessionIds, ["runtime-a", "stored-a"]);
    assert.equal(
      snapshot.runs[0].configuration.sourceRecord.result_payload_json,
      '{"full":"result"}',
    );
    assert.equal(
      snapshot.reports.find(
        (r) => r.schemaId === "hermes-source/task_instances",
      ).data.metadata_json,
      '{"custom":"keep"}',
    );
    assert.equal(
      snapshot.reports.find(
        (r) => r.schemaId === "hermes-source/task_result_submissions",
      ).data.payload_json,
      "malformed-original-json",
    );
    assert.equal(
      snapshot.reports.find(
        (r) => r.schemaId === "hermes-source/report_artifacts",
      ).data.payload_json,
      '{"report":"stored inline"}',
    );
    assert.equal(snapshot.artifacts[0].finalized, false);
    assert.equal(
      snapshot.events[0].detail.sourceRecord.payload_json,
      '{"causal":"detail"}',
    );
    assert.equal(snapshot.templates.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy queues, schedules, decisions and notifications migrate as inert evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-inert-")),
    file = join(dir, "source.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE task_instances(task_id TEXT,title TEXT,status TEXT,admission_state TEXT);INSERT INTO task_instances VALUES('old','Excluded old task','blocked','dismissed');
    CREATE TABLE task_runs(run_id TEXT,task_id TEXT,status TEXT);
    CREATE TABLE task_result_submissions(submission_id TEXT,task_id TEXT);
    CREATE TABLE report_artifacts(artifact_id TEXT,root_task_id TEXT);
    CREATE TABLE events(event_id TEXT);
    CREATE TABLE task_messages(message_id TEXT,target_task_id TEXT,content_json TEXT,status TEXT);INSERT INTO task_messages VALUES('m','old','{"text":"Queued before migration"}','pending');
    CREATE TABLE notification_outbox(notification_id TEXT,task_id TEXT,status TEXT,destination TEXT,payload_json TEXT);INSERT INTO notification_outbox VALUES('n','old','pending','feishu:chat:fixture','{"text":"Old notification"}');
    CREATE TABLE schedule_bindings(schedule_id TEXT,status TEXT,schedule_expression TEXT);INSERT INTO schedule_bindings VALUES('s','active','0 8 * * *');
    CREATE TABLE task_intake_candidates(candidate_id TEXT,payload_json TEXT,status TEXT);INSERT INTO task_intake_candidates VALUES('c','{"text":"Observed source"}','pending');
    CREATE TABLE outbox(candidate_id TEXT,payload_json TEXT,status TEXT);INSERT INTO outbox VALUES('local-c','{"text":"Unacknowledged local evidence"}','pending');`);
  db.close();
  const ledger = TaskLedger.open(join(dir, "new.sqlite"));
  try {
    const { snapshot } = readLegacyHermes(file, {
      observedAt: "2026-10-01T00:00:00Z",
    });
    ledger.importSnapshot("inert-migration", snapshot);
    assert.equal(ledger.snapshot().tasks[0].admissionState, "dismissed");
    assert.equal(ledger.querySnapshot().tasks.length, 0);
    assert.equal(ledger.snapshot().reports[0].kind, "observation");
    assert.ok(
      ledger
        .snapshot()
        .events.some((e) => e.type === "legacy.source.task_messages"),
    );
    assert.ok(
      ledger.snapshot().events.some((e) => e.type === "legacy.source.outbox"),
    );
    assert.equal(ledger.deliveries().length, 0);
    assert.equal(ledger.snapshot().schedules.length, 0);
    assert.equal(ledger.observationCandidates().length, 0);
    assert.equal(ledger.pendingRuns("worker").length, 0);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
