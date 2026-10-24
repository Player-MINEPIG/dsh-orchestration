import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";

const createReadPolls = runInNewContext(`${readFileSync(new URL("../src/project-native-client.js", import.meta.url), "utf8")}\ncreateNativeReadPolls`, {
  setTimeout, clearTimeout, DOMException, TextEncoder,
});
const gzipClient = runInNewContext(`${readFileSync(new URL("../src/project-native-client.js", import.meta.url), "utf8")}\n({ createNativeReadPolls, decodeNativeGzip, decodeNativeFrameList })`, {
  setTimeout, clearTimeout, DOMException, TextEncoder, TextDecoder, Blob, DecompressionStream,
});
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const batch = (stream, cursor) => ({ stream, result: { frames: [], cursor } });

test("native client groups independent readers and cancels one late opening without canceling siblings", async () => {
  const lifetime = new AbortController(), consumer = new AbortController();
  const calls = [];
  let deliver;
  const polls = createReadPolls(async operation => {
    calls.push(operation);
    if (operation.kind === "stream-polls") return new Promise(resolve => { deliver = resolve; });
    return { closed: true };
  }, lifetime.signal);
  const first = polls.next({ stream: "session-follow" }, consumer.signal);
  const rejected = assert.rejects(first, { name: "AbortError" });
  const second = polls.next({ stream: "events" });
  await pause();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].polls.length, 2);
  assert.equal(calls[0].codec, undefined, "A client without a public decoder never requests compressed streams");
  consumer.abort();
  await rejected;
  deliver({ polls: [batch("session-follow", "follow:1"), batch("events", "events:1")] });
  assert.equal((await second).cursor, "events:1");
  await pause();
  assert.equal(calls.filter(call => call.kind === "stream-close").length, 1);
  assert.equal(calls[1].cursor, "follow:1");
  lifetime.abort();
});

test("native client keeps one bounded group in flight and closes every late cursor on mount disposal", async () => {
  const lifetime = new AbortController(), calls = [];
  let deliver;
  const polls = createReadPolls(async operation => {
    calls.push(operation);
    if (operation.kind === "stream-polls") return new Promise(resolve => { deliver = resolve; });
    return { closed: true };
  }, lifetime.signal);
  const first = polls.next({ stream: "session-follow" });
  const failedFirst = assert.rejects(first, { name: "AbortError" });
  await pause();
  const second = polls.next({ stream: "events" });
  const failedSecond = assert.rejects(second, { name: "AbortError" });
  await pause();
  assert.equal(calls.length, 1);
  lifetime.abort();
  await Promise.all([failedFirst, failedSecond]);
  deliver({ polls: [batch("session-follow", "late:1")] });
  await pause();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].kind, "stream-close");
  assert.equal(calls[1].cursor, "late:1");
  await assert.rejects(polls.next({ stream: "workspace" }), { name: "AbortError" });
});

test("native client validates a full group before delivery and isolates a member error", async () => {
  const lifetime = new AbortController();
  const polls = createReadPolls(async () => ({ polls: [
    { stream: "session-follow", error: "STREAM_FAILED" }, batch("events", "events:1"),
  ] }), lifetime.signal);
  const first = polls.next({ stream: "session-follow" });
  const second = polls.next({ stream: "events" });
  await assert.rejects(first, { code: "STREAM_FAILED" });
  assert.equal((await second).cursor, "events:1");
  lifetime.abort();

  const nextLifetime = new AbortController(), closes = [];
  const malformed = createReadPolls(async operation => {
    if (operation.kind === "stream-close") { closes.push(operation); return {}; }
    return { polls: [batch("session-follow", "orphan:1"), batch("session-follow", "orphan:2")] };
  }, nextLifetime.signal);
  const replies = await Promise.allSettled([malformed.next({ stream: "session-follow" }), malformed.next({ stream: "events" })]);
  assert.ok(replies.every(reply => reply.status === "rejected"));
  assert.equal(closes.length, 2);
  nextLifetime.abort();
});

test("native client never combines two different cursors of the same stream", async () => {
  const lifetime = new AbortController(), calls = [];
  const polls = createReadPolls(async operation => {
    calls.push(operation);
    return { polls: operation.polls.map(poll => batch(poll.stream, `${poll.cursor}:next`)) };
  }, lifetime.signal);
  const replies = await Promise.all([
    polls.next({ stream: "session-follow", cursor: "first:1" }),
    polls.next({ stream: "session-follow", cursor: "second:1" }),
  ]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.polls.length === 1));
  assert.deepEqual(replies.map(reply => reply.cursor), ["first:1:next", "second:1:next"]);
  lifetime.abort();
});

test("native client removes a cancelled queued reader before opening a stream", async () => {
  const lifetime = new AbortController(), consumer = new AbortController(), calls = [];
  const polls = createReadPolls(async operation => {
    calls.push(operation);
    return { polls: operation.polls.map(poll => batch(poll.stream, "opened:1")) };
  }, lifetime.signal);
  const cancelled = polls.next({ stream: "session-follow" }, consumer.signal);
  const rejection = assert.rejects(cancelled, { name: "AbortError" });
  consumer.abort();
  const active = polls.next({ stream: "events" });
  await rejection;
  assert.equal((await active).cursor, "opened:1");
  assert.equal(calls.length, 1);
  assert.deepEqual(Array.from(calls[0].polls, poll => poll.stream), ["events"]);
  lifetime.abort();
});

test("native gzip read groups opt in explicitly and decode an ordered semantic frame list", async () => {
  const lifetime = new AbortController(), calls = [];
  const polls = gzipClient.createNativeReadPolls(async operation => {
    calls.push(operation); return { polls: [batch("session-follow", "gzip:1")] };
  }, lifetime.signal);
  await polls.next({ stream: "session-follow" });
  assert.equal(calls[0].codec, "gzip");
  const frames = Array.from({ length: 22 }, (_, index) => ({ type: "event", event: { seq: index, text: "🌏".repeat(index + 1) } }));
  const bytes = Buffer.from(JSON.stringify(frames));
  const decoded = await gzipClient.decodeNativeFrameList(gzipSync(bytes), bytes.length);
  assert.deepEqual(JSON.parse(JSON.stringify(decoded)), frames);
  lifetime.abort();
});

test("native gzip decoder rejects expansion, truncated streams, wrong lengths and invalid semantic frames", async () => {
  const bytes = Buffer.from(JSON.stringify([{ type: "event", value: "decoded" }]));
  const compressed = gzipSync(bytes);
  await assert.rejects(gzipClient.decodeNativeGzip(gzipSync(Buffer.alloc(1024 * 1024, 65)), 65536, 65536), /限制/);
  await assert.rejects(gzipClient.decodeNativeGzip(compressed.subarray(0, compressed.length - 4), bytes.length, 65536));
  await assert.rejects(gzipClient.decodeNativeGzip(compressed, bytes.length + 1, 65536), /长度/);
  await assert.rejects(gzipClient.decodeNativeGzip(compressed, bytes.length - 1, 65536), /限制/);
  await assert.rejects(gzipClient.decodeNativeGzip(compressed, 8388609, 8388608), /大小/);
  await assert.rejects(gzipClient.decodeNativeGzip(gzipSync(Buffer.from([0xc3, 0x28])), 2, 65536));
  const invalid = Buffer.from("not JSON");
  await assert.rejects(gzipClient.decodeNativeGzip(gzipSync(invalid), invalid.length, 65536));
  for (const value of [{ type: "event" }, [], Array.from({ length: 33 }, () => ({}))]) {
    const raw = Buffer.from(JSON.stringify(value));
    await assert.rejects(gzipClient.decodeNativeFrameList(gzipSync(raw), raw.length), /集合/);
  }
  const abort = new AbortController(); abort.abort();
  await assert.rejects(gzipClient.decodeNativeGzip(compressed, bytes.length, 65536, abort.signal), { name: "AbortError" });
});

test("native read groups wait for finite member decoding before any consumer can poll again", async () => {
  const lifetime = new AbortController(), calls = [];
  let release;
  const decoded = new Promise(resolve => { release = resolve; });
  const polls = createReadPolls(async operation => {
    calls.push(operation);
    return { polls: operation.polls.map(poll => batch(poll.stream, `${poll.stream}:${calls.length}`)) };
  }, lifetime.signal);
  const follow = polls.next({ stream: "session-follow" }, undefined, async result => { await decoded; return result; });
  const events = polls.next({ stream: "events" });
  const continued = Promise.all([
    follow.then(result => polls.next({ stream: "session-follow", cursor: result.cursor })),
    events.then(result => polls.next({ stream: "events", cursor: result.cursor })),
  ]);
  continued.catch(() => {});
  try {
    await pause(); await pause();
    assert.equal(calls.length, 1, "Background readers cannot start another group while an included follow is decoding");
    release();
    await continued;
    assert.equal(calls.length, 2);
    assert.deepEqual(Array.from(calls[1].polls, poll => poll.stream), ["session-follow", "events"]);
  } finally { release(); lifetime.abort(); await Promise.allSettled([continued]); }
});

test("native read groups finish real gzip decoding before delivery and resume follow before background readers", async () => {
  const lifetime = new AbortController(), calls = [], delivered = [];
  const frames = [{ type: "event", event: { seq: 1, text: "header🌏".repeat(5000) } }, { type: "event", event: { seq: 2 } }];
  const bytes = Buffer.from(JSON.stringify(frames)), data = gzipSync(bytes).toString("base64");
  let decoded = false;
  const polls = gzipClient.createNativeReadPolls(async operation => {
    calls.push(operation);
    return { polls: operation.polls.map(poll => ({ stream: poll.stream, result: {
      frames: [], cursor: `${poll.stream}:${calls.length}`,
      ...(calls.length === 1 && poll.stream === "session-follow" ? { encodedFrames: { encoding: "gzip", decodedBytes: bytes.length, data } } : {}),
    } })) };
  }, lifetime.signal);
  const events = polls.next({ stream: "events" }).then(result => {
    assert.equal(decoded, true); delivered.push("events");
    return polls.next({ stream: "events", cursor: result.cursor });
  });
  const follow = polls.next({ stream: "session-follow" }, undefined, async result => {
    const output = await gzipClient.decodeNativeFrameList(Buffer.from(result.encodedFrames.data, "base64"), result.encodedFrames.decodedBytes);
    assert.deepEqual(JSON.parse(JSON.stringify(output)), frames); decoded = true;
    return { frames: output, cursor: result.cursor };
  }).then(result => {
    delivered.push("session-follow");
    return polls.next({ stream: "session-follow", cursor: result.cursor });
  });
  try {
    await Promise.all([events, follow]);
    assert.deepEqual(delivered, ["session-follow", "events"]);
    assert.equal(calls.length, 2);
    assert.deepEqual(Array.from(calls[1].polls, poll => poll.stream), ["session-follow", "events"]);
  } finally { lifetime.abort(); }
});

test("native read group preparation rejects a bad gzip member and closes only its new cursor", async () => {
  const lifetime = new AbortController(), calls = [];
  const polls = gzipClient.createNativeReadPolls(async operation => {
    calls.push(operation);
    if (operation.kind === "stream-close") return { closed: true };
    return { polls: [batch("session-follow", "bad-gzip:1"), batch("events", "events:1")] };
  }, lifetime.signal);
  try {
    const follow = polls.next({ stream: "session-follow" }, undefined, () => gzipClient.decodeNativeFrameList(Buffer.from("broken gzip"), 12));
    const events = polls.next({ stream: "events" });
    await assert.rejects(follow);
    assert.equal((await events).cursor, "events:1");
    const closes = calls.filter(call => call.kind === "stream-close");
    assert.equal(closes.length, 1);
    assert.equal(closes[0].cursor, "bad-gzip:1");
  } finally { lifetime.abort(); }
});

test("cancellation during preparation closes the late cursor without releasing siblings early", async () => {
  const lifetime = new AbortController(), consumer = new AbortController(), calls = [];
  let release, started;
  const decoding = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  const polls = createReadPolls(async operation => {
    calls.push(operation);
    if (operation.kind === "stream-close") return { closed: true };
    return { polls: [batch("session-follow", "cancelled:1"), batch("events", "events:1")] };
  }, lifetime.signal);
  const follow = polls.next({ stream: "session-follow" }, consumer.signal, async result => { started(); await decoding; return result; });
  const rejected = assert.rejects(follow, { name: "AbortError" });
  let delivered = false;
  const events = polls.next({ stream: "events" }).then(result => { delivered = true; return result; });
  try {
    await began; consumer.abort(); await rejected;
    assert.equal(delivered, false);
    release();
    assert.equal((await events).cursor, "events:1");
    assert.equal(calls.filter(call => call.kind === "stream-close" && call.cursor === "cancelled:1").length, 1);
  } finally { release(); lifetime.abort(); }
});
