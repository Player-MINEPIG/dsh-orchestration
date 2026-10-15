import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionCodexJobs, codexJobRows } from '../dist/session-codex-jobs.js';
import { SessionDispatchIndex, sessionTaskSnapshot } from '../dist/session-task-monitor.js';

const command = String.raw`$c='C:\Users\test\Codex\bin\codex.exe'; Get-Content 'private-brief.md' -Raw | & $c exec -m gpt-6-astra -o 'private-output.md' -`;
function call(seq, name, args, result, error = false) {
  return [
    { seq, time: seq * 1000, type: 'tool/call', data: { name, callId: `c${seq}`, arguments: JSON.stringify(args) } },
    { seq: seq + 1, time: seq * 1000 + 50, type: 'tool/result', data: { message: { toolCallId: `c${seq}`, isError: error, content: [{ type: 'text', text: result }] } } },
  ];
}
const launch = (seq = 10, job = 'pwsh-9', cmd = command) => call(seq, 'pwsh', { command: cmd, description: 'UI correction' }, `started background job ${job}`);
const notice = (id, status, kind = 'tool-jobs') => ({ type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text: `background job ${id} (pwsh: command) finished [status: ${status}]. Read its output with job_output.` }] } });

test('legacy shell dispatch uses confirmed job receipts; status notices and output do not imply acceptance', () => {
  const jobs = sessionCodexJobs([
    ...launch(), ...launch(20, 'pwsh-10'), ...launch(30, 'pwsh-11'),
    ...call(40, 'job_output', { job_id: 'pwsh-9' }, 'exit 0\n[status: completed, exit code: 0]'),
    { type: 'agent/inbox/spliced', data: { inserted: [notice('pwsh-10', 'completed, exit code: 3').data] } },
    notice('pwsh-10', 'completed, exit code: 3'),
    ...call(50, 'job_kill', { job_id: 'pwsh-11' }, 'requested cancellation of job pwsh-11'),
    notice('pwsh-11', 'completed, exit code: 0', 'user'),
  ]);
  const snapshot = sessionTaskSnapshot({ tasks: [], runs: [] }, [], 's', 0, jobs);
  assert.deepEqual(snapshot.counts, { all: 3, handled: 1, error: 1, unknown: 1 });
  assert.equal(snapshot.externalDispatchCount, 3);
  assert.match(snapshot.tasks[0].stateLabel, /未验收/);
  assert.equal(snapshot.tasks[2].status, 'unknown');
  assert.doesNotMatch(JSON.stringify(snapshot), /private-brief|private-output|commandHash/);
});

test('help, log inspection, mere mentions, foreground shell jobs, errors and unmatched receipts are not Codex dispatches', () => {
  const events = [
    ...launch(10, 'pwsh-1', 'codex exec --help'),
    ...launch(20, 'pwsh-2', "Get-Content 'codex-run.log'"),
    ...launch(30, 'pwsh-3', 'echo "codex exec"'),
    ...call(40, 'pwsh', { command }, '(no output)'),
    ...call(50, 'pwsh', { command }, 'started background job pwsh-4', true),
    call(60, 'pwsh', { command }, 'started background job pwsh-5')[1],
  ];
  assert.deepEqual(sessionCodexJobs(events), []);
});

test('direct executable, resume and timeout promotion are tracked as distinct invocations', () => {
  const jobs = sessionCodexJobs([
    ...launch(10, 'pwsh-1', 'codex exec -m gpt-6-astra test'),
    ...call(20, 'bash', { command: '/usr/bin/codex exec resume abc -m gpt-6-astra -' }, '[still running after 1000ms; moved to background job bash-1]\nThe command keeps running.'),
    ...launch(30, 'pwsh-1', 'codex exec resume abc -'),
    notice('pwsh-1', 'killed'),
  ]);
  assert.equal(jobs.length, 3);
  assert.equal(new Set(jobs.map(j => j.id)).size, 3);
  assert.deepEqual(codexJobRows(jobs, 's').map(j => j.status), ['unknown', 'unknown', 'cancelled']);
});

test('live registry is session-fenced and must match command and start window; cache never makes a dead process live', () => {
  const jobs = sessionCodexJobs(launch());
  let job = { id: 'pwsh-9', owner: 's', label: command, startedAt: 10001, status: 'running' };
  const registry = { list: id => { assert.equal(id, 's'); return [job]; } };
  assert.equal(codexJobRows(jobs, 's', registry)[0].status, 'running');
  job = { ...job, status: 'completed', detail: 'exit code: 0' };
  assert.equal(codexJobRows(jobs, 's', registry)[0].status, 'handled');
  for (const patch of [{ owner: 'other' }, { owner: undefined }, { startedAt: 90000 }, { label: 'different' }]) {
    assert.equal(codexJobRows(jobs, 's', { list: () => [{ ...job, ...patch }] })[0].status, 'unknown');
  }
  assert.equal(codexJobRows(jobs, 's')[0].status, 'unknown');
  assert.equal(jobs[0].state, 'running');
});

test('historical calls survive reopening and next-turn refresh adds only new calls', async () => {
  const index = new SessionDispatchIndex();
  let revision = '1', events = launch(), reads = 0;
  const persistence = { identity: Symbol(), stat: async () => ({ revision }), open: async () => ({
    inheritedEventCount: 5,
    read: async offset => { assert.equal(offset, 5); reads++; return { events }; }, close: async () => {},
  }) };
  assert.equal((await index.readHistory(persistence, 's')).codexJobs.length, 1);
  await index.readHistory(persistence, 's'); assert.equal(reads, 1);
  revision = '2'; events = [...events, notice('pwsh-9', 'completed, exit code: 0'), ...launch(30, 'pwsh-10')];
  const reopened = await new SessionDispatchIndex().readHistory(persistence, 's');
  const next = await index.readHistory(persistence, 's');
  assert.deepEqual(next.codexJobs, reopened.codexJobs);
  assert.deepEqual(codexJobRows(next.codexJobs, 's').map(j => j.status), ['handled', 'unknown']);
});
