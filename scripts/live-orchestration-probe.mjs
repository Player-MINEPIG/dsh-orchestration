import { writeFileSync } from 'node:fs';

export const name = 'live-orchestration-probe';
export const inject = ['llm', 'taskSystem', 'loader'];
export function apply(ctx, config) {
  let stopped = false;
  const timer = setTimeout(async () => {
    const result = { sampledAt: new Date().toISOString(), pid: process.pid, modelCalls: 0 };
    try {
      await ctx.loader.await();
      result.nodeId = ctx.taskSystem.config.nodeId;
      result.role = ctx.taskSystem.config.role;
      result.providers = ctx.llm.listProviders();
      result.models = [];
      for (const provider of result.providers) {
        for (const model of await ctx.llm.listModels(provider.id)) {
          const info = await ctx.llm.resolveModelInfo(provider.id, model.id);
          result.models.push({ ...model, reasoning: info.reasoning });
        }
      }
      const settings = ctx.get('taskPluginSettings');
      if (settings) {
        result.workspaces = await settings.workspaces();
        result.decisionSettings = await settings.decisionSettings();
        result.startup = await settings.startup();
        result.queue = await settings.queue();
      }
      result.remote = ctx.get('remoteExecution')?.settingsSnapshot();
      const snapshot = ctx.taskSystem.ledger.snapshot();
      result.counts = Object.fromEntries(['tasks', 'runs', 'reports', 'attempts'].map(key => [key, snapshot[key].length]));
      result.pendingRuns = snapshot.runs.filter(run => !['succeeded', 'failed', 'cancelled', 'blocked'].includes(run.state)).map(run => ({runId:run.runId, state:run.state, route:run.route}));
      result.status = 'passed';
    } catch (error) {
      result.status = 'failed';
      result.errorCode = error.code ?? error.name;
    }
    if (!stopped) writeFileSync(config.output, JSON.stringify(result, null, 2) + '\n', {mode:0o600});
  }, 0);
  ctx.effect(() => () => { stopped = true; clearTimeout(timer); });
}
