/** Display advice changes neither dispatch authority nor record retention. */
export interface DelegationDisplayInput {
  requested?: "task" | "step";
  complexity?: "small" | "independent";
}
export interface DelegationDisplay {
  mode: "task" | "step";
  reason:
    | "explicit-request"
    | "independent-delivery"
    | "small-execution"
    | "default-task";
}
export function delegationDisplay(
  input: DelegationDisplayInput = {},
  defaultMode: "task" | "step" = "task",
): DelegationDisplay {
  if (
    ![undefined, "task", "step"].includes(input.requested) ||
    ![undefined, "small", "independent"].includes(input.complexity)
  )
    throw new Error("invalid delegation display advice");
  if (input.requested)
    return { mode: input.requested, reason: "explicit-request" };
  if (input.complexity === "independent")
    return { mode: "task", reason: "independent-delivery" };
  if (input.complexity === "small")
    return { mode: "step", reason: "small-execution" };
  return { mode: defaultMode, reason: "default-task" };
}
