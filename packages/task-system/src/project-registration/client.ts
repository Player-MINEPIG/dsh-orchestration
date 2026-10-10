import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { digest, validateRegistration } from "./protocol.js";
import { TaskError, canonical } from "../ledger.js";
/** Files are the durable outbox; receipt must match packet identity before ack. */
export function enqueueRegistration(directory: string, input: unknown) {
  const p = validateRegistration(input),
    dir = resolve(directory),
    name =
      digest([p.namespace, p.projectExternalId]) +
      "-" +
      String(p.revision).padStart(16, "0") +
      ".json",
    file = join(dir, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(file)) {
    if (canonical(JSON.parse(readFileSync(file, "utf8"))) !== canonical(p))
      throw new TaskError("CONFLICT", "Queued revision has different content");
    return { file, queued: true };
  }
  writeFileSync(file, canonical(p), { flag: "wx", mode: 0o600, flush: true });
  return { file, queued: true };
}
export async function flushRegistrations(
  directory: string,
  endpoint: string,
  token?: string,
) {
  const url = new URL(endpoint);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new TaskError("FORBIDDEN", "Use HTTPS or a loopback SSH tunnel");
  const dir = resolve(directory);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sent = [];
  // Stop on the first failure: later source revisions must not leapfrog an unacknowledged one.
  for (const name of readdirSync(dir)
    .filter((x) => x.endsWith(".json") && !x.endsWith(".receipt.json"))
    .sort()) {
    const file = join(dir, name),
      p = validateRegistration(JSON.parse(readFileSync(file, "utf8")));
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      body: canonical(p),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (!response.ok)
      throw new TaskError(
        response.status === 409 ? "CONFLICT" : "TRANSPORT",
        "Registration HTTP " + response.status + "; packet remains queued",
      );
    const receipt = (await response.json()) as {
      value?: { digest?: string; sourceRevision?: number };
      digest?: string;
      sourceRevision?: number;
    };
    const value = receipt.value ?? receipt;
    if (value.digest !== digest(p) || value.sourceRevision !== p.revision)
      throw new TaskError(
        "TRANSPORT",
        "Mismatched receipt; packet remains queued",
      );
    const receiptFile = file.replace(/\.json$/, ".receipt.json");
    writeFileSync(receiptFile, canonical(receipt), {
      mode: 0o600,
      flush: true,
    });
    renameSync(file, file + ".ack");
    sent.push({ file, receiptFile });
  }
  return { sent };
}
