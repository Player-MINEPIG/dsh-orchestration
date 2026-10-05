import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import {
  readDecisionSettings,
  saveDecisionSettings,
} from "../../typed-decisions/dist/settings.js";
import { DshCompletionService } from "../../typed-decisions/dist/dsh-completion.js";
import { SaveDecisionInput } from "../dist/decision-settings.js";
const native = "@dsh-task/typed-decisions/dsh-completion",
  decision = "@dsh-task/typed-decisions";
function fixture() {
  const entries = [
    {
      options: {
        id: "decisions",
        name: decision,
        config: {
          defaultProvider: "rules",
          providers: [
            { id: "rules", kind: "rules", rulesVersion: "1", rules: [] },
            {
              id: "other",
              kind: "structured",
              models: [
                {
                  model: "other",
                  version: "old",
                  reasoningEfforts: [],
                  hidden: "preserved",
                },
              ],
              envRef: "do-not-change",
            },
          ],
          unknown: "preserved",
        },
      },
    },
    {
      options: {
        id: "completion",
        name: native,
        config: {
          routes: [
            {
              model: "other",
              provider: "offline",
              modelVersion: "old",
              reasoningEfforts: [],
              hidden: "preserved",
            },
          ],
          maxOutputTokens: 20,
          maxInputBytes: 1024,
          maxOutputBytes: 1024,
          maxRuntimeMs: 100,
          maxConcurrent: 1,
          unknown: "preserved",
        },
      },
    },
  ];
  const writes = [];
  let refuseDecision = false,
    refuseRollback = false;
  const editor = {
    entries: () => entries,
    async edit(entry, change) {
      if (entry.options.name === decision && refuseDecision)
        throw Error("synthetic persistence failure");
      if (entry.options.name === native && refuseRollback && writes.length)
        throw Error("synthetic rollback failure");
      const next = change(structuredClone(entry.options.config), {});
      entries.find((e) => e === entry).options.config = next;
      writes.push(entry.options.name);
    },
  };
  const services = {
    configEditor: editor,
    llm: {
      listProviders: () => [{ id: "offline", name: "Offline" }],
      listModels: async () => [
        { id: "old", name: "Old" },
        { id: "new", name: "New" },
      ],
      listConfigurableProviders: () => [
        {
          provider: "offline",
          settingsNs: "provider-config",
          settingsPath: [],
        },
      ],
    },
    settings: {
      describe: () => [
        { ns: "provider-config", value: { apiKeyEnv: "FIXTURE_MISSING_KEY" } },
      ],
    },
    credentials: {
      describe: async (ref) => {
        assert.equal(ref, "FIXTURE_MISSING_KEY");
        return { configured: false };
      },
    },
  };
  return {
    ctx: { get: (key) => services[key] },
    entries,
    writes,
    fail: (rollback = false) => {
      refuseDecision = true;
      refuseRollback = rollback;
    },
  };
}
test("official local catalog joins only credential metadata and exposes missing readiness", async () => {
  const f = fixture(),
    view = await readDecisionSettings(f.ctx);
  assert.equal(view.catalog[0].credential, "missing");
  assert.equal(
    view.readiness.find((r) => r.providerId === "other").status,
    "credential-missing",
  );
  assert.ok(!JSON.stringify(view).includes("FIXTURE_MISSING_KEY"));
  assert.ok(!JSON.stringify(view).includes("hidden"));
  assert.equal(f.writes.length, 0);
});
test("strict save accepts configured Models selections, rejects secrets and unavailable models, preserves unknown provider/route fields", async () => {
  const f = fixture(),
    view = await readDecisionSettings(f.ctx);
  const input = {
    expected: view.snapshot,
    selection: {
      kind: "structured",
      providerId: "other",
      nativeProvider: "offline",
      modelVersion: "new",
    },
  };
  assert.throws(() =>
    SaveDecisionInput.parse({
      ...input,
      selection: { ...input.selection, apiKey: "rejected" },
    }),
  );
  await assert.rejects(
    saveDecisionSettings(f.ctx, {
      ...input,
      selection: { ...input.selection, modelVersion: "unknown" },
    }),
    /DECISION_MODEL_UNAVAILABLE/,
  );
  assert.equal(f.writes.length, 0);
  await saveDecisionSettings(f.ctx, input);
  const provider = f.entries[0].options.config.providers.find(
    (p) => p.id === "other",
  );
  assert.equal(provider.models[0].version, "new");
  assert.equal(provider.models[1].hidden, "preserved");
  assert.equal(provider.envRef, "do-not-change");
  assert.equal(f.entries[1].options.config.routes[0].hidden, "preserved");
  assert.equal(f.entries[1].options.config.unknown, "preserved");
  await assert.rejects(saveDecisionSettings(f.ctx, input), /DECISION_CONFLICT/);
});
test("a failed second ConfigEditor save rolls back only this bridge addition; failed rollback is accurately partial", async () => {
  for (const rollbackFails of [false, true]) {
    const f = fixture(),
      before = structuredClone(f.entries[1].options.config),
      view = await readDecisionSettings(f.ctx);
    f.fail(rollbackFails);
    await assert.rejects(
      saveDecisionSettings(f.ctx, {
        expected: view.snapshot,
        selection: {
          kind: "structured",
          providerId: "ordinary",
          nativeProvider: "offline",
          modelVersion: "new",
        },
      }),
      rollbackFails ? /DECISION_PARTIAL_SAVE/ : /DECISION_SAVE_REJECTED/,
    );
    assert.equal(f.entries[0].options.config.defaultProvider, "rules");
    if (!rollbackFails) assert.deepEqual(f.entries[1].options.config, before);
  }
});
test("missing bridge does not fall back to an invented adapter and empty installed bridge stays idle", async () => {
  const f = fixture();
  f.entries.pop();
  const view = await readDecisionSettings(f.ctx);
  await assert.rejects(
    saveDecisionSettings(f.ctx, {
      expected: view.snapshot,
      selection: {
        kind: "structured",
        providerId: "ordinary",
        nativeProvider: "offline",
        modelVersion: "new",
      },
    }),
    /DECISION_BRIDGE_MISSING/,
  );
  const ctx = new Context();
  try {
    const service = new DshCompletionService(ctx, {
      routes: [],
      maxOutputTokens: 20,
      maxInputBytes: 1024,
      maxOutputBytes: 1024,
      maxRuntimeMs: 100,
      maxConcurrent: 1,
    });
    assert.equal(service.routes.length, 0);
    assert.equal(service.activeCount, 0);
  } finally {
    await ctx.fiber.dispose();
  }
});
