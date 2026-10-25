import { z } from "zod";
import {
  ExecutionModelChoice,
  ExecutionModelViewPage,
} from "./execution-models.js";

const view = ExecutionModelViewPage.shape.view;
const node = z.object({
  nodeId: z.string(),
  state: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  workspaceIds: z.array(z.string()).optional(),
  maxConcurrent: z.number().optional(),
  runtimeReady: z.boolean().optional(),
  activeExecutions: z.number().optional(),
  activeClaims: z.number().optional(),
  availableSlots: z.number().optional(),
  observedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  source: z.string().optional(),
  roles: z.array(z.string()).optional(),
  defaultWorkspaceId: z.string().optional(),
  executionModels: view.optional(),
  catalog: view.shape.catalog.optional(),
  policy: view.shape.policy.optional(),
});
export const NodeReadOptions = z
  .object({
    nodeId: z.string().optional(),
    model: z.string().optional(),
    details: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z
      .string()
      .regex(/^\d{1,9}$/)
      .optional(),
  })
  .strict();
const route = ExecutionModelChoice.extend({
  nodeId: z.string(),
  workspaceId: z.string().optional(),
  requiredCapabilities: z.array(z.string()).optional(),
});

export function nodeRead(
  value: unknown,
  raw: z.infer<typeof NodeReadOptions> = {},
) {
  const input = NodeReadOptions.parse(raw),
    payload = Array.isArray(value)
      ? { nodes: value, routes: undefined }
      : z
          .object({
            nodes: z.array(z.unknown()),
            routes: z.array(route).optional(),
          })
          .parse(value);
  const nodes = z
    .array(node)
    .parse(payload.nodes)
    .filter((node) => !input.nodeId || node.nodeId === input.nodeId);
  const routes =
    payload.routes ??
    nodes.flatMap((node) => {
      const catalog = node.executionModels?.catalog ?? node.catalog;
      return (
        catalog?.positiveSnapshot?.models ??
        catalog?.snapshot?.models ??
        []
      ).map((model) => ({ ...model, nodeId: node.nodeId }));
    });
  const filtered = routes.filter(
    (route) =>
      (!input.nodeId || route.nodeId === input.nodeId) &&
      (!input.model || route.model === input.model),
  );
  const offset = Number(input.cursor ?? 0),
    limit = input.limit ?? 25;
  return {
    nodes: nodes.map((node) => {
      const catalog = node.executionModels?.catalog ?? node.catalog,
        policy = node.executionModels?.policy ?? node.policy;
      return {
        nodeId: node.nodeId,
        state: node.state,
        capabilities: node.capabilities,
        workspaceIds: node.workspaceIds,
        maxConcurrent: node.maxConcurrent,
        runtimeReady: node.runtimeReady,
        activeExecutions: node.activeExecutions,
        activeClaims: node.activeClaims,
        availableSlots: node.availableSlots,
        observedAt: node.observedAt,
        expiresAt: node.expiresAt,
        source: node.source,
        roles: node.roles,
        defaultWorkspaceId: node.defaultWorkspaceId,
        policy,
        catalog: catalog && {
          state: catalog.state,
          reason: catalog.reason,
          request: catalog.request,
          diagnostic: catalog.diagnostic,
          progress: catalog.progress,
          revision: catalog.snapshot?.revision,
          modelCount: (
            catalog.positiveSnapshot?.models ??
            catalog.snapshot?.models ??
            []
          ).length,
        },
      };
    }),
    ...(input.details
      ? { routes: filtered.slice(offset, offset + limit) }
      : {}),
    page: {
      limit,
      nextCursor:
        input.details && offset + limit < filtered.length
          ? String(offset + limit)
          : null,
      total: filtered.length,
    },
  };
}

export type NodeReadOptions = z.infer<typeof NodeReadOptions>;
