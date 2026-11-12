import { createHash } from "node:crypto";
import { z } from "zod";
import { canonical, TaskError } from "./ledger.js";
import {
  stewardBinding,
  stewardScope,
  type StewardBinding,
  type StewardScope,
} from "./steward-contracts.js";
import type { TopicRef } from "./steward-topic-types.js";
import type { StewardTopicRelations } from "./steward-topic-relations.js";

export const stewardRecipientChoice = z.strictObject({
  id: z.string().min(1).max(160),
  token: z.string().min(1).max(160),
});
export type StewardRecipientChoice = z.infer<typeof stewardRecipientChoice>;
export type StewardSeat = {
  id: string;
  token: string;
  topic: TopicRef;
  source: StewardBinding;
  title: string;
  role: "discussion" | "task-coordinator" | "project-coordinator";
  responsibility: string;
  artifacts: string[];
  taskId?: string;
};
type SeatInput = Omit<StewardSeat, "id" | "token">;
export type StewardRecipientHost = {
  source(topic: TopicRef): Promise<{ binding: StewardBinding; title: string }>;
  coordinators(topic: TopicRef): Promise<SeatInput[]>;
  current(seat: StewardSeat): Promise<boolean>;
  precise?(
    topic: TopicRef,
    identity: { source?: StewardBinding; taskId?: string },
  ): Promise<SeatInput | null>;
  coordinator?(topic: TopicRef): Promise<SeatInput | null>;
};
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex").slice(0, 32);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** Chooses an existing authorized conversation. Membership never grants access to
 * another conversation's history, tools, workspace or owned execution lease. */
export class StewardRecipients {
  constructor(
    private readonly relations: StewardTopicRelations,
    private readonly host: StewardRecipientHost,
  ) {}
  async list(
    topic: TopicRef,
  ): Promise<{ seats: StewardSeat[]; complete: boolean }> {
    const group = this.relations.group(topic),
      values: SeatInput[] = [];
    for (const scope of group.scopes) {
      const ref = { conversationId: topic.conversationId, scope };
      try {
        const current = await this.host.source(ref),
          metadata = this.relations.read(ref);
        values.push({
          topic: ref,
          source: stewardBinding.parse(current.binding),
          title: current.title,
          role: scope.kind === "project" ? "project-coordinator" : "discussion",
          responsibility: [metadata.role, metadata.responsibility]
            .filter(Boolean)
            .join(" · "),
          artifacts: this.relations.artifacts(ref, current.binding.sessionId),
        });
        values.push(...(await this.host.coordinators(ref)));
      } catch (error) {
        if (
          !(
            error instanceof TaskError &&
            ["FORBIDDEN", "NOT_FOUND"].includes(error.code)
          )
        )
          throw error;
      }
    }
    const unique = [
      ...new Map(
        values.map((value) => [canonical(value.source), value]),
      ).values(),
    ];
    const seats = unique
      .slice(0, 8)
      .map((value) => ({
        ...value,
        id: hash({
          conversationId: topic.conversationId,
          source: value.source,
        }),
        token: hash({
          topic: this.relations.root(topic),
          source: value.source,
          role: value.role,
          responsibility: value.responsibility,
          taskId: value.taskId,
        }),
      }));
    return { seats, complete: group.complete && unique.length <= 8 };
  }
  async choose(input: {
    topic: TopicRef;
    text: string;
    replySource?: StewardBinding;
    taskId?: string;
    explicit?: StewardRecipientChoice;
    call?: (input: {
      stage: "recipient";
      text: string;
      recipients: {
        id: string;
        role: string;
        responsibility: string;
        artifacts: string[];
        scopeLabel: string;
      }[];
    }) => Promise<unknown>;
  }) {
    const groupToken = this.relations.stamp(input.topic);
    const precise =
      input.replySource || input.taskId
        ? await this.host.precise?.(input.topic, {
            source: input.replySource,
            taskId: input.taskId,
          })
        : null;
    const listing = await this.list(input.topic),
      { seats } = listing;
    const preciseSeat = precise
      ? {
          ...precise,
          id: hash({
            conversationId: input.topic.conversationId,
            source: precise.source,
          }),
          token: hash({
            topic: this.relations.root(input.topic),
            source: precise.source,
            role: precise.role,
            responsibility: precise.responsibility,
            taskId: precise.taskId,
          }),
        }
      : null;
    const finish = async (
      seat: StewardSeat,
      reason:
        | "reply"
        | "task-owner"
        | "explicit"
        | "role"
        | "project-coordinator"
        | "default",
    ) => {
      if (!(await this.host.current(seat)))
        throw new TaskError(
          "CONFLICT",
          "原承接会话或任务负责人已变化，请重新核对。",
        );
      return { kind: "selected" as const, seat, reason, groupToken };
    };
    if (input.replySource) {
      const source =
        preciseSeat ??
        seats.find((seat) => same(seat.source, input.replySource));
      if (!source)
        throw new TaskError("FORBIDDEN", "回复来源已不属于当前可用承接者。");
      return finish(source, "reply");
    }
    if (input.explicit) {
      const source = seats.find(
        (seat) =>
          seat.id === input.explicit!.id &&
          seat.token === input.explicit!.token,
      );
      if (!source)
        throw new TaskError("CONFLICT", "承接会话选项已变化，请重新选择。");
      return finish(source, "explicit");
    }
    if (input.taskId && preciseSeat) return finish(preciseSeat, "task-owner");
    const owners = input.taskId
      ? seats.filter((seat) => seat.taskId === input.taskId)
      : [];
    if (owners.length === 1) return finish(owners[0]!, "task-owner");
    if (input.taskId)
      return {
        kind: "clarification" as const,
        question: "尚未核实这项任务当前的负责会话，请从任务入口选择负责会话。",
        seats,
      };
    if (listing.complete && seats.length === 1)
      return finish(seats[0]!, "default");
    if (
      listing.complete &&
      input.call &&
      seats.some((seat) => seat.responsibility || seat.artifacts.length)
    ) {
      const recipients = seats.map((seat, index) => ({
        id: `seat_${index}`,
        role: seat.role,
        responsibility: seat.responsibility,
        artifacts: seat.artifacts,
        scopeLabel: seat.title,
      }));
      try {
        const result = z
          .strictObject({
            kind: z.literal("recipient"),
            id: z.string().regex(/^seat_[0-7]$/),
          })
          .safeParse(
            await input.call({
              stage: "recipient",
              text: input.text,
              recipients,
            }),
          );
        if (result.success) {
          const index = recipients.findIndex(
            (item) => item.id === result.data.id,
          );
          if (index >= 0) return finish(seats[index]!, "role");
        }
      } catch (error) {
        if (
          error instanceof TaskError &&
          !["LIMIT", "TIMEOUT", "UNAVAILABLE"].includes(error.code)
        )
          throw error;
      }
    }
    const known = await this.host.coordinator?.(
      this.relations.root(input.topic),
    );
    if (known) {
      const seat = {
        ...known,
        id: hash({
          conversationId: input.topic.conversationId,
          source: known.source,
        }),
        token: hash({
          topic: input.topic,
          source: known.source,
          role: known.role,
          taskId: known.taskId,
        }),
      };
      return finish(seat, "project-coordinator");
    }
    const coordinators = listing.complete
      ? seats.filter((seat) => seat.role === "project-coordinator")
      : [];
    if (coordinators.length === 1)
      return finish(coordinators[0]!, "project-coordinator");
    return {
      kind: "clarification" as const,
      question: listing.complete
        ? "这条消息应由哪个已有会话承接？请选择具体职责或产物对应的会话。"
        : "这个话题关联的会话较多，请明确选择要回复的原会话。",
      seats,
    };
  }
}
