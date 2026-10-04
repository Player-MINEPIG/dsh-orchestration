import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { ScriptedModel } from './scripted-model.mjs';

export const name = 'independent-capability-probe';
const capability = process.env.DSH_TEST_CAPABILITY;
export const inject = capability === 'typed' ? ['typedDecisions', 'typedDecisionCompletion', 'llm'] : capability === 'feishu' ? ['feishuChannel', 'agents', 'agentLoop'] : ['remoteExecution', 'taskSystem'];

export async function apply(ctx) {
  let result;
  if (capability === 'typed') {
    assert.equal(ctx.get('taskSystem'), undefined, 'typed rules provider must not require task system');
    assert.equal(ctx.get('remoteExecution'), undefined);
    const receipt = await ctx.typedDecisions.evaluate({ requestId: 'installed-rules', stateHash: 'fixture-1', context: { approved: true }, questions: [{ questionId: 'persist', questionVersion: '1', type: 'noul', instructions: 'Is the fixture approved?' }] });
    assert.equal(receipt.status, 'answered');
    assert.equal(receipt.answers.persist.noul, 1);
    assert.equal(receipt.evidence.kind, 'deterministic');
    assert.ok(ctx.get('typedDecisionCompletion'), 'installed optional ordinary-model bridge must boot');
    const adapter = new ScriptedModel(['{"verified":true}']);
    ctx.llm.registerAdapter(['installed-offline'], adapter);
    const completion = await ctx.typedDecisionCompletion.complete({ model: 'offline-judge', modelVersion: 'script', system: 'Offline installed module test', input: { verify: true }, responseSchema: { type: 'object', properties: { verified: { type: 'boolean' } }, required: ['verified'], additionalProperties: false }, signal: new AbortController().signal });
    assert.equal(completion.output, '{"verified":true}');
    assert.equal(completion.modelVersionSource, 'configured-pin');
    assert.equal(adapter.requests.length, 1);
    assert.deepEqual(adapter.requests[0].tools, []);
    result = { independent: true, service: 'typedDecisions', status: receipt.status, evidence: receipt.evidence, ordinaryModelBridge: 'installed-native-service-scripted-model' };
  } else if (capability === 'feishu') {
    assert.equal(ctx.get('taskSystem'), undefined, 'standalone channel must not require task system');
    assert.equal(ctx.get('typedDecisions'), undefined);
    assert.equal(ctx.feishuChannel.inspect().enabled, false, 'default profile opens no authenticated connection');
    const detach = ctx.feishuChannel.consume(async () => ({ text: 'Offline standalone consumer' }));
    assert.equal(ctx.feishuChannel.inspect().consumerAttached, true);
    detach();
    assert.equal(ctx.feishuChannel.inspect().consumerAttached, false);
    assert.ok(ctx.get('agents') && ctx.get('agentLoop'), 'real host has optional chat runtime dependencies');
    assert.equal(ctx.get('feishuChat'), undefined, 'installed optional chat module remains disabled without explicit opt-in');
    result = { independent: true, service: 'feishuChannel', enabled: false, consumerLifecycle: true, optionalNativeChat: 'installed-and-disabled', liveDelivery: false };
  } else {
    assert.equal(ctx.get('typedDecisions'), undefined, 'remote bridge must not require typed decisions');
    const gateway = ctx.remoteExecution.gateway;
    assert.ok(gateway);
    const ledger = ctx.taskSystem.ledger;
    const privateKey = createPrivateKey(readFileSync(process.env.DSH_TEST_PEER_KEY));
    const { signEnvelope } = await import(pathToFileURL(join(process.env.DSH_TEST_PROFILE_DIR, 'node_modules/@dsh-task/task-system/dist/remote/api.js')).href);
    ledger.registerWorkspace('remote-probe-workspace', { workspaceId: 'probe-workspace', nodeId: 'probe-node', path: process.cwd(), label: 'Isolated protocol probe workspace', state: 'ready', createdAt: new Date().toISOString() });
    ledger.registerNode('remote-probe-node', { nodeId: 'probe-node', roles: ['executor'], capabilities: ['offline-probe'], models: [{ provider: 'fixture', model: 'protocol-only', reasoningEfforts: [] }], workspaceIds: ['probe-workspace'], enabled: true, lastSeenAt: new Date().toISOString() });
    let semanticChecks = 0;
    const unregisterValidator = ledger.registerResultValidator('offline-protocol-v1', ({ submission }) => { semanticChecks++; return { valid: submission.report?.data?.verified === true }; });
    ctx.effect(() => unregisterValidator);
    const task = ledger.createTask('remote-probe-task', { title: 'Synthetic external peer protocol acceptance' }).value;
    const run = ledger.createRun('remote-probe-run', { taskId: task.taskId, configuration: { input: {}, template: { templateId: 'offline-protocol', version: 1, name: 'Installed semantic check', description: '', defaults: {}, inputSchema: { type: 'object' }, resultContract: { type: 'object' }, resultValidator: 'offline-protocol-v1' } }, route: { nodeId: 'probe-node', provider: 'fixture', model: 'protocol-only', workspaceId: 'probe-workspace', requiredCapabilities: ['offline-probe'] } }).value;
    let sequence = 0;
    const envelope = (operation, payload) => signEnvelope({ version: 1, keyId: 'probe-key', nodeId: 'probe-node', audience: 'task-coordinator', commandId: `probe-command-${++sequence}`, nonce: `probe-nonce-${sequence}`, sequence, issuedAt: Date.now(), expiresAt: Date.now() + 30000, operation, payload }, privateKey);
    const first = envelope('claim', { runId: run.runId, ttlMs: 10000 });
    const claimed = await gateway.handle(JSON.stringify(first));
    assert.equal(claimed.state, 'done');
    await assert.rejects(gateway.handle(JSON.stringify(first)), /REPLAY/, 'reusing the authenticated nonce is rejected');
    const { signature, ...retry } = envelope('claim', { runId: run.runId, ttlMs: 10000 });
    const retransmission = signEnvelope({ ...retry, commandId: first.commandId }, privateKey);
    assert.deepEqual(await gateway.handle(JSON.stringify(retransmission)), claimed, 'same command with fresh authenticated nonce recovers one receipt');
    await assert.rejects(gateway.handle(JSON.stringify({ ...first, payload: { runId: 'forged', ttlMs: 10000 } })), /BAD_SIGNATURE/);
    const claim = claimed.result.value;
    const ref = { runId: run.runId, attemptId: claim.attempt.attemptId, fence: claim.attempt.fence, executionId: 'offline-cli-owner' };
    await gateway.handle(JSON.stringify(envelope('markRunning', ref)));
    await gateway.handle(JSON.stringify(envelope('bindSession', { ...ref, sessionId: 'external-protocol-session' })));
    const submitted = await gateway.handle(JSON.stringify(envelope('submit', { ...ref, outcome: 'success', summary: 'Synthetic protocol fixture acknowledged', report: { title: 'Protocol fixture', body: 'External peer test result; no live model or remote workload was run.', data: { verified: true }, schemaId: 'offline-protocol-v1' } })));
    assert.equal(submitted.state, 'done');
    assert.equal(ledger.getRun(run.runId).state, 'succeeded');
    assert.equal(ledger.history(task.taskId).reports.length, 1);
    assert.deepEqual(ledger.history(task.taskId).reports[0].data, { verified: true });
    assert.equal(semanticChecks, 1);
    const observed = await gateway.handle(JSON.stringify(envelope('observe', { workspaceId: 'probe-workspace', sessionId: 'external-observed-session', sourceRevision: '1', title: 'Synthetic observation', body: 'Bounded external peer text fixture', observedAt: new Date().toISOString(), truncated: false })));
    assert.equal(observed.state, 'done');
    assert.equal(ledger.observationCandidates('pending').length, 1);
    assert.equal(ledger.snapshot().tasks.length, 1, 'observation intake never creates a task or dispatches a run');
    assert.equal(ledger.snapshot().runs.length, 1);
    result = { independentOfDecisions: true, service: 'remoteExecution', signedPeerRoundtrip: true, structuredReport: true, registeredSemanticValidator: true, signedObservationOnly: true, commandReceiptRecovered: true, nonceReplayRejected: true, forgedSignatureRejected: true, externalPeer: 'offline-fixture' };
  }
  writeFileSync(process.env.DSH_TASK_PROBE_OUT, JSON.stringify({ ok: true, ...result }));
  const timer = setInterval(() => {}, 1000);
  ctx.effect(() => () => clearInterval(timer));
}
