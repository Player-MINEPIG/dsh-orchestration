import type { Agent } from "@deepseek-ai/dsh-agent";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";

export interface StewardTurnSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export function pinStewardTurnSelection(
  agent: Agent,
  requestId: string,
  selection: StewardTurnSelection,
): () => void {
  const selected = Object.freeze({
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : {
          reasoningEffort: ReasoningEffortId(selection.reasoningEffort),
        }),
  });
  let turn: number | undefined;
  const disposers: (() => unknown)[] = [];
  const dispose = () => {
    for (const off of disposers.splice(0)) off();
  };
  disposers.push(
    agent.ctx.on("agent/inbox/claimed", (payload) => {
      if (
        payload.agent === agent &&
        payload.message.source.kind === "user" &&
        "rpcId" in payload.message.source &&
        payload.message.source.rpcId === requestId
      )
        turn = payload.turn;
    }),
  );
  disposers.push(
    agent.ctx.on(
      "system-prompt/assemble",
      async (_assembly, context, next) => {
        const pinned = turn !== undefined && context.agent === agent;
        const assembly = await next();
        return pinned
          ? {
              ...assembly,
              variables: {
                ...assembly.variables,
                provider: selected.provider,
                model: selected.model,
              },
            }
          : assembly;
      },
      { prepend: true },
    ),
  );
  disposers.push(
    agent.ctx.on(
      "agent/request",
      async (payload, next) => {
        const pinned = payload.agent === agent && payload.turn === turn;
        const config = await next();
        if (!pinned) return config;
        const { reasoningEffort: _inheritedEffort, ...base } = config;
        return { ...base, ...selected };
      },
      { prepend: true },
    ),
  );
  disposers.push(
    agent.ctx.on("session/event", (session, event) => {
      if (
        session === agent.session &&
        event.type === "turn/end" &&
        event.data.turn === turn
      )
        dispose();
    }),
  );
  disposers.push(
    agent.ctx.on("agent/inbox/discarded", (payload) => {
      if (
        payload.agent === agent &&
        payload.message.source.kind === "user" &&
        "rpcId" in payload.message.source &&
        payload.message.source.rpcId === requestId &&
        turn === undefined
      )
        dispose();
    }),
  );
  return dispose;
}
