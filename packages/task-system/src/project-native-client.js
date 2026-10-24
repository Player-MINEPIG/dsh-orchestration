async function decodeNativeGzip(bytes, decodedBytes, limit, signal) {
  if (typeof DecompressionStream !== "function" || !Number.isSafeInteger(decodedBytes) || decodedBytes < 1 || decodedBytes > limit ||
      bytes.byteLength < 1 || bytes.byteLength > 8388608) throw new Error("项目会话压缩帧大小无效。");
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      if (done) break;
      size += value.byteLength;
      if (size > decodedBytes || size > limit) throw new Error("项目会话压缩帧超出解码限制。");
      chunks.push(value);
    }
    if (size !== decodedBytes) throw new Error("项目会话压缩帧长度不符。");
    const decoded = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { decoded.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
  }
}
async function decodeNativeFrameList(bytes, decodedBytes, signal) {
  const frames = await decodeNativeGzip(bytes, decodedBytes, 65536, signal);
  if (!Array.isArray(frames) || !frames.length || frames.length > 32) throw new Error("项目会话压缩帧集合无效。");
  return frames;
}

function createNativeReadPolls(execute, lifetime) {
  const queued = [];
  const codec = typeof DecompressionStream === "function" ? "gzip" : undefined;
  let timer, running = false, closed = false;
  const close = (stream, result) => {
    if (typeof result?.cursor === "string") void execute({ kind: "stream-close", stream, cursor: result.cursor }).catch(() => {});
  };
  const schedule = () => {
    if (!closed && !running && timer === undefined && queued.length)
      timer = setTimeout(() => { timer = undefined; void flush(); }, 0);
  };
  async function flush() {
    if (closed || running) return;
    const entries = [], streams = new Set();
    for (let index = 0; index < queued.length && entries.length < 5;) {
      const entry = queued[index];
      if (entry.cancelled) { queued.splice(index, 1); entry.finish(); continue; }
      if (streams.has(entry.poll.stream)) { index++; continue; }
      queued.splice(index, 1); entries.push(entry); streams.add(entry.poll.stream);
    }
    if (!entries.length) return;
    running = true;
    let response;
    try {
      response = await execute({ kind: "stream-polls", ...(codec ? { codec } : {}), polls: entries.map(entry => entry.poll) });
      if (!response || !Array.isArray(response.polls) || response.polls.length !== entries.length ||
          new TextEncoder().encode(JSON.stringify(response)).byteLength > 49152)
        throw new Error("项目会话数据流响应不完整。");
      const results = new Map();
      for (const item of response.polls) {
        if (!item || !streams.has(item.stream) || results.has(item.stream) ||
            (typeof item.error === "string" ? !item.error.length || item.error.length > 200 || item.result !== undefined :
              item.error !== undefined || !item.result || !Array.isArray(item.result.frames) || typeof item.result.cursor !== "string"))
          throw new Error("项目会话数据流响应不完整。");
        results.set(item.stream, item);
      }
      const prepared = await Promise.allSettled(entries.map(entry => {
        const item = results.get(entry.poll.stream);
        return entry.cancelled || closed || item.error ? undefined : entry.prepare(item.result);
      }));
      const deliveries = entries.map((entry, index) => ({ entry, prepared: prepared[index] }));
      deliveries.sort((left, right) => Number(right.entry.poll.stream === "session-follow") - Number(left.entry.poll.stream === "session-follow"));
      for (const { entry, prepared } of deliveries) {
        const item = results.get(entry.poll.stream);
        if (entry.cancelled || closed) close(entry.poll.stream, item.result);
        else if (item.error) entry.reject(Object.assign(new Error("项目会话数据流暂时不可用。"), { code: item.error }));
        else if (prepared.status === "rejected") { close(entry.poll.stream, item.result); entry.reject(prepared.reason); }
        else entry.resolve(prepared.value);
      }
    } catch (error) {
      if (Array.isArray(response?.polls))
        for (const item of response.polls) if (item && streams.has(item.stream)) close(item.stream, item.result);
      for (const entry of entries) entry.reject(error);
    } finally {
      for (const entry of entries) entry.finish();
      running = false; schedule();
    }
  }
  const stop = () => {
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    for (const entry of queued.splice(0)) { entry.cancel(); entry.finish(); }
  };
  lifetime.addEventListener("abort", stop, { once: true });
  if (lifetime.aborted) stop();
  return {
    next(poll, signal, prepare = result => result) {
      if (closed || signal?.aborted) return Promise.reject(signal?.reason ?? lifetime.reason ?? new DOMException("Aborted", "AbortError"));
      if (queued.length >= 32) return Promise.reject(new Error("项目会话数据流请求过多。"));
      return new Promise((resolve, reject) => {
        const entry = { poll, prepare, resolve, reject, cancelled: false,
          cancel() { entry.cancelled = true; reject(signal?.reason ?? lifetime.reason ?? new DOMException("Aborted", "AbortError")); },
          finish() { signal?.removeEventListener("abort", entry.cancel); lifetime.removeEventListener("abort", entry.cancel); } };
        signal?.addEventListener("abort", entry.cancel, { once: true });
        lifetime.addEventListener("abort", entry.cancel, { once: true });
        queued.push(entry); schedule();
      });
    },
  };
}

function createProjectNativeClient({ React, Context, modules }) {
  const h = React.createElement;
  const corePlugins = [
    "dsh-typert-registry", "dsh-api-gateway", "dsh-api-remotes", "dsh-api-remote-access",
    "dsh-api-session-controller", "dsh-api-workspace-controller",
  ];
  const basePlugins = [
    "dsh-client-ui-renderer",
    "dsh-client-locale", "dsh-client-shortcuts", "dsh-client-ui-session", "dsh-client-ui-workspace",
    "dsh-client-ui-settings", "dsh-client-ui-conversation", "dsh-client-ui-chat",
    "dsh-client-ui-attachment", "dsh-client-ui-tool", "dsh-client-ui-sidebar-right", "dsh-client-resources",
  ];
  const streamOperations = new Map([
    ["$events", "events"], ["remoteAccess/follow", "access"], ["workspace/follow", "workspace"],
    ["session/control", "session-control"], ["session/follow", "session-follow"], ["userQuestions/attachWait", "user-question-wait"],
  ]);
  const pluginModules = new Map();
  const importPlugin = (name) => {
    const id = `@deepseek-ai/${name}`;
    if (!pluginModules.has(id)) pluginModules.set(id, modules.import(id));
    return pluginModules.get(id);
  };
  function FixedChatConversationView({ renderSlot, useConversation }) {
    const empty = useConversation((value) => value.activeTargets.size === 0);
    return h(React.Fragment, null, renderSlot("conversation.session", { view: "chat" }),
      empty && h("div", { "aria-hidden": true, style: { flex: "1 0 auto" } }));
  }
  const contentSlots = { views: FixedChatConversationView };
  function Conversation({ renderFactorySlot, useSession }) {
    const session = useSession((value) => value);
    return renderFactorySlot("conversation.content", {
      variant: "embedded", phase: session.openState === "loading" ? "settling" : "active", hero: false,
    }, { slots: contentSlots });
  }
  function commandIdentity() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
    const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  function promptFingerprint(request) {
    const text = JSON.stringify(request);
    let first = 2166136261, second = 3339675911;
    for (let index = 0; index < text.length; index += 1) {
      first = Math.imul(first ^ text.charCodeAt(index), 16777619);
      second = Math.imul(second ^ text.charCodeAt(index), 2246822519);
    }
    return `${text.length}:${first >>> 0}:${second >>> 0}`;
  }
  function failure(error) {
    const value = error?.rpcError ?? error;
    return { code: typeof value?.code === "string" ? value.code : "project/native-unavailable",
      message: typeof value?.message === "string" ? value.message : "项目会话暂时无法连接，请稍后重试。",
      details: value?.details && typeof value.details === "object" ? value.details : {} };
  }
  function unsupported(endpoint) {
    return { ok: false, error: { code: "project/native-unsupported", message: "当前项目会话暂不支持此操作。", details: { endpoint } } };
  }
  function aborted(signal) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  function cancellable(promise, signal) {
    if (!signal) return promise;
    aborted(signal);
    return new Promise((resolve, reject) => {
      const cancel = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", cancel, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    });
  }
  function waitFor(source, predicate, signal, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      let off = () => {};
      const timer = setTimeout(() => finish(new Error("项目会话连接超时，请检查所属设备后重试。")), timeoutMs);
      const cancel = () => finish(signal.reason ?? new DOMException("Aborted", "AbortError"));
      const finish = (error) => { clearTimeout(timer); off(); signal.removeEventListener("abort", cancel); error ? reject(error) : resolve(); };
      const check = () => { if (predicate(source.getSnapshot())) finish(); };
      signal.addEventListener("abort", cancel, { once: true });
      off = source.subscribe(check);
      check();
    });
  }
  return {
    async mount(container, descriptor, invoke, { onRecipient, onState, signal } = {}) {
      const binding = Object.freeze({ ...descriptor });
      const lifetime = new AbortController();
      const abortFromHost = () => lifetime.abort(signal.reason);
      if (signal?.aborted) abortFromHost(); else signal?.addEventListener('abort', abortFromHost, { once: true });
      const ctx = new Context();
      let reference, unmount;
      const preparedPrompts = new Map();
      let capabilities = { approval: false, userQuestions: false, timedQuestions: false, skills: false };
      const setState = (state, message) => onState?.({ state, message });
      const execute = (operation, signal) => {
        aborted(signal);
        const commandId = operation.kind === "session-prompt" ? operation.requestId : commandIdentity();
        return cancellable(Promise.resolve().then(() => invoke("projectNativeConversation", {
          projectId: binding.projectId, generation: binding.generation, commandId, operation,
        })), signal);
      };
      const readPolls = createNativeReadPolls(execute, lifetime.signal);
      async function* pollNative(stream, request, signal) {
        let cursor, pending;
        const prepare = async batch => {
          aborted(signal);
          if (!batch || !Array.isArray(batch.frames) || typeof batch.cursor !== "string") throw new Error("项目会话数据流响应不完整。");
          cursor = batch.cursor;
          const frames = [];
          if (batch.encodedFrames !== undefined) {
            const encoded = batch.encodedFrames;
            if (pending || batch.frames.length || batch.framePart !== undefined || typeof DecompressionStream !== "function" ||
                !encoded || encoded.encoding !== "gzip" || typeof encoded.data !== "string" || encoded.data.length > 65536)
              throw new Error("项目会话压缩数据格式无效。");
            const raw = atob(encoded.data);
            if (!raw.length || btoa(raw) !== encoded.data) throw new Error("项目会话压缩数据编码无效。");
            frames.push(...await decodeNativeFrameList(Uint8Array.from(raw, value => value.charCodeAt(0)), encoded.decodedBytes, signal));
          } else if (batch.framePart !== undefined) {
            const part = batch.framePart;
            if (batch.frames.length || !part || typeof part.id !== "string" || !part.id.length || part.id.length > 200 ||
                !Number.isSafeInteger(part.totalBytes) || part.totalBytes <= 0 || part.totalBytes > 8388608 ||
                !Number.isSafeInteger(part.offset) || typeof part.data !== "string" || part.data.length > 32768 || typeof part.eof !== "boolean") throw new Error("项目会话历史分片格式无效。");
            if (part.encoding !== undefined && (typeof DecompressionStream !== "function" || !["gzip-frame", "gzip-frames"].includes(part.encoding) ||
                !Number.isSafeInteger(part.decodedBytes) || part.decodedBytes <= 0 || part.decodedBytes > (part.encoding === "gzip-frames" ? 65536 : 8388608)) ||
                part.encoding === undefined && part.decodedBytes !== undefined || part.encoding === "gzip-frames" && part.totalBytes > 66560)
              throw new Error("项目会话历史压缩格式无效。");
            const raw = atob(part.data);
            if (!raw.length || raw.length > 24576 || btoa(raw) !== part.data) throw new Error("项目会话历史分片编码无效。");
            if (!pending) {
              if (part.offset !== 0) throw new Error("项目会话历史缺少起始分片。");
              pending = { id: part.id, bytes: new Uint8Array(part.totalBytes), offset: 0, encoding: part.encoding, decodedBytes: part.decodedBytes };
            }
            if (part.id !== pending.id || part.totalBytes !== pending.bytes.length || part.offset !== pending.offset || part.encoding !== pending.encoding || part.decodedBytes !== pending.decodedBytes ||
                part.offset + raw.length > part.totalBytes || part.eof !== (part.offset + raw.length === part.totalBytes)) throw new Error("项目会话历史分片不连续。");
            pending.bytes.set(Uint8Array.from(raw, value => value.charCodeAt(0)), pending.offset);
            pending.offset += raw.length;
            if (part.eof) {
              const payload = pending;
              const frame = payload.encoding === "gzip-frames" ? await decodeNativeFrameList(payload.bytes, payload.decodedBytes, signal) :
                payload.encoding ? await decodeNativeGzip(payload.bytes, payload.decodedBytes, 8388608, signal) :
                JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload.bytes));
              aborted(signal);
              pending = undefined;
              if (payload.encoding === "gzip-frames") frames.push(...frame);
              else frames.push(frame);
            }
          } else {
            if (pending) throw new Error("项目会话历史分片尚未完整。");
            frames.push(...batch.frames);
          }
          aborted(signal);
          if (batch.closed && pending) throw new Error("项目会话历史传输提前结束。");
          return { frames, cursor: batch.cursor, closed: batch.closed };
        };
        try {
          while (!signal?.aborted) {
            const poll = { stream,
              ...(cursor === undefined ? {} : { cursor }),
              ...(request === undefined || stream === "user-question-wait" && cursor !== undefined ? {} : { request }) };
            const batch = stream === "user-question-wait" || stream === "session-page" ?
              await prepare(await execute({ kind: "stream-poll", ...poll }, signal)) : await readPolls.next(poll, signal, prepare);
            for (const frame of batch.frames) { aborted(signal); yield frame; }
            if (batch.closed) return;
          }
        } finally {
          pending = undefined;
          if (cursor !== undefined) void execute({ kind: "stream-close", stream, cursor }).catch(() => {});
        }
      }
      async function stageBytes(bytes, name, signal, onProgress, image) {
        if (bytes.byteLength > 8388608) throw new Error("附件不能超过 8 MiB。");
        let uploadId, finished = false;
        try {
          const started = await execute({ kind: "file-upload-start", bytes: bytes.byteLength,
            ...(name === undefined ? {} : { name }), ...(image === undefined ? {} : { image }) }, signal);
          if (!started || typeof started.uploadId !== "string" || started.chunkBytes !== 24576) throw new Error("所属设备未确认附件上传。");
          uploadId = started.uploadId;
          let index = 0;
          for (let offset = 0; offset < bytes.byteLength; offset += 24576) {
            const chunk = bytes.subarray(offset, Math.min(offset + 24576, bytes.byteLength));
            const receipt = await execute({ kind: "file-upload-part", uploadId, index, data: btoa(String.fromCharCode(...chunk)) }, signal);
            if (receipt?.nextIndex !== index + 1 || receipt.receivedBytes !== offset + chunk.byteLength) throw new Error("所属设备的附件上传进度不一致。");
            index += 1; onProgress?.({ loaded: offset + chunk.byteLength, total: bytes.byteLength });
          }
          const value = await execute({ kind: "file-upload-finish", uploadId }, signal);
          finished = true; return { uploadId, value };
        } finally { if (uploadId && !finished) void execute({ kind: "file-upload-abort", uploadId }).catch(() => {}); }
      }
      function preparePrompt(operation, signal) {
        const fingerprint = promptFingerprint(operation), cached = preparedPrompts.get(operation.requestId);
        if (cached) {
          if (cached.fingerprint !== fingerprint) throw Object.assign(new Error("同一消息标识的内容已改变，请核对原消息。"), { code: "CONFLICT" });
          return cached.promise;
        }
        const promise = (async () => {
          const content = [];
          for (const part of operation.content ?? []) {
            if (part.type !== "image") { content.push(Object.freeze({ ...part })); continue; }
            if (!capabilities.files) throw new Error("所属设备尚不支持图片。");
            const decoded = atob(part.data), bytes = Uint8Array.from(decoded, value => value.charCodeAt(0));
            const digest = crypto.subtle ? new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)) : undefined;
            const sha256 = digest ? Array.from(digest, value => value.toString(16).padStart(2, "0")).join("") : undefined;
            const staged = await stageBytes(bytes, part.name, signal, undefined, { mediaType: part.mediaType, ...(sha256 ? { sha256 } : {}) });
            content.push(Object.freeze({ type: "image-upload", uploadId: staged.uploadId }));
          }
          return Object.freeze({ ...operation, content: Object.freeze(content) });
        })();
        const entry = { fingerprint, promise }; preparedPrompts.set(operation.requestId, entry);
        promise.catch(() => { if (preparedPrompts.get(operation.requestId) === entry) preparedPrompts.delete(operation.requestId); });
        return promise;
      }
      const assertSession = (request) => {
        const sessionId = request?.sessionId ?? request?.address?.sessionId;
        if (sessionId !== undefined && sessionId !== binding.sessionId) throw new Error("项目会话目标已变化，请刷新。 ");
      };
      const rpc = {
        async call(channel, endpoint, payload, signal) {
          if (channel !== "/api") return unsupported(endpoint);
          if (endpoint === "$events/result") {
            try {
              if (!capabilities.approval && !capabilities.userQuestions) return unsupported(endpoint);
              return { ok: true, value: await execute({ kind: "interaction-result", clientId: payload?.args?.clientId, eventId: payload?.args?.eventId, outcome: payload?.args?.outcome }, signal) };
            } catch (error) { return { ok: false, error: failure(error) }; }
          }
          const args = payload?.args;
          if (!args || typeof args !== "object") return unsupported(endpoint);
          const request = args.request;
          try {
            assertSession(request);
            let operation;
            switch (endpoint) {
              case "session/list": operation = { kind: "session-list" }; break;
              case "session/projections": operation = { kind: "session-projections" }; break;
              case "session/page": {
                const pageRequest = { throughSeq: request?.throughSeq,
                ...(request?.beforeSeq === undefined ? {} : { beforeSeq: request.beforeSeq }),
                ...(request?.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
                ...(request?.turnWindow === undefined ? {} : { turnWindow: request.turnWindow }) };
                let page, received = false;
                for await (const frame of pollNative("session-page", pageRequest, signal)) {
                  if (received) throw new Error("项目历史分页返回了重复页面。");
                  page = frame; received = true;
                }
                if (!received) throw new Error("项目历史分页未返回页面。");
                return { ok: true, value: page };
              }
              case "session/prompt": operation = { kind: "session-prompt", requestId: request?.requestId,
                mode: request?.mode, content: request?.content,
                ...(request?.clientTimeZone === undefined ? {} : { clientTimeZone: request.clientTimeZone }) }; break;
              case "session/cancel": operation = { kind: "session-cancel" }; break;
              case "session/updateQueue": operation = { kind: "session-queue", itemId: request?.itemId, action: request?.action }; break;
              case "session/modelCatalog": operation = { kind: "model-catalog" }; break;
              case "session/selectModel":
                if (!capabilities.modelSelect) return unsupported(endpoint);
                operation = { kind: "model-select", provider: request?.provider, model: request?.model,
                  ...(request?.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }) }; break;
              case "session/attachment": {
                if (!capabilities.files || typeof request?.attachmentId !== "string") return unsupported(endpoint);
                let offset = 0, attachment;
                const chunks = [];
                while (true) {
                  const chunk = await execute({ kind: "attachment-read", attachmentId: request.attachmentId, offset, maxBytes: 24576 }, signal);
                  if (!chunk || chunk.offset !== offset || typeof chunk.data !== "string" || !Number.isSafeInteger(chunk.totalBytes) || chunk.totalBytes > 8388608) throw new Error("项目图片超出读取限制。");
                  const bytes = atob(chunk.data); attachment ??= chunk.attachment; chunks.push(bytes); offset += bytes.length;
                  if (offset > chunk.totalBytes || !chunk.eof && bytes.length === 0) throw new Error("项目图片读取进度无效。");
                  if (chunk.eof) { if (offset !== chunk.totalBytes) throw new Error("项目图片内容不完整。"); break; }
                }
                return { ok: true, value: { attachment, data: btoa(chunks.join("")) } };
              }
              case "permissionPresets/catalog": operation = { kind: "permissions-catalog" }; break;
              case "commands/list":
                if (!capabilities.commands || args.agentId !== binding.sessionId) return unsupported(endpoint);
                operation = { kind: "commands-list" }; break;
              case "commands/execute": {
                const match = typeof args.line === "string" && /^\/permission\s+([a-z][a-z0-9-]*)\s*$/.exec(args.line);
                if (!capabilities.permissions || args.agentId !== binding.sessionId || !match || args.submittedAttachments?.length) return unsupported(endpoint);
                operation = { kind: "commands-execute", command: "permission", preset: match[1] }; break;
              }
              case "userQuestions/answer":
                if (!capabilities.timedQuestions || args.agentId !== binding.sessionId) return unsupported(endpoint);
                operation = { kind: "user-question-answer", callId: args.callId, answer: args.answer }; break;
              case "skills/list":
                if (!capabilities.skills || request?.sessionId !== binding.sessionId) return unsupported(endpoint);
                operation = { kind: "skills-list" }; break;
              case "settings/describe": operation = { kind: "settings-describe", ns: "ui-conversation" }; break;
              default: return unsupported(endpoint);
            }
            if (operation.kind === "session-prompt") operation = await preparePrompt(operation, signal);
            const value = await execute(operation, signal);
            return { ok: true, value };
          } catch (error) { return { ok: false, error: failure(error) }; }
        },
        async *open(channel, endpoint, payload, signal) {
          const stream = streamOperations.get(endpoint);
          if (channel !== "/api" || !stream) throw Object.assign(new Error("当前项目会话不提供此数据流。"), { code: "project/native-unsupported" });
          const request = payload?.args?.request;
          assertSession(request);
          if (stream === "user-question-wait" && (!capabilities.timedQuestions || payload?.args?.agentId !== binding.sessionId)) throw new Error("此项目会话不支持等待该问题。");
          const follow = stream === "session-follow" ? {
            ...(request?.assistantStream === undefined ? {} : { assistantStream: request.assistantStream }),
            ...(request?.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
            ...(request?.turnWindow === undefined ? {} : { turnWindow: request.turnWindow }),
          } : stream === "user-question-wait" ? { callId: payload.args.callId } : undefined;
          yield* pollNative(stream, follow, signal);
        },
      };
      const notifyAttachment = () => {
        const scope = ctx.get("sessions")?.scope(binding.sessionId);
        if (scope) ctx.get("conversation")?.input?.for(scope)?.notify("info", "此项目会话暂不支持附件，请发送文字。");
      };
      const denyFiles = (event) => {
        const transfer = event.clipboardData ?? event.dataTransfer;
        if (capabilities.files) return;
        if (!transfer || !Array.from(transfer.items ?? []).some((item) => item.kind === "file") && !transfer.files?.length && !Array.from(transfer.types ?? []).includes("Files")) return;
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.type === "drop" || event.type === "paste") notifyAttachment();
      };
      for (const name of ["paste", "drop", "dragover"]) container.addEventListener(name, denyFiles, true);
      const dispose = async () => {
        lifetime.abort();
        preparedPrompts.clear();
        signal?.removeEventListener('abort', abortFromHost);
        for (const name of ["paste", "drop", "dragover"]) container.removeEventListener(name, denyFiles, true);
        // Leave the parent React commit before synchronously unmounting the SDK root.
        await Promise.resolve();
        unmount?.(); unmount = undefined;
        reference?.release(); reference = undefined;
        await ctx.fiber.dispose();
      };
      try {
        setState("connecting", "正在连接项目所属设备…");
        const advertised = await execute({ kind: "native-capabilities" }, lifetime.signal);
        if (!advertised || typeof advertised !== "object" || ["approval", "userQuestions", "timedQuestions", "skills", "files", "modelSelect"].some((name) => typeof advertised[name] !== "boolean")) throw new Error("项目所属设备未提供完整的会话能力信息。");
        capabilities = advertised;
        const connection = await importPlugin("dsh-client-connection");
        connection.installConnection(ctx, { interactions: "answer", transport: { rpc }, location: { hostname: "project-session.invalid" } });
        const panelSnapshot = { activePanelId: null };
        const panelInfo = { getSnapshot: () => panelSnapshot, subscribe: () => () => {} };
        ctx.reflect.provide("layout", { panelInfo, selectPanel() { throw new Error("请从项目页面选择导航。"); },
          beginNavigation: () => lifetime.signal, toggleSidebar() {}, openRightbar() {}, closeRightbar() {} });
        ctx.reflect.provide("fileUpload", { async upload(sessionId, data, name, signal, onProgress) {
          if (!capabilities.files || sessionId !== binding.sessionId) return unsupported("fileUploads/upload");
          const uploadSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
          try {
            aborted(uploadSignal);
            let bytes;
            if (data instanceof Uint8Array) bytes = data;
            else {
              const reader = data instanceof Blob ? data.stream().getReader() : data.getReader();
              const parts = []; let size = 0;
              try { while (true) { const part = await cancellable(reader.read(), uploadSignal); if (part.done) break;
                if (!(part.value instanceof Uint8Array)) throw new Error("附件内容格式无效。");
                size += part.value.byteLength; if (size > 8388608) throw new Error("附件不能超过 8 MiB。"); parts.push(part.value);
              } } finally { void reader.cancel().catch(() => {}); }
              bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
            }
            const staged = await stageBytes(bytes, name, uploadSignal, onProgress);
            return { ok: true, value: staged.value };
          } catch (error) { return { ok: false, error: failure(error) }; }
        } });
        for (const name of corePlugins) { aborted(lifetime.signal); ctx.plugin(await importPlugin(name)); }
        await waitFor({ getSnapshot: () => !!ctx.get("sessions"), subscribe: (listener) => { const timer = setInterval(listener, 25); return () => clearInterval(timer); } }, Boolean, lifetime.signal);
        await waitFor(ctx.connection.generation, (value) => value !== undefined, lifetime.signal);
        await ctx.sessions.refresh();
        await waitFor(ctx.sessions.list, (state) => !!state.byId[binding.sessionId], lifetime.signal);
        reference = ctx.sessions.retain(binding.sessionId, { source: "projectConversation", signal: lifetime.signal });
        await cancellable(reference.ready, lifetime.signal);
        const plugins = [...basePlugins];
        if (capabilities.files && capabilities.commands) plugins.push("dsh-client-ui-input-trigger", "dsh-client-ui-commands");
        if (capabilities.files && capabilities.commands && capabilities.modelSelect) plugins.push("dsh-client-ui-model-selection");
        if (capabilities.files && capabilities.commands && capabilities.permissions) plugins.push("dsh-client-ui-permission-presets");
        if (capabilities.approval) plugins.push("dsh-client-ui-approval");
        if (capabilities.userQuestions && capabilities.timedQuestions) plugins.push("dsh-client-ui-user-questions");
        if (capabilities.skills) plugins.push("dsh-client-ui-input-trigger", "dsh-client-ui-skill");
        for (const name of new Set(plugins)) { aborted(lifetime.signal); ctx.plugin(await importPlugin(name)); }
        await waitFor({ getSnapshot: () => !!ctx.get("slots"), subscribe: (listener) => { const timer = setInterval(listener, 25); return () => clearInterval(timer); } }, Boolean, lifetime.signal);
        ctx.slots.provideRoot({ hooks: { panelInfo } });
        ctx.slots.register({ name: "root", children: { main: { kind: "keyed", scope: "root" },
          "shell.overlay": { kind: "list", scope: "root" }, "project.native.conversation": { kind: "single", scope: "session" } } },
        function ProjectNativeRoot({ SessionProvider, renderSlot }) {
          return h("div", { "data-project-native-conversation": "", style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } },
            h("div", { style: { display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", flexShrink: 0 } },
              h("button", { type: "button", onClick: onRecipient, style: { border: "1px solid var(--dsw-alias-border-l3)", borderRadius: 8,
                background: "transparent", color: "inherit", padding: "6px 10px", cursor: "pointer", font: "inherit" } }, "对话对象：项目统筹"),
              h("span", { style: { color: "var(--dsw-alias-label-caption)", fontSize: 12 } }, capabilities.files ? "附件和图片最多 8 MiB" : capabilities.skills ? "可发送文字和引用技能；附件暂不可用" : "可发送文字；附件暂不可用")),
            h("div", { style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 } },
              h(SessionProvider, { session: reference }, renderSlot("project.native.conversation", {}))),
            renderSlot("shell.overlay", {}));
        });
        ctx.slots.inject("project.native.conversation", () => ctx.slots.register({ name: "project.native.conversation" }, Conversation));
        await waitFor({ getSnapshot: () => !!ctx.get("conversation"), subscribe: (listener) => { const timer = setInterval(listener, 25); return () => clearInterval(timer); } }, Boolean, lifetime.signal);
        aborted(lifetime.signal);
        const promptAccess = ctx.remoteAccess.source("session", binding.sessionId, "session/prompt");
        const updateAccess = () => ctx.conversation.blocks.set(binding.sessionId, promptAccess.getSnapshot() === true ? undefined : { reason: "当前会话仅可查看，无法发送新消息。" });
        ctx.effect(() => promptAccess.subscribe(updateAccess), "project native prompt availability");
        updateAccess();
        unmount = ctx.uiRenderer.mount(container);
        ctx.effect(() => ctx.connection.state.subscribe(() => {
          const state = ctx.connection.state.getSnapshot();
          setState(state === "connected" ? "ready" : "connecting", "正在重新连接项目所属设备…");
        }), "project native connection state");
        setState("ready");
        return { dispose };
      } catch (error) { await dispose(); throw error; }
    },
  };
}
