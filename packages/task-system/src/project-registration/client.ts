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
import type { TrustedNetworkTarget } from "../remote/trusted-network.js";
import { validateNetworkTarget } from "../remote/network-client.js";
import { registrationNetworkFetch } from "./transport.js";
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
  if (
    existsSync(file + ".ack") &&
    canonical(JSON.parse(readFileSync(file + ".ack", "utf8"))) !== canonical(p)
  )
    throw new TaskError(
      "CONFLICT",
      "Acknowledged revision has different content",
    );
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
  signal?: AbortSignal,
  trustedNetwork?: TrustedNetworkTarget | null,
) {
  const url = new URL(endpoint);
  if (trustedNetwork) validateNetworkTarget(endpoint, trustedNetwork);
  const send = trustedNetwork
    ? registrationNetworkFetch(trustedNetwork)
    : fetch;
  if (
    !trustedNetwork &&
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new TaskError(
      "FORBIDDEN",
      "Use HTTPS, loopback, or an explicitly bound trusted network",
    );
  const dir = resolve(directory);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sent = [];
  // Stop on the first failure: later source revisions must not leapfrog an unacknowledged one.
  for (const name of readdirSync(dir)
    .filter((x) => x.endsWith(".json") && !x.endsWith(".receipt.json"))
    .sort()) {
    signal?.throwIfAborted();
    const file = join(dir, name);
    let p;
    try {
      p = validateRegistration(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      // Another process may have drained this exact queued entry after our directory listing.
      if (
        (error as { code?: string }).code === "ENOENT" &&
        existsSync(file + ".ack")
      )
        continue;
      throw error;
    }
    const response = await send(trustedNetwork ? endpoint : url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      body: canonical(p),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
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
    try {
      renameSync(file, file + ".ack");
    } catch (error) {
      // HTTP intake is idempotent; concurrent clients can receive the same valid receipt.
      // Only accept the other process's acknowledgement when its packet matches ours.
      if (
        (error as { code?: string }).code !== "ENOENT" ||
        !existsSync(file + ".ack") ||
        digest(
          validateRegistration(JSON.parse(readFileSync(file + ".ack", "utf8"))),
        ) !== digest(p)
      )
        throw error;
    }
    sent.push({ file, receiptFile });
  }
  return { sent };
}

/** Metadata only: status never reads credentials or exposes report bodies. */
export function registrationOutboxStatus(directory: string) {
  if (!existsSync(directory)) return { pending: [], acknowledged: [] };
  const pending: {
    namespace: string;
    projectExternalId: string;
    revision: number;
  }[] = [];
  const acknowledged: typeof pending = [];
  for (const name of readdirSync(directory).sort()) {
    if (!/^[a-f0-9]{64}-[0-9]{16}\.json(?:\.ack)?$/.test(name)) continue;
    const packet = validateRegistration(
      JSON.parse(readFileSync(join(directory, name), "utf8")),
    );
    (name.endsWith(".ack") ? acknowledged : pending).push({
      namespace: packet.namespace,
      projectExternalId: packet.projectExternalId,
      revision: packet.revision,
    });
  }
  return { pending, acknowledged };
}
