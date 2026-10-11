import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-commands";
import { readFileSync, statSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { TaskError } from "../ledger.js";
import { validateRegistration } from "./protocol.js";
import { flushRegistrations, registrationOutboxStatus } from "./client.js";
import {
  sendRegistration,
  type RegistrationConfig,
  type RegistrationAction,
} from "./service.js";

const help = [
  "/project preview [packet.json] — 校验并预览，不上报",
  "/project register [packet.json] — 登记首个实时快照",
  "/project sync [packet.json] — 上报实时更新并重试待发送快照",
  "/project submit [packet.json] — 提交完成快照",
  "/project history [packet.json] — 补录历史项目",
  "/project status — 查看本机待发送与中央已确认的快照",
  "省略文件时读取当前会话工作目录的 .dsh/project-registration.json；文件名含空格可用双引号。",
  "快照使用 dsh.project-registration/v1。此命令直接执行，不调用模型、不扫描工作区；历史资料需先整理为协议文件。",
].join("\n");
function packetPath(agent: Agent, raw: string): string {
  let path = raw.trim();
  if (path.startsWith('"')) {
    try {
      path = JSON.parse(path);
    } catch {
      throw new TaskError(
        "INVALID",
        "Use a JSON-quoted path for filenames containing spaces",
      );
    }
  }
  if (typeof path !== "string" || path.includes("\0"))
    throw new TaskError("INVALID", "Invalid packet path");
  const cwd = agent.session.header.cwd;
  if (!isAbsolute(path) && !cwd)
    throw new TaskError(
      "INVALID",
      "Session has no workspace; supply an absolute packet path",
    );
  return resolve(cwd ?? "/", path || ".dsh/project-registration.json");
}
function readPacket(file: string) {
  if (!existsSync(file))
    throw new TaskError(
      "NOT_FOUND",
      `未找到登记快照：${file}。请先将项目证据整理为 dsh.project-registration/v1 文件；/project help 查看用法。`,
    );
  if (!statSync(file).isFile() || statSync(file).size > 1900000)
    throw new TaskError(
      "TOO_LARGE",
      "Packet must be a regular JSON file no larger than 1.9 MB",
    );
  return validateRegistration(JSON.parse(readFileSync(file, "utf8")));
}
export function registerProjectCommands(
  ctx: Context,
  config: RegistrationConfig,
) {
  return ctx.commands.register({
    name: "project",
    description:
      "登记、同步和补录当前项目到中央任务面板（直接执行，不调用模型）",
    input: {
      hint: "register | sync | submit | history | preview | status [packet.json]",
    },
    handler: async ({ agent, rawInput, signal }) => {
      try {
        signal.throwIfAborted();
        if (ctx.taskSystem.native?.scopeFor(agent))
          throw new TaskError(
            "FORBIDDEN",
            "Owned execution cannot import unrelated project evidence",
          );
        const match = rawInput.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
        const action = match?.[1] ?? "help",
          path = match?.[2] ?? "";
        if (action === "help") return { kind: "success", text: help };
        if (action === "status") {
          if (path)
            throw new TaskError("INVALID", "status does not accept a path");
          const status = config.outboxPath
            ? registrationOutboxStatus(config.outboxPath)
            : { pending: [], acknowledged: [] };
          return {
            kind: "success",
            text: JSON.stringify(
              {
                transport: config.endpoint ? "remote" : "central-local",
                ...status,
              },
              null,
              2,
            ),
          };
        }
        if (
          !["preview", "register", "sync", "submit", "history"].includes(action)
        )
          throw new TaskError("INVALID", help);
        const file = packetPath(agent, path);
        // A disconnected client can retry the durable queue even if its source packet has moved.
        if (
          action === "sync" &&
          !path &&
          !existsSync(file) &&
          config.endpoint &&
          config.outboxPath
        ) {
          const result = await flushRegistrations(
            config.outboxPath,
            config.endpoint,
            config.tokenEnv ? process.env[config.tokenEnv] : undefined,
            signal,
            config.trustedNetwork,
          );
          return {
            kind: "success",
            text: `中央已确认 ${result.sent.length} 个待发送快照。`,
          };
        }
        const packet = readPacket(file);
        if (!config.namespaces.includes(packet.namespace))
          throw new TaskError("FORBIDDEN", "Source namespace not authorized");
        const summary = {
          project: packet.project.title,
          namespace: packet.namespace,
          projectExternalId: packet.projectExternalId,
          mode: packet.mode,
          revision: packet.revision,
          tasks: packet.tasks.length,
          runs: packet.runs.length,
          reports: packet.reports.length,
          artifacts: packet.artifacts.length,
          workspace: packet.origin.workspaceUri,
        };
        if (action === "preview")
          return {
            kind: "success",
            text: JSON.stringify({ preview: true, file, ...summary }, null, 2),
          };
        const result = await sendRegistration(
          ctx.taskSystem.ledger,
          config,
          action as RegistrationAction,
          packet,
          signal,
        );
        const pending = "delivery" in result && result.delivery === "pending";
        return {
          kind: "success",
          text: `${pending ? "已保存到本机待发送队列，中央尚未确认；恢复连接后 /project sync 重试。" : "中央已确认项目快照。"}\n${JSON.stringify(summary, null, 2)}`,
        };
      } catch (error) {
        return {
          kind: "error",
          text: `${(error as { code?: string }).code ?? "INVALID"}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });
}
