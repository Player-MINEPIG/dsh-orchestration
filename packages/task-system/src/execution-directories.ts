import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { TaskError } from "./ledger.js";
import type {
  WorkspaceMemory,
  WorkspaceBinding,
} from "./remote/project-workspace.js";

/** Operator-selected local parent and durable cwd bindings; never model-supplied. */
export class ExecutionDirectories implements WorkspaceMemory {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS execution_directory_settings
      (id INTEGER PRIMARY KEY CHECK(id=1), root TEXT, revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO execution_directory_settings VALUES(1,NULL,0);
      CREATE TABLE IF NOT EXISTS execution_directory_bindings
      (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  settings() {
    return this.db
      .prepare(
        "SELECT root,revision FROM execution_directory_settings WHERE id=1",
      )
      .get() as { root: string | null; revision: number };
  }
  validatedRoot(): string | null {
    const selected = this.settings().root;
    if (!selected) return null;
    const root = realpathSync(selected);
    if (!statSync(root).isDirectory())
      throw new TaskError("INVALID", "Execution parent is not a directory");
    accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK);
    return root;
  }
  save(input: { root: string; expectedRevision: number }) {
    if (!isAbsolute(input.root))
      throw new TaskError(
        "INVALID",
        "Choose an absolute directory on this executor",
      );
    const root = realpathSync(input.root);
    if (!statSync(root).isDirectory())
      throw new TaskError("INVALID", "Choose a directory");
    accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK);
    const result = this.db
      .prepare(
        "UPDATE execution_directory_settings SET root=?,revision=revision+1 WHERE id=1 AND revision=?",
      )
      .run(root, input.expectedRevision);
    if (!result.changes)
      throw new TaskError(
        "CONFLICT",
        "Execution directory settings changed; refresh before saving",
      );
    return this.settings();
  }
  sessionWorkspace(key: string): WorkspaceBinding | undefined {
    const row = this.db
      .prepare("SELECT value FROM execution_directory_bindings WHERE key=?")
      .get(key);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  rememberSessionWorkspace(key: string, value: WorkspaceBinding) {
    const prior = this.sessionWorkspace(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(value))
      throw new TaskError("CONFLICT", "Session workspace changed");
    this.db
      .prepare("INSERT OR IGNORE INTO execution_directory_bindings VALUES(?,?)")
      .run(key, JSON.stringify(value));
  }
  dispatches() {
    return [];
  }
  legacySchedulerIs() {
    return false;
  }
}
