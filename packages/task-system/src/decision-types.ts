export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type QuestionType = 'choice' | 'noul' | 'score';
export interface QuestionBase {
  questionId: string;
  questionVersion: string;
  instructions: string;
  abstainWhen?: string[];
}
export interface ChoiceQuestion extends QuestionBase {
  type: 'choice';
  candidates: Record<string, string | null>;
}
export interface NoulQuestion extends QuestionBase {
  type: 'noul';
  criteria?: { true: string; false: string };
}
export interface ScoreQuestion extends QuestionBase {
  type: 'score';
  levels: string[];
}
export type DecisionQuestion = ChoiceQuestion | NoulQuestion | ScoreQuestion;
export interface DecisionRequest {
  requestId: string;
  stateHash: string;
  context: Json;
  questions: DecisionQuestion[];
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  /** Stable preset ID configured by the host. Cannot be mixed with explicit routing. */
  preset?: string;
}
export interface Distribution {
  probabilities?: Record<string, number>;
  confidence?: number;
}
export type DecisionAnswer =
  | ({ type: 'choice'; choice: string } & Distribution)
  | { type: 'noul'; noul: number }
  | ({ type: 'score'; score: number; legend?: Record<string, string> } & Distribution)
  | { type: 'abstain'; reason: string };
/** Caller-owned audit data, persisted in the existing task ledger. Not a model-service receipt. */
export interface DecisionReceipt {
  schemaVersion: 1;
  requestId: string; inputDigest: string; requestDigest: string; stateHash: string;
  provider: string; model: string; questionVersions: Record<string,string>;
  answers: Record<string, DecisionAnswer>; status: 'answered'|'abstained';
  error?: {code:string;message:string};
  usage?: unknown;
}
