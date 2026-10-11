import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { TaskError } from "../ledger.js";
import { validateRegistration } from "./protocol.js";
import { sendRegistration } from "./service.js";
import { registerProjectCommands } from "./commands.js";
import { flushRegistrations } from "./client.js";
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
  ctx.inject(["commands"], (commandsCtx) => {
    registerProjectCommands(commandsCtx, config);
  });
  const output = {
    schema: { type: "json" as const },
    render: (_args: unknown, value: unknown) => [
      { type: "text" as const, text: JSON.stringify(value) },
    ],
  };
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
