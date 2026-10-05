/** Non-secret configuration owned by typed-decisions. No Task/remote dependency. */
import type { Context } from "@deepseek-ai/cordis";
import { isDeepStrictEqual } from "node:util";
import { Config } from "./index.js";
import { Config as CompletionConfig } from "./dsh-completion.js";

type Raw = Record<string, any>;
interface Entry {
  options: { id: string; name: string; config?: Raw };
}
interface Editor {
  entries(): Entry[];
  edit(
    entry: Entry,
    change: (current: Raw, inherited: Raw) => Raw,
  ): Promise<void>;
}
export interface ModelView {
  model: string;
  version: string;
  reasoningEfforts: string[];
}
export interface ProviderView {
  id: string;
  kind: "rules" | "structured" | "jev" | "compatible";
  models?: ModelView[];
  model?: string;
  modelVersion?: string;
  endpoint?: string;
}
export interface RouteView {
  model: string;
  modelVersion: string;
  provider: string;
  reasoningEfforts: string[];
}
export interface DecisionSnapshot {
  entryId: string;
  defaultProvider: string;
  providers: ProviderView[];
  completion: { entryId: string; routes: RouteView[] } | null;
}
export type DecisionSelection =
  | { kind: "rules"; providerId: string }
  | {
      kind: "structured";
      providerId: string;
      nativeProvider: string;
      modelVersion: string;
    }
  | { kind: "jev"; providerId: string; model: string; modelVersion: string }
  | {
      kind: "compatible";
      providerId: string;
      model: string;
      modelVersion: string;
      endpoint: string;
    };
export class DecisionSettingsError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DecisionSettingsError";
  }
}
function reject(code: string): never {
  throw new DecisionSettingsError(code);
}
const record = (v: unknown): Raw =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {};
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
const modules = [
  "@dsh-task/typed-decisions",
  "@dsh-task/typed-decisions/dsh-completion",
];
function owner(ctx: Context) {
  const editor = ctx.get("configEditor") as Editor | undefined;
  const find = (name: string) => {
    const rows = editor?.entries().filter((e) => e.options.name === name) ?? [];
    if (rows.length > 1) reject("DECISION_AMBIGUOUS");
    return rows[0];
  };
  return { editor, decision: find(modules[0]!), completion: find(modules[1]!) };
}
function providers(raw: Raw): ProviderView[] {
  return (
    Array.isArray(raw.providers)
      ? raw.providers
      : [{ id: "rules", kind: "rules" }]
  ).map((p: Raw) => ({
    id: p.id,
    kind: p.kind,
    ...(p.kind === "structured"
      ? {
          models: (p.models ?? []).map((m: Raw) => ({
            model: m.model,
            version: m.version,
            reasoningEfforts: strings(m.reasoningEfforts),
          })),
        }
      : {}),
    ...(["jev", "compatible"].includes(p.kind)
      ? {
          model: p.model ?? "jev-1.13.0",
          modelVersion: p.modelVersion ?? "jev-1.13.0",
        }
      : {}),
    ...(p.kind === "compatible"
      ? { endpoint: publicEndpoint(p.endpoint) }
      : {}),
  }));
}
function publicEndpoint(value: unknown): string {
  try {
    const url = new URL(String(value));
    if (url.username || url.password || url.search || url.hash) return "";
    return String(value);
  } catch {
    return "";
  }
}
function routes(raw: Raw): RouteView[] {
  return (raw.routes ?? []).map((r: Raw) => ({
    model: r.model,
    modelVersion: r.modelVersion,
    provider: r.provider,
    reasoningEfforts: strings(r.reasoningEfforts),
  }));
}
function snapshot(
  ctx: Context,
  decisionRaw?: Raw,
  completionRaw?: Raw,
): DecisionSnapshot | null {
  const state = owner(ctx);
  if (!state.decision) return null;
  const raw = decisionRaw ?? state.decision.options.config ?? {};
  return {
    entryId: state.decision.options.id,
    defaultProvider: raw.defaultProvider ?? "rules",
    providers: providers(raw),
    completion: state.completion
      ? {
          entryId: state.completion.options.id,
          routes: routes(
            completionRaw ?? state.completion.options.config ?? {},
          ),
        }
      : null,
  };
}
/** Same local adapter directory/catalog and credential metadata used by official Models. */
async function catalog(ctx: Context) {
  const llm = ctx.get("llm") as
    | {
        listProviders(): { id: string; name: string }[];
        listModels(provider: string): Promise<{ id: string; name: string }[]>;
        listConfigurableProviders?(): {
          provider: string;
          displayName: string;
          settingsNs: string;
          settingsPath: string[];
        }[];
      }
    | undefined;
  if (!llm) return [];
  const directory = llm.listConfigurableProviders?.() ?? [];
  const settings = ctx.get("settings") as
    | {
        describe(options: {
          redactSecrets: boolean;
        }): { ns: string; value: unknown }[];
      }
    | undefined;
  const views = settings?.describe({ redactSecrets: true }) ?? [];
  const credentials = ctx.get("credentials") as
    | { describe(ref: string): Promise<{ configured: boolean }> }
    | undefined;
  return await Promise.all(
    llm.listProviders().map(async (p) => {
      let credential: "configured" | "missing" | "unknown" | "provider-owned" =
        "provider-owned";
      const entry = directory.find((d) => d.provider === p.id);
      if (entry) {
        let profile: any = views.find((v) => v.ns === entry.settingsNs)?.value;
        for (const part of entry.settingsPath) profile = record(profile)[part];
        if (!profile) credential = "unknown";
        const ref = record(profile).apiKeyEnv;
        if (typeof ref === "string" && ref) {
          try {
            credential = credentials
              ? (await credentials.describe(ref)).configured
                ? "configured"
                : "missing"
              : process.env[ref]?.trim()
                ? "configured"
                : "missing";
          } catch {
            credential = "unknown";
          }
        }
      }
      let models: { id: string; name: string }[] = [],
        available = true;
      try {
        models = (await llm.listModels(p.id)).map((m) => ({
          id: m.id,
          name: m.name,
        }));
      } catch {
        available = false;
      }
      return { provider: p.id, name: p.name, credential, available, models };
    }),
  );
}
export async function readDecisionSettings(ctx: Context) {
  const { editor, decision } = owner(ctx);
  const value = snapshot(ctx);
  const models = await catalog(ctx);
  const readiness = (value?.providers ?? []).map((p) => {
    const raw =
      (decision?.options.config?.providers ?? []).find(
        (x: Raw) => x.id === p.id,
      ) ?? {};
    if (p.kind === "rules") return { providerId: p.id, status: "ready" };
    if (p.kind === "structured") {
      const m = p.models?.[0],
        r = value?.completion?.routes.find(
          (r) => r.model === m?.model && r.modelVersion === m.version,
        );
      const native = models.find((c) => c.provider === r?.provider);
      return {
        providerId: p.id,
        status: !r
          ? "bridge-missing"
          : !native || !native.models.some((x) => x.id === r.modelVersion)
            ? "model-unavailable"
            : native.credential === "missing"
              ? "credential-missing"
              : native.credential === "unknown"
                ? "unconfirmed"
                : "ready",
      };
    }
    const ref = raw.apiKeyEnv ?? (p.kind === "jev" ? "TYPESAFE_API_KEY" : "");
    return {
      providerId: p.id,
      status:
        ref && process.env[ref]?.trim()
          ? "configured-unverified"
          : "credential-missing",
    };
  });
  return {
    available: !!decision,
    writable: !!editor && !!decision,
    snapshot: value,
    catalog: models,
    readiness,
  };
}
function overlayOwns(patches: readonly unknown[], entry: Entry): boolean {
  return patches.some((v) => {
    const p = record(v);
    return (
      ((p.id === entry.options.id || p.name === entry.options.name) &&
        Object.hasOwn(p, "config")) ||
      (Array.isArray(p.insert) && overlayOwns(p.insert, entry))
    );
  });
}
/** Strict callers pass only public values. Merge into the authoritative raw row. */
export async function saveDecisionSettings(
  ctx: Context,
  input: { expected: DecisionSnapshot; selection: DecisionSelection },
) {
  const state = owner(ctx),
    host = state.editor;
  if (!host || !state.decision) reject("DECISION_READ_ONLY");
  const overlays =
    (ctx.get("profileContext") as { overlays?: unknown[] } | undefined)
      ?.overlays ?? [];
  for (const e of [state.decision, state.completion])
    if (e && overlayOwns(overlays, e)) reject("DECISION_OVERRIDE");
  if (!isDeepStrictEqual(snapshot(ctx), input.expected))
    reject("DECISION_CONFLICT");
  const s = input.selection;
  const source = state.decision.options.config ?? {};
  const oldProviders: Raw[] = structuredClone(
    source.providers ?? [
      { id: "rules", kind: "rules", rulesVersion: "1", rules: [] },
    ],
  );
  let provider = oldProviders.find((p) => p.id === s.providerId);
  if (!provider) {
    if (s.kind === "structured")
      provider = { id: s.providerId, kind: "structured", models: [] };
    else if (s.kind === "jev")
      provider = {
        id: s.providerId,
        kind: "jev",
        apiKeyEnv: "TYPESAFE_API_KEY",
        maxResponseBytes: 1048576,
      };
    else reject("DECISION_PROVIDER_MISSING");
    oldProviders.push(provider);
  }
  if (provider.kind !== s.kind) reject("DECISION_KIND_CONFLICT");
  let bridgeNext: Raw | undefined;
  if (s.kind === "structured") {
    if (!state.completion) reject("DECISION_BRIDGE_MISSING");
    const native = (await catalog(ctx)).find(
      (c) => c.provider === s.nativeProvider,
    );
    if (
      !native?.available ||
      !native.models.some((m) => m.id === s.modelVersion)
    )
      reject("DECISION_MODEL_UNAVAILABLE");
    bridgeNext = structuredClone(state.completion.options.config ?? {});
    const prior = (bridgeNext.routes ?? []).find(
      (r: Raw) =>
        r.provider === s.nativeProvider && r.modelVersion === s.modelVersion,
    );
    let selector =
      prior?.model ?? `native:${s.nativeProvider}/${s.modelVersion}`;
    const occupied = new Set(
      (bridgeNext.routes ?? []).map((r: Raw) => r.model),
    );
    if (!prior) {
      const base = selector;
      for (let n = 2; occupied.has(selector); n++) selector = `${base}:${n}`;
    }
    const existing = provider.models?.find(
      (m: Raw) => m.model === selector && m.version === s.modelVersion,
    );
    const model = existing ?? {
      model: selector,
      version: s.modelVersion,
      versionSource: "configured-pin",
      reasoningEfforts: prior?.reasoningEfforts ?? [],
    };
    provider.models = [
      model,
      ...(provider.models ?? []).filter((m: Raw) => m !== existing),
    ];
    if (!prior)
      bridgeNext.routes = [
        ...(bridgeNext.routes ?? []),
        {
          model: selector,
          modelVersion: s.modelVersion,
          provider: s.nativeProvider,
          reasoningEfforts: model.reasoningEfforts ?? [],
        },
      ];
    CompletionConfig(
      structuredClone(bridgeNext) as unknown as CompletionConfig,
    );
  } else if (s.kind !== "rules") {
    provider.model = s.model;
    provider.modelVersion = s.modelVersion;
    if (s.kind === "compatible") {
      let endpoint: URL;
      try {
        endpoint = new URL(s.endpoint);
      } catch {
        reject("DECISION_ENDPOINT_INVALID");
      }
      if (
        !["https:", "http:"].includes(endpoint!.protocol) ||
        endpoint!.username ||
        endpoint!.password ||
        endpoint!.search ||
        endpoint!.hash
      )
        reject("DECISION_ENDPOINT_INVALID");
      provider.endpoint = s.endpoint;
    }
  }
  const next = {
    ...source,
    defaultProvider: s.providerId,
    providers: oldProviders,
  };
  Config(structuredClone(next) as unknown as Config);
  const beforeBridge = state.completion
    ? structuredClone(state.completion.options.config ?? {})
    : undefined;
  let bridgeSaved = false;
  try {
    if (bridgeNext && !isDeepStrictEqual(beforeBridge, bridgeNext)) {
      await host.edit(state.completion!, (current) => {
        if (
          !isDeepStrictEqual(snapshot(ctx, undefined, current), input.expected)
        )
          reject("DECISION_CONFLICT");
        // Derive only the appended route; preserve concurrently edited hidden fields.
        return {
          ...current,
          routes: [
            ...(current.routes ?? []),
            ...bridgeNext!.routes.slice((beforeBridge!.routes ?? []).length),
          ],
        };
      });
      bridgeSaved = true;
    }
    const expected = {
      ...input.expected,
      completion:
        bridgeNext && state.completion
          ? { entryId: state.completion.options.id, routes: routes(bridgeNext) }
          : input.expected.completion,
    };
    await host.edit(state.decision, (current) => {
      if (!isDeepStrictEqual(snapshot(ctx, current), expected))
        reject("DECISION_CONFLICT");
      const currentProviders: Raw[] = structuredClone(
        current.providers ?? [
          { id: "rules", kind: "rules", rulesVersion: "1", rules: [] },
        ],
      );
      const currentProvider = currentProviders.find(
        (p) => p.id === s.providerId,
      );
      const update =
        s.kind === "structured"
          ? {
              models: [
                currentProvider?.models?.find(
                  (m: Raw) => m.model === provider!.models[0].model,
                ) ?? provider!.models[0],
                ...(currentProvider?.models ?? []).filter(
                  (m: Raw) => m.model !== provider!.models[0].model,
                ),
              ],
            }
          : s.kind === "rules"
            ? {}
            : {
                model: s.model,
                modelVersion: s.modelVersion,
                ...(s.kind === "compatible" ? { endpoint: s.endpoint } : {}),
              };
      if (currentProvider) Object.assign(currentProvider, update);
      else currentProviders.push({ ...provider, ...update });
      return {
        ...current,
        defaultProvider: s.providerId,
        providers: currentProviders,
      };
    });
  } catch (error) {
    if (bridgeSaved) {
      try {
        const entry = owner(ctx).completion;
        if (entry)
          await host.edit(entry, (current) => {
            if (!isDeepStrictEqual(routes(current), routes(bridgeNext!)))
              reject("DECISION_CONFLICT");
            return { ...current, routes: beforeBridge!.routes ?? [] };
          });
      } catch {
        reject("DECISION_PARTIAL_SAVE");
      }
    }
    if (error instanceof DecisionSettingsError) throw error;
    reject("DECISION_SAVE_REJECTED");
  }
  const saved = snapshot(ctx);
  if (saved?.defaultProvider !== s.providerId)
    reject("DECISION_SAVE_UNCONFIRMED");
  return { saved: true as const, applies: "plugin-restart" as const };
}
