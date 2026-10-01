import { LlmAdapter } from '@deepseek-ai/dsh-llm';

/** Only the model boundary is fake; Loader, sessions, tools and AgentLoop are real. */
export class ScriptedModel extends LlmAdapter {
  constructor(script) { super(); this.script = [...script]; this.requests = []; }
  async *stream(options) {
    this.requests.push(options);
    let entry = this.script.shift();
    if (typeof entry === 'function') entry = await entry(options);
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      await new Promise((resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
      return;
    }
    if (entry && typeof entry === 'object') {
      const call = { type: 'tool-call', id: `fake-${this.requests.length}`, name: entry.name, arguments: JSON.stringify(entry.args) };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments };
      yield { type: 'block-end', index: 0, block: call };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else {
      const text = entry ?? 'No more work';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
}
