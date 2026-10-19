import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const identitySchema = z
  .object({
    version: z.literal(1),
    nodeId: z.string().refine((value) => value.trim().length > 0),
  })
  .strict();

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function readIdentity(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024)
      throw new Error(
        "identity must be a regular JSON file of at most 1024 bytes",
      );
    const input: unknown = JSON.parse(readFileSync(fd, "utf8"));
    return identitySchema.parse(input).nodeId;
  } finally {
    closeSync(fd);
  }
}

function hasLegacyTaskLedger(databasePath?: string): boolean {
  if (!databasePath || !existsSync(databasePath)) return false;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    if (
      !database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='entities'",
        )
        .get()
    )
      return false;
    if (
      !database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_meta'",
        )
        .get()
    )
      return false;
    const schema = database.prepare("SELECT version FROM schema_meta").get();
    if (schema?.version !== 1) return false;
    const authority = database
      .prepare(
        "SELECT data FROM entities WHERE kind='authority' AND id='scheduler'",
      )
      .get();
    if (typeof authority?.data !== "string") return false;
    const input: unknown = JSON.parse(authority.data);
    return z
      .object({ schedulerId: z.string().regex(/^scheduler-[0-9a-f-]{36}$/) })
      .safeParse(input).success;
  } finally {
    database.close();
  }
}

/** Explicit names and existing local nodes keep their identity on upgrade. */
export function resolveDeviceNodeId(
  configured?: string,
  {
    home = process.env.DSH_HOME ?? join(homedir(), ".dsh"),
    profileDir,
    legacyDatabasePath,
  }: { home?: string; profileDir?: string; legacyDatabasePath?: string } = {},
): string {
  if (configured?.trim()) return configured;
  const path = resolve(
    profileDir ?? home,
    "task-system",
    "device-identity.json",
  );
  try {
    try {
      return readIdentity(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const nodeId = hasLegacyTaskLedger(legacyDatabasePath)
      ? "local"
      : `node-${randomUUID()}`;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, JSON.stringify({ version: 1, nodeId }) + "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        // Publish a complete file without replacing a concurrent creator's identity.
        linkSync(temporary, path);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          )
        )
          throw error;
      }
    } finally {
      unlinkSync(temporary);
    }
    return readIdentity(path);
  } catch (cause) {
    throw new Error(
      `Cannot load stable task-system device identity at ${path}`,
      { cause },
    );
  }
}
