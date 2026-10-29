import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import {
  SCRIPT_PROGRAM,
  ScriptExecution,
  ProgramResultSchema,
  type ProgramContext,
  type ProgramRegistry,
} from "./workflow-programs.js";

export function registerWorkflowScripts(
  registry: ProgramRegistry,
  subprocess: Pick<SubprocessRuntime, "spawn" | "resolveExecutable">,
  workspaceIds: string[],
): () => void {
  if (!workspaceIds.length)
    throw new Error("Script execution requires an explicit workspace grant");
  return registry.register({
    ...SCRIPT_PROGRAM,
    title: "Workflow script",
    description:
      "Runs an operator-configured workflow executable in an explicitly authorized workspace",
    workspaceIds: [...new Set(workspaceIds)],
    execute: async (context: ProgramContext) => {
      const script = ScriptExecution.parse(context.script);
      const executable = await subprocess.resolveExecutable(
        script.executable,
        undefined,
        context.signal,
      );
      context.signal.throwIfAborted();
      const { signal, script: _script, ...input } = context;
      const child = subprocess.spawn({
        argv: [executable, ...script.args],
        cwd: context.workspacePath,
        signal,
        graceMs: 1000,
        stdio: {
          stdin: { data: JSON.stringify(input) + "\n" },
          stdout: "pipe",
          stderr: { maxBytes: 8192 },
        },
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let outputError: Error | undefined;
      const onData = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2_000_000) {
          outputError ??= new Error("Script stdout exceeds 2 MB");
          child.terminate();
        } else if (!outputError) chunks.push(chunk);
      };
      child.stdout!.on("data", onData);
      try {
        const outcome = await child.done;
        child.terminate();
        if (!(await child.waitForExit()))
          throw new Error("Script process cleanup could not be confirmed");
        signal.throwIfAborted();
        if (outputError) throw outputError;
        if (outcome.exitCode !== 0) {
          const diagnostic = child.collected.stderr
            ?.readFrom(0)
            .text.slice(-2000);
          throw new Error(
            `Script exited with ${outcome.exitCode ?? outcome.signal ?? "unknown status"}${diagnostic ? `: ${diagnostic}` : ""}`,
          );
        }
        let result: unknown;
        try {
          result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new Error("Script stdout must contain one JSON ProgramResult");
        }
        return ProgramResultSchema.parse(result);
      } finally {
        child.terminate();
        await child.waitForExit();
        child.stdout!.off("data", onData);
      }
    },
  });
}
