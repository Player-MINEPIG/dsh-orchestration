/** Optional Web companion: independent of task-system and its database. */
import type { Context } from "@deepseek-ai/cordis";
import {
  TypertRemoteService,
  RemoteError,
  type InvocationDescriptor,
} from "@deepseek-ai/dsh-typert-protocol";
import { readFileSync } from "node:fs";
import { json } from "./validation.js";
import { DecisionSettingsError } from "./settings.js";
import { readDecisionConsole, decisionConsoleCommand } from "./console.js";
declare module "@deepseek-ai/dsh-typert-protocol" {
  interface RemoteErrorDetailsMap {
    "decision/settings": { readonly reason: string };
  }
}
const codec = {
  parse(value: unknown) {
    json(value);
    return value;
  },
};
export const descriptors: InvocationDescriptor[] = [
  "view",
  "command",
  "page",
].map((method) => ({
  id: `@dsh-task/typed-decisions#typedDecisionSettings/${method}`,
  service: "typedDecisionSettings",
  namespace: "typedDecisionSettings",
  method,
  invocation: { kind: "direct" },
  parameters:
    method === "command"
      ? [
          {
            name: "input",
            wire: "input",
            source: "json",
            codec: {
              mode: "strict",
              typeSymbol: "@dsh-task/typed-decisions#ConsoleCommand",
              create: () => codec,
            },
          },
        ]
      : [],
  result: {
    mode: "strict",
    typeSymbol: `@dsh-task/typed-decisions#${method}Result`,
    create: () => codec,
  },
}));
export class TypedDecisionSettings extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, "typedDecisionSettings");
  }
  async view() {
    return readDecisionConsole(this.ctx);
  }
  async page() {
    return readFileSync(
      new URL("./console-page.html", import.meta.url),
      "utf8",
    );
  }
  async command(input: unknown) {
    try {
      return await decisionConsoleCommand(this.ctx, input);
    } catch (error) {
      const reason =
        error instanceof DecisionSettingsError
          ? error.code
          : error instanceof Error && error.name === "DecisionValidationError"
            ? "DECISION_INPUT_INVALID"
            : "DECISION_OPERATION_FAILED";
      throw new RemoteError(
        "decision/settings",
        "Decision configuration operation failed",
        { reason },
      );
    }
  }
}
export const name = "typed-decisions-settings";
export function apply(ctx: Context) {
  ctx.inject(["typedDecisions", "typert"], (host) => {
    const registry = host.get("typert") as unknown as {
      register(value: unknown): () => void;
    };
    host.effect(() =>
      registry.register({
        package: "@dsh-task/typed-decisions",
        face: "host",
        schemas: [],
        model: { services: [], events: [], objects: [] },
        invocations: descriptors,
      }),
    );
    new TypedDecisionSettings(host);
  });
}
