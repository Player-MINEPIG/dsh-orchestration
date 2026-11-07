import type { Agent } from "@deepseek-ai/dsh-agent";
import { z } from "zod";
import {
  ManualCheckScopes,
  type SessionMessage,
  type ManualCheckScope,
} from "./remote/ports.js";

const manualScopes = new WeakMap<Agent, Map<string, ManualCheckScope>>();
export function manualCheckFor(
  agent: Agent,
  taskId: string,
  runId: string,
): ManualCheckScope | undefined {
  const scope = manualScopes.get(agent)?.get(taskId);
  return scope?.runId === runId ? scope : undefined;
}

export function manualCheckTools(
  scopes: readonly ManualCheckScope[],
): string[] {
  return [
    "task_checkin",
    "task_query",
    "task_history",
    "task_wait",
    ...(scopes.some((scope) => scope.runId) ? ["task_execution_status"] : []),
  ];
}

export function checkinTools(
  message: SessionMessage,
  original: readonly string[],
): string[] {
  const scopes =
    message.checkIn && !message.checkIn.automatic
      ? ManualCheckScopes.safeParse(message.checkIn.manualChecks)
      : undefined;
  return scopes?.success ? manualCheckTools(scopes.data) : [...original];
}

export function applyCheckinSurface(
  agent: Agent,
  message: SessionMessage,
  original: readonly string[],
): () => void {
  const allowed = new Set(checkinTools(message, original));
  const parsed =
    message.checkIn && !message.checkIn.automatic
      ? ManualCheckScopes.safeParse(message.checkIn.manualChecks)
      : undefined;
  const scopes = parsed?.success
    ? new Map(parsed.data.map((scope) => [scope.taskId, scope]))
    : undefined;
  const args = z.object({
    taskId: z.string(),
    runId: z.string().optional(),
    action: z.string().optional(),
  });
  const disposers: (() => void)[] = [];
  let active = true,
    turn: number | undefined;
  const dispose = () => {
    if (!active) return;
    active = false;
    if (manualScopes.get(agent) === scopes) manualScopes.delete(agent);
    for (const off of disposers.splice(0)) off();
  };
  try {
    if (scopes) {
      const inherited = [...allowed].filter((name) =>
        agent.ctx.tools.get(name),
      );
      disposers.push(agent.ctx.tools.restrict({ allow: inherited }));
    }
    disposers.push(
      agent.ctx.tools.guard((exec) => {
        if (!active) return;
        if (exec.name === "run_code" && !exec.parent) return;
        if (!allowed.has(exec.name))
          return "Tool is outside this task check's capability scope";
        if (!scopes) return;
        const input = args.safeParse(exec.arguments),
          scope = input.success ? scopes.get(input.data.taskId) : undefined;
        if (!input.success || !scope)
          return "This check is authorized only for its recorded task";
        if (
          exec.name === "task_execution_status" &&
          (input.data.runId !== scope.runId ||
            !["inspect", "reconcile"].includes(input.data.action ?? ""))
        )
          return "This check is authorized only for its recorded execution";
        if (
          exec.name === "task_checkin" &&
          !["status", "responsibility", "update"].includes(
            input.data.action ?? "",
          )
        )
          return "This check cannot request other work or change global scheduling";
      }),
    );
    disposers.push(
      agent.ctx.on(
        "system-prompt/assemble",
        async (_assembly, context, next) => {
          const assembly = await next();
          if (!active || context.agent !== agent) return assembly;
          const tools = assembly.tools.filter(
            (tool) => tool.name === "run_code" || allowed.has(tool.name),
          );
          if (!tools.some((tool) => tool.name === "run_code"))
            return { ...assembly, tools };
          const contracts = [...allowed].flatMap((name) => {
            const definition = agent.ctx.tools.get(name, agent);
            return definition
              ? [
                  {
                    name,
                    description: definition.description,
                    parameters: definition.parameters,
                    output: definition.output.schema,
                  },
                ]
              : [];
          });
          // rc2 generates this section before the waterfall; replace only its SDK catalog,
          // retaining the host's PTC transport, language and execution policy.
          const text =
            "Only these tools bindings are available for this check. Call them through the existing run_code transport using tools.<name>(arguments). JSON contracts: " +
            JSON.stringify(contracts);
          return {
            ...assembly,
            tools,
            sections: assembly.sections.map((section) =>
              section.name === "tools:sdk"
                ? { ...section, text, interpolate: false }
                : section,
            ),
          };
        },
        { prepend: true },
      ),
    );
    disposers.push(
      agent.ctx.on("agent/inbox/claimed", (payload) => {
        if (payload.agent !== agent) return;
        const source = payload.message.source;
        if (
          source.kind === "dsh-task-checkin" &&
          source.eventId === message.messageId
        )
          turn = payload.turn;
        else if (
          turn !== undefined &&
          (payload.turn !== turn || source.kind === "user")
        )
          dispose();
      }),
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
    if (scopes) manualScopes.set(agent, scopes);
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
