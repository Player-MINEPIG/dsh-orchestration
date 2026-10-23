// Synthetic executor declarations still go through the real catalog protocol.
let serial = 0;
export function publishModels(ledger, nodeId, models, { temporaryWorkspaceReady = true } = {}) {
  const key = `fixture-catalog-${++serial}`;
  const request = ledger.executionModels.request(key, { nodeId }).catalog.request;
  return ledger.completeExecutionModels(`${key}-complete`, {
    nodeId, requestId: request.requestId, generation: request.generation,
    result: {
      state: 'success', complete: true,
      observedAt: Date.parse(ledger.snapshot().generatedAt),
      temporaryWorkspaceReady, models,
    },
  }).value;
}
export function registerExecutor(ledger, commandId, node) {
  const receipt = ledger.registerNode(commandId, node);
  const catalog = publishModels(ledger, node.nodeId, node.models.flatMap(({ provider, model, reasoningEfforts }) =>
    [undefined, ...reasoningEfforts].map(reasoningEffort => ({ provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }))));
  const choice = catalog.catalog.positiveSnapshot?.models.find(model => model.reasoningEffort) ?? catalog.catalog.positiveSnapshot?.models[0];
  if (choice) ledger.executionModels.setDefault(`fixture-default-${++serial}`, { nodeId: node.nodeId, expectedRevision: catalog.policy.revision, expectedCatalogRevision: catalog.catalog.positiveSnapshot.revision, choice });
  return receipt;
}
