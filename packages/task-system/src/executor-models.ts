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
