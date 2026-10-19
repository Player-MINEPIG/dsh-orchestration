import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-llm";
import type { ExecutionRoute } from "./contracts.js";

type AdvertisedRoute = Pick<
  ExecutionRoute,
  | "nodeId"
  | "provider"
  | "model"
  | "reasoningEffort"
  | "backend"
  | "requiredCapabilities"
>;

/** Installed model metadata narrows execution grants; discovery never grants access. */
export async function executorModelRoutes(
  llm: Context["llm"] | undefined,
  grants: ExecutionRoute[],
): Promise<AdvertisedRoute[]> {
  const backends = grants.filter((route) => route.backend !== undefined);
  if (!llm) return backends;
  const providers = new Set(llm.listProviders().map((provider) => provider.id));
  const discovered = await Promise.all(
    [...providers].map(async (provider) => {
      const allowed = grants.filter(
        (route) => !route.backend && route.provider === provider,
      );
      if (!allowed.length) return [];
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const read = async () => {
          const routes: AdvertisedRoute[] = [];
          const models = new Set(
            (await llm.listModels(provider)).map((model) => model.id),
          );
          for (const model of new Set(allowed.map((route) => route.model))) {
            if (!models.has(model)) continue;
            const info = await llm.resolveModelInfo(provider, model);
            const efforts = new Set<string>(
              info?.reasoning?.efforts?.map((effort) => effort.id) ?? [],
            );
            routes.push(
              ...allowed.filter(
                (route) =>
                  route.model === model &&
                  (route.reasoningEffort === undefined ||
                    efforts.has(route.reasoningEffort)),
              ),
            );
          }
          return routes;
        };
        // A stalled adapter catalog must not prevent the device's next heartbeat.
        return await Promise.race([
          read(),
          new Promise<AdvertisedRoute[]>((resolve) => {
            timeout = setTimeout(() => resolve([]), 3000);
          }),
        ]);
      } catch {
        // Unavailable catalogs must not turn configured names into selectable models.
        return [];
      } finally {
        clearTimeout(timeout);
      }
    }),
  );
  return [...backends, ...discovered.flat()].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}

/** A new connection uses the host's installed model catalog when it has no explicit route mask. */
export async function installedExecutorRoutes(
  llm: Context["llm"] | undefined,
  nodeId: string,
): Promise<AdvertisedRoute[]> {
  if (!llm) return [];
  const result = await Promise.all(
    llm
      .listProviders()
      .slice(0, 32)
      .map(async (provider) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            (async () => {
              const models = (await llm.listModels(provider.id)).slice(0, 64);
              const routes: AdvertisedRoute[] = [];
              for (const model of models) {
                const info = await llm.resolveModelInfo(provider.id, model.id);
                const efforts =
                  info?.reasoning?.efforts?.map((effort) => effort.id) ?? [];
                for (const reasoningEffort of [undefined, ...efforts])
                  routes.push({
                    nodeId,
                    provider: provider.id,
                    model: model.id,
                    ...(reasoningEffort ? { reasoningEffort } : {}),
                    requiredCapabilities: [],
                  });
              }
              return routes;
            })(),
            new Promise<AdvertisedRoute[]>((resolve) => {
              timer = setTimeout(() => resolve([]), 3000);
            }),
          ]);
        } catch {
          return [];
        } finally {
          clearTimeout(timer);
        }
      }),
  );
  return result.flat().slice(0, 128);
}

import {
  verifyOfficialProfile,
  type OfficialBackend,
} from "./official-execution.js";
import type {
  ExecutionCatalogResult,
  ExecutionModelChoice,
} from "./execution-models.js";

type InventorySuccess = Extract<ExecutionCatalogResult, { state: "success" }>;
export interface ExecutionModelInventoryOptions {
  llm(): Context["llm"] | undefined;
  nativeReady(): boolean;
  officialBackends(): readonly OfficialBackend[];
  officialAvailable(backend: string): boolean;
  timeoutMs?: number;
  temporaryWorkspaceReady?(): boolean;
}

/** Collects only on demand; one adapter catalog call remains in flight even after a reader times out. */
export class ExecutionModelInventory {
  private inFlight?: Promise<InventorySuccess>;
  private readonly providerQueries = new Map<
    string,
    Promise<ExecutionModelChoice[]>
  >();
  private lastSuccessful?: InventorySuccess;
  constructor(private readonly options: ExecutionModelInventoryOptions) {}
  lastSuccess(): InventorySuccess | undefined {
    return this.lastSuccessful;
  }
  async collect(signal?: AbortSignal): Promise<ExecutionCatalogResult> {
    if (signal?.aborted) return { state: "failure", code: "UNAVAILABLE" };
    if (!this.inFlight) {
      const collection = this.discover();
      this.inFlight = collection;
      void collection
        .then(
          (result) => {
            this.lastSuccessful = result;
          },
          () => {},
        )
        .finally(() => {
          if (this.inFlight === collection) this.inFlight = undefined;
        });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        this.inFlight,
        new Promise<ExecutionCatalogResult>((resolve) => {
          timer = setTimeout(
            () => resolve({ state: "failure", code: "TIMEOUT" }),
            this.options.timeoutMs ?? 3000,
          );
          abort = () => resolve({ state: "failure", code: "UNAVAILABLE" });
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        }),
      ]);
    } catch {
      return { state: "failure", code: "CATALOG_FAILED" };
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
    }
  }
  private async discover(): Promise<InventorySuccess> {
    let complete = true;
    const models: ExecutionModelChoice[] = [];
    const llm = this.options.llm();
    if (llm && this.options.nativeReady()) {
      const providers = llm.listProviders();
      await Promise.all(
        providers.map(async (provider) => {
          let query = this.providerQueries.get(provider.id);
          if (!query) {
            query = (async () => {
              const choices: ExecutionModelChoice[] = [];
              const catalog = await llm.listModels(provider.id);
              for (const model of catalog) {
                const info = await llm.resolveModelInfo(provider.id, model.id);
                const efforts =
                  info?.reasoning?.efforts?.map((effort) => effort.id) ?? [];
                for (const reasoningEffort of [undefined, ...efforts])
                  choices.push({
                    provider: provider.id,
                    model: model.id,
                    ...(reasoningEffort ? { reasoningEffort } : {}),
                    kind: "native-dsh",
                    resume: true,
                  });
              }
              return choices;
            })();
            this.providerQueries.set(provider.id, query);
            const current = query;
            void query.then(
              () => {
                if (this.providerQueries.get(provider.id) === current)
                  this.providerQueries.delete(provider.id);
              },
              () => {
                if (this.providerQueries.get(provider.id) === current)
                  this.providerQueries.delete(provider.id);
              },
            );
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const choices = await Promise.race([
              query,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error("Provider catalog timed out")),
                  Math.max(
                    1,
                    Math.floor((this.options.timeoutMs ?? 3000) * 0.8),
                  ),
                );
              }),
            ]);
            models.push(...choices);
          } catch {
            complete = false;
          } finally {
            clearTimeout(timer);
          }
        }),
      );
    }
    for (const backend of this.options.officialBackends()) {
      try {
        if (!this.options.officialAvailable(backend.backend)) {
          complete = false;
          continue;
        }
        verifyOfficialProfile(backend);
        models.push({
          provider: backend.provider,
          model: backend.model,
          reasoningEffort: backend.reasoningEffort,
          backend: backend.backend,
          kind: "official-codex",
          resume: false,
        });
      } catch {
        complete = false;
      }
    }
    const unique = new Map(
      models.map((choice) => [
        JSON.stringify([
          choice.provider,
          choice.model,
          choice.reasoningEffort ?? null,
          choice.backend ?? null,
        ]),
        choice,
      ]),
    );
    const ordered = [...unique.values()].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
    if (ordered.length > 2048) complete = false;
    return {
      state: "success",
      observedAt: Date.now(),
      complete,
      ...(this.options.temporaryWorkspaceReady
        ? { temporaryWorkspaceReady: this.options.temporaryWorkspaceReady() }
        : {}),
      models: ordered.slice(0, 2048),
    };
  }
}
