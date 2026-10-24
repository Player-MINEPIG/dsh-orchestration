import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { z } from "zod";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import { MessageId, ToolCallId } from "@deepseek-ai/dsh-llm/brand";
import { createScope } from "@deepseek-ai/dsh-scope";
import { AttachmentId } from "@deepseek-ai/dsh-attachment";
import type { ImageAttachmentLimits } from "@deepseek-ai/dsh-attachment";
import type {
  FileUploadReceiptId,
  FileUploadValue,
} from "@deepseek-ai/dsh-client-file-upload";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { SessionRequestId } from "@deepseek-ai/dsh-api-session-controller";
import type {
  SessionControlFrame,
  SessionProjectionValues,
  SessionProjectionsValue,
  SessionProjectionBaseline,
  SessionFollowFrame,
  SessionPromptRequest,
  SessionPageRequest,
} from "@deepseek-ai/dsh-api-session-controller";
import type {
  WorkspaceFollowFrame,
  WorkspaceBaseline,
  WorkspaceView,
} from "@deepseek-ai/dsh-api-workspace-controller";
import type { ApprovalRequestEvent } from "@deepseek-ai/dsh-user-approval/types";
import type { AskUserQuestionRequestEvent } from "@deepseek-ai/dsh-user-questions/types";
import type {} from "@deepseek-ai/dsh-settings";
import type {} from "@deepseek-ai/dsh-user-questions";
import type {} from "@deepseek-ai/dsh-agent-preset-registry";
import type {} from "@deepseek-ai/dsh-skill";
import type {} from "@deepseek-ai/dsh-permission-presets";
import type {} from "@deepseek-ai/dsh-commands";

const key = z.string().min(1).max(200);
const uploadMaxBytes = 8 * 1024 * 1024;
const logicalFrameMaxBytes = 8 * 1024 * 1024;
const imageMetadata = z.strictObject({
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const textPart = z.strictObject({
  type: z.literal("text"),
  text: z.string().max(48 * 1024),
});
const filePart = z.strictObject({
  type: z.literal("file"),
  receiptId: key.transform((value) => brandString<FileUploadReceiptId>(value)),
});
const imagePart = z.strictObject({
  type: z.literal("image"),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  data: z.string().max(22000),
  name: z.string().max(255).optional(),
});
const uploadedImagePart = z.strictObject({
  type: z.literal("image-upload"),
  uploadId: key,
});
const promptContent = z
  .array(
    z.discriminatedUnion("type", [
      textPart,
      filePart,
      imagePart,
      uploadedImagePart,
    ]),
  )
  .min(1)
  .max(100)
  .refine(
    (parts) =>
      parts.some((part) => part.type !== "text" || part.text.trim().length > 0),
    "A prompt must contain text or an attachment",
  );
const textContent = z
  .array(textPart)
  .min(1)
  .max(100)
  .refine(
    (parts) => parts.some((part) => part.text.trim().length > 0),
    "Text must contain non-whitespace content",
  );
const windowSchema = z.strictObject({
  minMessages: z.number().int().positive().max(500),
  minTurns: z.number().int().positive().max(100),
});
const followRequest = z.strictObject({
  assistantStream: z.literal(true).optional(),
  maxMessages: z.number().int().positive().max(500).optional(),
  turnWindow: windowSchema.optional(),
});
const pageRequest = z.strictObject({
  throughSeq: sequence,
  beforeSeq: sequence.optional(),
  maxMessages: z.number().int().positive().max(500).optional(),
  turnWindow: windowSchema.optional(),
});
const questionWaitRequest = z.strictObject({ callId: key });
const queueAction = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("edit"), content: textContent }),
  z.strictObject({ kind: z.literal("remove") }),
  z.strictObject({ kind: z.literal("steer") }),
]);
const approvalOutcome = z.enum([
  "allowed-once",
  "rejected",
  "cancelled",
  "unavailable",
]);
const answerSchema = z.strictObject({
  answers: z
    .array(
      z.strictObject({
        id: key,
        selected: z.array(z.string().max(10000)).max(100),
        custom: z.string().max(20000).optional(),
      }),
    )
    .max(100),
});
const interactionOutcome = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("next") }),
  z.strictObject({ kind: z.literal("result"), value: z.unknown() }),
  z.strictObject({
    kind: z.literal("rejected"),
    error: z.strictObject({
      name: key,
      message: z.string().max(20000),
      code: key.optional(),
    }),
  }),
]);

export const ProjectSessionNativeBindingSchema = z.strictObject({
  kind: z.literal("native"),
  projectId: key,
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nodeId: key,
  sessionId: key,
  workspaceId: key,
  workspaceRevision: key,
  cwd: z.string().min(1).max(4096),
});
export type ProjectSessionNativeBinding = z.infer<
  typeof ProjectSessionNativeBindingSchema
>;
export const ProjectNativeOperation = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("native-capabilities") }),
  z.strictObject({ kind: z.literal("session-list") }),
  z.strictObject({ kind: z.literal("session-projections") }),
  z.strictObject({ kind: z.literal("session-excerpt") }),
  z.strictObject({
    kind: z.literal("session-page"),
    throughSeq: sequence,
    beforeSeq: sequence.optional(),
    maxMessages: z.number().int().positive().max(500).optional(),
    turnWindow: windowSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("session-prompt"),
    requestId: key,
    mode: z.enum(["queue", "steer"]),
    content: promptContent,
    clientTimeZone: z.string().min(1).max(200).optional(),
  }),
  z.strictObject({ kind: z.literal("session-cancel") }),
  z.strictObject({
    kind: z.literal("session-queue"),
    itemId: key,
    action: queueAction,
  }),
  z.strictObject({
    kind: z.literal("settings-describe"),
    ns: z.literal("ui-conversation"),
  }),
  z
    .strictObject({
      kind: z.literal("stream-poll"),
      stream: z.enum([
        "events",
        "access",
        "workspace",
        "session-control",
        "session-follow",
        "session-page",
        "user-question-wait",
      ]),
      cursor: z.string().min(1).max(100).optional(),
      request: z
        .union([followRequest, questionWaitRequest, pageRequest])
        .optional(),
    })
    .refine(
      (value) =>
        value.request === undefined ||
        (value.stream === "session-follow"
          ? followRequest.safeParse(value.request).success
          : value.stream === "session-page"
            ? pageRequest.safeParse(value.request).success
            : value.stream === "user-question-wait" &&
              questionWaitRequest.safeParse(value.request).success),
      "The native stream request must match its stream",
    )
    .refine(
      (value) =>
        (value.stream !== "user-question-wait" &&
          value.stream !== "session-page") ||
        value.cursor !== undefined ||
        value.request !== undefined,
      "A new history page or question wait requires its request",
    ),
  z.strictObject({
    kind: z.literal("stream-close"),
    stream: z.enum([
      "events",
      "access",
      "workspace",
      "session-control",
      "session-follow",
      "session-page",
      "user-question-wait",
    ]),
    cursor: z.string().min(1).max(100),
  }),
  z.strictObject({ kind: z.literal("model-catalog") }),
  z.strictObject({
    kind: z.literal("model-select"),
    provider: key,
    model: key,
    reasoningEffort: key.optional(),
  }),
  z.strictObject({
    kind: z.literal("file-upload-start"),
    name: z.string().min(1).max(255).optional(),
    image: imageMetadata.optional(),
    bytes: z.number().int().min(0).max(uploadMaxBytes),
  }),
  z.strictObject({
    kind: z.literal("file-upload-part"),
    uploadId: key,
    index: z.number().int().nonnegative().max(512),
    data: z.string().min(1).max(32768),
  }),
  z.strictObject({ kind: z.literal("file-upload-finish"), uploadId: key }),
  z.strictObject({ kind: z.literal("file-upload-abort"), uploadId: key }),
  z.strictObject({
    kind: z.literal("attachment-read"),
    attachmentId: key,
    offset: sequence.optional(),
    maxBytes: z.number().int().positive().max(24576).optional(),
  }),
  z.strictObject({ kind: z.literal("skills-list") }),
  z.strictObject({ kind: z.literal("permissions-catalog") }),
  z.strictObject({ kind: z.literal("commands-list") }),
  z.strictObject({
    kind: z.literal("commands-execute"),
    command: z.literal("permission"),
    preset: key,
  }),
  z.strictObject({
    kind: z.literal("user-question-answer"),
    callId: key,
    answer: answerSchema,
  }),
  z.strictObject({
    kind: z.literal("interaction-result"),
    clientId: key,
    eventId: key,
    outcome: interactionOutcome,
  }),
]);
export type ProjectNativeOperation = z.infer<typeof ProjectNativeOperation>;
export const ProjectSessionNativeOperationSchema = ProjectNativeOperation;
export type ProjectSessionNativeOperation = ProjectNativeOperation;
export type ProjectNativeJson = z.infer<ReturnType<typeof z.json>>;

type StreamName = Extract<
  ProjectNativeOperation,
  { kind: "stream-poll" }
>["stream"];
type PollResult = {
  frames: ProjectNativeJson[];
  cursor: string;
  closed?: boolean;
  framePart?: {
    id: string;
    offset: number;
    totalBytes: number;
    data: string;
    eof: boolean;
  };
};
type InteractionResolution =
  | { kind: "next" }
  | { kind: "result"; value: unknown };
type PendingInteraction = {
  event: "approval/request" | "user-questions/request";
  request: ApprovalRequestEvent | AskUserQuestionRequestEvent;
  settle(value: InteractionResolution): void;
  reject(error: Error): void;
};
interface StreamState {
  readonly id: string;
  readonly binding: string;
  readonly stream: StreamName;
  readonly abort: AbortController;
  readonly iterator: AsyncIterator<unknown>;
  readonly cached: Map<string, PollResult>;
  next: number;
  touchedAt: number;
  pending?: Promise<IteratorResult<unknown>>;
  polling?: Promise<PollResult>;
  expiry?: ReturnType<typeof setTimeout>;
  frame?: { id: string; bytes: Buffer; offset: number };
}
type ScopedServices = <K extends string & keyof Context>(
  name: K,
) => Context[K] | undefined;
interface UploadState {
  readonly binding: string;
  readonly id: string;
  readonly name: string | undefined;
  readonly image: z.infer<typeof imageMetadata> | undefined;
  readonly bytes: number;
  readonly abort: AbortController;
  readonly chunks: Uint8Array[];
  phase: "receiving" | "finishing" | "completed" | "failed";
  receivedBytes: number;
  expiry?: ReturnType<typeof setTimeout>;
  result?: Promise<FileUploadValue>;
}
interface EventState {
  readonly binding: string;
  readonly clientId: string;
  readonly queue: AsyncQueue;
  readonly pending: Map<string, PendingInteraction>;
  readonly disposers: (() => void)[];
}
export interface ProjectNativeOwnerOptions {
  readonly ctx: Context;
  readonly authorizeBinding: (
    binding: ProjectSessionNativeBinding,
    access: "read" | "write",
  ) => Promise<void>;
  readonly withAgent: <T>(
    binding: ProjectSessionNativeBinding,
    operation: (agent: Agent) => Promise<T>,
  ) => Promise<T>;
  readonly maxBytes?: number;
  readonly pollWaitMs?: number;
}
export class ProjectSessionNativeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectSessionNativeError";
  }
}

class AsyncQueue implements AsyncIterable<unknown> {
  private readonly values: unknown[] = [];
  private wake?: () => void;
  private closed = false;
  private failure?: Error;
  push(value: unknown): void {
    if (this.closed) return;
    if (this.values.length >= 128) {
      this.failure = new ProjectSessionNativeError(
        "STREAM_OVERFLOW",
        "Native event consumer fell behind; reopen the stream",
      );
      this.values.length = 0;
      this.end();
      return;
    }
    this.values.push(value);
    this.wake?.();
  }
  end(): void {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    while (!this.closed || this.values.length) {
      if (!this.values.length) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = undefined;
        continue;
      }
      yield this.values.shift();
    }
    if (this.failure) throw this.failure;
  }
}

function bindingKey(binding: ProjectSessionNativeBinding): string {
  return JSON.stringify(binding);
}
export function projectNativeOperationWrites(
  operation: ProjectNativeOperation,
): boolean {
  return (
    operation.kind === "session-prompt" ||
    operation.kind === "session-cancel" ||
    operation.kind === "session-queue" ||
    operation.kind === "commands-execute" ||
    operation.kind === "interaction-result" ||
    operation.kind === "user-question-answer" ||
    operation.kind === "model-select" ||
    operation.kind.startsWith("file-upload-") ||
    (operation.kind === "stream-poll" &&
      operation.stream === "user-question-wait")
  );
}
function json(value: unknown): ProjectNativeJson {
  return z.json().parse(JSON.parse(JSON.stringify(value)));
}
function error(code: string, message: string): never {
  throw new ProjectSessionNativeError(code, message);
}

export class ProjectNativeOwner {
  private readonly streams = new Map<string, StreamState>();
  private readonly uploads = new Map<string, UploadState>();
  private readonly events = new Map<string, EventState>();
  private readonly maxBytes: number;
  private readonly pollWaitMs: number;
  constructor(private readonly options: ProjectNativeOwnerOptions) {
    this.maxBytes = options.maxBytes ?? 48 * 1024;
    this.pollWaitMs = options.pollWaitMs ?? 50;
    if (
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1024 ||
      this.maxBytes > 48 * 1024
    )
      error(
        "INVALID_BUDGET",
        "Native result budget must be between 1024 and 49152 bytes",
      );
    if (
      !Number.isFinite(this.pollWaitMs) ||
      this.pollWaitMs < 0 ||
      this.pollWaitMs > 1000
    )
      error(
        "INVALID_POLL_WAIT",
        "Native poll wait must be between 0 and 1000 ms",
      );
  }
  async invoke(
    rawBinding: ProjectSessionNativeBinding,
    rawOperation: ProjectNativeOperation,
    _commandId: string,
  ): Promise<ProjectNativeJson> {
    const binding = ProjectSessionNativeBindingSchema.parse(rawBinding);
    const operation = ProjectNativeOperation.parse(rawOperation);
    this.checkSize({ binding, operation }, "REQUEST_TOO_LARGE");
    const access = projectNativeOperationWrites(operation) ? "write" : "read";
    await this.options.authorizeBinding(binding, access);
    this.prune();
    const ctx = this.options.ctx;
    const sessionId = SessionId(binding.sessionId);
    const signal = new AbortController().signal;
    let result: unknown;
    switch (operation.kind) {
      case "native-capabilities":
        result = await this.capabilities(binding);
        break;
      case "session-list":
        result = {
          items: (await ctx.sessionController.list({}, signal)).items
            .filter((item) => item.sessionId === sessionId)
            .map((item) =>
              item.projections
                ? {
                    ...item,
                    projections: {
                      ...item.projections,
                      values: this.projectionValues(item.projections.values),
                    },
                  }
                : item,
            ),
        };
        break;
      case "session-projections":
        result = this.projectionResult(
          await ctx.sessionController.projections({ sessionId }, signal),
        );
        break;
      case "session-excerpt": result = await this.excerpt(sessionId, signal); break;
      case "session-page": {
        const { kind: _, ...request } = operation;
        result = await ctx.sessionController.page(
          { ...request, address: { kind: "session", sessionId } },
          signal,
        );
        break;
      }
      case "session-prompt": {
        const { kind: _, requestId, ...request } = operation;
        const images = request.content.filter(
          (part) => part.type === "image" || part.type === "image-upload",
        );
        if (
          images.length > 1 ||
          images.some(
            (part) =>
              part.type === "image" &&
              this.decode(part.data).byteLength > uploadMaxBytes,
          )
        )
          error(
            "IMAGE_LIMIT",
            "Project native images are limited to one image and 8 MiB per message",
          );
        const content = await Promise.all(
          request.content.map((part) =>
            part.type === "image-upload"
              ? this.uploadedImage(binding, part.uploadId)
              : part,
          ),
        );
        result = await ctx.sessionController.prompt(
          {
            ...request,
            content,
            requestId: brandString<SessionRequestId>(requestId),
            sessionId,
          },
          signal,
        );
        break;
      }
      case "session-cancel":
        result = ctx.sessionController.cancel({ sessionId });
        break;
      case "session-queue":
        result = await ctx.sessionController.updateQueue({
          sessionId,
          itemId: MessageId(operation.itemId),
          action: operation.action,
        });
        break;
      case "settings-describe":
        result = {
          writable: false,
          hasDocument: false,
          namespaces: (
            ctx.get("settings")?.describe({ redactSecrets: true }) ?? []
          )
            .filter((item) => item.ns === operation.ns)
            .map((item) => ({
              ...item,
              ns: String(item.ns),
              secrets: item.secrets ?? [],
            })),
        };
        break;
      case "stream-poll":
        result = await this.poll(binding, operation);
        break;
      case "stream-close":
        this.closeCursor(binding, operation.stream, operation.cursor);
        result = { closed: true };
        break;
      case "model-catalog":
        result = await ctx.sessionController.modelCatalog();
        break;
      case "model-select": {
        const { kind: _, ...selection } = operation;
        result = await ctx.sessionController.selectModel({
          ...selection,
          sessionId,
        });
        break;
      }
      case "file-upload-start":
        result = this.beginUpload(binding, operation);
        break;
      case "file-upload-part":
        result = this.uploadPart(binding, operation);
        break;
      case "file-upload-finish":
        result = await this.finishUpload(binding, operation.uploadId);
        break;
      case "file-upload-abort": {
        const upload = this.uploadFor(binding, operation.uploadId);
        upload.abort.abort();
        this.removeUpload(upload);
        result = { aborted: true };
        break;
      }
      case "attachment-read": {
        const value = await ctx.sessionController.attachment({
          sessionId,
          attachmentId: AttachmentId(operation.attachmentId),
        });
        const bytes = this.decode(value.data);
        const offset = operation.offset ?? 0;
        if (offset > bytes.byteLength)
          error(
            "INVALID_OFFSET",
            "Attachment offset exceeds its exact byte length",
          );
        const end = Math.min(
          bytes.byteLength,
          offset + (operation.maxBytes ?? 24576),
        );
        result = {
          attachment: value.attachment,
          data: Buffer.from(bytes.subarray(offset, end)).toString("base64"),
          offset,
          totalBytes: bytes.byteLength,
          eof: end === bytes.byteLength,
        };
        break;
      }
      case "skills-list": {
        const catalog = ctx.get("sessionSkillCatalog");
        if (!catalog)
          error("UNSUPPORTED", "Owner session skill catalog is unavailable");
        result = await catalog.list({ sessionId }, signal);
        break;
      }
      case "permissions-catalog": {
        result = await this.readServices(binding, async (service) => {
          const permissions = service("permissionPresets");
          if (!permissions)
            error(
              "UNSUPPORTED",
              "Owner session permission presets are unavailable",
            );
          return permissions.catalog();
        });
        break;
      }
      case "commands-list":
        {
          const agent = ctx.agents.get(sessionId);
          result = agent ? this.permissionCommands(agent) : [];
        }
        break;
      case "commands-execute":
        result = await this.options.withAgent(binding, async (agent) => {
          const commands = this.service(agent, "commands");
          const descriptor = this.permissionCommands(agent)[0];
          if (!commands || !descriptor)
            error(
              "UNSUPPORTED",
              "Owner session permission command is unavailable",
            );
          const permissions = this.service(agent, "permissionPresets");
          if (!permissions?.names.includes(operation.preset))
            error(
              "INVALID_PRESET",
              "The permission preset is not available on this owner session",
            );
          return (
            (await commands.execute(
              agent,
              `/permission ${operation.preset}`,
              [],
              signal,
            )) ??
            error(
              "UNSUPPORTED",
              "Owner session permission command is unavailable",
            )
          );
        });
        break;
      case "user-question-answer": {
        if (!ctx.agents.get(sessionId)) {
          const projected = await ctx.sessionController.projections(
            { sessionId },
            signal,
          );
          if (
            !projected?.values.userQuestions?.active.some(
              (question) =>
                question.callId === operation.callId &&
                question.state === "continued",
            )
          ) {
            result = false;
            break;
          }
        }
        result = await this.options.withAgent(binding, async (agent) => {
          const questions = this.service(agent, "userQuestions");
          if (!questions)
            error("UNSUPPORTED", "Owner user question service is unavailable");
          return questions.answer(
            agent,
            ToolCallId(operation.callId),
            operation.answer,
          );
        });
        break;
      }
      case "interaction-result":
        result = this.answer(binding, operation);
        break;
    }
    const value = json(result);
    this.checkSize(value, "RESULT_TOO_LARGE");
    return value;
  }
  dispose(): void {
    for (const stream of [...this.streams.values()]) this.close(stream);
    for (const upload of [...this.uploads.values()]) {
      upload.abort.abort();
      this.removeUpload(upload);
    }
  }
  private checkSize(value: unknown, code: string): void {
    if (Buffer.byteLength(JSON.stringify(value)) > this.maxBytes)
      error(
        code,
        "Native value exceeds the bound transport budget; request a smaller history window or restart the stream",
      );
  }
  private imageLimits(limits: ImageAttachmentLimits) {
    return {
      ...limits,
      mediaTypes: [...limits.mediaTypes],
      maxImageBytes: Math.min(limits.maxImageBytes, uploadMaxBytes),
      maxMessageImageBytes: Math.min(
        limits.maxMessageImageBytes,
        uploadMaxBytes,
      ),
      maxImagesPerMessage: Math.min(limits.maxImagesPerMessage, 1),
    };
  }
  private projectionValues(
    values: SessionProjectionValues,
  ): SessionProjectionValues {
    return values.imageLimits
      ? Object.assign({}, values, {
          imageLimits: this.imageLimits(values.imageLimits),
        })
      : values;
  }
  private projectionBaseline(
    value: SessionProjectionBaseline,
  ): SessionProjectionBaseline {
    return { ...value, values: this.projectionValues(value.values) };
  }
  private async excerpt(sessionId: SessionId, signal: AbortSignal) {
    const ctx = this.options.ctx;
    const projection = await ctx.sessionController.projections({ sessionId }, signal);
    if (!projection || projection.kind !== "sequenced") error("UNAVAILABLE", "An exact ordinary session cut is unavailable");
    const asOfSeq = projection.asOfSeq;
    const page = asOfSeq < 0 ? { records: [], hasMore: false } : await ctx.sessionController.page({ address: { kind: "session", sessionId }, throughSeq: asOfSeq, maxMessages: 16 }, signal);
    const message = z.object({ role: z.enum(["user", "assistant"]), source: z.object({ kind: z.string() }).passthrough(), content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()) }).passthrough();
    const rows: string[] = [];
    for (const record of page.records) {
      const event = record.event;
      let value: unknown;
      if (event.type === "user/message") value = event.data;
      else if (event.type === "assistant/message") value = z.object({ message: z.unknown() }).passthrough().parse(event.data).message;
      else continue;
      const parsed = message.safeParse(value);
      if (!parsed.success || !["user", "model", "dsh-task-result"].includes(parsed.data.source.kind)) continue;
      const text = parsed.data.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
      if (text) rows.push(`[${parsed.data.role}] ${text}`);
    }
    const all = Array.from(rows.join("\n")), maximum = Math.min(all.length, 12000);
    let low = 0, high = maximum;
    while (low < high) {
      const count = Math.ceil((low + high) / 2), summary = all.slice(all.length - count).join("");
      if (Buffer.byteLength(JSON.stringify({ asOfSeq, summary, truncated: page.hasMore || count < all.length })) <= 12 * 1024) low = count;
      else high = count - 1;
    }
    return { asOfSeq, summary: all.slice(all.length - low).join(""), truncated: page.hasMore || low < all.length };
  }
  private projectionResult(
    value: SessionProjectionsValue,
  ): SessionProjectionsValue {
    return value === null
      ? null
      : { ...value, values: this.projectionValues(value.values) };
  }
  private async *follow(
    source: AsyncIterable<SessionFollowFrame>,
  ): AsyncGenerator<SessionFollowFrame> {
    for await (const frame of source)
      yield frame.type === "snapshot"
        ? { ...frame, projections: this.projectionBaseline(frame.projections) }
        : frame;
  }
  private decode(data: string): Uint8Array {
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data)
      error(
        "INVALID_BASE64",
        "Native attachment bytes must use canonical base64",
      );
    return bytes;
  }
  private beginUpload(
    binding: ProjectSessionNativeBinding,
    operation: Extract<ProjectNativeOperation, { kind: "file-upload-start" }>,
  ): unknown {
    if (!this.options.ctx.get("fileUploads"))
      error("UNSUPPORTED", "The owner has no native file upload service");
    if (
      [...this.uploads.values()].filter(
        (upload) =>
          upload.phase === "receiving" || upload.phase === "finishing",
      ).length >= 2 ||
      this.uploads.size >= 16
    )
      error("UPLOAD_LIMIT", "At most two project native uploads may be active");
    const upload: UploadState = {
      id: randomUUID(),
      binding: bindingKey(binding),
      name: operation.name,
      image: operation.image,
      bytes: operation.bytes,
      receivedBytes: 0,
      abort: new AbortController(),
      chunks: [],
      phase: "receiving",
    };
    this.uploads.set(upload.id, upload);
    this.touchUpload(upload);
    return {
      uploadId: upload.id,
      chunkBytes: 24576,
      maxBytes: uploadMaxBytes,
    };
  }
  private uploadFor(
    binding: ProjectSessionNativeBinding,
    id: string,
  ): UploadState {
    const upload = this.uploads.get(id);
    if (!upload || upload.binding !== bindingKey(binding))
      error(
        "UPLOAD_RESET",
        "The native upload belongs to another binding or is no longer available",
      );
    this.touchUpload(upload);
    return upload;
  }
  private touchUpload(upload: UploadState): void {
    if (upload.expiry !== undefined) clearTimeout(upload.expiry);
    upload.expiry = setTimeout(() => {
      upload.abort.abort();
      this.removeUpload(upload);
    }, 120000);
    upload.expiry.unref();
  }
  private removeUpload(upload: UploadState): void {
    this.uploads.delete(upload.id);
    if (upload.expiry !== undefined) clearTimeout(upload.expiry);
    upload.chunks.length = 0;
  }
  private uploadPart(
    binding: ProjectSessionNativeBinding,
    operation: Extract<ProjectNativeOperation, { kind: "file-upload-part" }>,
  ): unknown {
    const upload = this.uploadFor(binding, operation.uploadId);
    if (upload.phase !== "receiving")
      error("UPLOAD_FINISHING", "The upload is no longer accepting chunks");
    const bytes = this.decode(operation.data);
    if (!bytes.byteLength || bytes.byteLength > 24576)
      error(
        "UPLOAD_PART_LIMIT",
        "Native upload chunks must contain between one byte and 24 KiB",
      );
    const previous = upload.chunks[operation.index];
    if (previous) {
      if (!Buffer.from(previous).equals(bytes))
        error(
          "UPLOAD_PART_CONFLICT",
          "A retried upload chunk has different bytes",
        );
    } else {
      if (operation.index !== upload.chunks.length)
        error(
          "UPLOAD_PART_ORDER",
          "Native upload chunks must arrive in contiguous index order",
        );
      if (upload.receivedBytes + bytes.byteLength > upload.bytes)
        error(
          "UPLOAD_SIZE",
          "The native upload exceeds its declared byte count",
        );
      upload.chunks.push(bytes);
      upload.receivedBytes += bytes.byteLength;
    }
    return {
      accepted: true,
      nextIndex: upload.chunks.length,
      receivedBytes: upload.receivedBytes,
    };
  }
  private async finishUpload(
    binding: ProjectSessionNativeBinding,
    id: string,
  ): Promise<FileUploadValue> {
    const upload = this.uploadFor(binding, id);
    if (upload.result) return upload.result;
    if (upload.receivedBytes !== upload.bytes)
      error(
        "UPLOAD_INCOMPLETE",
        "All declared native upload bytes must arrive before finishing",
      );
    const files = this.options.ctx.get("fileUploads");
    if (!files)
      error("UNSUPPORTED", "The owner has no native file upload service");
    if (upload.image?.sha256) {
      const hash = createHash("sha256");
      for (const chunk of upload.chunks) hash.update(chunk);
      if (hash.digest("hex") !== upload.image.sha256)
        error("UPLOAD_DIGEST", "Image bytes do not match the declared SHA-256");
    }
    upload.phase = "finishing";
    const chunks = upload.chunks.slice();
    upload.result = files
      .uploadStream({
        sessionId: SessionId(binding.sessionId),
        name: upload.name,
        signal: upload.abort.signal,
        data: (async function* () {
          for (const chunk of chunks) {
            upload.abort.signal.throwIfAborted();
            yield chunk;
          }
        })(),
      })
      .then(
        (value) => {
          upload.phase = "completed";
          upload.chunks.length = 0;
          return value;
        },
        (failure) => {
          upload.phase = "failed";
          upload.chunks.length = 0;
          throw failure;
        },
      );
    return upload.result;
  }
  private async uploadedImage(
    binding: ProjectSessionNativeBinding,
    id: string,
  ): Promise<
    Extract<SessionPromptRequest["content"][number], { type: "image" }>
  > {
    const upload = this.uploadFor(binding, id);
    if (!upload.image || upload.phase !== "completed" || !upload.result)
      error("IMAGE_UPLOAD_INCOMPLETE", "A completed image upload is required");
    const metadata = upload.image;
    const receipt = await upload.result;
    return this.options.withAgent(binding, async (agent) => {
      const ctx = this.options.ctx;
      const file = ctx.get("fileUploads")?.resolve(agent, receipt.receiptId);
      if (
        !file ||
        file.bytes !== upload.bytes ||
        (metadata.sha256 && file.attachmentId !== `sha256:${metadata.sha256}`)
      )
        error(
          "IMAGE_UPLOAD_INVALID",
          "The image receipt or metadata is no longer valid",
        );
      const chunks: Uint8Array[] = [];
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of ctx.attachments.readFileStream(
        file,
        upload.abort.signal,
      )) {
        bytes += chunk.byteLength;
        if (bytes > upload.bytes || bytes > uploadMaxBytes)
          error("IMAGE_LIMIT", "Stored image exceeds its declared byte count");
        hash.update(chunk);
        chunks.push(chunk);
      }
      if (
        bytes !== upload.bytes ||
        `sha256:${hash.digest("hex")}` !== file.attachmentId
      )
        error(
          "UPLOAD_DIGEST",
          "Stored image bytes do not match the upload metadata",
        );
      return {
        type: "image",
        mediaType: metadata.mediaType,
        data: Buffer.concat(chunks).toString("base64"),
        name: upload.name,
      };
    });
  }
  private service<K extends string & keyof Context>(
    agent: Agent,
    name: K,
  ): Context[K] | undefined {
    return (
      this.options.ctx.get("agentPresets")?.serviceFor(agent, name) ??
      agent.ctx.get(name)
    );
  }
  private permissionCommands(agent: Agent) {
    return (this.service(agent, "commands")?.list(agent) ?? []).filter(
      (command) =>
        command.name === "permission" &&
        command.definitionId === "@deepseek-ai/dsh-permission-presets",
    );
  }
  private async poll(
    binding: ProjectSessionNativeBinding,
    operation: Extract<ProjectNativeOperation, { kind: "stream-poll" }>,
  ): Promise<PollResult> {
    let state: StreamState;
    let cursor = operation.cursor;
    if (cursor) {
      state = this.stateFor(binding, operation.stream, cursor);
      const cached = state.cached.get(cursor);
      if (cached) return cached;
      if (cursor !== `${state.id}:${state.next}`)
        error(
          "STREAM_CURSOR_EXPIRED",
          "Native poll cursor is stale; reopen the stream",
        );
    } else {
      if (this.streams.size >= 32)
        error("STREAM_LIMIT", "Too many active project native streams");
      const abort = new AbortController();
      const id = randomUUID();
      const source = await this.open(binding, operation, abort.signal, id);
      state = {
        id,
        binding: bindingKey(binding),
        stream: operation.stream,
        abort,
        iterator: source[Symbol.asyncIterator](),
        cached: new Map(),
        next: 0,
        touchedAt: Date.now(),
      };
      this.streams.set(id, state);
      cursor = `${id}:0`;
    }
    state.touchedAt = Date.now();
    if (state.expiry !== undefined) clearTimeout(state.expiry);
    state.expiry = setTimeout(() => this.close(state), 120000);
    state.expiry.unref();
    if (state.polling) return state.polling;
    const activeCursor = cursor;
    state.polling = this.readPoll(state)
      .then((result) => {
        state.cached.set(activeCursor, result);
        while (state.cached.size > 8) {
          const oldest = state.cached.keys().next().value;
          if (oldest !== undefined) state.cached.delete(oldest);
        }
        return result;
      })
      .finally(() => {
        state.polling = undefined;
      });
    return state.polling;
  }
  private async readPoll(state: StreamState): Promise<PollResult> {
    const result: PollResult = {
      frames: [],
      cursor: `${state.id}:${state.next + 1}`,
    };
    if (state.frame) {
      this.framePart(state, result);
      state.next++;
      return result;
    }
    state.pending ??= state.iterator.next();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = Symbol("poll-timeout");
    try {
      const next = await Promise.race([
        state.pending,
        new Promise<typeof timeout>((resolve) => {
          timer = setTimeout(() => resolve(timeout), this.pollWaitMs);
        }),
      ]);
      if (next !== timeout) {
        state.pending = undefined;
        if (next.done) result.closed = true;
        else {
          const frame = json(next.value);
          result.frames.push(frame);
          if (Buffer.byteLength(JSON.stringify(result)) > this.maxBytes) {
            const bytes = Buffer.from(JSON.stringify(frame));
            if (bytes.byteLength > logicalFrameMaxBytes)
              error("FRAME_TOO_LARGE", "Native logical frame exceeds 8 MiB");
            state.frame = { id: randomUUID(), bytes, offset: 0 };
            result.frames.length = 0;
            this.framePart(state, result);
          }
        }
      }
      state.next++;
      return result;
    } catch (failure) {
      this.close(state);
      throw failure;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  private framePart(state: StreamState, result: PollResult): void {
    const frame = state.frame;
    if (!frame) error("STREAM_RESET", "Native frame is no longer available");
    const offset = frame.offset;
    const bytes = Math.min(24576, Math.floor(((this.maxBytes - 512) * 3) / 4));
    const end = Math.min(offset + bytes, frame.bytes.byteLength);
    result.framePart = {
      id: frame.id,
      offset,
      totalBytes: frame.bytes.byteLength,
      data: frame.bytes.subarray(offset, end).toString("base64"),
      eof: end === frame.bytes.byteLength,
    };
    this.checkSize(result, "FRAME_TOO_LARGE");
    if (result.framePart.eof) state.frame = undefined;
    else frame.offset = end;
  }
  private stateFor(
    binding: ProjectSessionNativeBinding,
    stream: StreamName,
    cursor: string,
  ): StreamState {
    const id = cursor.slice(0, cursor.lastIndexOf(":"));
    const state = this.streams.get(id);
    if (
      !state ||
      state.binding !== bindingKey(binding) ||
      state.stream !== stream
    )
      error(
        "STREAM_RESET",
        "Native stream belongs to another binding or is no longer available",
      );
    return state;
  }
  private closeCursor(
    binding: ProjectSessionNativeBinding,
    stream: StreamName,
    cursor: string,
  ): void {
    this.close(this.stateFor(binding, stream, cursor));
  }
  private close(state: StreamState): void {
    state.abort.abort();
    this.streams.delete(state.id);
    state.frame = undefined;
    if (state.expiry !== undefined) clearTimeout(state.expiry);
    const events = this.events.get(state.id);
    if (events) {
      this.events.delete(state.id);
      events.queue.end();
      for (const pending of events.pending.values())
        pending.settle({ kind: "next" });
      for (const dispose of events.disposers) dispose();
    }
    void state.iterator.return?.().catch(() => {});
  }
  private prune(): void {
    for (const state of this.streams.values())
      if (Date.now() - state.touchedAt > 120000) this.close(state);
  }
  private async open(
    binding: ProjectSessionNativeBinding,
    operation: Extract<ProjectNativeOperation, { kind: "stream-poll" }>,
    signal: AbortSignal,
    id: string,
  ): Promise<AsyncIterable<unknown>> {
    const ctx = this.options.ctx;
    switch (operation.stream) {
      case "session-page": {
        const request = pageRequest.parse(operation.request);
        const nativeRequest = {
          ...request,
          address: {
            kind: "session",
            sessionId: SessionId(binding.sessionId),
          } satisfies SessionPageRequest["address"],
        };
        return (async function* () {
          yield await ctx.sessionController.page(nativeRequest, signal);
        })();
      }
      case "session-follow":
        return this.follow(
          ctx.sessionController.follow(
            {
              ...followRequest.parse(operation.request ?? {}),
              address: {
                kind: "session",
                sessionId: SessionId(binding.sessionId),
              },
            },
            signal,
          ),
        );
      case "session-control":
        return this.control(binding, ctx.sessionController.control(signal));
      case "workspace": {
        const controller = ctx.get("workspaceController");
        if (!controller)
          error("UNSUPPORTED", "Owner workspace stream is unavailable");
        return this.workspace(binding, controller.follow(signal));
      }
      case "user-question-wait": {
        const agent = ctx.agents.get(SessionId(binding.sessionId));
        if (!agent) return (async function* () {})();
        const questions = this.service(agent, "userQuestions");
        if (!questions)
          error("UNSUPPORTED", "Owner user question service is unavailable");
        return questions.attachWait(
          agent,
          ToolCallId(questionWaitRequest.parse(operation.request).callId),
          signal,
        );
      }
      case "access":
        return this.access(binding, signal);
      case "events":
        return this.eventStream(binding, signal, id);
    }
  }
  private async *control(
    binding: ProjectSessionNativeBinding,
    source: AsyncIterable<SessionControlFrame>,
  ): AsyncGenerator<unknown> {
    for await (const frame of source) {
      if (frame.type === "baseline") {
        const value = frame.value.projections[SessionId(binding.sessionId)];
        yield {
          type: "baseline",
          value: {
            projections:
              value === undefined
                ? {}
                : { [binding.sessionId]: this.projectionBaseline(value) },
          },
        };
      } else if (frame.sessionId === binding.sessionId)
        yield frame.key === "imageLimits"
          ? {
              ...frame,
              value: json(
                this.imageLimits(
                  z
                    .object({
                      maxImageBytes: z.number(),
                      maxImagesPerMessage: z.number(),
                      maxMessageImageBytes: z.number(),
                      maxImagePixels: z.number(),
                      maxImageDimension: z.number(),
                      mediaTypes: z.array(
                        z.enum([
                          "image/png",
                          "image/jpeg",
                          "image/webp",
                          "image/gif",
                        ]),
                      ),
                    })
                    .parse(frame.value),
                ),
              ),
            }
          : frame;
    }
  }
  private scopedWorkspace(
    binding: ProjectSessionNativeBinding,
    value: WorkspaceView,
  ): WorkspaceView | undefined {
    if (value.workspaceId !== binding.workspaceId) return undefined;
    if (value.path !== binding.cwd)
      error(
        "BINDING_CHANGED",
        "Owner workspace directory no longer matches the authorized binding",
      );
    return {
      ...value,
      sessionIds: value.sessionIds.filter((id) => id === binding.sessionId),
    };
  }
  private workspaceBaseline(
    binding: ProjectSessionNativeBinding,
    baseline: WorkspaceBaseline,
  ): unknown {
    return {
      items: baseline.items.flatMap((value) => {
        const row = this.scopedWorkspace(binding, value);
        return row ? [row] : [];
      }),
      archivedSessionIds: baseline.archivedSessionIds.filter(
        (id) => id === binding.sessionId,
      ),
      pinnedSessionIds: baseline.pinnedSessionIds.filter(
        (id) => id === binding.sessionId,
      ),
    };
  }
  private async *workspace(
    binding: ProjectSessionNativeBinding,
    source: AsyncIterable<WorkspaceFollowFrame>,
  ): AsyncGenerator<unknown> {
    for await (const frame of source)
      switch (frame.type) {
        case "baseline":
        case "replace":
          yield {
            type: frame.type,
            value: this.workspaceBaseline(binding, frame.value),
          };
          break;
        case "upsert": {
          const workspace = this.scopedWorkspace(binding, frame.workspace);
          if (workspace) yield { type: "upsert", workspace };
          break;
        }
        case "remove":
          if (frame.workspaceId === binding.workspaceId) yield frame;
          break;
        case "order":
          yield {
            ...frame,
            workspaceIds: frame.workspaceIds.filter(
              (id) => id === binding.workspaceId,
            ),
          };
          break;
        case "archived":
          yield {
            ...frame,
            archivedSessionIds: frame.archivedSessionIds.filter(
              (id) => id === binding.sessionId,
            ),
          };
          break;
        case "pinned":
          yield {
            ...frame,
            pinnedSessionIds: frame.pinnedSessionIds.filter(
              (id) => id === binding.sessionId,
            ),
          };
          break;
      }
  }
  private async readServices<T>(
    binding: ProjectSessionNativeBinding,
    operation: (service: ScopedServices) => Promise<T>,
  ): Promise<T> {
    const ctx = this.options.ctx;
    const live = ctx.agents.get(SessionId(binding.sessionId));
    if (live) return operation((name) => this.service(live, name));
    const presets = ctx.get("agentPresets");
    if (!presets) return operation((name) => ctx.get(name));
    const inspection = await ctx.sessionController.inspect(
      SessionId(binding.sessionId),
    );
    const lease = await presets.acquireScope(inspection.meta.agentPreset);
    const scope = createScope(ctx, {}, { parent: lease.key });
    try {
      return await operation(
        (name) => presets.serviceFor(scope, name) ?? ctx.get(name),
      );
    } finally {
      await scope.dispose();
      await lease[Symbol.asyncDispose]();
    }
  }
  private async capabilities(binding: ProjectSessionNativeBinding) {
    return this.readServices(binding, async (service) => ({
      approval: true,
      userQuestions: true,
      timedQuestions: true,
      commands:
        service("commands") !== undefined &&
        service("permissionPresets") !== undefined,
      permissions: service("permissionPresets") !== undefined,
      skills:
        service("skills") !== undefined &&
        service("sessionSkillCatalog") !== undefined,
      modelCatalog: true,
      modelSelect: true,
      files: service("fileUploads") !== undefined,
      uploadMaxBytes,
      imageMaxBytes: uploadMaxBytes,
    }));
  }
  private async *access(
    binding: ProjectSessionNativeBinding,
    signal: AbortSignal,
  ): AsyncGenerator<unknown> {
    let writable = true;
    try {
      await this.options.authorizeBinding(binding, "write");
    } catch {
      writable = false;
    }
    const capabilities = await this.capabilities(binding);
    yield {
      type: "baseline",
      owner: false,
      grants: [
        {
          resource: { kind: "session", id: binding.sessionId },
          actions: [
            "session/page",
            "session/projections",
            "session/follow",
            "session/attachment",
            ...(capabilities.skills ? ["skills/list"] : []),
            ...(capabilities.commands ? ["commands/list"] : []),
            ...(writable
              ? [
                  "session/prompt",
                  "session/cancel",
                  "session/updateQueue",
                  "session/selectModel",
                  ...(capabilities.files ? ["fileUploads/upload"] : []),
                  ...(capabilities.commands ? ["commands/execute"] : []),
                  ...(capabilities.userQuestions
                    ? ["userQuestions/answer", "userQuestions/attachWait"]
                    : []),
                ]
              : []),
          ],
        },
        {
          resource: { kind: "global" },
          actions: [
            "session/list",
            "session/control",
            "settings/describe",
            "remoteAccess/follow",
            "workspace/follow",
            "session/modelCatalog",
            ...(capabilities.permissions ? ["permissionPresets/catalog"] : []),
          ],
        },
      ],
    };
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  private async eventStream(
    binding: ProjectSessionNativeBinding,
    signal: AbortSignal,
    id: string,
  ): Promise<AsyncIterable<unknown>> {
    const state: EventState = {
      binding: bindingKey(binding),
      clientId: id,
      queue: new AsyncQueue(),
      pending: new Map(),
      disposers: [],
    };
    const ctx = this.options.ctx;
    state.queue.push({
      type: "ready",
      clientId: id,
      host: { home: homedir() },
    });
    this.events.set(id, state);
    const safePush = (value: unknown) => state.queue.push(value);
    state.disposers.push(
      ctx.on("api-session/added", (summary) => {
        if (summary.sessionId === binding.sessionId)
          safePush({
            type: "emit",
            event: "api-session/added",
            args: [
              summary.projections
                ? {
                    ...summary,
                    projections: {
                      ...summary.projections,
                      values: this.projectionValues(summary.projections.values),
                    },
                  }
                : summary,
            ],
          });
      }),
      ctx.on("api-session/status", (sessionId, running) => {
        if (sessionId === binding.sessionId)
          safePush({
            type: "emit",
            event: "api-session/status",
            args: [sessionId, running],
          });
      }),
      ctx.on("api-session/activity", (sessionId, updatedAt) => {
        if (sessionId === binding.sessionId)
          safePush({
            type: "emit",
            event: "api-session/activity",
            args: [sessionId, updatedAt],
          });
      }),
      ctx.on("api-session/removed", (sessionId) => {
        if (sessionId === binding.sessionId)
          safePush({
            type: "emit",
            event: "api-session/removed",
            args: [sessionId],
          });
      }),
      ctx.on("api-session/error", (sessionId, message) => {
        if (sessionId === binding.sessionId)
          safePush({
            type: "emit",
            event: "api-session/error",
            args: [sessionId, message],
          });
      }),
    );
    const attached = new WeakSet<Agent>();
    const attach = (agent: Agent) => {
      if (
        agent.id !== binding.sessionId ||
        ctx.agents.get(SessionId(binding.sessionId)) !== agent ||
        attached.has(agent)
      )
        return;
      attached.add(agent);
      state.disposers.push(
        agent.ctx.on("approval/request", async (request, next) =>
          request.agent !== agent || ctx.agents.get(agent.id) !== agent
            ? next()
            : approvalOutcome.parse(
                await this.interaction(
                  state,
                  binding,
                  "approval/request",
                  request,
                  next,
                ),
              ),
        ),
      );
      state.disposers.push(
        agent.ctx.on("user-questions/request", async (request, next) =>
          request.agent !== agent || ctx.agents.get(agent.id) !== agent
            ? next()
            : answerSchema.parse(
                await this.interaction(
                  state,
                  binding,
                  "user-questions/request",
                  request,
                  next,
                ),
              ),
        ),
      );
    };
    state.disposers.push(
      ctx.on("agent/created", ({ agent }) => {
        if (agent.id !== binding.sessionId) return;
        attach(agent);
        safePush({ type: "emit", event: "commands/change", args: [] });
        safePush({
          type: "emit",
          event: "permission-presets/catalog-changed",
          args: [],
        });
        return undefined;
      }),
    );
    state.disposers.push(
      ctx.on("agent/disposed", ({ agent }) => {
        if (agent.id !== binding.sessionId) return;
        for (const pending of state.pending.values())
          if (pending.request.agent === agent) pending.settle({ kind: "next" });
      }),
    );
    const live = ctx.agents.get(SessionId(binding.sessionId));
    if (live) attach(live);
    signal.addEventListener("abort", () => state.queue.end(), { once: true });
    return state.queue;
  }
  private async interaction(
    state: EventState,
    binding: ProjectSessionNativeBinding,
    event: "approval/request" | "user-questions/request",
    request: ApprovalRequestEvent | AskUserQuestionRequestEvent,
    next: () => Promise<unknown>,
  ): Promise<unknown> {
    try {
      await this.options.authorizeBinding(binding, "write");
    } catch {
      return next();
    }
    if (this.events.get(state.clientId) !== state || request.signal?.aborted)
      return next();
    const eventId = randomUUID();
    const { agent: _, signal, ...projected } = request;
    this.checkSize(
      {
        frames: [
          {
            type: "waterfall",
            event,
            eventId,
            agentId: binding.sessionId,
            request: projected,
          },
        ],
        cursor: `${state.clientId}:999999`,
      },
      "FRAME_TOO_LARGE",
    );
    const outcome = await new Promise<InteractionResolution>(
      (resolve, reject) => {
        const finish = (value: InteractionResolution) => {
          cleanup();
          resolve(value);
        };
        const fail = (failure: Error) => {
          cleanup();
          reject(failure);
        };
        const abort = () => finish({ kind: "next" });
        const cleanup = () => {
          state.pending.delete(eventId);
          signal?.removeEventListener("abort", abort);
          state.queue.push({ type: "cancel", eventId });
        };
        state.pending.set(eventId, {
          event,
          request,
          settle: finish,
          reject: fail,
        });
        signal?.addEventListener("abort", abort, { once: true });
        state.queue.push({
          type: "waterfall",
          event,
          eventId,
          agentId: binding.sessionId,
          request: projected,
        });
      },
    );
    if (outcome.kind === "next") return next();
    return outcome.value;
  }
  private answer(
    binding: ProjectSessionNativeBinding,
    operation: Extract<ProjectNativeOperation, { kind: "interaction-result" }>,
  ): unknown {
    const state = this.events.get(operation.clientId);
    if (!state || state.binding !== bindingKey(binding))
      error(
        "INTERACTION_GENERATION_EXPIRED",
        "The interaction belongs to another binding or an expired native generation",
      );
    const pending = state.pending.get(operation.eventId);
    if (!pending)
      error(
        "INTERACTION_EXPIRED",
        "The native interaction has already settled or was cancelled",
      );
    const outcome = operation.outcome;
    if (outcome.kind === "rejected") {
      const failure = new Error(outcome.error.message);
      failure.name = outcome.error.name;
      if (outcome.error.code !== undefined)
        Object.assign(failure, { code: outcome.error.code });
      pending.reject(failure);
    } else if (outcome.kind === "next") pending.settle(outcome);
    else {
      const value =
        pending.event === "approval/request"
          ? approvalOutcome.parse(outcome.value)
          : answerSchema.parse(outcome.value);
      if (
        pending.event === "user-questions/request" &&
        "questions" in pending.request
      ) {
        const ids = new Set(
          pending.request.questions.map((question) => question.id),
        );
        const answers = answerSchema.parse(value).answers;
        if (
          answers.length !== ids.size ||
          answers.some((answer) => !ids.has(answer.id)) ||
          new Set(answers.map((answer) => answer.id)).size !== answers.length
        )
          error(
            "INVALID_ANSWER",
            "Answer identifiers must name distinct questions from this interaction",
          );
      }
      pending.settle({ kind: "result", value });
    }
    return { accepted: true };
  }
}
export { ProjectNativeOwner as ProjectSessionNativeAdapter };
