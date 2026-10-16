import { z } from "zod";
import type { Json } from "./contracts.js";

const Request = z
  .object({
    path: z.array(z.string()).max(32).default([]),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();
function bytes(value: Json) {
  return Buffer.byteLength(JSON.stringify(value));
}
function descriptor(value: Json, path: string[]) {
  return {
    path,
    type:
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
    bytes: bytes(value),
    ...(bytes(value) <= 1500 ? { value } : { readRequired: true }),
  };
}
export function workflowInputPage(input: Json, request: unknown): Json {
  const { path, offset, limit } = Request.parse(request);
  let value = input;
  for (const key of path) {
    if (
      !value ||
      typeof value !== "object" ||
      ["__proto__", "prototype", "constructor"].includes(key) ||
      !Object.hasOwn(value, key)
    )
      throw new Error("Input path not found");
    value = Array.isArray(value) ? value[Number(key)]! : value[key]!;
    if (value === undefined) throw new Error("Input path not found");
  }
  if (typeof value === "string") {
    const chunk = value.slice(offset, offset + 2048);
    return {
      kind: "text",
      path,
      text: chunk,
      offset,
      nextOffset:
        offset + chunk.length < value.length ? offset + chunk.length : null,
      total: value.length,
    };
  }
  if (value === null || typeof value !== "object")
    return { kind: "value", path, value };
  const keys = Object.keys(value),
    entries: Json[] = [];
  let cursor = offset;
  for (const key of keys.slice(offset, offset + limit)) {
    const child = Array.isArray(value) ? value[Number(key)]! : value[key]!;
    const entry = {
      key,
      ...descriptor(child, [...path, key]),
    };
    if (entries.length && bytes([...entries, entry]) > 12000) break;
    entries.push(entry);
    cursor++;
  }
  return {
    kind: Array.isArray(value) ? "array" : "object",
    path,
    entries,
    offset,
    nextOffset: cursor < keys.length ? cursor : null,
    total: keys.length,
  };
}
export function workflowPromptConfiguration(configuration: Json): Json {
  if (
    !configuration ||
    typeof configuration !== "object" ||
    Array.isArray(configuration)
  )
    return configuration;
  const workflow = configuration.workflow;
  if (
    !workflow ||
    typeof workflow !== "object" ||
    Array.isArray(workflow) ||
    workflow.inputExposure !== "tools"
  )
    return configuration;
  const input = configuration.input ?? null;
  return {
    ...configuration,
    input: {
      availableViaTools: true,
      keys: input && typeof input === "object" ? Object.keys(input) : [],
      bytes: bytes(input),
      instructions:
        "Read the immutable input with the task-specific read tools, or workflow_input_read. The input has not been inserted into the prompt. Follow nextOffset and nested paths until the required evidence has been read.",
    },
  };
}
