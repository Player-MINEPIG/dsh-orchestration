import { TaskReadOptions } from "../task-reads.js";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { TaskError } from "../ledger.js";
import { validateRegistration } from "./protocol.js";
import { sendRegistration } from "./service.js";
import { registerProjectCommands } from "./commands.js";
import { flushRegistrations } from "./client.js";
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
  const collaboration = ctx.taskSystem.sessionCollaboration;
  const dispatch: NonNullable<
    typeof ctx.taskSystem.sessionProjectDispatch
  > = async (agent, input, callId) => {
    const binding = agent ? collaboration.binding(agent) : undefined;
    if (binding?.state !== "active") return { handled: false };
    if (!input.taskId && (!input.title || !input.description))
      throw new TaskError(
        "INVALID",
        "Project dispatch requires title and complete description",
      );
    if (
      input.requestId ||
      input.workspaceId
    )
      throw new TaskError(
        "INVALID",
        "Project dispatch uses its bound project and commandId; omit requestId/workspaceId",
      );
    const value = await collaboration.invoke(
      agent,
      "dispatch",
      {
        ...(input.taskId?{taskId:input.taskId}:{title:input.title,description:input.description}),
        ...(input.retry?{retry:input.retry}:{}),
        ...(input.expectedActionVersion?{expectedActionVersion:input.expectedActionVersion}:{}),
        ...(input.configuration!==undefined?{configuration:JSON.parse(JSON.stringify(input.configuration))}:{}),
        ...(input.route ? { route: input.route } : {}),
        ...(input.nodeId ? { nodeId: input.nodeId } : {}),
        ...(input.executionModel ? { executionModel: input.executionModel } : {}),
      },
      callId,
      input.commandId,
    );
    return { handled: true, value: JSON.parse(JSON.stringify(value)) };
  };
  const nodes:NonNullable<typeof ctx.taskSystem.sessionProjectNodes>=async(agent,callId,read)=>{
    const binding=agent ? collaboration.binding(agent) : undefined;
    if(binding?.state!=="active")return {handled:false};
    return {handled:true,value:JSON.parse(JSON.stringify(await collaboration.invoke(agent,"nodes",{read},callId)))};
  };
  ctx.taskSystem.sessionProjectNodes=nodes;
  ctx.taskSystem.sessionProjectDispatch = dispatch;
  ctx.effect(() => () => {
    if(ctx.taskSystem.sessionProjectNodes===nodes)ctx.taskSystem.sessionProjectNodes=undefined;
    if (ctx.taskSystem.sessionProjectDispatch === dispatch)
      ctx.taskSystem.sessionProjectDispatch = undefined;
  });
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
    ["project_progress", "update", "Sync factual progress and evidence to the bound central project; each update has a stable commandId."],
    ["project_finish", "submit", "Submit completion evidence for central/user review; this does not approve the project."],
  ] as const) {
    const parameters: Record<string, any> = action === "status" ? {details:{type:"boolean"},taskId:{type:"string"},state:{type:"string"},limit:{type:"integer"},cursor:{type:"string"}} : {
      commandId: {type:"string",description:"Stable operation ID; identical retries reuse it."},
      requestId: { type: "string", description: "Legacy alias for commandId; reuse with identical arguments on retries, including a new tool call." },
    };
    if (action === "update" || action === "submit") parameters.summary = { type: "string", required: true };
    ctx.tools.register(defineTool({
      name: toolName,
      description: `Available only after /project activates this user session. ${description} Project identity is supplied by the plugin.`,
      parameters,
      output,
      execute: async (args, exec) => {
        const input: { summary?: string;read?:import("../task-reads.js").TaskReadOptions } = {};
        if(args.commandId && args.requestId)throw new TaskError("INVALID","Provide commandId only; requestId is a legacy alias");
        if(action==="status") input.read=TaskReadOptions.parse({...(args.details!==undefined?{details:args.details}:{}),...(args.taskId?{taskId:args.taskId}:{}),...(args.state?{state:args.state}:{}),...(args.limit!==undefined?{limit:args.limit}:{}),...(args.cursor?{cursor:args.cursor}:{})});
        if (action === "update" || action === "submit") input.summary = args.summary as string;
        return JSON.parse(JSON.stringify(await collaboration.invoke(exec.agent, action, input, String(exec.callId), (args.commandId ?? args.requestId) as string | undefined)));
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
