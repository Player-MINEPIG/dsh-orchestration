import { z } from "zod";
import { stewardBinding, stewardScope } from "./steward-contracts.js";

const key = z.string().min(1).max(200);
export const topicReference = z.strictObject({ conversationId: key, scope: stewardScope });
export const topicSource = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("message"), id: key, revision: z.number().int().nonnegative(), seq: z.number().int().positive(), scope: stewardScope, binding: stewardBinding }),
  z.strictObject({ kind: z.literal("project"), id: key, revision: key }),
]);
export const topicFact = z.strictObject({ id: key, section: z.enum(["goal", "decision", "constraint", "question"]), text: z.string().min(1).max(1800),
  origin: z.enum(["authoritative", "extractive", "generated"]), state: z.enum(["active", "superseded"]), sources: z.array(topicSource).min(1).max(8), supersededBy: key.optional() });
export const topicCard = z.strictObject({ topic: topicReference, version: key, binding: stewardBinding.nullable(), title: z.string().min(1).max(500), summary: z.string().max(300),
  facts: z.array(topicFact).max(32), coverageSeq: z.number().int().nonnegative(), observedThroughSeq: z.number().int().nonnegative(),
  freshness: z.enum(["current", "stale", "insufficient"]), coverageReason: z.string().max(500).optional(), sources: z.array(topicSource).max(80) });
export const topicListInput = z.strictObject({ conversationId: key, query: z.string().trim().max(200).optional(), cursor: z.string().max(500).optional(), limit: z.number().int().min(1).max(12).default(12) });
export const topicDetailInput = z.strictObject({ topic: topicReference, throughSeq: z.number().int().nonnegative().optional() });
export const topicSourceInput = z.strictObject({ conversationId: key, ref: topicSource, offset: z.number().int().nonnegative().default(0) });
export type TopicRef = z.infer<typeof topicReference>;
export type TopicSource = z.infer<typeof topicSource>;
export type TopicFact = z.infer<typeof topicFact>;
export type TopicCard = z.infer<typeof topicCard>;
export type TopicListItem = Pick<TopicCard, "topic" | "version" | "title" | "summary" | "freshness" | "coverageReason"> & { lastDiscussion: { role: "user" | "assistant"; excerpt: string; at: string; hasAttachments: boolean; truncated: boolean } | null };
export type TopicListPage = { items: TopicListItem[]; nextCursor: string | null; hasMore: boolean };
export type TopicOriginal = { source: Extract<TopicSource, { kind: "message" }>; role: "user" | "assistant" | "notification"; text: string; replyTo?: string };
export type TopicContext = { card: TopicCard; originals: TopicOriginal[]; complete: boolean; byteLimit: number };
export type TopicSourcePage = { ref: TopicSource; content: string; offset: number; totalBytes: number; nextOffset: number | null; byteLimit: 2000; coordinate: "utf-8-bytes" };

/** Trusted host reads only. None of these callbacks may create/activate a native session. */
export interface TopicHostReads {
  authorize(input: TopicRef): Promise<{ title: string; binding: z.infer<typeof stewardBinding> | null; project: { id: string; revision: string; goal: string; createdAt?: string } | null; createdAt?: string }>;
  projects(input: { conversationId: string; query: string; page: number; limit: number }): Promise<{ items: { projectId: string; title: string; summary: string }[]; hasMore: boolean }>;
  /** Optional bounded per-real-request maintenance. Never called by list/source/detail. */
  compact?(input: { previous: TopicCard; delta: TopicOriginal[] }, signal?: AbortSignal): Promise<unknown>;
}
export interface TopicCardsPort {
  activity?(topic: TopicRef, throughSeq: number): Promise<string | null>;
  deterministic?(input: { conversationId: string; text: string; throughSeq: number }): Promise<{ matches: { card: TopicCard; lastActiveAt: string | null }[]; complete: boolean; directed?: boolean }>;
  list(input: z.input<typeof topicListInput>): Promise<TopicListPage>;
  context(input: { topic: TopicRef; throughSeq: number; maintain: boolean; requestBudget?: {signal:AbortSignal;claimCall():void} }): Promise<TopicContext>;
  candidates(input: { conversationId: string; queries: string[]; exclude: z.infer<typeof stewardScope>; limit?: number }): Promise<TopicCard[]>;
  source(input: z.input<typeof topicSourceInput>): Promise<TopicSourcePage>;
}
