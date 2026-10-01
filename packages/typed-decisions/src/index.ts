import { Service, type Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { DecisionEngine } from './engine.js';
import { AnyJevCompatibleProvider, JevProvider, ProviderError, RulesProvider, StructuredModelProvider, type CompatibleApiOptions, type DecisionRule, type StructuredCompletionAdapter } from './providers.js';
import type { DecisionProvider, DecisionReceipt, DecisionRequest, ModelCapability, ProviderCapabilities } from './types.js';
export * from './core.js';

export type ProviderConfig =
  | { id: string; kind: 'rules'; rulesVersion: string; rules: DecisionRule[] }
  | { id: string; kind: 'structured'; models: ModelCapability[] }
  | { id: string; kind: 'jev'; model: string; modelVersion: string; apiKeyEnv: string; maxResponseBytes: number }
  | { id: string; kind: 'compatible'; endpoint: string; model: string; modelVersion: string; apiKeyEnv: string; maxResponseBytes: number; capabilityDeclaration: CompatibleApiOptions['capabilityDeclaration'] };
export interface Config {
  defaultProvider: string;
  timeoutMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  failureLimit: number;
  cooldownMs: number;
  maxReceipts: number;
  providers: ProviderConfig[];
}
const integer = (max: number, fallback: number) => Schema.natural().min(1).max(max).default(fallback);
const modelSchema = Schema.object({ model: Schema.string().required(), version: Schema.string().required(), versionSource: Schema.union(['provider-reported', 'configured-pin']), reasoningEfforts: Schema.array(String).default([]) });
const apiFields = {
  model: Schema.string().required(), modelVersion: Schema.string().required(),
  apiKeyEnv: Schema.string().default(''), maxResponseBytes: integer(16 * 1024 * 1024, 1048576),
};
export const Config: Schema<Config> = Schema.object({
  defaultProvider: Schema.string().default('rules'),
  timeoutMs: integer(300000, 10000), maxAttempts: integer(5, 1), retryBaseMs: integer(60000, 100),
  failureLimit: integer(1000, 3), cooldownMs: integer(3600000, 30000), maxReceipts: integer(1000000, 10000),
  providers: Schema.array(Schema.union([
    Schema.object({ id: Schema.string().required(), kind: Schema.const('rules').required(), rulesVersion: Schema.string().default('1'), rules: Schema.array(Schema.any()).default([]) }),
    Schema.object({ id: Schema.string().required(), kind: Schema.const('structured').required(), models: Schema.array(modelSchema).required() }),
    Schema.object({ id: Schema.string().required(), kind: Schema.const('jev').required(), ...apiFields, model: Schema.string().default('jev-1.13.0'), modelVersion: Schema.string().default('jev-1.13.0'), apiKeyEnv: Schema.string().default('TYPESAFE_API_KEY') }),
    Schema.object({ id: Schema.string().required(), kind: Schema.const('compatible').required(), endpoint: Schema.string().required(), ...apiFields,
      capabilityDeclaration: Schema.object({
        readout: Schema.union(['logits', 'hidden-states']).required(), calibration: Schema.union(['none', 'L0', 'L1', 'L2']).required(),
        calibrationArtifact: Schema.string(), maxChoices: integer(255, 26), maxScoreLevels: integer(10, 10),
        questionTypes: Schema.array(Schema.union(['choice', 'noul', 'score'])).required(), reasoningEfforts: Schema.array(String).default([]),
      }).required(),
    }),
  ])).default([{ id: 'rules', kind: 'rules', rulesVersion: '1', rules: [] }]),
});

declare module '@deepseek-ai/cordis' {
  interface Context {
    typedDecisions: TypedDecisionService;
    /** Optional host adapter. It must honor AbortSignal and label configured pins separately from provider-reported versions. */
    typedDecisionCompletion: StructuredCompletionAdapter;
  }
}
export class TypedDecisionService extends Service {
  constructor(ctx: Context, private readonly engine: DecisionEngine) {
    super(ctx, 'typedDecisions');
    ctx.effect(() => () => engine.close());
  }
  evaluate(request: DecisionRequest, options?: { signal?: AbortSignal }): Promise<DecisionReceipt> { return this.engine.evaluate(request, options); }
  capabilities(provider?: string): ProviderCapabilities { return this.engine.capabilities(provider); }
}
export const name = 'typed-decisions';
/** No tools, task ledger, executor, storage, web host or model service are required by rules-only mode. */
export function apply(ctx: Context, config: Config): void {
  const providers: DecisionProvider[] = config.providers.map(provider => {
    switch (provider.kind) {
      case 'rules': return new RulesProvider(provider.id, provider.rulesVersion, provider.rules);
      case 'structured': return new StructuredModelProvider(provider.id, provider.models, {
        complete: input => {
          const adapter = ctx.get('typedDecisionCompletion');
          if (!adapter) throw new ProviderError('completion-adapter-unavailable');
          return adapter.complete(input);
        },
      });
      case 'jev': return new JevProvider({ ...provider, apiKey: () => provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined });
      case 'compatible': return new AnyJevCompatibleProvider({ ...provider, apiKey: () => provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined });
    }
  });
  const engine = new DecisionEngine(providers, config);
  new TypedDecisionService(ctx, engine);
}
