import test from "node:test";
import assert from "node:assert/strict";
import { managementRequest } from "../public/management-client.js";
const origin = "https://private.example.test",
  url = origin + "/api/manage";
const response = (body = {}, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
test("mutation uses JSON custom-header same-origin request and exact command replay", async () => {
  const command = {
    commandId: "stable",
    operation: "create_task",
    data: { title: "T" },
  };
  const calls = [];
  const fetcher = async (_, args) => {
    calls.push(args);
    return response({ commandId: "stable" });
  };
  for (let i = 0; i < 2; i++)
    await managementRequest(url, { origin, command, fetcher });
  assert.equal(calls[0].credentials, "same-origin");
  assert.equal(calls[0].redirect, "manual");
  assert.equal(calls[0].headers["X-DSH-Management"], "1");
  assert.equal(calls[0].body, calls[1].body);
});
test("cross-origin destination never receives a request", async () => {
  let called = false;
  await assert.rejects(
    managementRequest("https://evil.test/api/manage", {
      origin,
      fetcher: () => {
        called = true;
      },
    }),
    { kind: "configuration" },
  );
  assert.equal(called, false);
});
test("expired access, forbidden role and revision conflict remain distinct", async () => {
  for (const [status, kind] of [
    [401, "authentication"],
    [403, "authorization"],
    [409, "conflict"],
  ])
    await assert.rejects(
      managementRequest(url, {
        origin,
        command: {},
        fetcher: async () => response({}, status),
      }),
      { kind },
    );
});
test("uncertain save does not claim success or drop the idempotency key", async () => {
  await assert.rejects(
    managementRequest(url, {
      origin,
      command: { commandId: "keep" },
      fetcher: async () => {
        throw new Error("offline");
      },
    }),
    {
      kind: "connection",
      message: "保存结果尚未确认，可重试同一操作以查询幂等回执",
    },
  );
});
test("signed session expiry is rechecked after reading JSON", async () => {
  const realNow = Date.now,
    deadline = realNow() + 10000;
  try {
    await assert.rejects(
      managementRequest(url, {
        origin,
        requireSessionExpiry: true,
        command: {},
        fetcher: async () => ({
          ok: true,
          status: 200,
          headers: new Headers({
            "content-type": "application/json",
            "x-dsh-session-expires-at": new Date(deadline).toISOString(),
          }),
          json: async () => {
            Date.now = () => deadline + 1;
            return {};
          },
        }),
      }),
      { kind: "authentication" },
    );
  } finally {
    Date.now = realNow;
  }
});
