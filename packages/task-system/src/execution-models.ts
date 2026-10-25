import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export const ExecutionModelChoice = z
  .object({
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
    reasoningEffort: z.string().min(1).max(100).optional(),
    backend: z.string().min(1).max(100).optional(),
    kind: z.enum(["native-dsh", "official-codex"]).optional(),
    resume: z.boolean().optional(),
  })
  .strict();
export type ExecutionModelChoice = z.infer<typeof ExecutionModelChoice>;

export const ExecutionCatalogRequest = z.object({
  requestId: z.string().uuid(),
  nodeId: z.string().min(1).max(128),
  generation: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});
export type ExecutionCatalogRequest = z.infer<typeof ExecutionCatalogRequest>;

export const ExecutionCatalogResult = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("success"),
      observedAt: z.number().int().nonnegative(),
      complete: z.boolean(),
      temporaryWorkspaceReady: z.boolean().optional(),
      models: z.array(ExecutionModelChoice).max(2048),
    })
    .strict(),
  z
    .object({
      state: z.literal("failure"),
      code: z.enum([
        "TIMEOUT",
        "UNAVAILABLE",
        "CATALOG_UNSUPPORTED",
        "CATALOG_FAILED",
      ]),
    })
    .strict(),
]);
export type ExecutionCatalogResult = z.infer<typeof ExecutionCatalogResult>;

export const CompleteExecutionModels = z
  .object({
    nodeId: z.string().min(1).max(128),
    requestId: z.string().uuid(),
    generation: z.number().int().positive(),
    result: ExecutionCatalogResult,
    page: z
      .object({
        index: z.number().int().min(0).max(63),
        total: z.number().int().min(1).max(64),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CompleteExecutionModels = z.infer<typeof CompleteExecutionModels>;

export const ExecutionCatalogCompletion = z.discriminatedUnion("accepted", [
  z.object({ accepted: z.literal(true) }),
  z.object({
    accepted: z.literal(false),
    catalogError: z.object({
      code: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/),
    }),
  }),
]);
export type ExecutionCatalogCompletion = z.infer<
  typeof ExecutionCatalogCompletion
>;

export const ExecutionCatalogDelivery = z.object({
  key: z.string(),
  expiresAt: z.number(),
  pages: z.array(CompleteExecutionModels).min(1).max(64),
  next: z.number().int().min(0).max(64),
  error: z
    .object({
      kind: z.enum(["rejected", "uncertain"]),
      code: z.string().max(100),
      at: z.number().int().nonnegative(),
    })
    .optional(),
});
export type ExecutionCatalogDelivery = z.infer<typeof ExecutionCatalogDelivery>;

const Snapshot = z.object({
  revision: z.string(),
  observedAt: z.number(),
  receivedAt: z.number().optional(),
  expiresAt: z.number(),
  complete: z.boolean(),
  temporaryWorkspaceReady: z.boolean().optional(),
  models: z.array(ExecutionModelChoice),
});
const Policy = z.object({
  revision: z.number().int().nonnegative(),
  choice: ExecutionModelChoice.optional(),
});
export type NodeExecutionModelPolicy = z.infer<typeof Policy>;
const CatalogDiagnostic = z.object({
  requestId: z.string().uuid(),
  generation: z.number().int().positive(),
  code: z.string().max(100),
  at: z.number().int().nonnegative(),
  kind: z.enum(["rejected", "failed", "timeout"]),
  receivedPages: z.number().int().min(0).max(64),
  totalPages: z.number().int().min(1).max(64).optional(),
  action: z.literal("refresh_catalog"),
});
const CatalogProgress = z.object({
  startedAt: z.number().int().nonnegative(),
  receivedPages: z.number().int().min(0).max(64),
  totalPages: z.number().int().min(1).max(64).optional(),
});
export interface ExecutionModelsView {
  nodeId: string;
  catalog: {
    state: "fresh" | "stale" | "pending" | "unavailable";
    snapshot?: z.infer<typeof Snapshot>;
    positiveSnapshot?: z.infer<typeof Snapshot>;
    request?: ExecutionCatalogRequest;
    diagnostic?: z.infer<typeof CatalogDiagnostic>;
    progress?: z.infer<typeof CatalogProgress>;
    reason?:
      | "TIMEOUT"
      | "UNAVAILABLE"
      | "CATALOG_UNSUPPORTED"
      | "CATALOG_FAILED";
  };
  policy: NodeExecutionModelPolicy;
}
export const ExecutionModelViewPage = z.object({
  view: z.object({
    nodeId: z.string(),
    catalog: z.object({
      state: z.enum(["fresh", "stale", "pending", "unavailable"]),
      snapshot: Snapshot.optional(),
      positiveSnapshot: Snapshot.optional(),
      request: ExecutionCatalogRequest.optional(),
      diagnostic: CatalogDiagnostic.optional(),
      progress: CatalogProgress.optional(),
      reason: z
        .enum([
          "TIMEOUT",
          "UNAVAILABLE",
          "CATALOG_UNSUPPORTED",
          "CATALOG_FAILED",
        ])
        .optional(),
    }),
    policy: Policy,
  }),
  offset: z.number().int().nonnegative(),
  count: z.number().int().min(1).max(32),
  modelsPage: z.object({
    snapshot: z.array(ExecutionModelChoice).max(32),
    positiveSnapshot: z.array(ExecutionModelChoice).max(32),
  }),
  total: z.object({
    snapshot: z.number().int().min(0).max(2048),
    positiveSnapshot: z.number().int().min(0).max(2048),
  }),
});
export function executionCatalogCompletion(
  value: unknown,
): ExecutionCatalogCompletion {
  const parsed = ExecutionCatalogCompletion.or(
    ExecutionModelViewPage.shape.view,
  ).parse(value);
  if ("accepted" in parsed) return parsed;
  const diagnostic = parsed.catalog.diagnostic;
  return !parsed.catalog.request && diagnostic?.kind === "rejected"
    ? { accepted: false, catalogError: { code: diagnostic.code } }
    : { accepted: true };
}
export const AdmissionCode = z.enum([
  "READY",
  "MODEL_UNAVAILABLE",
  "CAPABILITY_REQUIRED",
  "WORKSPACE_BINDING_REQUIRED",
  "EXECUTION_ROOT_REQUIRED",
  "BACKEND_UNAVAILABLE",
]);
export const AdmissionReport = z
  .object({
    runId: z.string().min(1).max(128),
    nodeId: z.string().min(1).max(128),
    expectedUpdatedAt: z.string().min(1).max(100),
    routeDigest: z.string().min(1).max(100),
    code: AdmissionCode,
  })
  .strict();
export type AdmissionReport = z.infer<typeof AdmissionReport>;
const Stored = z.object({
  generation: z.number().int().nonnegative(),
  snapshot: Snapshot.optional(),
  positiveSnapshot: Snapshot.optional(),
  request: ExecutionCatalogRequest.optional(),
  failure: z
    .enum(["TIMEOUT", "UNAVAILABLE", "CATALOG_UNSUPPORTED", "CATALOG_FAILED"])
    .optional(),
  policy: Policy,
  diagnostic: CatalogDiagnostic.optional(),
  pages: z
    .object({
      requestId: z.string(),
      total: z.number(),
      items: z.array(
        z.object({ index: z.number(), result: ExecutionCatalogResult }),
      ),
    })
    .optional(),
});
type Stored = z.infer<typeof Stored>;

function failureDiagnostic(
  state: Stored,
  request: ExecutionCatalogRequest,
  code: string,
  kind: z.infer<typeof CatalogDiagnostic>["kind"],
  at: number,
): z.infer<typeof CatalogDiagnostic> {
  return {
    requestId: request.requestId,
    generation: request.generation,
    code,
    kind,
    at,
    receivedPages: state.pages?.items.length ?? 0,
    ...(state.pages ? { totalPages: state.pages.total } : {}),
    action: "refresh_catalog",
  };
}

export class ExecutionModelsError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ExecutionModelsError";
  }
}
function requireFact(condition: unknown, code: string): asserts condition {
  if (!condition) throw new ExecutionModelsError(code);
}
export function sameExecutionModel(
  left: ExecutionModelChoice,
  right: ExecutionModelChoice,
): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.backend === right.backend
  );
}

/** One authority-owned catalog and default per executor. Never owns or closes the ledger connection. */
export class ExecutionModels {
  private readonly now: () => number;
  private readonly readOnly: boolean;
  private readonly hasTables: boolean;
  constructor(
    private readonly db: DatabaseSync,
    options: { now?: () => number; readOnly?: boolean } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.readOnly = options.readOnly ?? false;
    if (!this.readOnly)
      db.exec(`CREATE TABLE IF NOT EXISTS execution_model_nodes(node_id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_model_commands(id TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT NOT NULL);`);
    this.hasTables =
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('execution_model_nodes','execution_model_commands')",
          )
          .get()?.count,
      ) === 2;
  }
  private read(nodeId: string): Stored {
    if (!this.hasTables) return { generation: 0, policy: { revision: 0 } };
    const row = this.db
      .prepare("SELECT data FROM execution_model_nodes WHERE node_id=?")
      .get(nodeId);
    return row
      ? Stored.parse(JSON.parse(String(row.data)))
      : { generation: 0, policy: { revision: 0 } };
  }
  private write(nodeId: string, state: Stored): void {
    this.db
      .prepare(
        "INSERT INTO execution_model_nodes(node_id,data) VALUES(?,?) ON CONFLICT(node_id) DO UPDATE SET data=excluded.data",
      )
      .run(nodeId, JSON.stringify(state));
  }
  private command<T>(id: string, input: unknown, apply: () => T): T {
    requireFact(!this.readOnly, "EXECUTION_MODELS_READ_ONLY");
    const digest = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const previous = this.db
      .prepare("SELECT digest,result FROM execution_model_commands WHERE id=?")
      .get(id);
    if (previous) {
      requireFact(
        previous.digest === digest,
        "EXECUTION_MODELS_COMMAND_CONFLICT",
      );
      // A saved result is produced by this same method, not supplied by a peer.
      return JSON.parse(String(previous.result));
    }
    this.db.exec("SAVEPOINT execution_models_write");
    try {
      const result = apply();
      this.db
        .prepare(
          "INSERT INTO execution_model_commands(id,digest,result) VALUES(?,?,?)",
        )
        .run(id, digest, JSON.stringify(result));
      this.db.exec("RELEASE execution_models_write");
      return result;
    } catch (error) {
      this.db.exec(
        "ROLLBACK TO execution_models_write; RELEASE execution_models_write",
      );
      throw error;
    }
  }
  view(nodeId: string): ExecutionModelsView {
    const state = this.read(nodeId),
      now = this.now();
    const request =
      state.request && state.request.expiresAt > now
        ? state.request
        : undefined;
    const snapshot = state.snapshot;
    const diagnostic =
      state.request && !request
        ? failureDiagnostic(
            state,
            state.request,
            "TIMEOUT",
            "timeout",
            state.request.expiresAt,
          )
        : state.diagnostic;
    return {
      nodeId,
      catalog: {
        state: request
          ? "pending"
          : snapshot &&
              snapshot.complete &&
              !state.failure &&
              !state.request &&
              snapshot.expiresAt > now
            ? "fresh"
            : snapshot
              ? "stale"
              : "unavailable",
        ...(snapshot ? { snapshot } : {}),
        ...(state.positiveSnapshot
          ? { positiveSnapshot: state.positiveSnapshot }
          : {}),
        ...(request ? { request } : {}),
        ...(diagnostic ? { diagnostic } : {}),
        ...(request
          ? {
              progress: {
                startedAt: request.createdAt,
                receivedPages: state.pages?.items.length ?? 0,
                ...(state.pages ? { totalPages: state.pages.total } : {}),
              },
            }
          : {}),
        ...(state.request && !request
          ? { reason: "TIMEOUT" as const }
          : state.failure
            ? { reason: state.failure }
            : {}),
      },
      policy: state.policy,
    };
  }
  request(
    commandId: string,
    input: { nodeId: string; ttlMs?: number },
  ): ExecutionModelsView {
    const parsed = z
      .object({
        nodeId: z.string().min(1).max(128),
        ttlMs: z.number().int().min(10000).max(60000).default(30000),
      })
      .strict()
      .parse(input);
    return this.command(`request:${commandId}`, parsed, () => {
      const state = this.read(parsed.nodeId),
        now = this.now();
      if (!state.request || state.request.expiresAt <= now) {
        if (state.request) {
          state.failure = "TIMEOUT";
          state.diagnostic = failureDiagnostic(
            state,
            state.request,
            "TIMEOUT",
            "timeout",
            state.request.expiresAt,
          );
        }
        state.generation++;
        state.request = {
          requestId: randomUUID(),
          nodeId: parsed.nodeId,
          generation: state.generation,
          createdAt: now,
          expiresAt: now + parsed.ttlMs,
        };
        delete state.pages;
        this.write(parsed.nodeId, state);
      }
      return this.view(parsed.nodeId);
    });
  }
  pending(nodeId: string): ExecutionCatalogRequest[] {
    const request = this.read(nodeId).request;
    return request && request.expiresAt > this.now() ? [request] : [];
  }
  complete(
    commandId: string,
    input: CompleteExecutionModels,
  ): ExecutionModelsView {
    const parsed = CompleteExecutionModels.parse(input);
    return this.command(`complete:${commandId}`, parsed, () => {
      const state = this.read(parsed.nodeId),
        request = state.request,
        now = this.now();
      requireFact(
        request &&
          request.requestId === parsed.requestId &&
          request.generation === parsed.generation,
        "EXECUTION_CATALOG_REQUEST_MISMATCH",
      );
      const reject = (code: string): ExecutionModelsView => {
        state.failure = "CATALOG_FAILED";
        state.diagnostic = failureDiagnostic(
          state,
          request,
          code,
          "rejected",
          now,
        );
        delete state.request;
        delete state.pages;
        this.write(parsed.nodeId, state);
        return this.view(parsed.nodeId);
      };
      if (request.expiresAt <= now)
        return reject("EXECUTION_CATALOG_REQUEST_EXPIRED");
      let result = parsed.result;
      if (parsed.page) {
        if (
          result.state !== "success" ||
          parsed.page.index >= parsed.page.total
        )
          return reject("EXECUTION_CATALOG_PAGE_INVALID");
        const pages = state.pages ?? {
          requestId: request.requestId,
          total: parsed.page.total,
          items: [],
        };
        if (
          pages.requestId !== request.requestId ||
          pages.total !== parsed.page.total
        )
          return reject("EXECUTION_CATALOG_PAGE_CONFLICT");
        const prior = pages.items.find(
          (item) => item.index === parsed.page!.index,
        );
        if (prior && JSON.stringify(prior.result) !== JSON.stringify(result))
          return reject("EXECUTION_CATALOG_PAGE_CONFLICT");
        const first = pages.items[0]?.result;
        if (
          first &&
          (first.state !== "success" ||
            first.observedAt !== result.observedAt ||
            first.complete !== result.complete ||
            first.temporaryWorkspaceReady !== result.temporaryWorkspaceReady)
        )
          return reject("EXECUTION_CATALOG_PAGE_CONFLICT");
        const models = [
          ...pages.items
            .filter((item) => item.index !== parsed.page!.index)
            .flatMap((item) =>
              item.result.state === "success" ? item.result.models : [],
            ),
          ...result.models,
        ];
        if (models.length > 2048) return reject("EXECUTION_CATALOG_LIMIT");
        const keys = models.map((model) =>
          JSON.stringify([
            model.provider,
            model.model,
            model.reasoningEffort ?? null,
            model.backend ?? null,
          ]),
        );
        if (new Set(keys).size !== keys.length)
          return reject("EXECUTION_CATALOG_DUPLICATE_MODEL");
        if (!prior) pages.items.push({ index: parsed.page.index, result });
        if (pages.items.length < pages.total) {
          state.pages = pages;
          this.write(parsed.nodeId, state);
          return this.view(parsed.nodeId);
        }
        const ordered = pages.items
          .sort((a, b) => a.index - b.index)
          .map((item) => item.result);
        if (!ordered.every((item) => item.state === "success"))
          return reject("EXECUTION_CATALOG_PAGE_INVALID");
        const successes = ordered.filter((item) => item.state === "success");
        result = {
          state: "success",
          observedAt: Math.min(...successes.map((item) => item.observedAt)),
          complete: successes.every((item) => item.complete),
          ...(successes[0]?.temporaryWorkspaceReady !== undefined
            ? { temporaryWorkspaceReady: successes[0].temporaryWorkspaceReady }
            : {}),
          models: successes.flatMap((item) => item.models),
        };
      } else if (state.pages && result.state === "success") {
        return reject("EXECUTION_CATALOG_PAGE_CONFLICT");
      }
      if (result.state === "success") {
        const keys = result.models.map((model) =>
          JSON.stringify([
            model.provider,
            model.model,
            model.reasoningEffort ?? null,
            model.backend ?? null,
          ]),
        );
        if (new Set(keys).size !== keys.length)
          return reject("EXECUTION_CATALOG_DUPLICATE_MODEL");
        state.positiveSnapshot = {
          revision: request.requestId,
          observedAt: result.observedAt,
          receivedAt: now,
          expiresAt: now + 60000,
          complete: result.complete,
          ...(result.temporaryWorkspaceReady !== undefined
            ? { temporaryWorkspaceReady: result.temporaryWorkspaceReady }
            : {}),
          models: result.models,
        };
        if (result.complete || !state.snapshot)
          state.snapshot = state.positiveSnapshot;
        if (result.complete) {
          delete state.failure;
          delete state.diagnostic;
        } else {
          state.failure = "CATALOG_FAILED";
          state.diagnostic = failureDiagnostic(
            state,
            request,
            "CATALOG_FAILED",
            "failed",
            now,
          );
        }
      } else {
        state.failure = result.code;
        state.diagnostic = failureDiagnostic(
          state,
          request,
          result.code,
          "failed",
          now,
        );
      }
      delete state.pages;
      delete state.request;
      this.write(parsed.nodeId, state);
      return this.view(parsed.nodeId);
    });
  }
  setDefault(
    commandId: string,
    input: {
      nodeId: string;
      expectedRevision: number;
      expectedCatalogRevision?: string;
      choice: ExecutionModelChoice | null;
    },
  ): ExecutionModelsView {
    const parsed = z
      .object({
        nodeId: z.string().min(1).max(128),
        expectedRevision: z.number().int().nonnegative(),
        expectedCatalogRevision: z.string().optional(),
        choice: ExecutionModelChoice.nullable(),
      })
      .strict()
      .parse(input);
    return this.command(`default:${commandId}`, parsed, () => {
      const state = this.read(parsed.nodeId);
      requireFact(
        state.policy.revision === parsed.expectedRevision,
        "EXECUTION_MODEL_POLICY_CONFLICT",
      );
      if (parsed.choice) {
        const snapshot = state.positiveSnapshot;
        requireFact(
          snapshot &&
            snapshot.revision === parsed.expectedCatalogRevision &&
            snapshot.expiresAt > this.now(),
          "EXECUTION_CATALOG_STALE",
        );
        const choice = snapshot.models.find((choice) =>
          sameExecutionModel(choice, parsed.choice!),
        );
        requireFact(choice, "EXECUTION_MODEL_UNAVAILABLE");
        state.policy = { revision: state.policy.revision + 1, choice };
      } else state.policy = { revision: state.policy.revision + 1 };
      this.write(parsed.nodeId, state);
      return this.view(parsed.nodeId);
    });
  }
}
