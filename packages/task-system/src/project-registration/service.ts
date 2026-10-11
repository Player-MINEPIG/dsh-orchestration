import { TaskError } from "../ledger.js";
import type { TaskLedger } from "../ledger.js";
import {
  validateRegistration,
  mappedId,
  type RegistrationPacket,
} from "./protocol.js";
import { enqueueRegistration, flushRegistrations } from "./client.js";

import type { TrustedNetworkTarget } from "../remote/trusted-network.js";

export interface RegistrationConfig {
  trustedNetwork?: TrustedNetworkTarget | null;
  namespaces: string[];
  outboxPath?: string;
  endpoint?: string;
  tokenEnv?: string;
}
export type RegistrationAction = "register" | "sync" | "submit" | "history";

/** Human commands and agent tools share exactly the same intake/outbox implementation. */
export async function sendRegistration(
  ledger: TaskLedger,
  config: RegistrationConfig,
  action: RegistrationAction,
  input: unknown,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const packet = validateRegistration(input);
  authorizePacket(config, action, packet);
  if (config.endpoint) {
    if (!config.outboxPath)
      throw new TaskError(
        "INVALID",
        "Remote registration requires an explicit outboxPath",
      );
    const queued = enqueueRegistration(config.outboxPath, packet);
    try {
      const sent = await flushRegistrations(
        config.outboxPath,
        config.endpoint,
        config.tokenEnv ? process.env[config.tokenEnv] : undefined,
        signal,
        config.trustedNetwork,
      );
      return { ...queued, ...sent, delivery: "acknowledged" as const };
    } catch (error) {
      return {
        ...queued,
        delivery: "pending" as const,
        code: (error as { code?: string }).code ?? "TRANSPORT",
      };
    }
  }
  return ledger.registerProject(
    mappedId(
      packet.namespace,
      packet.projectExternalId,
      "command",
      packet.idempotencyKey,
    ),
    packet,
    config.namespaces,
  );
}
export function authorizePacket(
  config: RegistrationConfig,
  action: RegistrationAction,
  packet: RegistrationPacket,
) {
  const mode =
    action === "submit" ? "final" : action === "history" ? "history" : "live";
  if (packet.mode !== mode || !config.namespaces.includes(packet.namespace))
    throw new TaskError("FORBIDDEN", "Mode or source namespace not authorized");
  if (action === "register" && packet.previousRevision !== 0)
    throw new TaskError(
      "INVALID",
      "Registration requires first revision; use /project sync for an update",
    );
}
