import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { TaskLedger } from "../ledger.js";
import { mappedId, validateRegistration } from "./protocol.js";
export interface RegistrationHttpOptions {
  ledger: TaskLedger;
  authorize: (
    req: IncomingMessage,
  ) => Promise<readonly string[] | false> | readonly string[] | false;
}
/** The caller supplies authenticated namespace authority. No production endpoints are inferred. */
export function createRegistrationServer({
  ledger,
  authorize,
}: RegistrationHttpOptions) {
  return createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    const send = (code: number, value: unknown) => {
      res.writeHead(code);
      res.end(JSON.stringify(value));
    };
    try {
      const namespaces = await authorize(req);
      if (!namespaces) {
        send(403, { code: "FORBIDDEN" });
        return;
      }
      if (req.method === "GET" && req.url === "/v1/registrations") {
        send(
          200,
          ledger
            .snapshot()
            .projectRegistrations?.filter((r) =>
              namespaces.includes(r.namespace),
            )
            .map(({ packet, ...r }) => r),
        );
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/registrations") {
        send(404, { code: "NOT_FOUND" });
        return;
      }
      if (!req.headers["content-type"]?.startsWith("application/json")) {
        send(415, { code: "INVALID" });
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1900000) {
          send(413, { code: "TOO_LARGE" });
          return;
        }
        chunks.push(chunk);
      }
      const packet = validateRegistration(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      const commandId = mappedId(
        packet.namespace,
        packet.projectExternalId,
        "command",
        packet.idempotencyKey,
      );
      send(200, ledger.registerProject(commandId, packet, namespaces));
    } catch (error) {
      const code = (error as { code?: string }).code ?? "INVALID";
      send(code === "CONFLICT" ? 409 : code === "FORBIDDEN" ? 403 : 400, {
        code,
      });
    }
  });
}
export function bearerNamespaceAuthorizer(
  token: string,
  namespaces: readonly string[],
) {
  if (token.length < 24)
    throw new Error("Registration token must have at least 24 characters");
  return (req: IncomingMessage) => {
    const header = req.headers.authorization ?? "",
      expected = "Bearer " + token,
      a = Buffer.from(header),
      b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b) ? namespaces : false;
  };
}
