import test from "node:test";
import assert from "node:assert/strict";
import {
  DecisionEngine,
  RulesProvider,
  StructuredModelProvider,
  digest,
  validateRequest,
} from "../dist/core.js";
import { Config, createEngine } from "../dist/index.js";
import {
  readDecisionConsole,
  decisionConsoleCommand,
  validateRules,
} from "../dist/console.js";
import { TypedDecisionSettings, descriptors } from "../dist/console-server.js";
const question = {
  questionId: "q",
  questionVersion: "1",
  type: "choice",
  instructions: "Choose",
  candidates: { yes: null, no: null },
};
const request = (id) => ({
  requestId: id,
  stateHash: "state",
  context: { flag: true },
  questions: [question],
});
const rule = {
  questionId: "q",
  questionVersion: "1",
  path: ["flag"],
  equals: true,
  answer: { type: "choice", choice: "yes" },
};
function fixture() {
  let calls = 0,
    effort;
  const rows = [
    {
      options: {
        id: "decision",
        name: "@dsh-task/typed-decisions",
        config: {
          defaultProvider: "rules",
          providers: [
            { id: "rules", kind: "rules", rulesVersion: "1", rules: [] },
          ],
          privateReference: "preserve-secret-reference",
        },
      },
    },
    {
      options: {
        id: "bridge",
        name: "@dsh-task/typed-decisions/dsh-completion",
        config: {
          routes: [],
          maxOutputTokens: 64,
          maxInputBytes: 1024,
          maxOutputBytes: 1024,
          maxRuntimeMs: 1000,
          maxConcurrent: 1,
        },
      },
    },
  ];
  const services = {
    configEditor: {
      entries: () => rows,
      edit: async (row, change) => {
        row.options.config = change(row.options.config, {});
      },
    },
    llm: {
      listProviders: () => [{ id: "native", name: "Native" }],
      listModels: async () => [{ id: "model-v1", name: "Model" }],
      resolveModelInfo: async () => ({
        reasoning: { efforts: [{ id: "high" }, { id: "low" }] },
      }),
    },
    typedDecisionCompletion: {
      complete: async (input) => {
        calls++;
        effort = input.reasoningEffort;
        return {
          modelVersion: input.modelVersion,
          modelVersionSource: "configured-pin",
          output: { answers: { connection: { type: "choice", choice: "ok" } } },
        };
      },
    },
  };
  const ctx = { get: (name) => services[name] };
  return {
    ctx,
    rows,
    services,
    get calls() {
      return calls;
    },
    get effort() {
      return effort;
    },
  };
}
async function command(f, action, extra) {
  const view = await readDecisionConsole(f.ctx);
  return decisionConsoleCommand(f.ctx, {
    action,
    expected: view.revision,
    ...extra,
  });
}

test("preset resolves fixed route and effort, preserves caller digest and validates unknown/conflicting routes", async () => {
  let actual;
  const provider = new StructuredModelProvider(
    "llm",
    [{ model: "model", version: "v1", reasoningEfforts: ["high"] }],
    {
      complete: async (input) => {
        actual = input;
        return {
          modelVersion: "v1",
          output: { answers: { q: { type: "choice", choice: "yes" } } },
        };
      },
    },
  );
  const evaluate = provider.evaluate.bind(provider);
  provider.evaluate = call => {
    validateRequest(call.request);
    assert.equal(call.request.preset, undefined);
    return evaluate(call);
  };
  const engine = new DecisionEngine([provider], {
    defaultProvider: "llm",
    presets: [
      {
        id: "work",
        name: "Work",
        provider: "llm",
        model: "model",
        reasoningEffort: "high",
      },
    ],
    defaultPreset: "work",
  });
  const input = { ...request("preset"), preset: "work" };
  const receipt = await engine.evaluate(input);
  assert.equal(receipt.status, "answered");
  assert.equal(receipt.requestDigest, digest(input));
  assert.equal(actual.reasoningEffort, "high");
  assert.equal(await engine.evaluate(input), receipt);
  assert.throws(
    () => engine.evaluate({ ...request("unknown"), preset: "missing" }),
    /preset is not configured/,
  );
  assert.throws(
    () =>
      engine.evaluate({ ...request("mix"), preset: "work", provider: "llm" }),
    /cannot be mixed/,
  );
  await engine.close();
});

test("independent console creates/edits named presets and rules with protected references and stale write rejection", async () => {
  const f = fixture(),
    initial = await readDecisionConsole(f.ctx);
  assert.equal(initial.presets[0].id, "default");
  assert.ok(!JSON.stringify(initial).includes("preserve-secret-reference"));
  await command(f, "saveRules", { id: "routing", rules: [rule] });
  await command(f, "savePreset", {
    id: "routing-preset",
    name: "Routing",
    selection: { kind: "rules", providerId: "routing" },
  });
  await command(f, "setBinding", {
    consumer: "some-other-plugin",
    id: "routing-preset",
  });
  const view = await readDecisionConsole(f.ctx);
  assert.equal(view.bindings["some-other-plugin"], "routing-preset");
  const engine = createEngine(
    f.ctx,
    Config(structuredClone(f.rows[0].options.config)),
  );
  assert.equal(
    (await engine.evaluate({ ...request("rules"), preset: "routing-preset" }))
      .answers.q.choice,
    "yes",
  );
  await engine.close();
  await assert.rejects(
    command(f, "deleteRules", { id: "routing" }),
    (e) => e.code === "DECISION_IN_USE",
  );
  await assert.rejects(
    command(f, "deletePreset", { id: "routing-preset" }),
    (e) => e.code === "DECISION_IN_USE",
  );
  await assert.rejects(
    decisionConsoleCommand(f.ctx, {
      action: "saveRules",
      expected: initial.revision,
      id: "routing",
      rules: [],
    }),
    (e) => e.code === "DECISION_CONFLICT",
  );
  const priorVersion = view.rulesets.find((r) => r.id === "routing").version;
  await command(f, "saveRules", {
    id: "routing",
    rules: [{ ...rule, answer: { type: "choice", choice: "no" } }],
  });
  assert.notEqual(
    (await readDecisionConsole(f.ctx)).rulesets.find((r) => r.id === "routing")
      .version,
    priorVersion,
  );
  assert.equal(
    f.rows[0].options.config.privateReference,
    "preserve-secret-reference",
  );
  await command(f, "setBinding", { consumer: "some-other-plugin", id: "" });
  await command(f, "deletePreset", { id: "routing-preset" });
  await command(f, "deleteRules", { id: "routing" });
});

test("model preset adds route atomically, keeps another preset fixed, and real probe evaluates once", async () => {
  const f = fixture();
  await command(f, "savePreset", {
    id: "work",
    name: "Work",
    selection: {
      kind: "structured",
      providerId: "unused",
      nativeProvider: "native",
      modelVersion: "model-v1",
    },
    reasoningEffort: "high",
  });
  const saved = await readDecisionConsole(f.ctx);
  assert.equal(
    saved.presets.find((p) => p.id === "work").reasoningEffort,
    "high",
  );
  assert.equal(saved.snapshot.defaultProvider, "rules");
  assert.equal(saved.snapshot.completion.routes.length, 1);
  await command(f, "savePreset", {
    id: "fast",
    name: "Fast",
    selection: {
      kind: "structured",
      providerId: "unused",
      nativeProvider: "native",
      modelVersion: "model-v1",
    },
    reasoningEffort: "low",
  });
  await command(f, "savePreset", {
    id: "work",
    name: "Work renamed",
    selection: {
      kind: "structured",
      providerId: "unused",
      nativeProvider: "native",
      modelVersion: "model-v1",
    },
    reasoningEffort: "high",
  });
  const now = await readDecisionConsole(f.ctx);
  assert.equal(now.presets.find((p) => p.id === "fast").reasoningEffort, "low");
  assert.notEqual(
    now.presets.find((p) => p.id === "fast").provider,
    now.presets.find((p) => p.id === "work").provider,
  );
  const result = await decisionConsoleCommand(f.ctx, {
    action: "checkConnection",
    id: "work",
  });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "model-api");
  assert.equal(f.calls, 1);
  assert.equal(f.effort, "high");
  const local = await decisionConsoleCommand(f.ctx, {
    action: "checkConnection",
    id: "default",
  });
  assert.equal(local.kind, "local-rules");
  assert.equal(f.calls, 1);
});

test("invalid effort rolls bridge back without changing presets; active task prevents writes", async () => {
  const f = fixture();
  await assert.rejects(
    command(f, "savePreset", {
      id: "bad",
      name: "Bad",
      selection: {
        kind: "structured",
        providerId: "x",
        nativeProvider: "native",
        modelVersion: "model-v1",
      },
      reasoningEffort: "ultra",
    }),
    (e) => e.code === "DECISION_EFFORT_UNSUPPORTED",
  );
  assert.deepEqual(f.rows[1].options.config.routes, []);
  assert.equal(f.rows[0].options.config.presets, undefined);
  f.services.taskSystem = {
    beginConfigurationEdit() {
      throw Object.assign(Error("busy"), { code: "CONFIGURATION_BUSY" });
    },
  };
  await assert.rejects(
    command(f, "saveRules", { id: "routing", rules: [] }),
    (e) => e.code === "DECISION_BUSY",
  );
  assert.equal(f.rows[0].options.config.providers.length, 1);
});

test("rules reject invalid answers and unsafe paths, RPC errors remain bounded and descriptors independent", async () => {
  assert.throws(() =>
    validateRules([{ ...rule, answer: { type: "noul", noul: 2 } }]),
  );
  assert.throws(() => validateRules([{ ...rule, path: ["__proto__"] }]));
  const f = fixture();
  await assert.rejects(
    decisionConsoleCommand(f.ctx, {
      action: "saveRules",
      expected: (await readDecisionConsole(f.ctx)).revision,
      id: "r",
      rules: [],
      apiKey: "secret",
    }),
  );
  assert.equal(descriptors.length, 3);
  assert.ok(descriptors.every((d) => d.service === "typedDecisionSettings"));
  // Native service is independently provided; no task/remote database is required.
  assert.equal(typeof TypedDecisionSettings.prototype.command, "function");
});

test('API presets clone registered adapters and preserve credential references without changing another preset', async () => {
  const f=fixture();
  f.rows[0].options.config.providers.push({id:'registered',kind:'compatible',endpoint:'https://example.test/v1/systemone',model:'local-v1',modelVersion:'local-v1',apiKeyEnv:'PRIVATE_EXISTING_API_KEY',maxResponseBytes:1024,custom:'keep',capabilityDeclaration:{readout:'logits',calibration:'L0',maxChoices:26,maxScoreLevels:10,questionTypes:['choice'],reasoningEfforts:[]}});
  await command(f,'savePreset',{id:'api-one',name:'API one',selection:{kind:'compatible',providerId:'registered',endpoint:'https://example.test/v1/systemone',model:'local-v1',modelVersion:'local-v1'}});
  await command(f,'savePreset',{id:'api-two',name:'API two',selection:{kind:'compatible',providerId:'registered',endpoint:'https://example.test/v2/systemone',model:'local-v2',modelVersion:'local-v2'}});
  const providers=f.rows[0].options.config.providers;
  assert.equal(providers.find(p=>p.id==='registered').model,'local-v1');
  assert.equal(providers.find(p=>p.id==='preset:api-one:compatible').model,'local-v1');
  assert.equal(providers.find(p=>p.id==='preset:api-two:compatible').apiKeyEnv,'PRIVATE_EXISTING_API_KEY');
  assert.equal(providers.find(p=>p.id==='preset:api-two:compatible').custom,'keep');
  const view=await readDecisionConsole(f.ctx);assert.ok(!JSON.stringify(view).includes('PRIVATE_EXISTING_API_KEY'));
  const probe=await decisionConsoleCommand(f.ctx,{action:'checkConnection',id:'api-one'});
  assert.equal(probe.code,'CREDENTIAL_MISSING');assert.equal(probe.ok,false);assert.equal(f.calls,0);
});

test('API preset owns its stored key, public view never reveals it, rotation reaches next call and clear removes only that key', async () => {
  const f = fixture(), secrets = new Map([['TYPESAFE_API_KEY', 'shared-fixture-key']]);
  f.services.credentials = {
    resolve: async ref => secrets.has(ref) ? {value: secrets.get(ref)} : undefined,
    describe: async ref => ({configured: secrets.has(ref), writable: true}),
    set: async (ref, key) => { secrets.set(ref, key); },
    unset: async ref => { secrets.delete(ref); },
  };
  const selection = {kind:'jev',providerId:'new-jev',model:'jev-1.13.0',modelVersion:'jev-1.13.0'};
  await command(f,'savePreset',{id:'jev-one',name:'Jev one',selection:{...selection}});
  await command(f,'savePreset',{id:'jev-two',name:'Jev two',selection:{...selection}});
  await command(f,'setApiKey',{id:'jev-one',apiKey:'fixture-private-key-one'});
  let view = await readDecisionConsole(f.ctx);
  assert.ok(!JSON.stringify(view).includes('fixture-private-key-one'));
  assert.ok(!JSON.stringify(f.rows).includes('fixture-private-key-one'));
  assert.deepEqual(view.apiCredentials.find(p=>p.providerId==='preset:jev-one:jev'), {providerId:'preset:jev-one:jev',configured:true,writable:true,managed:true});
  assert.equal(f.rows[0].options.config.providers.find(p=>p.id==='preset:jev-two:jev').apiKeyEnv,'TYPESAFE_API_KEY');
  const engine = createEngine(f.ctx, Config(structuredClone(f.rows[0].options.config)));
  const previousFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (_url, options) => {
    seen = options.headers.authorization;
    return new Response(JSON.stringify({model:'jev-1.13.0',answers:{q:{type:'choice',choice:'yes',probabilities:{yes:0.8,no:0.2},confidence:0.6}},usage:{input_tokens:1,output_tokens:0}}),{status:200});
  };
  try {
    assert.equal((await engine.evaluate({...request('stored-one'),preset:'jev-one'})).status,'answered');
    assert.equal(seen,'Bearer fixture-private-key-one');
    await command(f,'setApiKey',{id:'jev-one',apiKey:'fixture-private-key-two'});
    await engine.evaluate({...request('stored-two'),preset:'jev-one'});
    assert.equal(seen,'Bearer fixture-private-key-two');
  } finally {globalThis.fetch = previousFetch; await engine.close();}
  await command(f,'clearApiKey',{id:'jev-one'});
  assert.equal(secrets.get('TYPESAFE_API_KEY'),'shared-fixture-key');
  view = await readDecisionConsole(f.ctx);
  assert.equal(view.apiCredentials.find(p=>p.providerId==='preset:jev-one:jev').configured,false);
  assert.equal((await decisionConsoleCommand(f.ctx,{action:'checkConnection',id:'jev-one'})).code,'CREDENTIAL_MISSING');
});

test('credential failure rolls back private store, rejects stale changes and refuses removing external credentials', async () => {
  const f = fixture(), secrets = new Map();
  f.services.credentials = {
    resolve: async ref => secrets.has(ref) ? {value:secrets.get(ref)} : undefined,
    describe: async ref => ({configured:secrets.has(ref),writable:true}),
    set: async (ref,key) => {secrets.set(ref,key);}, unset: async ref => {secrets.delete(ref);},
  };
  await command(f,'savePreset',{id:'jev-one',name:'Jev one',selection:{kind:'jev',providerId:'new-jev',model:'jev-1.13.0',modelVersion:'jev-1.13.0'}});
  await assert.rejects(command(f,'clearApiKey',{id:'jev-one'}),{code:'DECISION_CREDENTIAL_EXTERNAL'});
  await assert.rejects(command(f,'setApiKey',{id:'jev-one',apiKey:'bad\nkey'}),{code:'DECISION_INPUT_INVALID'});
  const view = await readDecisionConsole(f.ctx);
  f.rows[0].options.config.providers[1].apiKeyEnv='CHANGED_REFERENCE';
  await assert.rejects(decisionConsoleCommand(f.ctx,{action:'setApiKey',expected:view.revision,id:'jev-one',apiKey:'fixture-key'}),{code:'DECISION_CONFLICT'});
  const edit = f.services.configEditor.edit;
  f.services.configEditor.edit = async () => {throw Error('private config failure');};
  await assert.rejects(command(f,'setApiKey',{id:'jev-one',apiKey:'fixture-key'}),{code:'DECISION_SAVE_REJECTED'});
  assert.equal(secrets.size,0);
  f.services.configEditor.edit = edit;
});

test('preset bindings save live during execution without invoking restart guards',async()=>{
 const f=fixture();let guards=0;f.services.taskSystem={beginConfigurationEdit(){guards++;throw Error('active task')}};
 f.services.remoteExecution={beginConfigurationEdit(){guards++;throw Error('recovery')}};
 f.services.typedDecisions={activeCount:1};
 const result=await command(f,'setBinding',{consumer:'task-planning',id:'default'});
 assert.equal(result.applies,'live');assert.equal(guards,0);assert.equal(f.rows[0].options.config.bindings['task-planning'],'default');
});
