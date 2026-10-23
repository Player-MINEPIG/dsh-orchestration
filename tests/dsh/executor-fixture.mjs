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

// A synthetic remote host answers subsequent refreshes through the same protocol.
export function respondToCatalogRequests(ledger, nodeIds) {
  const timer = setInterval(() => {
    for (const nodeId of nodeIds) {
      const models = ledger.executionModels.view(nodeId).catalog.positiveSnapshot?.models;
      if (!models) continue;
      for (const request of ledger.executionModels.pending(nodeId)) {
        ledger.completeExecutionModels(`fixture-refresh-${++serial}`, {
          nodeId, requestId: request.requestId, generation: request.generation,
          result: { state: 'success', observedAt: Date.parse(ledger.snapshot().generatedAt), complete: true, temporaryWorkspaceReady: true, models },
        });
      }
    }
  }, 20);
  timer.unref();
  return () => clearInterval(timer);
}
