import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {SessionId} from '@deepseek-ai/dsh-session';
import {ToolCallId} from '@deepseek-ai/dsh-llm';
import {createNativeHarness} from './native-harness.mjs';
import {registerExecutor} from './executor-fixture.mjs';

async function waitFor(service, commandId) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const snapshot = await service.reconcile({conversationId: 'main'});
    if (snapshot.messages.some(message => message.commandId === commandId && message.state.kind === 'completed')) return snapshot;
    await new Promise(done => setTimeout(done, 20));
  }
  throw new Error('Canonical owner turn did not complete');
}
async function events(h, sessionId) {
  const handle = await h.ctx.sessionPersistence.open(SessionId(sessionId), 'read');
  try { return JSON.stringify((await handle.read()).events); }
  finally { await handle.close(); }
}

for (const kind of ['personal', 'managed-current', 'managed-retired']) test(`Task execution cannot borrow ${kind} canonical history; no worker request or session mutation occurs`, {timeout: 30000}, async () => {
  const h = await createNativeHarness({executionRoot: true, config: {role: 'both', schedulerEnabled: false, projectAgentOptions: {provider: 'test-offline', model: 'script'}}});
  const handles = [];
  try {
    const service = h.ctx.taskSystem.steward, projects = h.ctx.taskSystem.projects;
    let target = {kind: 'personal'};
    if (kind !== 'personal') {
      projects.saveSettings({root: join(h.dir, 'projects'), expectedRevision: 0});
      const project = await projects.create({commandId: 'reserved-project', title: 'Reserved PM', goal: 'Canonical owner privacy'});
      target = {kind: 'project', projectId: project.projectId};
    }
    const secret = `CANONICAL_OWNER_PRIVATE_${kind}`;
    h.adapter.script.push('Canonical owner warmup complete.');
    await service.send({conversationId: 'main', commandId: 'reserved-warmup', text: `Synthetic owner-only history ${secret}`, target});
    const snapshot = await waitFor(service, 'reserved-warmup');
    const user = snapshot.messages.find(message => message.commandId === 'reserved-warmup');
    const sessionId = user.source.sessionId;
    let agent = h.ctx.agents.get(SessionId(sessionId));
    if (!agent) {
      const handle = await h.ctx.agents.resume({resumeSessionId: SessionId(sessionId), agentOptions: {provider: 'test-offline', model: 'script'}});
      handles.push(handle); agent = handle.agent;
    }
    assert.equal(service.recall.read(sessionId, {query: secret}).items.length, 1);
    if (kind === 'managed-retired') await projects.handoff(target.projectId);
    await agent.whenIdle(); assert.equal(agent.status, 'idle');
    await h.ctx.sessions.flush(agent.session);
    const originalHistory = await events(h, sessionId), requests = h.adapter.requests.length;
    registerExecutor(h.ledger, 'reserved-owner-node', {nodeId: 'local', roles: ['both'], models: [{provider: 'test-offline', model: 'script', reasoningEfforts: []}], capabilities: [], workspaceIds: [], enabled: true});
    const task = h.ledger.createTask('reserved-owner-task', {title: 'A workload must not borrow this conversation owner'}).value;
    const run = h.ledger.createRun('reserved-owner-run', {taskId: task.taskId, route: {nodeId: 'local', provider: 'test-offline', model: 'script', requiredCapabilities: []}}).value;
    const claim = h.ledger.claim('reserved-owner-claim', {runId: run.runId, nodeId: 'local', ttlMs: 10000}).value;
    claim.attempt.executionId = randomUUID(); claim.attempt.sessionId = sessionId;
    const result = await h.ctx.taskSystem.native.executeExternal({claim, sessionId, resumeSession: true, workspacePath: agent.session.header.cwd, signal: new AbortController().signal});
    assert.equal(result.outcome, 'blocked');
    assert.match(result.summary, /reserved|canonical|steward/i);
    assert.equal(h.adapter.requests.length, requests, 'No worker model request may see canonical owner history');
    assert.equal(h.ctx.taskSystem.native.scopeFor(agent), undefined);
    assert.equal(h.ctx.agents.get(SessionId(sessionId)), agent);
    assert.equal(await events(h, sessionId), originalHistory, 'Refusal must not append a task prompt or mutate the original session');
    await Promise.all(handles.splice(0).map(handle => handle.dispose()));
    h.adapter.script.push('The legitimate conversation owner remains usable.');
    await service.send({conversationId: 'main', commandId: 'reserved-owner-continues', text: 'Continue normal owner conversation.', target});
    const continued = await waitFor(service, 'reserved-owner-continues');
    const current = continued.messages.find(message => message.commandId === 'reserved-owner-continues');
    let currentAgent = h.ctx.agents.get(SessionId(current.source.sessionId));
    if (!currentAgent) {
      const handle = await h.ctx.agents.resume({resumeSessionId: SessionId(current.source.sessionId), agentOptions: {provider: 'test-offline', model: 'script'}});
      handles.push(handle); currentAgent = handle.agent;
    }
    const recalled = await h.ctx.tools.execute({callId: ToolCallId('owner-recall-restored'), name: 'steward_recall', arguments: {query: secret}, agent: currentAgent, signal: new AbortController().signal});
    assert.equal(recalled.isError, false);
    assert.equal(recalled.value.items.length, 1);
    assert.match(recalled.value.items[0].excerpt, new RegExp(secret));
  } finally { await Promise.all(handles.map(handle => handle.dispose())); await h.dispose(); }
});
