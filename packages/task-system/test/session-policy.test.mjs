import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultTaskSessionSelection, TaskSessionConfigurationError } from '../dist/session-default.js';
import { chooseExecutionSession } from '../dist/execution-session.js';

const base = {
  taskId: 'task-1', nodeId: 'local', defaultWorkspaceId: 'default',
  workspaces: [
    { workspaceId: 'default', nodeId: 'local', eligible: true, description: 'Default workspace' },
    { workspaceId: 'alternate', nodeId: 'local', eligible: true, description: 'Alternate workspace' },
    { workspaceId: 'disabled', nodeId: 'local', eligible: false, description: 'Disabled workspace' },
    { workspaceId: 'remote', nodeId: 'remote', eligible: true, description: 'Other node' },
  ],
  sessions: [
    { sessionId: 'session-1', taskId: 'task-1', nodeId: 'local', workspaceId: 'default', eligible: true, description: 'This Task in default workspace' },
    { sessionId: 'session-2', taskId: 'task-1', nodeId: 'local', workspaceId: 'alternate', eligible: true, description: 'This Task in alternate workspace' },
    { sessionId: 'foreign', taskId: 'other', nodeId: 'local', workspaceId: 'default', eligible: true, description: 'Another Task' },
    { sessionId: 'not-ready', taskId: 'task-1', nodeId: 'local', workspaceId: 'default', eligible: false, description: 'Unavailable' },
  ],
};

test('default selection imports independently and reuses only the bound session in the effective workspace', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'task-session-default-'));
  try {
    const path = join(directory, 'session-default.mjs');
    copyFileSync(new URL('../dist/session-default.js', import.meta.url), path);
    const independent = await import(pathToFileURL(path).href);
    assert.deepEqual(independent.defaultTaskSessionSelection(base), { session: { mode: 'new' }, workspaceId: 'default' });
    assert.deepEqual(independent.defaultTaskSessionSelection({ ...base, taskSessionId: 'session-1' }).session, { mode: 'reuse', sessionId: 'session-1' });
    assert.deepEqual(independent.defaultTaskSessionSelection({ ...base, defaultWorkspaceId: 'alternate', taskSessionId: 'session-2' }), { session: { mode: 'reuse', sessionId: 'session-2' }, workspaceId: 'alternate' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('missing default, duplicate catalog IDs, or incompatible existing binding are configuration errors', () => {
  for (const change of [
    { defaultWorkspaceId: '' }, { defaultWorkspaceId: 'disabled' }, { defaultWorkspaceId: 'remote' },
    { taskSessionId: 'session-2' }, { taskSessionId: 'not-ready' }, { taskSessionId: 'foreign' },
    { workspaces: [...base.workspaces, base.workspaces[0]] },
    { sessions: [...base.sessions, base.sessions[0]] },
  ]) assert.throws(() => defaultTaskSessionSelection({ ...base, ...change }), TaskSessionConfigurationError);
});

const managed = {
  claim: {task: {taskId: 'task', title: 'Task'}, run: {runId: 'run', projectContext: {schedulerId: 'scheduler', project: null}}, attempt: {attemptId: 'attempt', nodeId: 'node'}},
  context: {schedulerId: 'scheduler', taskSessionId: 'bound', sessions: [{taskId: 'task', nodeId: 'node', schedulerId: 'scheduler', sessionId: 'bound'}]},
  managedWorkspaceAvailable: true,
  workspaces: [],
};

test('managed selection creates a new session unless the bound session belongs to this Task, node and scheduler', async () => {
  assert.deepEqual(await chooseExecutionSession(managed), {expectedTaskSessionId: 'bound', session: {mode: 'reuse', sessionId: 'bound'}});
  for (const change of [{taskId: 'foreign'}, {nodeId: 'remote'}, {schedulerId: 'other'}, {workspaceId: 'explicit'}]) {
    const context = {...managed.context, sessions: [{...managed.context.sessions[0], ...change}]};
    assert.deepEqual((await chooseExecutionSession({...managed, context})).session, {mode: 'new'});
  }
  const context = {...managed.context, taskSessionId: undefined};
  assert.deepEqual(await chooseExecutionSession({...managed, context}), {expectedTaskSessionId: null, session: {mode: 'new'}});
});

test('scheduled occurrences create a fresh session and explicit redispatch continues the binding', async () => {
  const explicit = {
    ...managed,
    claim: {...managed.claim, run: {...managed.claim.run, route: {workspaceId: 'default'}}},
    context: {...managed.context, sessions: [{...managed.context.sessions[0], workspaceId: 'default'}]},
    workspaces: [{workspaceId: 'default', nodeId: 'node', eligible: true}],
  };
  for (const input of [managed, explicit]) {
    for (const configuration of [undefined, {taskRetry: true}, {continuationOf: 'prior-run'}]) {
      const claim = {...input.claim, task: {...input.claim.task, kind: 'scheduled'}, run: {...input.claim.run, configuration}};
      const choice = await chooseExecutionSession({...input, claim});
      assert.deepEqual(choice.session, configuration ? {mode: 'reuse', sessionId: 'bound'} : {mode: 'new'});
      assert.equal(choice.expectedTaskSessionId, 'bound');
    }
  }
});

test('text-only compatibility never adopts an unbound or foreign session', async () => {
  const claim = {...managed.claim, run: {runId: 'text-run'}};
  const input = {...managed, claim};
  assert.deepEqual((await chooseExecutionSession(input)).session, {mode: 'reuse', sessionId: 'bound'});
  assert.deepEqual((await chooseExecutionSession({...input, context: {...managed.context, taskSessionId: undefined}})).session, {mode: 'new'});
  for (const change of [{taskId: 'foreign'}, {nodeId: 'remote'}, {schedulerId: 'other'}, {workspaceId: 'explicit'}]) {
    const context = {...managed.context, sessions: [{...managed.context.sessions[0], ...change}]};
    await assert.rejects(chooseExecutionSession({...input, context}), /TASK_SESSION_CONFIG/);
  }
});

test('already cancelled selection never creates or reuses a session', async () => {
  const controller = new AbortController();
  controller.abort();
  for (const run of [managed.claim.run, {runId: 'retry', retry: {sessionId: 'bound'}}, {runId: 'text-run'}, {runId: 'explicit', route: {workspaceId: 'default'}}]) {
    await assert.rejects(chooseExecutionSession({...managed, claim: {...managed.claim, run}, signal: controller.signal}), {name: 'AbortError'});
  }
});
