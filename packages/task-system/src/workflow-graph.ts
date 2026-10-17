import { TaskError } from "./ledger.js";
import type { WorkflowDefinition } from "./workflow-contracts.js";

export function compileWorkflow(
  definition: WorkflowDefinition,
): WorkflowDefinition {
  const copy = structuredClone(definition);
  const stages =
    copy.stages ??
    [...new Set(copy.steps.map((step) => step.nodeId))].map(
      (nodeId, index) => ({
        stageId: `stage-${index + 1}`,
        nodeId,
        title: nodeId,
        position: { x: 40 + index * 320, y: 40 },
      }),
    );
  const stageById = new Map(stages.map((stage) => [stage.stageId, stage]));
  if (stageById.size !== stages.length)
    throw new TaskError("WORKFLOW_DAG", "Duplicate stage identifier");
  const calls =
    copy.calls ??
    copy.steps.flatMap((step) =>
      step.dependsOn.map((fromStepId) => ({
        fromStepId,
        toStepId: step.stepId,
      })),
    );
  const stepIds = new Set(copy.steps.map((step) => step.stepId));
  if (copy.resultStepIds && (new Set(copy.resultStepIds).size !== copy.resultStepIds.length || copy.resultStepIds.some(id => !stepIds.has(id))))
    throw new TaskError("WORKFLOW_OUTPUT", "Final output steps must be distinct existing steps");
  const seen = new Set<string>();
  for (const call of calls) {
    const key = JSON.stringify([call.fromStepId, call.toStepId]);
    if (call.fromStepId === call.toStepId)
      throw new TaskError("WORKFLOW_DAG", "Workflow call cycle");
    if (
      seen.has(key) ||
      !stepIds.has(call.fromStepId) ||
      !stepIds.has(call.toStepId)
    )
      throw new TaskError("WORKFLOW_DAG", "Invalid or duplicate step call");
    seen.add(key);
  }
  copy.steps = copy.steps.map((step, index) => {
    if (copy.stages && !step.stageId)
      throw new TaskError("WORKFLOW_ROUTE", "Step must name its stage");
    const stage = step.stageId
      ? stageById.get(step.stageId)
      : stages.find((candidate) => candidate.nodeId === step.nodeId);
    if (!stage)
      throw new TaskError(
        "WORKFLOW_ROUTE",
        "Step must belong to an existing stage",
      );
    return {
      ...step,
      stageId: stage.stageId,
      nodeId: stage.nodeId,
      position: step.position ?? { x: 40 + index * 260, y: 40 },
      dependsOn: calls
        .filter((call) => call.toStepId === step.stepId)
        .map((call) => call.fromStepId),
    };
  });
  return { ...copy, stages, calls };
}

export function workflowResultStepIds(definition: WorkflowDefinition): string[] {
  if (definition.resultStepIds) return [...definition.resultStepIds];
  const called = new Set(definition.steps.flatMap(step => step.dependsOn));
  return definition.steps.filter(step => !called.has(step.stepId)).map(step => step.stepId);
}
