import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDsh } from '../../examples/legacy-task-pack/activity/dsh.mjs';
import { collectCodex, codexEntries } from '../../examples/legacy-task-pack/activity/codex.mjs';
import { buildNodeReport, validateNodeReport, buildDailyReport } from '../../examples/legacy-task-pack/activity/report.mjs';
const window = { start: '2026-10-10T16:00:00.000Z', end: '2026-10-11T16:00:00.000Z', timeZone: 'Asia/Shanghai' };

test('DSH official read handles retain human continuation, exclude injected/subagent/inherited history and close', async () => {
  const before = Date.parse(window.start) - 1000, during = before + 2000; let closed = 0;
  const events = [
    { seq: 0, time: before, type: 'turn/start', data: { turn: 0 } },
    { seq: 1, time: before, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Fix real work' }] } },
    { seq: 2, time: during, type: 'assistant/message', data: { turn: 0, message: { content: [{ type: 'text', text: 'Done' }] } } },
    { seq: 3, time: during, type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } },
    { seq: 4, time: during, type: 'turn/start', data: { turn: 1 } },
    { seq: 5, time: during, type: 'user/message', data: { source: { kind: 'dsh-task' }, content: [{ type: 'text', text: 'Background collector' }] } },
    { seq: 6, time: during, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'Automatic result' }] } } },
  ];
  const result = await collectDsh({ window, persistence: { list: async () => [{ header: { id: 'human', createdAt: before } }, { header: { id: 'child', origin: 'subagent', createdAt: before } }], open: async (id, mode) => { assert.equal(id, 'human'); assert.equal(mode, 'read'); return { id, inheritedEventCount: 0, read: async (offset, length) => ({ events: events.slice(offset, offset + length) }), close: async () => { closed++; } }; } } });
  assert.equal(closed, 1); assert.equal(result.entries.length, 1); assert.equal(result.entries[0].request, 'Fix real work'); assert.equal(result.entries[0].state, 'completed');
});
test('Codex uses only read methods, pages archives, preserves boundary state and closes', async () => {
  let closed = 0; const methods = [];
  const startedAt = Date.parse(window.start) / 1000 + 1;
  const thread = { id: 'a', updatedAt: startedAt + 1, name: 'Work' };
  const turn = { id: 'one', startedAt, completedAt: Date.parse(window.end) / 1000 + 1, status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Do work' }] }, { type: 'agentMessage', phase: 'final_answer', text: 'Finished after report window' }] };
  const result = await collectCodex({ executable: '/configured/codex', window, readerFactory: async () => ({ close: async () => { closed++; }, call: async (method, params) => { methods.push(method); if (method === 'thread/list') return { data: params.archived ? [] : [thread], nextCursor: null }; assert.equal(method, 'thread/turns/list'); return { data: [turn], nextCursor: null }; } }) });
  assert.equal(closed, 1); assert.equal(result.entries[0].completedAt, null); assert.equal(result.entries[0].state, 'inProgress'); assert.deepEqual(methods, ['thread/list', 'thread/turns/list', 'thread/list']);
  assert.equal(result.entries[0].answer, '');
  assert.equal(codexEntries({ ...thread, updatedAt: Date.parse(window.end) / 1000 + 100 }, [{ ...turn, startedAt: Date.parse(window.start) / 1000 - 100, completedAt: null, status: 'inProgress' }], window).length, 0);
  assert.equal(codexEntries(thread, [{ ...turn, items: [{ type: 'userMessage', content: [{ type: 'text', text: '<environment_context>automatic</environment_context>' }] }] }], window).length, 0);
});
test('activity report keeps DSH/Codex identities and rejects omitted/fabricated/repeated summaries', () => {
  const capture = { nodeId: 'MBP', window, sources: [{ runtime: 'codex', window, errors: [], entries: [{ sourceRef: 'codex:a:1', runtime: 'codex' }] }] };
  const summaries = [{ sourceRef: 'codex:a:1', title: 'Real work', summary: 'Evidence-based outcome', status: 'completed' }];
  assert.throws(() => buildNodeReport(capture, []), /Every observed/);
  assert.throws(() => buildNodeReport(capture, [{ ...summaries[0], sourceRef: 'fake' }]), /Invalid/);
  const payload = buildNodeReport(capture, summaries); assert.equal(validateNodeReport(payload).turnCount, 1);
  assert.throws(() => validateNodeReport({ ...payload, turnCount: 2 }), /derived/);
  assert.throws(() => validateNodeReport({ ...payload, sources: [{ ...capture.sources[0], runtime: 'hermes' }] }), /Invalid activity source/);
});
test('root aggregation accepts only matching run children and marks missing nodes', () => {
  const local = buildNodeReport({ nodeId: 'VPS', window, sources: [{ runtime: 'dsh', window, errors: [], entries: [] }] }, []);
  const remote = { ...local, nodeId: 'MBP' };
  const snapshot = { tasks: [{ taskId: 'root-task', tags: ['daily-report'] }, { taskId: 'child', parentTaskId: 'root-task', parentRunId: 'root' }], runs: [{ runId: 'child-run', taskId: 'child', createdAt: window.start }] };
  const ledger = { snapshot: () => snapshot, history: () => ({ runs: [{ runId: 'child-run', parentRunId: 'root', route: { nodeId: 'MBP' }, state: 'succeeded' }], reports: [{ runId: 'child-run', kind: 'result', schemaId: 'dsh_agent_activity_node.v1', data: remote }] }) };
  const result = buildDailyReport({ ledger, run: { runId: 'root' }, local, expectedNodes: ['VPS', 'MBP', 'PC_AU'] });
  assert.deepEqual(result.nodes.map(n => n.nodeId), ['VPS', 'MBP']); assert.deepEqual(result.missingNodes.map(n => n.nodeId), ['PC_AU']); assert.equal(result.partial, true);
  assert.deepEqual(result.executions, [], 'Report collector children are not business executions');
});
