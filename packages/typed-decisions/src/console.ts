/** Independent, non-secret operator configuration. Consumers own their choice of preset. */
import type { Context } from "@deepseek-ai/cordis";
import { credentialStore, apiKeyStatus } from "./credentials.js";
import { randomUUID } from "node:crypto";
import { Config, configuredPresets, createEngine } from "./index.js";
import { RulesProvider, type DecisionRule } from "./providers.js";
import {
  DecisionSettingsError,
  owner,
  overlayOwns,
  readDecisionSettings,
  saveDecisionSettings,
  type DecisionSelection,
} from "./settings.js";
import {
  digest,
  id,
  json,
  keys,
  object,
  text,
  validateAnswer,
} from "./validation.js";
import type { DecisionPreset, DecisionQuestion } from "./types.js";

type Raw = Record<string, any>;
function reject(code: string): never {
  throw new DecisionSettingsError(code);
}
function publicState(raw: Raw) {
  const presets = configuredPresets(raw as Config);
  return {
    presets,
    defaultPreset: raw.defaultPreset || (raw.presets?.length ? "" : "default"),
    bindings: { ...(raw.bindings ?? {}) } as Record<string, string>,
    rulesets: (
      raw.providers ?? [
        { id: "rules", kind: "rules", rulesVersion: "1", rules: [] },
      ]
    )
      .filter((p: Raw) => p.kind === "rules")
      .map((p: Raw) => ({
        id: p.id,
        version: p.rulesVersion ?? "1",
        rules: p.rules ?? [],
      })),
  };
}
function revision(
  ctx: Context,
  raw = owner(ctx).decision?.options.config ?? {},
  completionRoutes?: unknown,
) {
  const state = owner(ctx);
  return digest({
    entry: state.decision?.options.id ?? null,
    ...publicState(raw),
    defaultProvider: raw.defaultProvider ?? "rules",
    providers: (raw.providers ?? []).map((p: Raw) => ({
      id: p.id,
      kind: p.kind,
      models: p.models ?? null,
      model: p.model ?? null,
      modelVersion: p.modelVersion ?? null,
      endpoint: p.endpoint ?? null,
      credentialReferenceDigest: digest(p.apiKeyEnv ?? null),
    })),
    routes: completionRoutes ?? state.completion?.options.config?.routes ?? [],
  });
}
export async function readDecisionConsole(ctx: Context) {
  const view = await readDecisionSettings(ctx);
  return {
    ...view,
    ...publicState(owner(ctx).decision?.options.config ?? {}),
    revision: revision(ctx),
    apiCredentials: await Promise.all((owner(ctx).decision?.options.config?.providers ?? [])
      .filter((p: Raw) => p.kind === 'jev' || p.kind === 'compatible')
      .map(async (p: Raw) => ({ providerId: p.id, ...(await apiKeyStatus(ctx, p.apiKeyEnv ?? (p.kind === 'jev' ? 'TYPESAFE_API_KEY' : ''))),
        managed: p.apiKeyEnv === managedRef(p.id) }))),
  };
}
function check(ctx: Context, expected: string, raw?: Raw) {
  if (revision(ctx, raw) !== expected) reject("DECISION_CONFLICT");
}
function validateSelection(s: unknown): asserts s is DecisionSelection {
  object(s, "selection");
  const fields =
    s.kind === "rules"
      ? []
      : s.kind === "structured"
        ? ["nativeProvider", "modelVersion"]
        : s.kind === "jev"
          ? ["model", "modelVersion"]
          : s.kind === "compatible"
            ? ["model", "modelVersion", "endpoint"]
            : reject("DECISION_KIND_CONFLICT");
  keys(
    s,
    ["kind", "providerId", ...fields],
    ["kind", "providerId", ...fields],
    "selection",
  );
  id(s.providerId, "providerId");
  for (const field of fields) text(s[field], field);
}
export function validateRules(rules: unknown): asserts rules is DecisionRule[] {
  if (
    !Array.isArray(rules) ||
    rules.length > 500 ||
    JSON.stringify(rules).length > 131072
  )
    reject("DECISION_RULES_INVALID");
  new RulesProvider("validate", "1", rules);
  for (const rule of rules) {
    const a = rule.answer;
    object(a, "rule answer");
    let q: DecisionQuestion;
    const base = {
      questionId: rule.questionId,
      questionVersion: rule.questionVersion,
      instructions: "Validate rule",
    };
    if (a.type === "choice") {
      id(a.choice, "rule choice");
      q = { ...base, type: "choice", candidates: { [a.choice]: null } };
    } else if (a.type === "noul") q = { ...base, type: "noul" };
    else if (a.type === "score")
      q = {
        ...base,
        type: "score",
        levels: Array.from({ length: 10 }, (_, i) => String(i)),
      };
    else if (a.type === "abstain") q = { ...base, type: "noul" };
    else reject("DECISION_RULES_INVALID");
    validateAnswer(a, q!, false);
  }
}
function managedRef(providerId: string): string { return `DSH_TYPED_${digest(providerId).slice(0, 16).toUpperCase()}_API_KEY`; }
const busy = new WeakSet<object>();
export async function decisionConsoleCommand(
  ctx: Context,
  value: unknown,
): Promise<unknown> {
  json(value);
  object(value, "command");
  if (JSON.stringify(value).length > 196608) reject("DECISION_INPUT_TOO_LARGE");
  const command = value as Raw;
  const allowed: Record<string, string[]> = {
    savePreset: ["expected", "id", "name", "selection", "reasoningEffort"],
    setApiKey: ["expected", "id", "apiKey"],
    clearApiKey: ["expected", "id"],
    deletePreset: ["expected", "id"],
    saveRules: ["expected", "id", "rules"],
    deleteRules: ["expected", "id"],
    setDefault: ["expected", "id"],
    setBinding: ["expected", "consumer", "id"],
    checkConnection: ["id"],
    modelInfo: ["provider", "model"],
  };
  if (!allowed[command.action]) reject("DECISION_COMMAND_INVALID");
  keys(
    command,
    ["action", ...allowed[command.action]!],
    [
      "action",
      ...allowed[command.action]!.filter((k) => k !== "reasoningEffort"),
    ],
    "command",
  );
  if (command.action === "modelInfo") {
    id(command.provider, "provider");
    text(command.model, "model");
    const llm = ctx.get("llm") as any;
    try {
      const info = await llm?.resolveModelInfo(command.provider, command.model);
      if (!info) reject("DECISION_MODEL_UNAVAILABLE");
      return {
        reasoningEfforts: (info.reasoning?.efforts ?? []).map((e: Raw) =>
          String(e.id),
        ),
      };
    } catch {
      return reject("DECISION_MODEL_METADATA_UNAVAILABLE");
    }
  }
  id(command.id || (command.action === "setBinding" ? "inherit" : ""), "id");
  if (command.action === "checkConnection") return probe(ctx, command.id);
  const state = owner(ctx),
    editor = state.editor,
    row = state.decision;
  if (!editor || !row) reject("DECISION_READ_ONLY");
  const overlays =
    (ctx.get("profileContext") as { overlays?: unknown[] } | undefined)
      ?.overlays ?? [];
  if ([row, state.completion].some((e) => e && overlayOwns(overlays, e)))
    reject("DECISION_OVERRIDE");
  text(command.expected, "expected");
  check(ctx, command.expected);
  if (busy.has(row)) reject("DECISION_BUSY");
  busy.add(row);
  const release: (() => void)[] = [];
  try {
    if (command.action === "setBinding") {
      id(command.consumer, "consumer");
      await editor.edit(row, current => {
        check(ctx, command.expected, current);
        const presets = configuredPresets(current as Config);
        if (command.id && !presets.some(preset => preset.id === command.id)) reject("DECISION_PRESET_MISSING");
        const bindings = {...(current.bindings ?? {})};
        if (command.id) bindings[command.consumer] = command.id; else delete bindings[command.consumer];
        return {...current, bindings};
      });
      return {saved:true, applies:"live"};
    }
    for (const name of ["taskSystem", "remoteExecution"]) {
      const service = ctx.get(name) as
        | { beginConfigurationEdit?(): () => void }
        | undefined;
      if (service?.beginConfigurationEdit)
        release.push(service.beginConfigurationEdit());
    }
    if (
      (ctx.get("typedDecisions") as { activeCount?: number } | undefined)
        ?.activeCount
    )
      reject("DECISION_BUSY");
    if (
      (
        ctx.get("typedDecisionCompletion") as
          | { activeCount?: number }
          | undefined
      )?.activeCount
    )
      reject("DECISION_BUSY");
    const source = row.options.config ?? {};
    const presets = configuredPresets(source as Config);
    if (command.action === 'setApiKey' || command.action === 'clearApiKey') {
      const preset = presets.find(p => p.id === command.id);
      const provider = source.providers?.find((p: Raw) => p.id === preset?.provider);
      if (!provider || !['jev', 'compatible'].includes(provider.kind)) reject('DECISION_PRESET_MISSING');
      const store = credentialStore(ctx);
      if (!store) reject('DECISION_CREDENTIAL_STORE_MISSING');
      const ref = managedRef(provider.id);
      const prior = await store.resolve(ref);
      const info = await store.describe(ref);
      if (!info.writable) reject('DECISION_CREDENTIAL_READ_ONLY');
      check(ctx, command.expected);
      if (command.action === 'clearApiKey') {
        if (provider.apiKeyEnv !== ref) reject('DECISION_CREDENTIAL_EXTERNAL');
        await store.unset(ref);
        return { saved: true, applies: 'next-call' };
      }
      text(command.apiKey, 'apiKey');
      if (command.apiKey.length > 8192 || /[\r\n\0]/.test(command.apiKey)) reject('DECISION_INPUT_INVALID');
      try { await store.set(ref, command.apiKey.trim()); }
      catch { reject('DECISION_CREDENTIAL_SAVE_FAILED'); }
      try {
        await editor.edit(row, current => {
          check(ctx, command.expected, current);
          const next = structuredClone(current);
          next.providers.find((p: Raw) => p.id === provider.id).apiKeyEnv = ref;
          validateConfig(ctx, next);
          return next;
        });
      } catch (error) {
        try { if (prior) await store.set(ref, prior.value); else await store.unset(ref); }
        catch { reject('DECISION_PARTIAL_SAVE'); }
        throw error;
      }
      return { saved: true, applies: 'next-call' };
    } else if (command.action === "savePreset") {
      text(command.name, "name");
      if (command.name.length > 100) reject("DECISION_INPUT_TOO_LARGE");
      validateSelection(command.selection);
      if (command.reasoningEffort !== undefined)
        text(command.reasoningEffort, "reasoningEffort");
      if (command.selection.kind === "rules" && command.reasoningEffort)
        reject("DECISION_EFFORT_UNSUPPORTED");
      const selection: DecisionSelection = command.selection;
      const templateProviderId = selection.providerId;
      // Each editable model preset owns its provider row; edits cannot change another preset.
      if (selection.kind !== "rules")
        selection.providerId = `preset:${command.id}:${selection.kind}`;
      const before = await readDecisionSettings(ctx);
      check(ctx, command.expected);
      const beforeRoutes = structuredClone(
        state.completion?.options.config?.routes ?? [],
      );
      await saveDecisionSettings(
        ctx,
        { expected: before.snapshot!, selection },
        {
          templateProviderId,
          check: (current) => {
            if (revision(ctx, current, beforeRoutes) !== command.expected)
              reject("DECISION_CONFLICT");
          },
          update: (current, provider) => {
            const model =
              provider.kind === "structured" ? provider.models[0] : undefined;
            const efforts =
              model?.reasoningEfforts ??
              (provider.kind === "compatible"
                ? provider.capabilityDeclaration.reasoningEfforts
                : []);
            if (
              command.reasoningEffort &&
              !efforts.includes(command.reasoningEffort)
            )
              reject("DECISION_EFFORT_UNSUPPORTED");
            const preset: DecisionPreset = {
              id: command.id,
              name: command.name,
              provider: selection.providerId,
              ...(model
                ? { model: model.model }
                : provider.kind === "rules"
                  ? {}
                  : { model: provider.model }),
              ...(command.reasoningEffort
                ? { reasoningEffort: command.reasoningEffort }
                : {}),
            };
            const next = {
              ...current,
              defaultPreset:
                source.defaultPreset ||
                (source.presets?.length ? "" : "default"),
              presets: [...presets.filter((p) => p.id !== command.id), preset],
            };
            if (next.presets.length > 64) reject("DECISION_PRESET_LIMIT");
            validateConfig(ctx, next);
            return next;
          },
        },
      );
    } else {
      await editor.edit(row, (current) => {
        check(ctx, command.expected, current);
        const next = structuredClone(current);
        next.presets = configuredPresets(current as Config);
        next.defaultPreset =
          current.defaultPreset || (current.presets?.length ? "" : "default");
        next.bindings = { ...(current.bindings ?? {}) };
        next.providers ??= [
          { id: "rules", kind: "rules", rulesVersion: "1", rules: [] },
        ];
        if (command.action === "saveRules") {
          validateRules(command.rules);
          const existing = next.providers.find((p: Raw) => p.id === command.id);
          if (existing && existing.kind !== "rules")
            reject("DECISION_KIND_CONFLICT");
          const updated = {
            id: command.id,
            kind: "rules",
            rulesVersion: digest(command.rules).slice(0, 16),
            rules: command.rules,
          };
          if (existing) Object.assign(existing, updated);
          else next.providers.push(updated);
        } else if (command.action === "deleteRules") {
          if (
            next.defaultProvider === command.id ||
            next.presets.some((p: DecisionPreset) => p.provider === command.id)
          )
            reject("DECISION_IN_USE");
          next.providers = next.providers.filter(
            (p: Raw) => p.kind !== "rules" || p.id !== command.id,
          );
        } else if (command.action === "deletePreset") {
          if (
            next.defaultPreset === command.id ||
            Object.values(next.bindings).includes(command.id)
          )
            reject("DECISION_IN_USE");
          next.presets = next.presets.filter(
            (p: DecisionPreset) => p.id !== command.id,
          );
          if (!next.presets.length) reject("DECISION_LAST_PRESET");
        } else {
          if (
            command.id &&
            !next.presets.some((p: DecisionPreset) => p.id === command.id)
          )
            reject("DECISION_PRESET_MISSING");
          if (command.action === "setDefault") next.defaultPreset = command.id;

        }
        validateConfig(ctx, next);
        return next;
      });
    }
    return { saved: true, applies: "plugin-restart" };
  } catch (e) {
    if (e instanceof DecisionSettingsError) throw e;
    if (e instanceof Error && e.name === "DecisionValidationError")
      reject("DECISION_INPUT_INVALID");
    if ((e as Raw)?.code === "CONFIGURATION_BUSY") reject("DECISION_BUSY");
    reject("DECISION_SAVE_REJECTED");
  } finally {
    busy.delete(row);
    for (const done of release.reverse()) done();
  }
}
function validateConfig(ctx: Context, raw: Raw) {
  const config = Config(structuredClone(raw) as Config);
  const engine = createEngine(ctx, config);
  void engine.close();
}
async function probe(ctx: Context, presetId: string) {
  const row = owner(ctx).decision;
  if (!row) reject("DECISION_READ_ONLY");
  const raw = Config(structuredClone(row.options.config ?? {}) as Config);
  const preset = configuredPresets(raw).find((p) => p.id === presetId);
  if (!preset) reject("DECISION_PRESET_MISSING");
  const provider = raw.providers.find((p) => p.id === preset.provider)!;
  const checkedAt = new Date().toISOString();
  if (provider.kind === "rules") {
    validateRules(provider.rules);
    return {
      ok: true,
      kind: "local-rules",
      code: "RULES_VALID",
      checkedAt,
      ruleCount: provider.rules.length,
    };
  }
  const readiness = (await readDecisionSettings(ctx)).readiness.find(
    (p) => p.providerId === provider.id,
  )?.status;
  const preflight: Record<string, string> = {
    "credential-missing": "CREDENTIAL_MISSING",
    "bridge-missing": "BRIDGE_MISSING",
    "model-unavailable": "MODEL_UNAVAILABLE",
  };
  if (readiness && preflight[readiness])
    return {
      ok: false,
      kind: "model-api",
      code: preflight[readiness],
      checkedAt,
    };
  const engine = createEngine(ctx, {
    ...raw,
    timeoutMs: Math.min(raw.timeoutMs, 15000),
    maxAttempts: 1,
  });
  try {
    const receipt = await engine.evaluate({
      requestId: `connection:${randomUUID()}`,
      stateHash: "connection-probe-v1",
      preset: presetId,
      context: { expected: "ok" },
      questions: [
        {
          questionId: "connection",
          questionVersion: "1",
          type: "choice",
          instructions: "Connection check: choose ok.",
          candidates: { ok: "Connection works", no: "Connection failed" },
        },
      ],
    });
    const ok =
      !receipt.error &&
      receipt.answers.connection?.type === "choice" &&
      receipt.answers.connection.choice === "ok";
    const code = receipt.error
      ? (receipt.error.message.match(/^http-\d{3}$/)?.[0] ?? receipt.error.code)
      : ok
        ? "CONNECTED"
        : "PROBE_ABSTAINED";
    return {
      ok,
      kind: "model-api",
      code,
      checkedAt,
      elapsedMs: Math.round(receipt.elapsedMs),
    };
  } finally {
    await engine.close();
  }
}
