import type { ProjectExecutionContext } from "./contracts.js";
import {
  canonicalData,
  identifier,
  insist,
  isRecord,
} from "./remote/protocol.js";
import { validateCriteria } from "./workbench-contracts.js";

/** Validate even persisted/foreign snapshots before they influence a local path. */
export function projectContext(value: unknown): ProjectExecutionContext {
  insist(
    isRecord(value) && value.version === 1,
    "PROJECT_CONTEXT_VERSION_UNSUPPORTED",
  );
  insist(
    identifier(value.schedulerId) &&
      Object.keys(value).every((k) =>
        ["version", "schedulerId", "project"].includes(k),
      ),
    "INVALID_PROJECT_CONTEXT",
  );
  if (value.project !== null) {
    const p = value.project;
    insist(
      isRecord(p) &&
      typeof p.projectId === "string" && /^[\w][\w:./@-]{0,199}$/.test(p.projectId) &&
        Number.isSafeInteger(p.revision) &&
        Number(p.revision) >= 1,
      "INVALID_PROJECT_CONTEXT",
    );
    insist(
      Object.keys(p).every((k) =>
        [
          "projectId",
          "revision",
          "title",
          "goal",
          "description",
          "acceptanceCriteria",
        ].includes(k),
      ),
      "INVALID_PROJECT_CONTEXT",
    );
    for (const key of ["title", "goal", "description"])
      insist(
        typeof p[key] === "string" &&
          String(p[key]).length <= (key === "title" ? 500 : 20000),
        "PROJECT_CONTEXT_LIMIT",
      );
    validateCriteria(p.acceptanceCriteria);
  }
  canonicalData(value);
  return structuredClone(value) as unknown as ProjectExecutionContext;
}
