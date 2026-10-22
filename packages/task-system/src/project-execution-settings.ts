import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const Identifier = z.string().min(1).max(200);
export const ProjectExecutionSettingsData = z
  .object({
    allowedNodeIds: z
      .array(Identifier)
      .max(128)
      .refine((ids) => new Set(ids).size === ids.length, "Duplicate executor")
      .nullable(),
    executionBindings: z.record(Identifier, Identifier),
  })
  .strict();
export const ProjectExecutionSettings = ProjectExecutionSettingsData.extend({
  projectId: Identifier,
  revision: z.number().int().nonnegative(),
});
export type ProjectExecutionSettings = z.infer<typeof ProjectExecutionSettings>;
const Save = ProjectExecutionSettingsData.extend({
  projectId: Identifier,
  expectedRevision: z.number().int().nonnegative(),
}).strict();

export class ProjectExecutionSettingsError extends Error {
  constructor(readonly code: "CONFLICT" | "READ_ONLY") {
    super(
      code === "CONFLICT"
        ? "Project execution settings changed; reload before saving"
        : "Project execution settings are read-only",
    );
  }
}

/** Synchronous CAS participates in the caller's transaction, including coordinator workspace updates. */
export class ProjectExecutionSettingsStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly options: { readOnly?: boolean } = {},
  ) {
    if (!options.readOnly)
      db.exec(
        "CREATE TABLE IF NOT EXISTS pr_project_execution_settings(project TEXT PRIMARY KEY,revision INTEGER NOT NULL,data TEXT NOT NULL)",
      );
  }
  read(projectId: string): ProjectExecutionSettings {
    Identifier.parse(projectId);
    const exists = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='pr_project_execution_settings'",
      )
      .get();
    const row = exists
      ? this.db
          .prepare(
            "SELECT revision,data FROM pr_project_execution_settings WHERE project=?",
          )
          .get(projectId)
      : undefined;
    return row
      ? ProjectExecutionSettings.parse({
          ...JSON.parse(String(row.data)),
          projectId,
          revision: Number(row.revision),
        })
      : { projectId, revision: 0, allowedNodeIds: null, executionBindings: {} };
  }
  save(input: z.infer<typeof Save>): ProjectExecutionSettings {
    if (this.options.readOnly)
      throw new ProjectExecutionSettingsError("READ_ONLY");
    const { projectId, expectedRevision, ...data } = Save.parse(input);
    const revision = expectedRevision + 1;
    const changed =
      expectedRevision === 0
        ? this.db
            .prepare(
              "INSERT INTO pr_project_execution_settings VALUES(?,?,?) ON CONFLICT(project) DO NOTHING",
            )
            .run(projectId, revision, JSON.stringify(data)).changes
        : this.db
            .prepare(
              "UPDATE pr_project_execution_settings SET revision=?,data=? WHERE project=? AND revision=?",
            )
            .run(revision, JSON.stringify(data), projectId, expectedRevision)
            .changes;
    if (Number(changed) !== 1)
      throw new ProjectExecutionSettingsError("CONFLICT");
    return { projectId, revision, ...data };
  }
}
