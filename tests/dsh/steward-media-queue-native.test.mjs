import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {createNativeHarness} from './native-harness.mjs';
import {ScriptedModel} from './scripted-model.mjs';
import {attachProjectSessionHost} from '../../packages/task-system/test/fixtures/project-session-host.mjs';
import {pinStewardTurnSelection} from '../../packages/task-system/dist/steward-turn-selection.js';
import {canonical} from '../../packages/task-system/dist/ledger.js';

const config = {role: 'both', schedulerEnabled: false, autoExecute: false, projectAgentOptions: {provider: 'test-offline', model: 'script'}};
const alpha = {provider: 'test-other', model: 'alpha', reasoningEffort: 'high'};
const beta = {provider: 'test-offline', model: 'beta'};
const latest = options => options.messages.findLast(message => message.role === 'user' && message.source?.kind === 'user');
async function until(read, reason) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(done => setTimeout(done, 10)); }
  throw Error(reason);
}
function gate() { let release; const promise = new Promise(done => release = done); return {promise, release}; }
async function hold(barrier, signal) {
  let stop;
  const aborted = new Promise((_, reject) => { stop = () => reject(signal.reason); signal.addEventListener('abort', stop, {once: true}); if (signal.aborted) stop(); });
  try { await Promise.race([barrier.promise, aborted]); } finally { signal.removeEventListener('abort', stop); }
}
function catalog(h, register = true) {
  h.adapter.listModels = async provider => ['script', 'alpha', 'beta'].map(id => ({provider, id, name: id}));
  h.adapter.resolveModel = async (provider, id) => ({provider, id, name: id, inputModalities: ['text', 'image'], reasoning: {efforts: [{id: 'high', name: 'High'}]}});
  if (register) h.ctx.llm.registerAdapter(['test-other'], h.adapter);
}
async function mount(h) { await attachProjectSessionHost(h); catalog(h); }
async function project(h, id = 'a') {
  const runtime = h.ctx.taskSystem.projects;
  if (!runtime.settings().root) runtime.saveSettings({root: join(h.dir, 'projects'), expectedRevision: 0});
  const {projectId} = await runtime.create({commandId: 'create-' + id, title: id, goal: id + ' context'});
  return {projectId, sessionId: runtime.placementProject(projectId).session};
}
function completed(h, id) {
  return until(() => h.ledger.managementDatabase().prepare("SELECT state FROM pr_turns WHERE command=?").get(id)?.state === 'completed', 'Queued request did not complete: ' + id);
}
async function events(h, sessionId) {
  const handle = await h.ctx.sessionPersistence.open(sessionId, 'read');
  try { return (await handle.read()).events; } finally { await handle.close(); }
}
async function file(h, value = 'exact attachment bytes') {
  return h.ctx.attachments.saveFileStream({name: 'proof.txt', data: (async function* () { yield Buffer.from(value); })()});
}
function pixel() {
  const chunk = (type, bytes) => {
    const input = Buffer.concat([Buffer.from(type), bytes]); let crc = 0xffffffff;
    for (const byte of input) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    const size = Buffer.alloc(4), check = Buffer.alloc(4); size.writeUInt32BE(bytes.length); check.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, input, check]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0,255,0,0,255]))), chunk('IEND', Buffer.alloc(0))]);
}
async function prompt(h, sessionId, id, text) {
  await h.ctx.sessionController.prompt({sessionId, requestId: id, mode: 'queue', content: [{type: 'text', text}]}, AbortSignal.timeout(15000));
  const agent = h.ctx.agents.get(sessionId);
  await agent.whenIdle();
  await h.ctx.sessions.flush(agent.session);
  return agent;
}

test('controller-owned live queue freezes rich content and each model through all steps without changing other sessions or the default', {timeout: 30000}, async () => {
  const h = await createNativeHarness({config}), barrier = gate();
  try {
    await mount(h);
    const a = await project(h), b = await project(h, 'b'), runtime = h.ctx.taskSystem.projects, db = h.ledger.managementDatabase();
    const live = await prompt(h, a.sessionId, 'seed-live', 'SEED');
    const unrelated = await prompt(h, b.sessionId, 'seed-other', 'OTHER_SEED');
    const defaultBefore = h.ctx.agentDefaultModel.currentSelection(), unrelatedBefore = unrelated.session.requestHeader().config;
    const removeSection = live.ctx.systemPrompt.section({name: 'model-proof', order: 1, text: 'ASSEMBLED_ROUTE={{provider}}/{{model}}'});
    const attachment = await file(h), image = await h.ctx.attachments.saveImage({mediaType: 'image/png', name: 'pixel.png', data: pixel()});
    const content = [{type: 'file', attachment}, {type: 'image', attachment: image}], frozenContent = structuredClone(content);
    const selection = {...alpha}, seen = [];
    h.adapter.stream = async function* (options) {
      this.requests.push(options); const id = latest(options)?.source.rpcId;
      seen.push({id, provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort,
        system: options.messages.filter(message => message.role === 'system').flatMap(message => message.content.filter(part => part.type === 'text').map(part => part.text)).join('\n')});
      if (id === 'rich-alpha' && seen.filter(row => row.id === id).length === 1) { await hold(barrier, options.signal); yield* new ScriptedModel([{name: 'task_nodes', args: {}}]).stream(options); }
      else yield* new ScriptedModel(['ANSWER:' + id]).stream(options);
    };
    runtime.send({projectId: a.projectId, commandId: 'rich-alpha', text: '', content, selection});
    await until(() => seen.some(row => row.id === 'rich-alpha'), 'Rich live request never reached the adapter');
    const secondContent = [{type: 'text', text: 'BETA'}, {type: 'file', attachment}], secondSelection = {...beta}, secondFrozen = structuredClone(secondContent);
    runtime.send({projectId: a.projectId, commandId: 'queued-beta', text: 'BETA', content: secondContent, selection: secondSelection});
    assert.equal(db.prepare("SELECT state FROM pr_turns WHERE command='queued-beta'").get().state, 'queued');
    selection.model = 'script'; secondSelection.model = 'script'; content[0].attachment.name = 'mutated.txt';
    await prompt(h, b.sessionId, 'unrelated-while-held', 'UNRELATED');
    assert.deepEqual(unrelated.session.requestHeader().config, unrelatedBefore);
    barrier.release(); await completed(h, 'queued-beta');
    const alphaRequests = seen.filter(row => row.id === 'rich-alpha');
    assert.equal(alphaRequests.length, 2, 'The tool continuation runs with the same pinned choice');
    for (const row of alphaRequests) { assert.equal(row.provider, alpha.provider); assert.equal(row.model, alpha.model); assert.equal(row.reasoningEffort, 'high'); assert.match(row.system, /ASSEMBLED_ROUTE=test-other\/alpha/); }
    const second = seen.find(row => row.id === 'queued-beta'); assert.equal(second.model, 'beta'); assert.equal(second.reasoningEffort, undefined); assert.match(second.system, /ASSEMBLED_ROUTE=test-offline\/beta/);
    const log = await events(h, a.sessionId), message = log.find(event => event.type === 'user/message' && event.data.source.rpcId === 'rich-alpha');
    assert.deepEqual(message.data.content, frozenContent);
    assert.deepEqual(log.find(event => event.type === 'user/message' && event.data.source.rpcId === 'queued-beta').data.content, secondFrozen);
    assert.equal(log.filter(event => event.type === 'user/message' && event.data.source.rpcId === 'rich-alpha').length, 1);
    assert.deepEqual(h.ctx.agentDefaultModel.currentSelection(), defaultBefore);
    assert.deepEqual(live.session.requestHeader().config, {provider: 'test-offline', model: 'beta'});
    assert.equal(h.ctx.sessionProjections.stateOf(live.session, 'modelSelection').lastUsed.model, 'beta');
    removeSection();
  } finally { barrier.release(); await h.dispose(); }
});

test('cold managed rich queue survives host restart with exact content, model and idempotency, preserving legacy text digests', {timeout: 30000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'steward-media-restart-'));
  let h = await createNativeHarness({dir, config, registerScriptedProvider: false});
  try {
    await attachProjectSessionHost(h);
    const a = await project(h), runtime = h.ctx.taskSystem.projects, attachment = await file(h, 'restart bytes');
    const request = {projectId: a.projectId, commandId: 'durable-rich', text: '', content: [{type: 'file', attachment}], selection: alpha};
    runtime.send(request); runtime.send(request);
    assert.throws(() => runtime.send({...request, selection: beta}), error => error.code === 'CONFLICT');
    assert.throws(() => runtime.send({...request, content: [{type: 'file', attachment: {...attachment, name: 'changed'}}]}), error => error.code === 'CONFLICT');
    runtime.send({projectId: a.projectId, commandId: 'legacy', text: 'LEGACY'});
    const expectedDigest = createHash('sha256').update(canonical({projectId: a.projectId, text: 'LEGACY'})).digest('hex');
    assert.equal(h.ledger.managementDatabase().prepare("SELECT digest FROM pr_turns WHERE command='legacy'").get().digest, expectedDigest);
    assert.equal(h.ctx.agents.get(a.sessionId), undefined);
    await h.dispose(); h = await createNativeHarness({dir, config, registerScriptedProvider: false});
    await attachProjectSessionHost(h); catalog(h, false);
    const seen = [], errors = [];
    h.ctx.on('agent/error', ({error}) => errors.push(String(error?.stack ?? error)));
    h.adapter.stream = async function* (options) { this.requests.push(options); seen.push({id: latest(options)?.source.rpcId, model: options.model, provider: options.provider, effort: options.reasoningEffort}); yield* new ScriptedModel(['RESTART_OK']).stream(options); };
    h.ctx.llm.registerAdapter(['test-offline', 'test-other'], h.adapter);
    h.ctx.taskSystem.projects.resumeConversationQueue(); await completed(h, 'legacy');
    assert.deepEqual(seen.map(row => row.id), ['durable-rich', 'legacy'], JSON.stringify({errors, rows: h.ledger.managementDatabase().prepare('SELECT command,state,error,native_admission FROM pr_turns').all()}));
    assert.deepEqual(seen[0], {id: 'durable-rich', provider: alpha.provider, model: alpha.model, effort: 'high'});
    const log = await events(h, a.sessionId);
    assert.deepEqual(log.find(event => event.type === 'user/message' && event.data.source.rpcId === request.commandId).data.content, request.content);
    h.ctx.taskSystem.projects.send(request); assert.equal(seen.length, 2);
    const data = []; for await (const bytes of h.ctx.attachments.readFileStream(attachment)) data.push(bytes);
    assert.equal(Buffer.concat(data).toString(), 'restart bytes');
    assert.deepEqual(h.ctx.agentDefaultModel.currentSelection(), {provider: 'test-offline', model: 'script'});
  } finally { await h.dispose(); rmSync(dir, {recursive: true, force: true}); }
});

test('public turn pin ignores earlier ordinary messages and cleans up after its exact native turn', {timeout: 30000}, async () => {
  const h = await createNativeHarness({config});
  try {
    await mount(h); const a = await project(h), agent = await prompt(h, a.sessionId, 'initial', 'INITIAL');
    const before = h.ctx.agentDefaultModel.currentSelection(), seen = [];
    h.adapter.stream = async function* (options) { this.requests.push(options); seen.push({id: latest(options)?.source.rpcId, model: options.model}); yield* new ScriptedModel(['OK']).stream(options); };
    const dispose = pinStewardTurnSelection(agent, 'exact-pinned', alpha);
    await prompt(h, a.sessionId, 'earlier-ordinary', 'EARLIER');
    await prompt(h, a.sessionId, 'exact-pinned', 'PINNED');
    const after = pinStewardTurnSelection(agent, 'second-pinned', beta);
    await prompt(h, a.sessionId, 'second-pinned', 'SECOND');
    await prompt(h, a.sessionId, 'after-pins', 'AFTER');
    assert.deepEqual(seen.map(row => row.model), ['script', 'alpha', 'beta', 'beta']);
    assert.deepEqual(h.ctx.agentDefaultModel.currentSelection(), before);
    dispose(); dispose(); after();
    const runtime = h.ctx.taskSystem.projects, db = h.ledger.managementDatabase();
    runtime.send({projectId: a.projectId, commandId: 'invalid-effort', text: 'INVALID', selection: {...beta, reasoningEffort: 'unsupported'}});
    await until(() => db.prepare("SELECT state FROM pr_turns WHERE command='invalid-effort'").get().state === 'failed', 'Unavailable effort was not rejected before native admission');
    assert.equal(db.prepare("SELECT native_admission FROM pr_turns WHERE command='invalid-effort'").get().native_admission, 'not-started');
    assert.equal(seen.some(row => row.id === 'invalid-effort'), false);
  } finally { await h.dispose(); }
});

test('optional rich queue columns migrate legacy rows once across repeated native startup', {timeout: 30000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'steward-media-migration-'));
  let h = await createNativeHarness({dir, config, registerScriptedProvider: false});
  try {
    const a = await project(h);
    h.ctx.taskSystem.projects.send({projectId: a.projectId, commandId: 'legacy-before-migration', text: 'PRESERVE'});
    const before = {...h.ledger.managementDatabase().prepare("SELECT digest,state,native_admission FROM pr_turns WHERE command='legacy-before-migration'").get()};
    await h.dispose();
    const old = new DatabaseSync(join(dir, 'tasks.sqlite'));
    try { old.exec('ALTER TABLE pr_turns DROP COLUMN content; ALTER TABLE pr_turns DROP COLUMN selection'); } finally { old.close(); }
    for (let restart = 0; restart < 2; restart++) {
      h = await createNativeHarness({dir, config, registerScriptedProvider: false});
      const db = h.ledger.managementDatabase(), columns = db.prepare('PRAGMA table_info(pr_turns)').all();
      for (const name of ['content', 'selection']) assert.equal(columns.filter(row => row.name === name).length, 1);
      assert.deepEqual({...db.prepare("SELECT digest,state,native_admission FROM pr_turns WHERE command='legacy-before-migration'").get()}, before);
      assert.deepEqual({...db.prepare("SELECT content,selection FROM pr_turns WHERE command='legacy-before-migration'").get()}, {content: null, selection: null});
      assert.equal(h.adapter.requests.length, 0);
      if (restart === 0) await h.dispose();
    }
  } finally { await h.dispose(); rmSync(dir, {recursive: true, force: true}); }
});
