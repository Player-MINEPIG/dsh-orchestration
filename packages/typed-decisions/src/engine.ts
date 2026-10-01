import { setTimeout as delay } from 'node:timers/promises';
import type { DecisionAnswer, DecisionErrorCode, DecisionProvider, DecisionReceipt, DecisionRequest, EngineOptions, ModelCapability, ProviderCapabilities, ProviderResult } from './types.js';
import { DecisionValidationError, digest, fail, freeze, id, json, positiveInteger, text, validateRequest, validateResult } from './validation.js';
import { ProviderError } from './providers.js';

class EvaluationError extends Error {
  constructor(readonly code: DecisionErrorCode, message: string) { super(message); }
}
interface RegisteredProvider {
  provider: DecisionProvider;
  capabilities: ProviderCapabilities;
  failures: number;
  blockedUntil: number;
}
function validateCapabilities(provider: DecisionProvider): void {
  id(provider.id, 'provider id'); text(provider.version, 'provider version');
  const c = provider.capabilities;
  json(c, 'capabilities');
  if (!Array.isArray(c.questionTypes) || !c.questionTypes.length || c.questionTypes.some(t => !['choice', 'noul', 'score'].includes(t)) || new Set(c.questionTypes).size !== c.questionTypes.length) fail('invalid provider questionTypes');
  positiveInteger(c.maxChoices, 'provider maxChoices', 255); positiveInteger(c.maxScoreLevels, 'provider maxScoreLevels', 10);
  if (typeof c.distributions !== 'boolean' || !['native', 'validation-only'].includes(c.abstention)) fail('invalid provider capabilities');
  if (!Array.isArray(c.models) || !c.models.length) fail('provider requires at least one model');
  const seen = new Set<string>();
  for (const model of c.models) {
    text(model.model, 'model'); text(model.version, 'model version');
    if (model.versionSource !== undefined && !['provider-reported', 'configured-pin'].includes(model.versionSource)) fail('invalid model versionSource');
    if (seen.has(model.model)) fail('duplicate model capability'); seen.add(model.model);
    if (!Array.isArray(model.reasoningEfforts) || new Set(model.reasoningEfforts).size !== model.reasoningEfforts.length) fail('invalid reasoningEfforts');
    for (const effort of model.reasoningEfforts) text(effort, 'reasoningEffort');
  }
  if (!c.evidence || !['deterministic', 'structured-output', 'hosted-typed-api', 'logits', 'hidden-states'].includes(c.evidence.kind)) fail('invalid evidence kind');
  if (c.evidence.kind === 'structured-output' && (c.distributions || c.evidence.calibration !== 'none')) fail('ordinary structured output cannot claim calibrated distributions');
  if ((c.evidence.kind === 'logits' || c.evidence.kind === 'hidden-states') && ['L1', 'L2'].includes(c.evidence.calibration)) text(c.evidence.artifact, 'calibration artifact');
}

/** In-host bounded decision evaluation. Durable storage and authorization belong to the consumer. */
export class DecisionEngine {
  readonly options: Required<EngineOptions>;
  private readonly providers = new Map<string, RegisteredProvider>();
  private readonly receipts = new Map<string, { digest: string; pending: Promise<DecisionReceipt> }>();
  private readonly controllers = new Set<AbortController>();
  private closed = false;

  constructor(providers: DecisionProvider[], options: EngineOptions) {
    this.options = { timeoutMs: 10000, maxAttempts: 1, retryBaseMs: 100, failureLimit: 3, cooldownMs: 30000, maxReceipts: 10000, ...options };
    id(options.defaultProvider, 'defaultProvider');
    positiveInteger(this.options.timeoutMs, 'timeoutMs', 300000);
    positiveInteger(this.options.maxAttempts, 'maxAttempts', 5);
    positiveInteger(this.options.retryBaseMs, 'retryBaseMs', 60000);
    positiveInteger(this.options.failureLimit, 'failureLimit', 1000);
    positiveInteger(this.options.cooldownMs, 'cooldownMs', 3600000);
    positiveInteger(this.options.maxReceipts, 'maxReceipts', 1000000);
    for (const provider of providers) {
      validateCapabilities(provider);
      if (this.providers.has(provider.id)) fail(`duplicate provider ${provider.id}`);
      this.providers.set(provider.id, { provider, capabilities: freeze(structuredClone(provider.capabilities)), failures: 0, blockedUntil: 0 });
    }
    if (!this.providers.has(options.defaultProvider)) fail('defaultProvider is not configured');
  }
  capabilities(provider = this.options.defaultProvider): ProviderCapabilities {
    const registered = this.providers.get(provider);
    if (!registered) fail('provider is not configured');
    return registered.capabilities;
  }
  evaluate(input: DecisionRequest, options: { signal?: AbortSignal } = {}): Promise<DecisionReceipt> {
    if (this.closed) return Promise.reject(new Error('typed decision service is closed'));
    validateRequest(input);
    const request = freeze(structuredClone(input));
    const providerId = request.provider ?? this.options.defaultProvider;
    const registered = this.providers.get(providerId);
    if (!registered) fail(`provider ${providerId} is not configured`);
    const fingerprint = digest({ request, provider: providerId, providerVersion: registered.provider.version, capabilities: registered.capabilities });
    const cached = this.receipts.get(request.requestId);
    if (cached) {
      if (cached.digest !== fingerprint) fail('requestId was reused for different input or provider capabilities');
      // A replay joins the first caller's evaluation; a second signal cannot cancel its owner.
      return cached.pending;
    }
    if (this.receipts.size >= this.options.maxReceipts) fail('receipt capacity reached; persist receipts and create a new engine instead of evicting idempotency keys');
    const pending = this.run(request, registered, fingerprint, options.signal);
    this.receipts.set(request.requestId, { digest: fingerprint, pending });
    return pending;
  }
  private unsupported(request: DecisionRequest, c: ProviderCapabilities, model?: ModelCapability): string | undefined {
    if (!model) return 'model is outside configured capabilities';
    if (request.reasoningEffort !== undefined && !model.reasoningEfforts.includes(request.reasoningEffort)) return 'reasoningEffort is unsupported for this model';
    for (const q of request.questions) {
      if (!c.questionTypes.includes(q.type)) return `unsupported question type ${q.type}`;
      if (q.type === 'choice' && Object.keys(q.candidates).length > c.maxChoices) return 'choice count exceeds provider capabilities';
      if (q.type === 'score' && q.levels.length > c.maxScoreLevels) return 'score levels exceed provider capabilities';
      if (q.abstainWhen?.length && c.abstention !== 'native') return 'provider has no native abstention; explicit abstain conditions require another provider or deterministic policy';
    }
    return;
  }
  private async run(request: DecisionRequest, registered: RegisteredProvider, inputDigest: string, parentSignal?: AbortSignal): Promise<DecisionReceipt> {
    const started = performance.now();
    const { provider, capabilities } = registered;
    const model = request.model === undefined ? capabilities.models[0] : capabilities.models.find(m => m.model === request.model);
    let attempts = 0;
    const base = {
      schemaVersion: 1 as const, requestId: request.requestId, inputDigest, requestDigest: digest(request), stateHash: request.stateHash,
      provider: provider.id, providerVersion: provider.version, model: request.model ?? model!.model,
      questionVersions: Object.fromEntries(request.questions.map(q => [q.questionId, q.questionVersion])), evidence: capabilities.evidence,
    };
    const controller = new AbortController();
    this.controllers.add(controller);
    const cancelled = () => controller.abort(new EvaluationError('cancelled', 'decision cancelled'));
    parentSignal?.addEventListener('abort', cancelled, { once: true });
    if (parentSignal?.aborted) cancelled();
    const timer = setTimeout(() => controller.abort(new EvaluationError('timeout', 'provider evaluation exceeded timeout')), this.options.timeoutMs);
    let abortListener: (() => void) | undefined;
    try {
      const unsupported = this.unsupported(request, capabilities, model);
      if (unsupported) throw new EvaluationError('unsupported', unsupported);
      if (registered.blockedUntil > Date.now()) throw new EvaluationError('circuit-open', 'provider failure limit reached; cooldown active');
      controller.signal.throwIfAborted();
      const abortPromise = new Promise<never>((_, reject) => {
        abortListener = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', abortListener, { once: true });
      });
      let result: ProviderResult | undefined;
      while (attempts < this.options.maxAttempts) {
        attempts++;
        try {
          result = await Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return provider.evaluate({ request, model: model!, signal: controller.signal }); }), abortPromise]);
          validateResult(result, request, capabilities);
          if (result.modelVersion !== model!.version) fail('returned modelVersion differs from pinned capability version');
          if ((result.modelVersionSource ?? 'provider-reported') !== (model!.versionSource ?? 'provider-reported')) fail('returned model version source differs from configured capability');
          break;
        } catch (error) {
          if (!(error instanceof ProviderError) || !error.retryable || attempts >= this.options.maxAttempts) throw error;
          const retryMs = Math.max(error.retryAfterMs, this.options.retryBaseMs * 2 ** (attempts - 1));
          await Promise.race([delay(retryMs, undefined, { signal: controller.signal }), abortPromise]);
        }
      }
      registered.failures = 0; registered.blockedUntil = 0;
      return freeze({ ...base, modelVersion: result!.modelVersion, modelVersionSource: result!.modelVersionSource ?? 'provider-reported', answers: structuredClone(result!.answers), status: Object.values(result!.answers).some(a => a.type === 'abstain') ? 'abstained' : 'answered', attempts, elapsedMs: Math.max(0, performance.now() - started), ...(result!.usage ? { usage: structuredClone(result!.usage) } : {}) });
    } catch (error) {
      const actual = controller.signal.aborted ? controller.signal.reason : error;
      const code: DecisionErrorCode = actual instanceof EvaluationError ? actual.code : actual instanceof ProviderError && ['unsupported', 'timeout', 'cancelled'].includes(actual.code) ? actual.code as DecisionErrorCode : actual instanceof DecisionValidationError || actual instanceof SyntaxError || (actual instanceof ProviderError && actual.code === 'invalid-json') ? 'invalid-output' : 'provider-error';
      if (code !== 'unsupported' && code !== 'cancelled' && code !== 'circuit-open') {
        registered.failures++;
        if (registered.failures >= this.options.failureLimit) registered.blockedUntil = Date.now() + this.options.cooldownMs;
      }
      // Arbitrary provider error text may contain credentials/prompts. Keep receipts bounded and non-sensitive.
      const message = actual instanceof EvaluationError ? actual.message : actual instanceof ProviderError && /^http-\d{3}$/.test(actual.code) ? actual.code : code === 'invalid-output' ? 'provider output failed strict validation' : 'provider evaluation failed';
      const answers: Record<string, DecisionAnswer> = Object.fromEntries(request.questions.map(q => [q.questionId, { type: 'abstain', reason: code }]));
      return freeze({ ...base, modelVersion: null, modelVersionSource: null, answers, status: 'abstained', error: { code, message }, attempts, elapsedMs: Math.max(0, performance.now() - started) });
    } finally {
      clearTimeout(timer);
      if (abortListener) controller.signal.removeEventListener('abort', abortListener);
      parentSignal?.removeEventListener('abort', cancelled);
      this.controllers.delete(controller);
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.controllers) controller.abort(new EvaluationError('cancelled', 'decision service unloaded'));
    await Promise.allSettled([...this.receipts.values()].map(r => r.pending));
  }
}
