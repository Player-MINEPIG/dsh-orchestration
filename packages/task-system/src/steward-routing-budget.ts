import { TaskError } from "./ledger.js";
import type { TopicContext, RoutingCandidate } from "./steward-topic-types.js";

/** UTF-8 bytes bound byte-level tokenizer tokens conservatively. This is not a
 * Jev/o200k token count. Count the whole wire envelope plus framing and output. */
export function assertRoutingBudget(envelope: unknown, outputTokens = 1200): void {
  if (Buffer.byteLength(JSON.stringify(envelope)) + 800 + outputTokens > 32000)
    throw new TaskError("LIMIT", "Router token upper-bound budget exhausted; original request preserved.");
}
function prefix(text: string, bytes: number): string {
  let result = "";
  for (const character of text) {
    if (Buffer.byteLength(result + character) > bytes) break;
    result += character;
  }
  return result;
}
/** One shared projection for Jev and fallback. Opaque IDs are mapped by the
 * router only after the model returns, never supplied as executable authority. */
export function compactRoutingCandidates(contexts: TopicContext[]): RoutingCandidate[] {
  if (contexts.length > 32) throw new TaskError("LIMIT", "Routing shortlist exceeds 32 candidates");
  return contexts.map((context, index) => {
    const card = context.card;
    const facts = card.facts.filter(fact => fact.state === "active");
    const evidence = [...facts.map(fact => `${fact.section}: ${fact.text}`), ...context.originals
      .filter(original => original.role !== "notification").map(original => `${original.role}: ${original.text}`)].join("\n");
    const shortEvidence = prefix(evidence, 240), title = prefix(card.title, 120);
    const summary = Array.from(card.summary).slice(0, 100).join("");
    const omitted = shortEvidence !== evidence;
    return { id: `topic_${index}`, title, summary, evidence: shortEvidence,
      freshness: card.freshness, complete: context.complete && !omitted && title === card.title && !!evidence,
      previewTruncated: omitted || title !== card.title || summary !== card.summary };
  });
}
