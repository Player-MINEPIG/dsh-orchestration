import { insist } from "./protocol.js";
import type {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
  Route,
  LeaseRef,
} from "./ports.js";

export interface NativeExecutionPort {
  readonly activeCount?: number;
  sendTaskReturn?: NonNullable<ExecutionProvider["sendTaskReturn"]>;
  sendSessionMessage?: NonNullable<ExecutionProvider["sendSessionMessage"]>;
  executionStatus?(ref: LeaseRef): string;
  executeExternal(request: ExecutionRequest): Promise<ExecutionResult>;
}
export interface NativeAdapterPolicy {
  provider: string;
  models: { model: string; reasoningEfforts: string[] }[];
  capabilities: string[];
}
/** Bridge the host's execution-only native DSH entrypoint; the worker owns settlement. */
export function nativeExecutionAdapter(
  native: NativeExecutionPort,
  policy: NativeAdapterPolicy,
): ExecutionProvider {
  insist(
    policy.provider.length > 0 && policy.models.length > 0,
    "NATIVE_ROUTE_POLICY_REQUIRED",
  );
  const capabilities = [...policy.capabilities];
  const models = policy.models.map((model) => ({
    model: model.model,
    reasoningEfforts: [...model.reasoningEfforts],
  }));
  const supports = (route: Route): boolean =>
    route.provider === policy.provider &&
    models.some(
      (model) =>
        model.model === route.model &&
        (route.reasoningEffort === undefined ||
          model.reasoningEfforts.includes(route.reasoningEffort)),
    );
  return {
    id: policy.provider,
    sendTaskReturn: native.sendTaskReturn?.bind(native),
    sendSessionMessage: native.sendSessionMessage?.bind(native),
    capabilities,
    supports,
    status: (ref) => native.executionStatus?.(ref) ?? "执行端正在运行任务。",
    async execute(request) {
      insist(
        request.claim.run.route && supports(request.claim.run.route),
        "NATIVE_ROUTE_DENIED",
        403,
      );
      insist(!request.signal.aborted, "EXECUTION_ABORTED", 409);
      return await native.executeExternal(request);
    },
  };
}
