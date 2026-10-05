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
  let owner: typeof import("@dsh-task/typed-decisions/settings");
  try {
    owner = await import("@dsh-task/typed-decisions/settings");
  } catch {
    return DecisionSettings.parse({
      available: false,
      writable: false,
      snapshot: null,
      catalog: [],
      readiness: [],
    });
  }
  return DecisionSettings.parse(await owner.readDecisionSettings(ctx));
}
export async function saveDecisionSettings(ctx: Context, value: unknown) {
  const input = SaveDecisionInput.parse(value);
  const owner = await import("@dsh-task/typed-decisions/settings");
  const task = ctx.get("taskSystem") as TaskSystemService | undefined;
  const remote = ctx.get("remoteExecution") as
    | RemoteExecutionService
    | undefined;
  const release: (() => void)[] = [];
  try {
    if (task) release.push(task.beginConfigurationEdit());
    if (remote) release.push(remote.beginConfigurationEdit());
    return SaveDecisionResult.parse(
      await owner.saveDecisionSettings(ctx, input),
    );
  } finally {
    for (const done of release.reverse()) done();
  }
}
