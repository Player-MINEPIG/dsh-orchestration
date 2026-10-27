import { Ajv, type ValidateFunction } from "ajv";
import { z } from "zod";
import type { Json } from "./contracts.js";
import type {
  ExecutionProvider,
  ExecutionRequest,
  ExecutionResult,
  Route,
} from "./remote/ports.js";

export const ProgramCatalog = z
  .object({
    nodeId: z.string().min(1),
    programId: z.string().min(1).max(100),
    version: z.string().min(1).max(80),
    title: z
      .string()
      .min(1)
      .max(300)
      .refine(
        (value) => Buffer.byteLength(value) <= 500,
        "Title exceeds 500 bytes",
      ),
    description: z.string().max(2000).optional(),
    inputSchema: z.record(z.string(), z.json()).optional(),
    outputSchema: z.record(z.string(), z.json()).optional(),
  })
  .strict();
export type ProgramCatalogEntry = z.infer<typeof ProgramCatalog>;
export interface ProgramContext {
  input: Json;
  signal: AbortSignal;
  workspacePath: string;
  nodeId: string;
  taskId: string;
  runId: string;
  executionId: string;
}
export interface ProgramResult {
  data: Json;
  summary: string;
  body?: string;
  title?: string;
  outcome?: "success" | "partial";
}
export interface ProgramRegistration
  extends Omit<ProgramCatalogEntry, "nodeId"> {
  execute(context: ProgramContext): Promise<ProgramResult> | ProgramResult;
}
const Result = z
  .object({
    data: z.json(),
    summary: z
      .string()
      .min(1)
      .refine(
        (value) => Buffer.byteLength(value) <= 5000,
        "Summary exceeds 5000 bytes",
      ),
    body: z
      .string()
      .min(1)
      .refine(
        (value) => Buffer.byteLength(value) <= 1_000_000,
        "Report body exceeds 1 MB",
      )
      .optional(),
    title: z
      .string()
      .min(1)
      .refine(
        (value) => Buffer.byteLength(value) <= 500,
        "Title exceeds 500 bytes",
      )
      .optional(),
    outcome: z.enum(["success", "partial"]).optional(),
  })
  .strict();
export const ProgramRoute = z
  .object({
    kind: z.literal("program"),
    programId: z.string().min(1).max(100),
    version: z.string().min(1).max(80),
  })
  .strict();
export function programExecution(route: Route | undefined) {
  return route?.execution;
}
export class ProgramRegistry {
  private readonly entries = new Map<
    string,
    {
      catalog: ProgramCatalogEntry;
      execute: ProgramRegistration["execute"];
      input?: ValidateFunction;
      output?: ValidateFunction;
    }
  >();
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  constructor(readonly nodeId: string) {}
  register(registration: ProgramRegistration): () => void {
    const { execute, ...metadata } = registration;
    const catalog = ProgramCatalog.parse({ ...metadata, nodeId: this.nodeId });
    if (typeof execute !== "function")
      throw new Error("Program execute function required");
    const key = JSON.stringify([catalog.programId, catalog.version]);
    if (this.entries.has(key))
      throw new Error("Program version already registered");
    const entry = {
      catalog,
      execute,
      input: catalog.inputSchema
        ? this.ajv.compile(catalog.inputSchema)
        : undefined,
      output: catalog.outputSchema
        ? this.ajv.compile(catalog.outputSchema)
        : undefined,
    };
    if (
      this.entries.size >= 32 ||
      Buffer.byteLength(JSON.stringify([...this.catalog(), catalog])) > 7000
    )
      throw new Error("Program catalog exceeds heartbeat metadata budget");
    this.entries.set(key, entry);
    return () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    };
  }
  catalog(): ProgramCatalogEntry[] {
    return structuredClone(
      [...this.entries.values()].map((entry) => entry.catalog),
    );
  }
  supports(route: Route): boolean {
    const program = programExecution(route);
    return (
      !!program &&
      route.nodeId === this.nodeId &&
      this.entries.has(JSON.stringify([program.programId, program.version]))
    );
  }
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const route = request.claim.run.route;
    if (!route || !this.supports(route) || !route.execution)
      throw new Error("Registered program route required");
    const entry = this.entries.get(
      JSON.stringify([route.execution.programId, route.execution.version]),
    )!;
    const configuration = z
      .object({ input: z.json() })
      .passthrough()
      .parse(request.claim.run.configuration);
    request.signal.throwIfAborted();
    if (entry.input && !entry.input(configuration.input))
      return {
        outcome: "failure",
        summary: `Program input rejected: ${this.ajv.errorsText(entry.input.errors)}`,
      };
    try {
      await request.executionStarted?.();
      const result = Result.parse(
        await entry.execute({
          input: configuration.input,
          signal: request.signal,
          workspacePath: request.workspacePath,
          nodeId: this.nodeId,
          taskId: request.claim.task.taskId,
          runId: request.claim.run.runId,
          executionId: request.claim.attempt.executionId!,
        }),
      );
      if (entry.output && !entry.output(result.data))
        throw new Error(
          `Program output rejected: ${this.ajv.errorsText(entry.output.errors)}`,
        );
      const output = {
        outcome: result.outcome ?? "success",
        summary: result.summary,
        report: {
          title: result.title ?? entry.catalog.title,
          body: result.body ?? result.summary,
          data: result.data,
        },
      } satisfies ExecutionResult;
      if (Buffer.byteLength(JSON.stringify(output)) > 2_000_000)
        throw new Error("Program result exceeds 2 MB");
      return output;
    } catch (error) {
      if (request.signal.aborted) throw error;
      return {
        outcome: "failure",
        summary:
          `Program stopped with error: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            1000,
          ),
      };
    }
  }
  provider(fallback?: ExecutionProvider): ExecutionProvider {
    return {
      id: "registered-programs",
      capabilities: fallback?.capabilities ?? [],
      supports: (route) =>
        route.execution
          ? this.supports(route)
          : (fallback?.supports(route) ?? false),
      execute: (request) =>
        request.claim.run.route?.execution
          ? this.execute(request)
          : fallback
            ? fallback.execute(request)
            : Promise.reject(new Error("Agent provider unavailable")),
      ...(fallback?.sendSessionMessage
        ? { sendSessionMessage: fallback.sendSessionMessage.bind(fallback) }
        : {}),
      status: (ref) => fallback?.status?.(ref) ?? "程序正在执行。",
    };
  }
}
