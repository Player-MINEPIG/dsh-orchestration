import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { Context } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
import { agentCarrier } from "@deepseek-ai/dsh-agent";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { ScriptedModel } from "../../../tests/dsh/scripted-model.mjs";
import {
  ProjectNativeOwner,
  ProjectNativeOperation,
} from "../dist/project-session-native.js";

function pngBytes(width = 1, height = 1) {
  const chunk = (name, bytes) => {
    const type = Buffer.from(name),
      body = Buffer.concat([type, bytes]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    const length = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = randomBytes(width * height * 4);
  const rows = [];
  for (let row = 0; row < height; row++)
    rows.push(
      Buffer.from([0]),
      pixels.subarray(row * width * 4, (row + 1) * width * 4),
    );
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function createOwner(existing) {
  const dir =
    existing?.dir ??
    realpathSync(mkdtempSync(join(tmpdir(), "project-native-owner-")));
  const ctx = new Context();
  await (await ctx.plugin(Loader, { baseUrl: import.meta.url })).await();
  const rows = [
    ["llm", "dsh-llm"],
    ["sessions", "dsh-session"],
    ["projections", "dsh-session-projection"],
    ["prompt", "dsh-system-prompt"],
    ["tools", "dsh-tools"],
    ["agents", "dsh-agent"],
    ["loop", "dsh-agent-loop", { agents: [] }],
    [
      "persistence",
      "dsh-session-persistence-jsonl",
      { root: join(dir, "sessions"), compression: "none" },
    ],
    [
      "query",
      "dsh-session-query-sqlite",
      { path: join(dir, "query.sqlite"), openAt: "never" },
    ],
    ["typert", "dsh-typert-registry"],
    ["access", "dsh-api-remote-access"],
    [
      "default-model",
      "dsh-agent-default-model",
      { provider: "test-offline", model: "script" },
    ],
    ["fs", "dsh-fs-local"],
    ["attachments", "dsh-attachment-local", { dshHome: join(dir, "home") }],
    ["commands", "dsh-commands"],
    [
      "credentials",
      "dsh-credentials-local",
      { dshHome: join(dir, "home"), watch: false },
    ],
    ["connection", "dsh-client-connection"],
    ["uploads", "dsh-client-file-upload"],
    ["storage", "dsh-storage"],
    ["storage-json", "dsh-storage-json", { root: join(dir, "storage") }],
    ["domain", "dsh-storage-domain", { backend: "json" }],
    ["workspaces", "dsh-workspace"],
    ["working-directory", "dsh-working-directory"],
    ["presets", "dsh-agent-preset-registry", { default: "ordinary" }],
    ["controller", "dsh-api-session-controller", { nativeOpen: false }],
    ["questions", "dsh-user-questions"],
    ["approval", "dsh-user-approval", { policy: "ask" }],
    ["workspace-controller", "dsh-api-workspace-controller"],
    [
      "preset",
      "dsh-agent-preset",
      { id: "ordinary", name: "Ordinary owner session", plugins: [] },
    ],
  ];
  await ctx.loader.root.update(
    rows.map(([id, name, config]) => ({
      id,
      name: import.meta.resolve(`@deepseek-ai/${name}`),
      config,
    })),
  );
  await ctx.loader.await();
  if (!ctx.sessionController) {
    const states = JSON.stringify(
      rows.map(([id]) => [id, ctx.loader.resolve(id)?.fiber.state]),
    );
    await ctx.fiber.dispose();
    rmSync(dir, { recursive: true, force: true });
    assert.fail(states);
  }
  const model = new ScriptedModel(["Native reply from the actual owner."]);
  ctx.llm.registerAdapter(["test-offline"], model);
  const workspace = (await ctx.workspaceController.create({ path: dir }))
    .workspace;
  const session = existing
    ? { sessionId: existing.binding.sessionId }
    : await ctx.sessionController.create({
        workspaceId: workspace.workspaceId,
      });
  const binding = existing?.binding ?? {
    kind: "native",
    projectId: "project",
    generation: 1,
    nodeId: "owner",
    sessionId: session.sessionId,
    workspaceId: workspace.workspaceId,
    workspaceRevision: "1",
    cwd: dir,
  };
  const authorizations = [];
  let writable = true;
  const authorizeBinding = async (target, access) => {
    authorizations.push([target, access]);
    assert.deepEqual(
      target,
      binding,
      "Every SDK operation retains the exact authorized target",
    );
    if (access === "write" && !writable) throw new Error("PROJECT_NOT_ACTIVE");
  };
  const withAgent = async (target, operation) => {
    assert.deepEqual(target, binding);
    const found = await ctx.sessionController.resolveAgent(target.sessionId);
    if ("error" in found) throw found.error;
    return operation(found.agent);
  };
  const owner = new ProjectNativeOwner({
    ctx,
    authorizeBinding,
    withAgent,
    pollWaitMs: 5,
  });
  return {
    ctx,
    dir,
    binding,
    owner,
    model,
    authorizations,
    authorizeBinding,
    withAgent,
    setWritable: (value) => {
      writable = value;
    },
    async dispose() {
      owner.dispose();
      await ctx.fiber.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const invoke = (h, operation) =>
  h.owner.invoke(h.binding, operation, randomUUID());
async function pollUntil(h, stream, initial, predicate) {
  let value = initial;
  for (let index = 0; index < 100; index++) {
    if (value.frames.some(predicate)) return value;
    value = await invoke(h, {
      kind: "stream-poll",
      stream,
      cursor: value.cursor,
    });
  }
  assert.fail(`Missing native ${stream} frame`);
}

test("the closed native operation schema rejects arbitrary target, endpoint, attachment, and global settings", () => {
  for (const value of [
    { kind: "session-cancel", sessionId: "another" },
    { kind: "session-list", endpoint: "session/fork" },
    { kind: "settings-describe", ns: "credentials" },
    {
      kind: "session-prompt",
      requestId: "r",
      mode: "queue",
      content: [{ type: "image", data: "bytes" }],
    },
    { kind: "stream-poll", stream: "events", request: { maxMessages: 1 } },
    { kind: "commands-execute", command: "shell", preset: "ignored" },
    {
      kind: "model-select",
      provider: "other",
      model: "other",
      sessionId: "another",
    },
  ])
    assert.equal(ProjectNativeOperation.safeParse(value).success, false);
});

test("ordinary SDK owner provides bound list, real journal/projections, finite streams, prompt, queue and cancellation", async () => {
  const h = await createOwner();
  try {
    const otherDir = join(h.dir, "unrelated");
    mkdirSync(otherDir);
    const other = await h.ctx.sessionController.create({ cwd: otherDir });
    const listed = await invoke(h, { kind: "session-list" });
    assert.deepEqual(
      listed.items.map((item) => item.sessionId),
      [h.binding.sessionId],
    );
    assert.ok(!JSON.stringify(listed).includes(other.sessionId));
    const control = await invoke(h, {
      kind: "stream-poll",
      stream: "session-control",
    });
    assert.equal(control.frames[0].type, "baseline");
    assert.deepEqual(Object.keys(control.frames[0].value.projections), [
      h.binding.sessionId,
    ]);
    const workspace = await invoke(h, {
      kind: "stream-poll",
      stream: "workspace",
    });
    assert.equal(workspace.frames[0].type, "baseline");
    assert.deepEqual(
      workspace.frames[0].value.items.map((item) => item.workspaceId),
      [h.binding.workspaceId],
    );
    assert.deepEqual(workspace.frames[0].value.items[0].sessionIds, [
      h.binding.sessionId,
    ]);
    const access = await invoke(h, { kind: "stream-poll", stream: "access" });
    assert.equal(access.frames[0].owner, false);
    assert.ok(!JSON.stringify(access).includes("session/fork"));
    assert.ok(!JSON.stringify(access).includes("session/create"));
    let follow = await invoke(h, {
      kind: "stream-poll",
      stream: "session-follow",
      request: { assistantStream: true, maxMessages: 10 },
    });
    assert.equal(follow.frames[0].type, "snapshot");
    assert.equal(follow.frames[0].header.id, h.binding.sessionId);
    const oldCursor = follow.cursor;
    const next = await invoke(h, {
      kind: "stream-poll",
      stream: "session-follow",
      cursor: oldCursor,
    });
    assert.deepEqual(
      await invoke(h, {
        kind: "stream-poll",
        stream: "session-follow",
        cursor: oldCursor,
      }),
      next,
      "A lost poll receipt replays the same native frames and cursor",
    );
    follow = next;
    const acknowledged = await invoke(h, {
      kind: "session-prompt",
      requestId: "native-owner-prompt",
      mode: "queue",
      content: [{ type: "text", text: "Use this owner session." }],
    });
    assert.deepEqual(acknowledged, { accepted: true });
    const { agent } = await h.ctx.sessionController.resolveAgent(
      h.binding.sessionId,
    );
    await agent.whenIdle();
    assert.equal(h.model.requests.length, 1);
    follow = await pollUntil(
      h,
      "session-follow",
      follow,
      (frame) =>
        frame.type === "event" && frame.event.type === "assistant/message",
    );
    assert.match(
      JSON.stringify(follow.frames),
      /Native reply from the actual owner/,
    );
    const projections = await invoke(h, { kind: "session-projections" });
    assert.equal(projections.kind, "sequenced");
    const page = await invoke(h, {
      kind: "session-page",
      throughSeq: projections.asOfSeq,
      maxMessages: 10,
    });
    assert.match(JSON.stringify(page), /Use this owner session/);
    assert.match(JSON.stringify(page), /Native reply from the actual owner/);
    let releaseMaintenance;
    const maintenance = agent.runMaintenance(
      () =>
        new Promise((resolve) => {
          releaseMaintenance = resolve;
        }),
    );
    try {
      await invoke(h, {
        kind: "session-prompt",
        requestId: "pending-owner-message",
        mode: "queue",
        content: [{ type: "text", text: "Pending original." }],
      });
      const itemId = agent.inbox.nextTurn[0].id;
      assert.deepEqual(
        await invoke(h, {
          kind: "session-queue",
          itemId,
          action: {
            kind: "edit",
            content: [{ type: "text", text: "Pending edited." }],
          },
        }),
        { accepted: true },
      );
      assert.equal(agent.inbox.nextTurn[0].content[0].text, "Pending edited.");
      assert.deepEqual(
        await invoke(h, {
          kind: "session-queue",
          itemId,
          action: { kind: "remove" },
        }),
        { accepted: true },
      );
      assert.equal(agent.inbox.nextTurn.length, 0);
    } finally {
      releaseMaintenance();
      await maintenance;
      await agent.whenIdle();
    }
    h.model.script.push("hang");
    await invoke(h, {
      kind: "session-prompt",
      requestId: "cancel-running",
      mode: "queue",
      content: [{ type: "text", text: "Run until cancelled." }],
    });
    for (let index = 0; index < 100 && h.model.requests.length < 2; index++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(agent.status, "running");
    assert.deepEqual(await invoke(h, { kind: "session-cancel" }), {
      accepted: true,
    });
    await agent.whenIdle();
    assert.equal(agent.status, "idle");
    await assert.rejects(
      invoke(h, {
        kind: "session-queue",
        itemId: "missing-queue-item",
        action: { kind: "remove" },
      }),
      /not found|no longer/i,
    );
    h.setWritable(false);
    await assert.rejects(
      invoke(h, {
        kind: "session-prompt",
        requestId: "denied",
        mode: "queue",
        content: [{ type: "text", text: "Must not run." }],
      }),
      /PROJECT_NOT_ACTIVE/,
    );
    assert.equal(h.model.requests.length, 2);
    assert.ok(h.authorizations.some(([, access]) => access === "write"));
    await invoke(h, {
      kind: "stream-close",
      stream: "session-follow",
      cursor: follow.cursor,
    });
    await assert.rejects(
      invoke(h, {
        kind: "stream-poll",
        stream: "session-follow",
        cursor: follow.cursor,
      }),
      (error) => error.code === "STREAM_RESET",
    );
  } finally {
    await h.dispose();
  }
});

test("real Agent-scoped waterfalls retain pending approval/questions and reject cross-generation answers", async () => {
  const h = await createOwner();
  try {
    let events = await invoke(h, { kind: "stream-poll", stream: "events" });
    assert.equal(events.frames[0].type, "ready");
    const clientId = events.frames[0].clientId;
    const { agent } = await h.ctx.sessionController.resolveAgent(
      h.binding.sessionId,
    );
    const questions = [
      {
        id: "decision",
        question: "Choose this owner?",
        options: [{ label: "Yes" }, { label: "No" }],
      },
    ];
    const question = h.ctx.userQuestions.ask({ agent, questions });
    events = await pollUntil(
      h,
      "events",
      events,
      (frame) =>
        frame.type === "waterfall" && frame.event === "user-questions/request",
    );
    const request = events.frames.find((frame) => frame.type === "waterfall");
    assert.equal(request.agentId, h.binding.sessionId);
    assert.equal("agent" in request.request, false);
    await assert.rejects(
      invoke(h, {
        kind: "interaction-result",
        clientId: "other-client",
        eventId: request.eventId,
        outcome: { kind: "result", value: { answers: [] } },
      }),
      (error) => error.code === "INTERACTION_GENERATION_EXPIRED",
    );
    await assert.rejects(
      invoke(h, {
        kind: "interaction-result",
        clientId,
        eventId: request.eventId,
        outcome: {
          kind: "result",
          value: { answers: [{ id: "foreign", selected: ["Yes"] }] },
        },
      }),
      (error) => error.code === "INVALID_ANSWER",
    );
    const answer = { answers: [{ id: "decision", selected: ["Yes"] }] };
    assert.deepEqual(
      await invoke(h, {
        kind: "interaction-result",
        clientId,
        eventId: request.eventId,
        outcome: { kind: "result", value: answer },
      }),
      { accepted: true },
    );
    assert.deepEqual(await question, answer);
    await assert.rejects(
      invoke(h, {
        kind: "interaction-result",
        clientId,
        eventId: request.eventId,
        outcome: { kind: "result", value: answer },
      }),
      (error) => error.code === "INTERACTION_EXPIRED",
    );
    agent.ctx.get("tools").register(
      defineTool({
        name: "owner_approval",
        description: "Exercise the real approval service.",
        parameters: {},
        output: {
          schema: { type: "string" },
          render: (_args, result) => [{ type: "text", text: result }],
        },
        execute: (_args, execution) =>
          h.ctx.approval.request({
            agent: execution.agent,
            toolName: "owner_approval",
            reason: "Read owner workspace",
          }),
      }),
    );
    h.model.script = [
      { name: "owner_approval", args: {} },
      "Approved owner operation.",
    ];
    await invoke(h, {
      kind: "session-prompt",
      requestId: "approval-turn",
      mode: "queue",
      content: [{ type: "text", text: "Ask permission." }],
    });
    events = await pollUntil(
      h,
      "events",
      events,
      (frame) =>
        frame.type === "waterfall" && frame.event === "approval/request",
    );
    const approvalFrame = events.frames.find(
      (frame) => frame.type === "waterfall",
    );
    await invoke(h, {
      kind: "interaction-result",
      clientId,
      eventId: approvalFrame.eventId,
      outcome: { kind: "result", value: "allowed-once" },
    });
    await agent.whenIdle();
    assert.match(JSON.stringify(h.model.requests), /allowed-once/);
    const audit = await h.ctx.sessionController.projections(
      { sessionId: h.binding.sessionId },
      new AbortController().signal,
    );
    const history = await invoke(h, {
      kind: "session-page",
      throughSeq: audit.asOfSeq,
      maxMessages: 20,
    });
    assert.match(JSON.stringify(history), /approval\/asked/);
    assert.match(JSON.stringify(history), /approval\/decided/);
    const capabilities = await invoke(h, { kind: "native-capabilities" });
    assert.equal(capabilities.approval, true);
    assert.equal(capabilities.userQuestions, true);
    assert.equal(capabilities.timedQuestions, true);
    assert.equal(capabilities.modelSelect, true);
    assert.equal(capabilities.files, true);
    const timed = h.ctx.userQuestions.askTimed(
      { agent, questions },
      "timed-owner-call",
      10000,
    );
    events = await pollUntil(
      h,
      "events",
      events,
      (frame) =>
        frame.type === "waterfall" && frame.event === "user-questions/request",
    );
    const timedFrame = events.frames.find(
      (frame) => frame.type === "waterfall",
    );
    const wait = await invoke(h, {
      kind: "stream-poll",
      stream: "user-question-wait",
      request: { callId: "timed-owner-call" },
    });
    assert.ok(wait.frames[0].remainingMs > 0);
    await invoke(h, {
      kind: "interaction-result",
      clientId,
      eventId: timedFrame.eventId,
      outcome: { kind: "result", value: answer },
    });
    assert.deepEqual(await timed, answer);
    await invoke(h, {
      kind: "stream-close",
      stream: "user-question-wait",
      cursor: wait.cursor,
    });
    assert.equal(
      await invoke(h, {
        kind: "user-question-answer",
        callId: "foreign-missing-call",
        answer,
      }),
      false,
    );
    const cancel = new AbortController();
    const cancelled = h.ctx.waterfall(
      agentCarrier(agent),
      "approval/request",
      { agent, toolName: "shell", signal: cancel.signal },
      async () => "cancelled",
    );
    events = await pollUntil(
      h,
      "events",
      events,
      (frame) =>
        frame.type === "waterfall" && frame.event === "approval/request",
    );
    cancel.abort();
    assert.equal(await cancelled, "cancelled");
    const other = await h.ctx.sessionController.create({ cwd: h.dir });
    const resolved = await h.ctx.sessionController.resolveAgent(
      other.sessionId,
    );
    assert.equal(
      await h.ctx.waterfall(
        agentCarrier(resolved.agent),
        "approval/request",
        { agent: resolved.agent, toolName: "shell" },
        async () => "unavailable",
      ),
      "unavailable",
      "The project listener cannot answer for another actual owner Agent",
    );
    await invoke(h, {
      kind: "stream-close",
      stream: "events",
      cursor: events.cursor,
    });
  } finally {
    await h.dispose();
  }
});

test("whole request and native frame budgets fail explicitly before invalid data can escape", async () => {
  const h = await createOwner();
  const small = new ProjectNativeOwner({
    ctx: h.ctx,
    authorizeBinding: h.authorizeBinding,
    withAgent: h.withAgent,
    maxBytes: 1024,
    pollWaitMs: 5,
  });
  try {
    await assert.rejects(
      small.invoke(
        h.binding,
        {
          kind: "session-prompt",
          requestId: "oversized",
          mode: "queue",
          content: [{ type: "text", text: "X".repeat(2000) }],
        },
        "oversized",
      ),
      (error) => error.code === "REQUEST_TOO_LARGE",
    );
    assert.equal(h.model.requests.length, 0);
    const { agent } = await h.ctx.sessionController.resolveAgent(
      h.binding.sessionId,
    );
    agent.session.append("project/native-budget-fixture", {
      text: "界".repeat(3 * 1024 * 1024),
    });
    await assert.rejects(
      small.invoke(
        h.binding,
        { kind: "stream-poll", stream: "session-follow" },
        "oversized-frame",
      ),
      (error) => error.code === "FRAME_TOO_LARGE",
    );
  } finally {
    small.dispose();
    await h.dispose();
  }
});

test("single large real tool records travel losslessly through bound finite polls and history pages", async () => {
  const h = await createOwner();
  const owner = new ProjectNativeOwner({
    ctx: h.ctx,
    authorizeBinding: async () => {},
    withAgent: h.withAgent,
    pollWaitMs: 5,
  });
  const call = (operation, binding = h.binding) =>
    owner.invoke(binding, operation, randomUUID());
  let pieces = 0;
  const oneFrame = async (stream, request) => {
    let cursor,
      id,
      totalBytes,
      length = 0;
    const chunks = [];
    for (let polls = 0; polls < 100; polls++) {
      const operation = {
        kind: "stream-poll",
        stream,
        ...(cursor ? { cursor } : { request }),
      };
      const batch = await call(operation);
      assert.ok(Buffer.byteLength(JSON.stringify(batch)) < 48 * 1024);
      if (batch.framePart) {
        const part = batch.framePart;
        const bytes = Buffer.from(part.data, "base64");
        assert.equal(bytes.toString("base64"), part.data);
        assert.equal(part.offset, length);
        assert.ok(bytes.byteLength > 0 && bytes.byteLength <= 24576);
        assert.ok(part.totalBytes <= 8 * 1024 * 1024);
        assert.deepEqual(batch.frames, []);
        if (id === undefined) {
          id = part.id;
          totalBytes = part.totalBytes;
        }
        assert.equal(part.id, id);
        assert.equal(part.totalBytes, totalBytes);
        if (cursor)
          assert.deepEqual(
            await call(operation),
            batch,
            "A lost chunk acknowledgement replays the same frame ID, offset and cursor",
          );
        await assert.rejects(
          call(
            { kind: "stream-poll", stream, cursor: batch.cursor },
            { ...h.binding, generation: 77 },
          ),
          (error) => error.code === "STREAM_RESET",
        );
        await assert.rejects(
          call({
            kind: "stream-poll",
            stream:
              stream === "session-follow" ? "session-page" : "session-follow",
            cursor: batch.cursor,
          }),
          (error) => error.code === "STREAM_RESET",
        );
        chunks.push(bytes);
        length += bytes.byteLength;
        pieces++;
        assert.equal(part.eof, length === totalBytes);
        cursor = batch.cursor;
        if (part.eof) {
          const frame = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
          );
          await call({ kind: "stream-close", stream, cursor });
          return frame;
        }
      } else if (batch.frames.length) {
        assert.equal(chunks.length, 0);
        assert.equal(batch.frames.length, 1);
        await call({ kind: "stream-close", stream, cursor: batch.cursor });
        return batch.frames[0];
      } else {
        assert.ok(!batch.closed);
        cursor = batch.cursor;
      }
    }
    assert.fail("Missing complete native frame");
  };
  try {
    const { agent } = await h.ctx.sessionController.resolveAgent(
      h.binding.sessionId,
    );
    const output = "真实工具输出🌏".repeat(12000);
    agent.ctx.tools.register(
      defineTool({
        name: "native_large_output",
        description: "Produce a real large tool record.",
        parameters: {},
        output: {
          schema: { type: "string" },
          render: (_args, value) => [{ type: "text", text: value }],
        },
        execute: async () => output,
      }),
    );
    h.model.script = [
      { name: "native_large_output", args: {} },
      "The large tool completed.",
      "Conversation continues.",
    ];
    await call({
      kind: "session-prompt",
      requestId: "large-tool",
      mode: "queue",
      content: [{ type: "text", text: "Read the large tool output." }],
    });
    await agent.whenIdle();
    const throughSeq = (await invoke(h, { kind: "session-projections" }))
      .asOfSeq;
    const original = await h.ctx.sessionController.page(
      {
        address: { kind: "session", sessionId: h.binding.sessionId },
        throughSeq,
        maxMessages: 500,
      },
      new AbortController().signal,
    );
    assert.ok(
      original.records.some(
        (record) => Buffer.byteLength(JSON.stringify(record)) > 48 * 1024,
      ),
    );
    const snapshot = await oneFrame("session-follow", {
      assistantStream: true,
      maxMessages: 1,
    });
    assert.equal(snapshot.type, "snapshot");
    let records = snapshot.records,
      hasMore = snapshot.hasMore;
    while (hasMore) {
      const page = await oneFrame("session-page", {
        throughSeq: snapshot.cursor,
        beforeSeq: records[0].event.seq,
        maxMessages: 1,
      });
      assert.ok(page.records.length > 0);
      records = [...page.records, ...records];
      hasMore = page.hasMore;
    }
    assert.deepEqual(
      records,
      original.records,
      "All original SDK bytes, records and sequence order survive bounded transport",
    );
    assert.ok(pieces > 2);
    await call({
      kind: "session-prompt",
      requestId: "after-large-tool",
      mode: "queue",
      content: [{ type: "text", text: "Continue this native conversation." }],
    });
    await agent.whenIdle();
    assert.equal(h.model.requests.length, 3);
  } finally {
    owner.dispose();
    await h.dispose();
  }
});

test("user model choice calls the real owner selection and the next ordinary request uses it", async () => {
  const h = await createOwner();
  try {
    h.ctx.llm.registerAdapter(["owner-selected"], h.model);
    const catalog = await invoke(h, { kind: "model-catalog" });
    assert.ok(catalog.groups.some((group) => group.id === "owner-selected"));
    assert.deepEqual(
      await invoke(h, {
        kind: "model-select",
        provider: "owner-selected",
        model: "script",
      }),
      { selected: { provider: "owner-selected", model: "script" } },
    );
    const projected = await invoke(h, { kind: "session-projections" });
    assert.equal(
      projected.values.modelSelection.next.provider,
      "owner-selected",
    );
    await invoke(h, {
      kind: "session-prompt",
      requestId: "chosen-model",
      mode: "queue",
      content: [{ type: "text", text: "Use my chosen native chat model." }],
    });
    const { agent } = await h.ctx.sessionController.resolveAgent(
      h.binding.sessionId,
    );
    await agent.whenIdle();
    assert.equal(h.model.requests[0].provider, "owner-selected");
    const history = await invoke(h, {
      kind: "session-page",
      throughSeq: (await invoke(h, { kind: "session-projections" })).asOfSeq,
      maxMessages: 10,
    });
    assert.match(JSON.stringify(history), /model\/selection/);
  } finally {
    await h.dispose();
  }
});

test("chunked owner upload produces a real session receipt consumed by the native prompt", async () => {
  const h = await createOwner();
  try {
    const bytes = Buffer.from("Owner-local file bytes. 你好。");
    const upload = await invoke(h, {
      kind: "file-upload-start",
      name: "owner-proof.txt",
      bytes: bytes.byteLength,
    });
    assert.equal(upload.chunkBytes, 24576);
    await assert.rejects(
      invoke(h, {
        kind: "file-upload-part",
        uploadId: upload.uploadId,
        index: 1,
        data: bytes.toString("base64"),
      }),
      (error) => error.code === "UPLOAD_PART_ORDER",
    );
    const part = {
      kind: "file-upload-part",
      uploadId: upload.uploadId,
      index: 0,
      data: bytes.toString("base64"),
    };
    const accepted = await invoke(h, part);
    assert.deepEqual(
      await invoke(h, part),
      accepted,
      "A chunk replay never appends its bytes twice",
    );
    await assert.rejects(
      invoke(h, { ...part, data: Buffer.from("changed").toString("base64") }),
      (error) => error.code === "UPLOAD_PART_CONFLICT",
    );
    const receipt = await invoke(h, {
      kind: "file-upload-finish",
      uploadId: upload.uploadId,
    });
    assert.equal(receipt.file.bytes, bytes.byteLength);
    assert.equal(receipt.file.name, "owner-proof.txt");
    assert.deepEqual(
      await invoke(h, {
        kind: "file-upload-finish",
        uploadId: upload.uploadId,
      }),
      receipt,
      "Finish replay retains the exact SDK receipt",
    );
    const { agent } = await h.ctx.sessionController.resolveAgent(
      h.binding.sessionId,
    );
    assert.deepEqual(
      h.ctx.fileUploads.resolve(agent, receipt.receiptId),
      receipt.file,
    );
    const unrelated = await h.ctx.sessionController.create({ cwd: h.dir });
    const foreign = await h.ctx.sessionController.resolveAgent(
      unrelated.sessionId,
    );
    assert.equal(
      h.ctx.fileUploads.resolve(foreign.agent, receipt.receiptId),
      undefined,
      "The SDK receipt is unusable by another owner session",
    );
    const stored = [];
    for await (const chunk of h.ctx.attachments.readFileStream(receipt.file))
      stored.push(chunk);
    assert.deepEqual(Buffer.concat(stored), bytes);
    await invoke(h, {
      kind: "session-prompt",
      requestId: "uploaded-file",
      mode: "queue",
      content: [
        { type: "text", text: "Read the attached owner file." },
        { type: "file", receiptId: receipt.receiptId },
      ],
    });
    await agent.whenIdle();
    assert.equal(h.model.requests.length, 1);
    const history = await invoke(h, {
      kind: "session-page",
      throughSeq: (await invoke(h, { kind: "session-projections" })).asOfSeq,
      maxMessages: 10,
    });
    assert.match(JSON.stringify(history), /owner-proof\.txt/);
    assert.match(
      JSON.stringify(history),
      new RegExp(receipt.file.attachmentId),
    );
    const one = await invoke(h, {
      kind: "file-upload-start",
      name: "one.txt",
      bytes: 1,
    });
    const two = await invoke(h, {
      kind: "file-upload-start",
      name: "two.txt",
      bytes: 1,
    });
    await assert.rejects(
      invoke(h, { kind: "file-upload-start", bytes: 1 }),
      (error) => error.code === "UPLOAD_LIMIT",
    );
    await invoke(h, { kind: "file-upload-abort", uploadId: one.uploadId });
    await invoke(h, { kind: "file-upload-abort", uploadId: two.uploadId });
    await assert.rejects(
      invoke(h, {
        kind: "file-upload-part",
        uploadId: one.uploadId,
        index: 0,
        data: "YQ==",
      }),
      (error) => error.code === "UPLOAD_RESET",
    );
  } finally {
    await h.dispose();
  }
});

test("small native images use SDK admission and authorized bounded attachment reads", async () => {
  const h = await createOwner();
  try {
    const png = pngBytes();
    const image = {
      type: "image",
      mediaType: "image/png",
      data: png.toString("base64"),
      name: "owner.png",
    };
    const projections = await invoke(h, { kind: "session-projections" });
    assert.equal(projections.values.imageLimits.maxImageBytes, 8 * 1024 * 1024);
    assert.equal(projections.values.imageLimits.maxImagesPerMessage, 1);
    await assert.rejects(
      invoke(h, {
        kind: "session-prompt",
        requestId: "too-many-images",
        mode: "queue",
        content: [image, image],
      }),
      (error) => error.code === "IMAGE_LIMIT",
    );
    await assert.rejects(
      invoke(h, {
        kind: "session-prompt",
        requestId: "inline-image-must-use-chunks",
        mode: "queue",
        content: [
          { ...image, data: Buffer.alloc(48 * 1024).toString("base64") },
        ],
      }),
      /Too big|too_big/i,
    );
    await invoke(h, {
      kind: "session-prompt",
      requestId: "small-image",
      mode: "queue",
      content: [image],
    });
    const { agent } = await h.ctx.sessionController.resolveAgent(
      h.binding.sessionId,
    );
    await agent.whenIdle();
    const page = await invoke(h, {
      kind: "session-page",
      throughSeq: (await invoke(h, { kind: "session-projections" })).asOfSeq,
      maxMessages: 10,
    });
    const imageData = JSON.stringify(page).match(/"attachmentId":"([^"]+)"/);
    assert.ok(imageData);
    const attachmentId = imageData[1];
    const received = [];
    let offset = 0;
    for (;;) {
      const value = await invoke(h, {
        kind: "attachment-read",
        attachmentId,
        offset,
        maxBytes: 20,
      });
      assert.equal(value.offset, offset);
      assert.ok(Buffer.byteLength(JSON.stringify(value)) < 48 * 1024);
      const bytes = Buffer.from(value.data, "base64");
      received.push(bytes);
      offset += bytes.byteLength;
      if (value.eof) break;
    }
    const native = await h.ctx.sessionController.attachment({
      sessionId: h.binding.sessionId,
      attachmentId,
    });
    assert.deepEqual(
      Buffer.concat(received),
      Buffer.from(native.data, "base64"),
    );
    await assert.rejects(
      invoke(h, { kind: "attachment-read", attachmentId: "unreachable-image" }),
      /not found|not reachable|not referenced|invalid|unavailable/i,
    );
  } finally {
    await h.dispose();
  }
});

test("a real MiB PNG uses bounded upload packets and reaches the SDK model and attachment reader", async () => {
  const h = await createOwner();
  const foreign = { ...h.binding, generation: h.binding.generation + 1 };
  const owner = new ProjectNativeOwner({
    ctx: h.ctx,
    authorizeBinding: async (binding) => {
      assert.deepEqual(
        binding,
        binding.generation === foreign.generation ? foreign : h.binding,
      );
    },
    withAgent: h.withAgent,
  });
  const packetSizes = [];
  const call = async (operation, binding = h.binding) => {
    packetSizes.push(Buffer.byteLength(JSON.stringify({ binding, operation })));
    const value = await owner.invoke(binding, operation, randomUUID());
    packetSizes.push(Buffer.byteLength(JSON.stringify(value)));
    return value;
  };
  const upload = async (bytes, image) => {
    const start = await call({
      kind: "file-upload-start",
      name: "screenshot.png",
      bytes: bytes.byteLength,
      image,
    });
    for (let offset = 0, index = 0; offset < bytes.byteLength; index++) {
      const end = Math.min(offset + start.chunkBytes, bytes.byteLength);
      await call({
        kind: "file-upload-part",
        uploadId: start.uploadId,
        index,
        data: bytes.subarray(offset, end).toString("base64"),
      });
      offset = end;
    }
    return start;
  };
  try {
    const png = pngBytes(512, 512);
    assert.ok(png.byteLength > 1024 * 1024);
    const sha256 = createHash("sha256").update(png).digest("hex");
    const start = await upload(png, { mediaType: "image/png", sha256 });
    await assert.rejects(
      call({
        kind: "session-prompt",
        requestId: "unfinished-image",
        mode: "queue",
        content: [{ type: "image-upload", uploadId: start.uploadId }],
      }),
      (error) => error.code === "IMAGE_UPLOAD_INCOMPLETE",
    );
    const receipt = await call({
      kind: "file-upload-finish",
      uploadId: start.uploadId,
    });
    assert.equal(receipt.file.attachmentId, `sha256:${sha256}`);
    assert.equal(receipt.file.bytes, png.byteLength);
    await assert.rejects(
      call(
        {
          kind: "session-prompt",
          requestId: "foreign-image",
          mode: "queue",
          content: [{ type: "image-upload", uploadId: start.uploadId }],
        },
        foreign,
      ),
      (error) => error.code === "UPLOAD_RESET",
    );
    let modelImage;
    let modelBytes;
    h.model.script = [
      async (request) => {
        modelImage = request.messages
          .flatMap((message) => message.content)
          .find((part) => part.type === "image");
        assert.ok(
          modelImage,
          "The actual model request contains a native image block",
        );
        modelBytes = await h.ctx.attachments.readImage(modelImage.attachment);
        return "The owner received the screenshot.";
      },
    ];
    const prompt = {
      kind: "session-prompt",
      requestId: "ordinary-screenshot",
      mode: "queue",
      content: [{ type: "image-upload", uploadId: start.uploadId }],
    };
    assert.deepEqual(await call(prompt), { accepted: true });
    const { agent } = await h.ctx.sessionController.resolveAgent(
      h.binding.sessionId,
    );
    await agent.whenIdle();
    assert.equal(h.model.requests.length, 1);
    assert.equal(modelImage.attachment.width, 512);
    assert.equal(modelImage.attachment.height, 512);
    assert.ok(modelBytes.data.byteLength > 16384);
    const projections = await call({ kind: "session-projections" });
    const page = await call({
      kind: "session-page",
      throughSeq: projections.asOfSeq,
      maxMessages: 10,
    });
    const follow = await call({
      kind: "stream-poll",
      stream: "session-follow",
    });
    for (const value of [page, follow]) {
      assert.ok(
        JSON.stringify(value).includes(modelImage.attachment.attachmentId),
      );
      assert.ok(!JSON.stringify(value).includes(png.toString("base64")));
    }
    await call({
      kind: "stream-close",
      stream: "session-follow",
      cursor: follow.cursor,
    });
    const received = [];
    for (let offset = 0; ; ) {
      const part = await call({
        kind: "attachment-read",
        attachmentId: modelImage.attachment.attachmentId,
        offset,
      });
      received.push(Buffer.from(part.data, "base64"));
      offset += received.at(-1).byteLength;
      if (part.eof) break;
    }
    assert.deepEqual(Buffer.concat(received), Buffer.from(modelBytes.data));
    assert.deepEqual(await call(prompt), { accepted: true });
    await agent.whenIdle();
    assert.equal(
      h.model.requests.length,
      1,
      "SDK request identity deduplicates the staged image prompt",
    );
    assert.ok(packetSizes.every((bytes) => bytes < 48 * 1024));

    await assert.rejects(
      call({
        kind: "file-upload-start",
        bytes: 8 * 1024 * 1024 + 1,
        image: { mediaType: "image/png" },
      }),
      /Too big|too_big/i,
    );
    const badDigest = await upload(pngBytes(), {
      mediaType: "image/png",
      sha256: "0".repeat(64),
    });
    await assert.rejects(
      call({ kind: "file-upload-finish", uploadId: badDigest.uploadId }),
      (error) => error.code === "UPLOAD_DIGEST",
    );
    await call({ kind: "file-upload-abort", uploadId: badDigest.uploadId });
    const wrongMime = await upload(pngBytes(), { mediaType: "image/jpeg" });
    await call({ kind: "file-upload-finish", uploadId: wrongMime.uploadId });
    await assert.rejects(
      call({
        ...prompt,
        requestId: "wrong-mime",
        content: [{ type: "image-upload", uploadId: wrongMime.uploadId }],
      }),
      /media|mime|format|match/i,
    );
    const plainHttp = await upload(pngBytes(), { mediaType: "image/png" });
    await call({ kind: "file-upload-finish", uploadId: plainHttp.uploadId });
    assert.deepEqual(
      await call({
        ...prompt,
        requestId: "owner-digest-without-browser-subtle",
        content: [{ type: "image-upload", uploadId: plainHttp.uploadId }],
      }),
      { accepted: true },
    );
    await agent.whenIdle();
    owner.dispose();
    await assert.rejects(
      call(prompt),
      (error) => error.code === "UPLOAD_RESET",
    );
  } finally {
    owner.dispose();
    await h.dispose();
  }
});

test("cold list, catalogs, access and event readiness never restore or drive the persisted owner Agent", async () => {
  const first = await createOwner();
  let h;
  try {
    await invoke(first, {
      kind: "session-prompt",
      requestId: "persist-before-restart",
      mode: "queue",
      content: [{ type: "text", text: "Keep the ordinary owner history." }],
    });
    const { agent } = await first.ctx.sessionController.resolveAgent(
      first.binding.sessionId,
    );
    await agent.whenIdle();
    first.owner.dispose();
    await first.ctx.fiber.dispose();
    h = await createOwner({ dir: first.dir, binding: first.binding });
    assert.equal(h.ctx.agents.get(h.binding.sessionId), undefined);
    assert.deepEqual(await invoke(h, { kind: "commands-list" }), []);
    const settings = await invoke(h, {
      kind: "settings-describe",
      ns: "ui-conversation",
    });
    assert.equal(settings.writable, false);
    assert.ok(Array.isArray(settings.namespaces));
    const capabilities = await invoke(h, { kind: "native-capabilities" });
    assert.equal(capabilities.approval, true);
    assert.equal(capabilities.userQuestions, true);
    await invoke(h, { kind: "session-list" });
    const events = await invoke(h, { kind: "stream-poll", stream: "events" });
    assert.equal(events.frames[0].type, "ready");
    await invoke(h, { kind: "stream-poll", stream: "access" });
    const projections = await invoke(h, { kind: "session-projections" });
    const page = await invoke(h, {
      kind: "session-page",
      throughSeq: projections.asOfSeq,
      maxMessages: 10,
    });
    assert.match(JSON.stringify(page), /Keep the ordinary owner history/);
    assert.equal(
      await invoke(h, {
        kind: "user-question-answer",
        callId: "not-actually-pending",
        answer: { answers: [] },
      }),
      false,
    );
    const wait = await invoke(h, {
      kind: "stream-poll",
      stream: "user-question-wait",
      request: { callId: "not-actually-pending" },
    });
    assert.equal(wait.closed, true);
    assert.equal(
      h.ctx.agents.get(h.binding.sessionId),
      undefined,
      "No read or nonexistent interaction answer starts native Agent restoration",
    );
    assert.equal(h.model.requests.length, 0);
    await invoke(h, {
      kind: "session-prompt",
      requestId: "explicit-resume",
      mode: "queue",
      content: [
        {
          type: "text",
          text: "Only my explicit new prompt restores the Agent.",
        },
      ],
    });
    const restored = await h.ctx.sessionController.resolveAgent(
      h.binding.sessionId,
    );
    await restored.agent.whenIdle();
    const pending = h.ctx.userQuestions.ask({
      agent: restored.agent,
      questions: [
        { id: "restored", question: "Is the original event bridge attached?" },
      ],
    });
    const delivered = await pollUntil(
      h,
      "events",
      events,
      (frame) =>
        frame.type === "waterfall" && frame.event === "user-questions/request",
    );
    const frame = delivered.frames.find((frame) => frame.type === "waterfall");
    await invoke(h, {
      kind: "interaction-result",
      clientId: events.frames[0].clientId,
      eventId: frame.eventId,
      outcome: {
        kind: "result",
        value: { answers: [{ id: "restored", selected: [], custom: "Yes." }] },
      },
    });
    assert.equal((await pending).answers[0].custom, "Yes.");
  } finally {
    if (h) await h.dispose();
    else {
      first.owner.dispose();
      await first.ctx.fiber.dispose();
      rmSync(first.dir, { recursive: true, force: true });
    }
  }
});
