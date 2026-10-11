import { request } from "node:http";
import { Readable } from "node:stream";
import { validateNetworkTarget } from "../remote/network-client.js";
import {
  exactAddress,
  networkAuthority,
  type TrustedNetworkTarget,
} from "../remote/trusted-network.js";
import { TaskError } from "../ledger.js";

/** Explicit trusted network transport. Verify both bound endpoints before sending bearer or packet bytes. */
export function registrationNetworkFetch(
  target: TrustedNetworkTarget,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (
      input instanceof Request ||
      init?.method !== "POST" ||
      typeof init.body !== "string"
    )
      throw new TaskError(
        "INVALID",
        "Registration transport requires a JSON POST",
      );
    const checked = validateNetworkTarget(String(input), target);
    const body = init.body,
      headers = new Headers(init.headers);
    const authorization = headers.get("authorization");
    return await new Promise<Response>((resolve, reject) => {
      const req = request(
        checked.endpoint,
        {
          method: "POST",
          agent: false,
          localAddress: checked.target.localAddress,
          signal: init.signal ?? undefined,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            host: networkAuthority(checked.target),
            ...(authorization ? { authorization } : {}),
          },
        },
        (res) => {
          if (
            !res.statusCode ||
            (res.statusCode >= 300 && res.statusCode < 400)
          ) {
            res.destroy();
            reject(
              new TaskError("FORBIDDEN", "Registration redirects are denied"),
            );
            return;
          }
          resolve(
            new Response(
              res.statusCode === 204 || res.statusCode === 304
                ? null
                : (Readable.toWeb(res) as ReadableStream<Uint8Array>),
              { status: res.statusCode },
            ),
          );
        },
      );
      req.once("error", reject);
      req.once("socket", (socket) =>
        socket.once("connect", () => {
          if (
            exactAddress(socket.remoteAddress) !== checked.target.address ||
            socket.remotePort !== checked.target.port ||
            exactAddress(socket.localAddress) !== checked.target.localAddress
          ) {
            req.destroy(
              new TaskError(
                "FORBIDDEN",
                "Registration socket target differs from trusted network configuration",
              ),
            );
            return;
          }
          req.end(body);
        }),
      );
    });
  }) as typeof fetch;
}
