import { z } from "zod";
import type { Context } from "@deepseek-ai/cordis";
import type { TaskSystemService } from "./dsh-plugin.js";
import type { RemoteExecutionService } from "./remote/index.js";
const Text = z.string().min(1).max(2048);
const Model = z
  .object({ model: Text, version: Text, reasoningEfforts: z.array(Text) })
  .strict();
const Provider = z
  .object({
    id: Text,
    kind: z.enum(["rules", "structured", "jev", "compatible"]),
    models: z.array(Model).optional(),
    model: Text.optional(),
    modelVersion: Text.optional(),
    endpoint: z.string().max(2048).optional(),
  })
  .strict();
const Route = z
  .object({
    model: Text,
    modelVersion: Text,
    provider: Text,
    reasoningEfforts: z.array(Text),
  })
  .strict();
export const DecisionSnapshot = z
  .object({
    entryId: Text,
    defaultProvider: Text,
    providers: z.array(Provider),
    completion: z
      .object({ entryId: Text, routes: z.array(Route) })
      .strict()
      .nullable(),
  })
  .strict();
export const DecisionSettings = z
  .object({
    available: z.boolean(),
    writable: z.boolean(),
    snapshot: DecisionSnapshot.nullable(),
    catalog: z.array(
      z
        .object({
          provider: Text,
          name: z.string(),
          credential: z.enum([
            "configured",
            "missing",
            "unknown",
            "provider-owned",
          ]),
          available: z.boolean(),
          models: z.array(z.object({ id: Text, name: z.string() }).strict()),
        })
        .strict(),
    ),
    readiness: z.array(
      z
        .object({
          providerId: Text,
          status: z.enum([
            "ready",
            "configured-unverified",
            "unconfirmed",
            "credential-missing",
            "bridge-missing",
            "model-unavailable",
          ]),
        })
        .strict(),
    ),
  })
  .strict();
export const SaveDecisionInput = z
  .object({
    expected: DecisionSnapshot,
    selection: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("rules"), providerId: Text }).strict(),
      z
        .object({
          kind: z.literal("structured"),
          providerId: Text,
          nativeProvider: Text,
          modelVersion: Text,
        })
        .strict(),
      z
        .object({
          kind: z.literal("jev"),
          providerId: Text,
          model: Text,
          modelVersion: Text,
        })
        .strict(),
      z
        .object({
          kind: z.literal("compatible"),
          providerId: Text,
          model: Text,
          modelVersion: Text,
          endpoint: Text,
        })
        .strict(),
    ]),
  })
  .strict();
export const SaveDecisionResult = z
  .object({ saved: z.literal(true), applies: z.literal("plugin-restart") })
  .strict();
export async function readDecisionSettings(ctx: Context) {
  const service = ctx.get('decisionModels');
  const cfg = service?.config();
  return DecisionSettings.parse({available:!!service,writable:false,snapshot:cfg ? {
    entryId:'jev',defaultProvider:cfg.provider ?? 'typesafe',providers:[{id:cfg.provider ?? 'typesafe',kind:cfg.provider === 'native' ? 'structured' : 'jev',...(cfg.model ? {model:cfg.model,modelVersion:cfg.model} : {})}],completion:null,
  } : null,catalog:[],readiness:[]});
}
/** Provider/model configuration is edited in the JEV plugin's own Settings card. */
export async function saveDecisionSettings(_ctx: Context, value: unknown) {
  SaveDecisionInput.parse(value);
  throw new Error('DECISION_PROVIDER_SETTINGS: configure providers and models in Plugins → Jev');
}
