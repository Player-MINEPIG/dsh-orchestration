import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {SessionId} from '@deepseek-ai/dsh-session';
import {ToolCallId} from '@deepseek-ai/dsh-llm';
import {createNativeHarness} from './native-harness.mjs';
import {registerExecutor} from './executor-fixture.mjs';

async function waitFor(service, commandId) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    const snapshot = await service.reconcile({conversationId: 'main'});
    if (snapshot.messages.some(message => message.commandId === commandId && message.state.kind === 'completed')) return snapshot;
    await new Promise(done => setTimeout(done, 20));
  }
  throw new Error('Managed gate native turn did not complete');
}

test('actual managed PM tools cannot persist planning before acceptance or shed scope after retirement; trusted continuation admits downstream', {timeout: 30000}, async () => {
  const h = await createNativeHarness({executionRoot: true, config: {role: 'both', schedulerEnabled: false, autoExecute: false, projectAgentOptions: {provider: 'test-offline', model: 'script'}}});
  let retiredHandle;
  try {
    const service = h.ctx.taskSystem.steward, projects = h.ctx.taskSystem.projects, ledger = h.ledger;
    projects.saveSettings({root: join(h.dir, 'projects'), expectedRevision: 0});
    const {projectId} = await projects.create({commandId: 'native-gate-project', title: 'Native gate project', goal: 'Repair, human acceptance, then decomposition'});
    const originalSession = projects.placementProject(projectId).session;
    ledger.createTask('native-root', {taskId: 'native-root', title: 'Workstream', policy: {settlementQuietMs: 0}});
    ledger.createTask('native-repair', {taskId: 'native-repair', title: 'Declared repair', parentTaskId: 'native-root'});
    projects.linkTask(originalSession, 'native-root');
    const arm = {gateId: 'native-gate', projectId, workstreamTaskId: 'native-root', upstreamTaskIds: ['native-repair'], instructionRef: 'actual-human-instruction'};
    ledger.withAcceptanceHumanAction({action: 'arm', reference: arm.instructionRef}, () => ledger.armAcceptanceGate('native-arm', arm));
    registerExecutor(ledger, 'native-gate-node', {nodeId: 'local', roles: ['both'], capabilities: [], models: [{provider: 'test-offline', model: 'script', reasoningEfforts: []}], workspaceIds: [], enabled: true});
    ledger.recordNodeHeartbeat('native-gate-ready', {nodeId: 'local', runtimeReady: true, activeExecutions: 0});
    const toolResults = [], attempted = [];
    h.ctx.on('tools/result', (exec, result) => {if (exec.name === 'task_dispatch') toolResults.push({error: result.error?.code, isError: result.isError, content: JSON.stringify(result.content)});});
    const dispatch = title => request => {
      const turn = ledger.managementDatabase().prepare("SELECT command FROM pr_turns WHERE session=? AND state='running'").get(request.sessionId);
      assert.ok(turn);
      const commandId = `project-message:${turn.command}`;
      assert.ok(JSON.stringify(request.messages).includes(commandId), 'Native model receives its trusted dispatch command');
      attempted.push(commandId);
      return {name: 'task_dispatch', args: {commandId, title, description: 'A formal downstream planning operation', nodeId: 'local'}};
    };
    const before = ledger.snapshot();
    h.adapter.script.push(dispatch('Forbidden decomposition'), 'The gate blocked formal planning.');
    await service.send({conversationId: 'main', commandId: 'native-blocked', text: 'Try to decompose before acceptance', target: {kind: 'project', projectId}});
    await waitFor(service, 'native-blocked');
    assert.equal(toolResults.at(-1).isError, true);
    assert.match(toolResults.at(-1).content, /ACCEPTANCE_REQUIRED|acceptance gate/, JSON.stringify(toolResults.at(-1)));
    assert.equal(ledger.getDecision(attempted[0]), undefined);
    assert.equal(ledger.snapshot().tasks.length, before.tasks.length);
    assert.equal(ledger.snapshot().runs.length, before.runs.length);
    retiredHandle = await h.ctx.agents.resume({resumeSessionId: SessionId(originalSession), agentOptions: {provider: 'test-offline', model: 'script'}});
    const retired = retiredHandle.agent;
    await projects.handoff(projectId);
    assert.throws(() => h.ctx.taskSystem.withDispatchOrigin(retired, () => ledger.createTask('retired-root', {title: 'A retired session cannot become unscoped'})), error => error.code === 'STALE_PROJECT_SESSION');
    const rejected = await h.ctx.tools.execute({callId: ToolCallId('retired-native-call'), name: 'task_dispatch', arguments: {commandId: 'retired-plan', title: 'A retired project plan'}, agent: retired, signal: new AbortController().signal});
    assert.equal(rejected.isError, true);
    await retiredHandle.dispose(); retiredHandle = undefined;
    const currentSession = projects.placementProject(projectId).session;
    assert.throws(() => ledger.withDispatchOrigin({kind: 'session', nodeId: 'foreign-peer', sessionId: currentSession}, () => ledger.createTask('foreign-root', {title: 'Peer-forged local PM'})), error => error.code === 'FORBIDDEN');
    const repair = ledger.createRun('native-repair-run', {taskId: 'native-repair', route: {nodeId: 'local', provider: 'test-offline', model: 'script', requiredCapabilities: []}}).value;
    const attempt = ledger.claim('native-repair-claim', {runId: repair.runId, nodeId: 'local', ttlMs: 10000}).value.attempt;
    ledger.submit('native-repair-submit', {runId: repair.runId, attemptId: attempt.attemptId, nodeId: 'local', fence: attempt.fence, outcome: 'success', summary: 'Repair is ready for acceptance', report: {title: 'Repair evidence', body: 'Exact synthetic repair result'}});
    const candidate = ledger.acceptanceGateView('native-gate');
    const accepted = service.gateDecide({conversationId: 'main', commandId: 'native-human-accept', gateId: 'native-gate', expectedRevision: candidate.revision, candidateDigest: candidate.candidate.digest, decision: 'accept', comment: 'I inspected this exact synthetic result'});
    h.adapter.script.push(dispatch('Native accepted decomposition'), 'Accepted downstream registered.');
    await service.gateContinue({conversationId: 'main', commandId: 'native-continue', gateId: 'native-gate', expectedRevision: accepted.revision, candidateDigest: accepted.candidate.digest, text: 'Begin the explicitly accepted decomposition now'});
    await waitFor(service, 'native-continue');
    assert.equal(toolResults.at(-1).isError, false);
    const downstream = ledger.snapshot().tasks.find(task => task.title === 'Native accepted decomposition');
    assert.ok(downstream);
    assert.equal(downstream.parentTaskId, 'native-root');
    projects.tick();
    assert.ok(ledger.history(downstream.taskId).runs.length);
    assert.equal(ledger.acceptanceGateView('native-gate').invocationCount, 1);
  } finally { await retiredHandle?.dispose(); await h.dispose(); }
});
