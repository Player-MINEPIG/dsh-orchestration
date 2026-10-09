import type { DecisionModelPort, Question } from "dsh-jev-plugin";
import type { DecisionReceipt, DecisionRequest, DecisionAnswer } from "./decision-types.js";
import { digest, stableStringify, validateRequest } from "./decision-validation.js";
export type DecisionServicePort = DecisionModelPort;
/** Convert caller questions to wire criteria. Only the caller validates business answers. */
export async function askTaskDecision(service: DecisionServicePort, input: DecisionRequest, options: {signal?:AbortSignal} = {}): Promise<DecisionReceipt> {
  options.signal?.throwIfAborted();
  const request = structuredClone(input);
  validateRequest(request);
  const questions: Record<string,Question> = {};
  const local: Record<string,DecisionAnswer> = {};
  for (const q of request.questions) {
    // A singleton catalog has no model choice; JEV requires at least two options.
    if (q.type === 'choice' && Object.keys(q.candidates).length === 1) {
      local[q.questionId] = {type:'choice',choice:Object.keys(q.candidates)[0]!}; continue;
    }
    const instructions = q.instructions + (q.abstainWhen?.length ? " Insufficient evidence when: " + q.abstainWhen.join('; ') : '');
    questions[q.questionId] = q.type === 'choice' ? {type:'choice',instructions,criteria:q.candidates} : q.type === 'score' ? {type:'score',instructions,criteria:q.levels} : {type:'noul',instructions,...(q.criteria ? {criteria:q.criteria} : {})};
  }
  const base = {schemaVersion:1 as const, requestId:request.requestId, inputDigest:digest(request), requestDigest:digest(request),stateHash:request.stateHash,questionVersions:Object.fromEntries(request.questions.map(q=>[q.questionId,q.questionVersion]))};
  try {
    const result = Object.keys(questions).length ? await service.ask({
      state:stableStringify(request.context), questions,
      ...((request.preset ?? request.provider) ? {provider:request.preset ?? request.provider} : {}),
      ...(request.model ? {model:request.model} : {}),
      ...(request.reasoningEffort ? {reasoningEffort:request.reasoningEffort} : {}),
    },options) : {provider:'caller',model:'single-candidate',answers:{}};
    options.signal?.throwIfAborted();
    // The caller rejects answers for questions it did not send, including resolved singletons.
    if (Object.keys(result.answers).some(id => !Object.hasOwn(questions, id))) throw new Error("Unexpected decision answer");
    const answers = {...local,...result.answers} as Record<string,DecisionAnswer>;
    return {...base,provider:result.provider,model:result.model,answers,status:'answered',...(result.usage ? {usage:result.usage} : {})};
  } catch {
    options.signal?.throwIfAborted();
    return {...base,provider:request.preset ?? request.provider ?? '',model:request.model ?? '',answers:{},status:'abstained',error:{code:'provider-error',message:'Decision model request failed'}};
  }
}
