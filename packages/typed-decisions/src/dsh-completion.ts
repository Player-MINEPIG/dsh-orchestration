import { Service, type Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { CompletionInput, CompletionOutput, StructuredCompletionAdapter } from './providers.js';
import { ProviderError } from './providers.js';
import { fail, freeze, positiveInteger, text } from './validation.js';
import type {} from './index.js';

/** One permitted decision-model selector and the exact native request route. */
export interface ModelRoute {
  model: string;
  /** Exact model id sent to the native provider. This is an operator pin, not provider attestation. */
  modelVersion: string;
  provider: string;
  reasoningEfforts: string[];
}
export interface Config {
  routes: ModelRoute[];
  /** Per-call output-token request cap; billing remains provider-owned. */
  maxOutputTokens: number;
  maxInputBytes: number;
  /** Combined text/reasoning payload bound, including the assembled blocks. */
  maxOutputBytes: number;
  maxRuntimeMs: number;
  maxConcurrent: number;
}
const requiredInteger = (max: number) => Schema.natural().min(1).max(max).required();
export const Config: Schema<Config> = Schema.object({
  routes: Schema.array(Schema.object({
    model: Schema.string().required(), modelVersion: Schema.string().required(), provider: Schema.string().required(),
    reasoningEfforts: Schema.array(String).default([]),
  })).required(),
  maxOutputTokens: requiredInteger(131072), maxInputBytes: requiredInteger(16 * 1024 * 1024),
  maxOutputBytes: requiredInteger(16 * 1024 * 1024), maxRuntimeMs: requiredInteger(300000),
  maxConcurrent: requiredInteger(64),
});
export const name = 'typed-decisions-dsh-completion';
export const inject = ['llm'];

interface Block { type: 'text' | 'reasoning'; deltas: string; ended: boolean; }

/**
 * A native one-shot model call. No agent, session, tool executor or background service is created.
 * DSH owns provider authentication and must honor cancellation on its registered adapter.
 */
export class DshCompletionService extends Service implements StructuredCompletionAdapter {
  readonly routes: readonly Readonly<ModelRoute>[];
  private readonly active = new Map<AbortController, Promise<CompletionOutput>>();
  private closed = false;
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'typedDecisionCompletion');
    const seen = new Set<string>();
    if (!config.routes.length) fail('native completion requires a model route');
    for (const route of config.routes) {
      text(route.model, 'native model selector'); text(route.modelVersion, 'native model version'); text(route.provider, 'native provider');
      if (seen.has(route.model)) fail('duplicate native model selector');
      seen.add(route.model);
      if (new Set(route.reasoningEfforts).size !== route.reasoningEfforts.length) fail('duplicate native reasoning effort');
      for (const effort of route.reasoningEfforts) text(effort, 'native reasoning effort');
    }
    this.routes = freeze(structuredClone(config.routes));
    ctx.effect(() => () => this.close());
  }
  get activeCount(): number { return this.active.size; }
  complete(input: CompletionInput): Promise<CompletionOutput> {
    if (this.closed) return Promise.reject(new ProviderError('cancelled'));
    input.signal.throwIfAborted();
    const route = this.routes.find(candidate => candidate.model === input.model);
    if (!route || route.modelVersion !== input.modelVersion) return Promise.reject(new ProviderError('unsupported'));
    if (input.reasoningEffort !== undefined && !route.reasoningEfforts.includes(input.reasoningEffort)) return Promise.reject(new ProviderError('unsupported'));
    if (this.active.size >= this.config.maxConcurrent) return Promise.reject(new ProviderError('native-completion-capacity'));
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal.reason);
    input.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new ProviderError('timeout')), this.config.maxRuntimeMs);
    const done = this.run(input, route, controller).finally(() => {
      clearTimeout(timer);
      input.signal.removeEventListener('abort', abort);
      this.active.delete(controller);
    });
    this.active.set(controller, done);
    return done;
  }
  private async run(input: CompletionInput, route: Readonly<ModelRoute>, controller: AbortController): Promise<CompletionOutput> {
    const { signal } = controller;
    let listener: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      listener = () => reject(signal.reason);
      signal.addEventListener('abort', listener, { once: true });
      if (signal.aborted) listener();
    });
    void aborted.catch(() => {});
    let iterator: AsyncIterator<StreamChunk> | undefined;
    let exhausted = false;
    try {
      signal.throwIfAborted();
      const payload = freeze({
        system: input.system,
        messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: JSON.stringify({ input: input.input, responseSchema: input.responseSchema }) }] }],
        tools: [],
      });
      if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > this.config.maxInputBytes) throw new ProviderError('native-input-too-large');
      const prepared = await Promise.race([this.ctx.llm.prepareCall({
        provider: route.provider, model: route.modelVersion, maxTokens: this.config.maxOutputTokens,
        ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(input.reasoningEffort) }),
      }, signal), aborted]);
      signal.throwIfAborted();
      if (prepared.config.reasoningEffort !== undefined && !route.reasoningEfforts.includes(prepared.config.reasoningEffort)) throw new ProviderError('unsupported');
      const options: GenerateOptions = { ...prepared.config, ...payload, signal };
      iterator = prepared.stream(options)[Symbol.asyncIterator]();
      const blocks = new Map<number, Block>();
      let outputBytes = 0;
      let finished = false;
      let usage: CompletionOutput['usage'];
      const count = (value: string) => {
        outputBytes += Buffer.byteLength(value, 'utf8');
        if (outputBytes > this.config.maxOutputBytes) throw new ProviderError('native-output-too-large');
      };
      while (true) {
        const item = await Promise.race([iterator.next(), aborted]);
        signal.throwIfAborted();
        if (item.done) { exhausted = true; break; }
        if (finished) fail('native stream emitted data after finish');
        const chunk = item.value;
        switch (chunk.type) {
          case 'block-start':
            if (!Number.isSafeInteger(chunk.index) || chunk.index < 0 || blocks.has(chunk.index) || !['text', 'reasoning'].includes(chunk.blockType)) fail('native stream returned an unsupported block');
            blocks.set(chunk.index, { type: chunk.blockType as 'text' | 'reasoning', deltas: '', ended: false });
            // Empty blocks also consume capacity, independently of their text size.
            count(' ');
            break;
          case 'text-delta':
          case 'reasoning-delta': {
            const block = blocks.get(chunk.index);
            if (!block || block.ended || block.type !== (chunk.type === 'text-delta' ? 'text' : 'reasoning')) fail('native stream returned an uncorrelated delta');
            count(chunk.text);
            if (block.type === 'text') block.deltas += chunk.text;
            break;
          }
          case 'block-end': {
            const block = blocks.get(chunk.index);
            if (!block || block.ended || chunk.block.type !== block.type) fail('native stream returned an uncorrelated block end');
            if (chunk.block.type !== 'text' && chunk.block.type !== 'reasoning') fail('native stream returned non-text output');
            count(chunk.block.text);
            if (block.type === 'text') {
              if (block.deltas && block.deltas !== chunk.block.text) fail('native stream text differs from assembled block');
              block.deltas = chunk.block.text;
            }
            block.ended = true;
            break;
          }
          case 'usage': {
            if (usage) fail('native stream returned duplicate usage');
            const u = chunk.usage;
            for (const value of [u.inputTokens, u.outputTokens, u.cacheReadTokens ?? 0, u.cacheWriteTokens ?? 0]) {
              if (!Number.isSafeInteger(value) || value < 0) fail('native stream returned invalid token usage');
            }
            const inputTokens = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
            if (!Number.isSafeInteger(inputTokens)) fail('native stream returned invalid total input usage');
            if (u.outputTokens > this.config.maxOutputTokens) throw new ProviderError('native-output-token-limit');
            usage = { input_tokens: inputTokens, output_tokens: u.outputTokens };
            break;
          }
          case 'finish':
            if (chunk.reason.kind !== 'stop') throw new ProviderError('native-stream-incomplete');
            finished = true;
            break;
          default:
            // Tool calls are never executed; unknown native extensions fail closed.
            fail('native stream returned an unsupported event');
        }
      }
      if (!finished || !blocks.size || [...blocks.values()].some(block => !block.ended)) fail('native stream ended without complete output');
      const output = [...blocks.values()].filter(block => block.type === 'text').map(block => block.deltas).join('');
      if (!output.trim()) fail('native stream returned no text');
      return { output, modelVersion: route.modelVersion, modelVersionSource: 'configured-pin', ...(usage ? { usage } : {}) };
    } catch (error) {
      if (!signal.aborted) controller.abort(error);
      if (error && typeof error === 'object' && 'code' in error && error.code === 'UNSUPPORTED_REASONING_EFFORT') throw new ProviderError('unsupported');
      throw error;
    } finally {
      if (listener) signal.removeEventListener('abort', listener);
      if (!exhausted && iterator?.return) {
        // Prompt cancellation cannot force an uncooperative in-process adapter to settle.
        // Request iterator cleanup and contain its eventual failure without retaining this call.
        const cleanup = Promise.resolve().then(() => iterator!.return!());
        if (signal.aborted) void cleanup.catch(() => {});
        else await cleanup;
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.active.keys()) controller.abort(new ProviderError('cancelled'));
    await Promise.allSettled(this.active.values());
  }
}

/** Mount the optional native bridge; rules and HTTP providers do not require it. */
export function apply(ctx: Context, config: Config): void {
  for (const key of ['maxOutputTokens', 'maxInputBytes', 'maxOutputBytes', 'maxRuntimeMs', 'maxConcurrent'] as const) positiveInteger(config[key], key);
  new DshCompletionService(ctx, config);
}
