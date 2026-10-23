import type { Role } from "./contracts.js";

export interface DeploymentPolicy {
  centralMode: "host" | "remote";
  executionEnabled: boolean;
}

/** Missing deployment fields identify legacy configuration, including its historical role default. */
export function deploymentPolicy(input: Partial<DeploymentPolicy> & { role?: Role }): DeploymentPolicy {
  const legacy = input.centralMode === undefined && input.executionEnabled === undefined;
  const oldRole = legacy ? input.role ?? "both" : undefined;
  return {
    centralMode: input.centralMode ?? (input.role === "executor" ? "remote" : "host"),
    executionEnabled: input.executionEnabled ?? (oldRole === "executor" || oldRole === "both"),
  };
}

/** Compatibility for the ledger's existing management and claim guards. */
export function ledgerRole(policy: DeploymentPolicy): Role {
  return policy.centralMode === "remote" ? "executor" : policy.executionEnabled ? "both" : "planner";
}
