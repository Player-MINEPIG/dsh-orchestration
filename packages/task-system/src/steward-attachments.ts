import type { Context } from "@deepseek-ai/cordis";
import { type AdmittedPromptContentPart } from "@deepseek-ai/dsh-attachment";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { TaskLedger } from "./ledger.js";
import { canonical, TaskError } from "./ledger.js";
import { stewardContent, stewardUpload } from "./steward-contracts.js";

const readyUpload = z.strictObject({ conversationId: z.string(), bytes: z.number(), name: z.string(), mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]).optional(), content: stewardContent, messageId: z.string().nullable(), filePath: z.string().optional() });
type Incoming = { conversationId: string; bytes: number; name: string; mediaType?: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; chunks: Uint8Array[]; received: number; touched: number; finishing?: Promise<unknown> };

export class StewardAttachments {
  private readonly incoming = new Map<string, Incoming>();
  private readonly db: ReturnType<TaskLedger["managementDatabase"]>;
  constructor(private readonly ctx: Context, ledger: TaskLedger) {
    this.db = ledger.managementDatabase();
    this.db.exec("CREATE TABLE IF NOT EXISTS steward_uploads(id TEXT PRIMARY KEY,command TEXT UNIQUE NOT NULL,conversation TEXT NOT NULL,data TEXT NOT NULL,created TEXT NOT NULL); CREATE INDEX IF NOT EXISTS steward_upload_file_path ON steward_uploads(json_extract(data,'$.filePath'))");
  }
  get active() { for (const [id, upload] of this.incoming) if (!upload.finishing && Date.now() - upload.touched > 120000) this.incoming.delete(id); return this.incoming.size > 0; }
  close() { this.incoming.clear(); }
  private storage() { const files = this.ctx.get("attachments"); if (!files) throw new TaskError("UNAVAILABLE", "Native attachment storage is unavailable"); return files; }
  async upload(input: unknown) {
    const request = stewardUpload.parse(input), files = this.ctx.get("attachments");
    if (!files) throw new TaskError("UNAVAILABLE", "Native attachment storage is unavailable");
    for (const [id, upload] of this.incoming) if (!upload.finishing && Date.now() - upload.touched > 120000) this.incoming.delete(id);
    this.db.prepare("DELETE FROM steward_uploads WHERE json_extract(data,'$.messageId') IS NULL AND created<?").run(new Date(Date.now() - 86400000).toISOString());
    if (request.kind === "start") {
      const prior = this.db.prepare("SELECT id,data FROM steward_uploads WHERE command=? AND conversation=?").get(request.commandId, request.conversationId);
      if (prior) { const value = readyUpload.parse(JSON.parse(String(prior.data))); if (value.bytes !== request.bytes || value.name !== request.name || value.mediaType !== request.mediaType) throw new TaskError("CONFLICT", "Upload command changed"); return { uploadId: String(prior.id), chunkBytes: 24576, completed: value.content[0] }; }
      if (this.incoming.size >= 16 || Number(this.db.prepare("SELECT COUNT(*) AS count FROM steward_uploads WHERE json_extract(data,'$.messageId') IS NULL").get()?.count) >= 64) throw new TaskError("LIMIT", "At most sixteen attachment uploads may be staged");
      const id = randomUUID();
      this.incoming.set(id, { conversationId: request.conversationId, bytes: request.bytes, name: request.name, ...(request.mediaType ? { mediaType: request.mediaType } : {}), chunks: [], received: 0, touched: Date.now() });
      this.db.prepare("INSERT INTO steward_uploads VALUES(?,?,?,?,?)").run(id, request.commandId, request.conversationId, canonical({ conversationId: request.conversationId, bytes: request.bytes, name: request.name, ...(request.mediaType ? { mediaType: request.mediaType } : {}), content: [], messageId: null }), new Date().toISOString());
      return { uploadId: id, chunkBytes: 24576 };
    }
    const row = this.db.prepare("SELECT data FROM steward_uploads WHERE id=? AND conversation=?").get(request.uploadId, request.conversationId);
    if (!row) throw new TaskError("FORBIDDEN", "Attachment upload is not owned by this conversation");
    const saved = readyUpload.parse(JSON.parse(String(row.data)));
    if (request.kind === "abort") { if (this.incoming.get(request.uploadId)?.finishing) throw new TaskError("BUSY", "Attachment storage is finishing"); if (saved.messageId) throw new TaskError("CONFLICT", "An admitted attachment cannot be removed"); this.incoming.delete(request.uploadId); this.db.prepare("DELETE FROM steward_uploads WHERE id=?").run(request.uploadId); return { aborted: true }; }
    if (saved.content.length) return request.kind === "finish" ? { receiptId: request.uploadId, content: saved.content[0] } : { nextIndex: request.index + 1, receivedBytes: saved.bytes };
    const upload = this.incoming.get(request.uploadId);
    if (!upload) throw new TaskError("UPLOAD_RESET", "The unfinished upload expired; attach the file again");
    upload.touched = Date.now();
    if (request.kind === "part") {
      const bytes = Buffer.from(request.data, "base64");
      if (bytes.toString("base64") !== request.data || !bytes.length || bytes.length > 24576) throw new TaskError("INVALID", "Attachment chunk encoding is invalid");
      const previous = upload.chunks[request.index];
      if (previous) { if (!Buffer.from(previous).equals(bytes)) throw new TaskError("CONFLICT", "A retried attachment chunk changed"); }
      else { if (request.index !== upload.chunks.length || upload.received + bytes.length > upload.bytes) throw new TaskError("INVALID", "Attachment upload order or byte count is invalid"); upload.chunks.push(bytes); upload.received += bytes.length; }
      return { nextIndex: upload.chunks.length, receivedBytes: upload.received };
    }
    if (upload.received !== upload.bytes) throw new TaskError("INVALID", "Attachment upload is incomplete");
    if (!upload.finishing) upload.finishing = (async () => {
      const content = upload.mediaType
        ? { type: "image", attachment: await files.saveImage({ data: Buffer.concat(upload.chunks), mediaType: upload.mediaType, name: upload.name }) }
        : { type: "file", attachment: await files.saveFileStream({ data: (async function* () { yield* upload.chunks; })(), name: upload.name }) };
      const parsed = stewardContent.parse([content]);
      this.db.prepare("UPDATE steward_uploads SET data=? WHERE id=?").run(canonical({ ...saved, content: parsed, ...(parsed[0]?.type === "file" ? { filePath: this.ctx.get("fs")?.processPathFromHostPath(files.fileHostPath(parsed[0].attachment) ?? "") } : {}) }), request.uploadId);
      this.incoming.delete(request.uploadId);
      return { receiptId: request.uploadId, content: parsed[0] };
    })().catch(error => { upload.finishing = undefined; throw error; });
    return upload.finishing;
  }
  authorizedFileMessages(path: string): string[] {
    const rows = this.db.prepare("SELECT data FROM steward_uploads WHERE json_extract(data,'$.filePath')=? AND json_extract(data,'$.messageId') IS NOT NULL").all(path);
    return rows.flatMap(row => {
      const value = readyUpload.parse(JSON.parse(String(row.data))), part = value.content[0];
      if (part?.type !== "file" || !value.messageId) return [];
      const host = this.storage().fileHostPath(part.attachment);
      return host && this.ctx.get("fs")?.processPathFromHostPath(host) === path ? [value.messageId] : [];
    });
  }
  resolve(conversationId: string, ids: readonly string[]): AdmittedPromptContentPart[] {
    if (!ids.length) return [];
    if (new Set(ids).size !== ids.length) throw new TaskError("INVALID", "Duplicate attachment receipt");
    let imageBytes = 0;
    const content = ids.flatMap(id => {
      const row = this.db.prepare("SELECT data FROM steward_uploads WHERE id=? AND conversation=?").get(id, conversationId);
      if (!row) throw new TaskError("FORBIDDEN", "Attachment receipt belongs to another conversation or expired");
      const value = readyUpload.parse(JSON.parse(String(row.data)));
      if (value.messageId || value.content.length !== 1) throw new TaskError("CONFLICT", "Attachment is unfinished or already admitted by another request");
      if (value.content[0]?.type === "image") imageBytes += value.bytes;
      return value.content;
    });
    const limits = this.storage().imageLimits, images = content.filter(part => part.type === "image");
    if (images.length > limits.maxImagesPerMessage || imageBytes > limits.maxMessageImageBytes) throw new TaskError("LIMIT", "Native message image limits exceeded");
    return content;
  }
  async read(part: Exclude<AdmittedPromptContentPart, { type: "text" }>, offset: number) {
    const totalBytes = part.attachment.bytes;
    if (offset > totalBytes) throw new TaskError("INVALID", "Attachment offset is outside the file");
    let data: Uint8Array;
    if (part.type === "image") data = (await this.storage().readImage(part.attachment)).data.subarray(offset, offset + 24576);
    else {
      const chunks: Uint8Array[] = []; let seen = 0, count = 0;
      for await (const chunk of this.storage().readFileStream(part.attachment)) {
        if (seen + chunk.length > offset && count < 24576) { const leaf = chunk.subarray(Math.max(0, offset - seen), Math.min(chunk.length, offset + 24576 - seen)); chunks.push(leaf); count += leaf.length; }
        seen += chunk.length;
      }
      data = Buffer.concat(chunks);
    }
    return { content: part, offset, data: Buffer.from(data).toString("base64"), totalBytes, eof: offset + data.length === totalBytes };
  }
  async unadmittedRead(conversationId: string, uploadId: string, offset: number) {
    const row = this.db.prepare("SELECT data FROM steward_uploads WHERE id=? AND conversation=?").get(uploadId, conversationId);
    if (!row) throw new TaskError("FORBIDDEN", "Attachment receipt is not owned by this conversation");
    const value = readyUpload.parse(JSON.parse(String(row.data))), part = value.content[0];
    if (value.messageId || !part || part.type === "text") throw new TaskError("CONFLICT", "Reconcile the original request before restoring this attachment");
    return this.read(part, offset);
  }
  bind(conversationId: string, ids: readonly string[], messageId: string) {
    for (const id of ids) { const result = this.db.prepare("UPDATE steward_uploads SET data=json_set(data,'$.messageId',?) WHERE id=? AND conversation=? AND json_extract(data,'$.messageId') IS NULL").run(messageId, id, conversationId); if (result.changes !== 1) throw new TaskError("CONFLICT", "Attachment was already admitted elsewhere"); }
  }
}
