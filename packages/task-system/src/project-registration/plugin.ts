import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { TaskError } from "../ledger.js";
import { ExecutionModelChoice } from "../execution-models.js";
import { validateRegistration } from "./protocol.js";
import { sendRegistration } from "./service.js";
import { registerProjectCommands } from "./commands.js";
import { flushRegistrations } from "./client.js";
import { SessionCollaboration, collaborationAuthority, type CollaborationPort } from "../project-collaboration/session.js";
import type {} from "../remote/index.js";
export const name = "dsh-project-registration";
export const inject = ["tools", "taskSystem"];
import type { TrustedNetworkTarget } from "../remote/trusted-network.js";

export interface Config {
  trustedNetwork?: TrustedNetworkTarget | null;
  namespaces: string[];
  outboxPath?: string;
  endpoint?: string;
  tokenEnv?: string;
}
export const Config: z<Config> = z.object({
  namespaces: z.array(z.string()).required(),
  trustedNetwork: z
    .union([
      z.const(null),
      z.object({
        address: z.string().required(),
        port: z.number().required(),
        localAddress: z.string().required(),
        allowHttp: z.const(true).required(),
      }),
    ])
    .default(null),
  outboxPath: z.string().required(false),
  endpoint: z.string().required(false),
  tokenEnv: z.string().required(false),
});
export function apply(ctx: Context, config: Config) {
  const collaboration = new SessionCollaboration(
    ctx.taskSystem.ledger,
    ctx.taskSystem.config.nodeId,
    (nodeId, commandId, input) => {
      const invoke = collaborationAuthority(
        ctx.taskSystem.config.role,
        ctx.taskSystem.ledger as unknown as { projectCollaborate?: CollaborationPort },
        ctx.get("remoteExecution") as unknown as Parameters<typeof collaborationAuthority>[2],
      );
      return invoke(nodeId, commandId, input);
    },
    agent => Boolean(ctx.taskSystem.native?.scopeFor(agent)),
  );
  ctx.inject(["systemPrompt"], promptCtx => {
    promptCtx.systemPrompt.section({ name: "session-project-collaboration", order: 95, interpolate: false, text: ({ agent }) => collaboration.prompt(agent) });
  });
  ctx.inject(["commands"], (commandsCtx) => {
    registerProjectCommands(commandsCtx, config, collaboration);
  });
  const output = {
    schema: { type: "json" as const },
    render: (_args: unknown, value: unknown) => [
      { type: "text" as const, text: JSON.stringify(value) },
    ],
  };
  for (const [toolName, action, description] of [
    ["project_status", "status", "Read the bound central project's actual tasks, runs and review state."],
    ["project_nodes", "nodes", "Request executor model catalogs and read eligible node identities, node defaults, catalog freshness and explicit routes for the bound project. Pending or stale metadata is not evidence that a model was removed."],
    ["project_dispatch", "dispatch", "Dispatch one authorized task under the bound project. Omit executionModelJson to use the chosen node default; model choices belong to the workload, not the planning decision. Reuse requestId and identical arguments after an uncertain response."],
    ["project_progress", "update", "Sync factual progress and evidence to the bound central project; each update has a stable requestId."],
    ["project_finish", "submit", "Submit completion evidence for central/user review; this does not approve the project."],
  ] as const) {
    const parameters: Record<string, any> = action === "status" || action === "nodes" ? {} : {
      requestId: { type: "string", required: true, description: "Stable operation ID; reuse with identical arguments on retries, including a new tool call." },
    };
    if (action === "dispatch") Object.assign(parameters, {
      title: { type: "string", required: true },
      description: { type: "string", required: true },
      nodeId: {type:"string",description:"Optional executor identity from project_nodes. With no explicit workload choice, this node's configured default is used. Omit to let central planning choose the executor."},
      executionModelJson:{type:"string",description:"Optional explicit workload selection from the user's context as JSON {provider,model,reasoningEffort?,backend?}. Omit to use the executor node default. A confirmed invalid explicit selection never falls back. Cannot be combined with routeJson."},
      routeJson: { type: "string", description: "Optional explicit full assignment copied from project_nodes.routes, including nodeId, provider, model, requiredCapabilities and returned effort, backend or workspaceId. Use only for an explicit workload route. Ordinary project tasks use their execution directory automatically and need no caller-created workspace. Cannot be combined with nodeId or executionModelJson." },
    });
    if (action === "update" || action === "submit") parameters.summary = { type: "string", required: true };
    ctx.tools.register(defineTool({
      name: toolName,
      description: `Available only after /project activates this user session. ${description} Project identity is supplied by the plugin.`,
      parameters,
      output,
      execute: async (args, exec) => {
        const input: { title?: string; description?: string; summary?: string; route?: unknown; nodeId?:string; executionModel?:ExecutionModelChoice } = {};
        if (action === "dispatch") {
          input.title = args.title as string;
          input.description = args.description as string;
          if (args.routeJson) input.route = JSON.parse(args.routeJson as string);
          if (args.nodeId)input.nodeId=String(args.nodeId);
          if (args.executionModelJson)input.executionModel=ExecutionModelChoice.parse(JSON.parse(String(args.executionModelJson)));
        }
        if (action === "update" || action === "submit") input.summary = args.summary as string;
        return JSON.parse(JSON.stringify(await collaboration.invoke(exec.agent, action, input, String(exec.callId), args.requestId as string | undefined)));
      },
    }));
  }
  ctx.tools.register(
    defineTool({
      name: "project_sync",
      description:
        "Drain the configured durable registration outbox after connectivity returns; never execute project work.",
      parameters: {},
      output,
      execute: async (_args, exec) => {
        if (ctx.taskSystem.native?.scopeFor(exec.agent))
          throw new TaskError(
            "FORBIDDEN",
            "Owned execution cannot synchronize unrelated projects",
          );
        if (!config.endpoint || !config.outboxPath)
          throw new TaskError(
            "INVALID",
            "Explicit remote endpoint and outbox required",
          );
        return await flushRegistrations(
          config.outboxPath,
          config.endpoint,
          config.tokenEnv ? process.env[config.tokenEnv] : undefined,
          undefined,
          config.trustedNetwork,
        );
      },
    }),
  );
  for (const [toolName, mode] of [
    ["project_register", "live"],
    ["project_update", "live"],
    ["project_submit", "final"],
    ["project_history_intake", "history"],
  ] as const) {
    ctx.tools.register(
      defineTool({
        name: toolName,
        description: `Record source-owned ${mode} project evidence; never dispatch or approve execution. Input is dsh.project-registration/v1 JSON.`,
        parameters: { packetJson: { type: "string", required: true } },
        output,
        execute: async (args, exec) => {
          if (ctx.taskSystem.native?.scopeFor(exec.agent))
            throw new TaskError(
              "FORBIDDEN",
              "Owned execution cannot import unrelated project evidence",
            );
          const p = validateRegistration(JSON.parse(args.packetJson));
          if (p.mode !== mode || !config.namespaces.includes(p.namespace))
            throw new TaskError(
              "FORBIDDEN",
              "Mode or source namespace not authorized",
            );
          if (toolName === "project_register" && p.previousRevision !== 0)
            throw new TaskError(
              "INVALID",
              "Registration requires first revision",
            );
          if (toolName === "project_update" && p.previousRevision === 0)
            throw new TaskError("INVALID", "Update requires existing revision");
          return JSON.parse(
            JSON.stringify(
              await sendRegistration(
                ctx.taskSystem.ledger,
                config,
                toolName === "project_register"
                  ? "register"
                  : toolName === "project_submit"
                    ? "submit"
                    : toolName === "project_history_intake"
                      ? "history"
                      : "sync",
                p,
              ),
            ),
          );
        },
      }),
    );
  }
}
