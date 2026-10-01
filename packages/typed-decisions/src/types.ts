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
export type Evidence =
  | { kind: 'deterministic'; calibration: 'not-applicable' }
  | { kind: 'structured-output'; calibration: 'none' }
  | { kind: 'hosted-typed-api'; calibration: 'provider-claimed'; source: string }
  | { kind: 'logits' | 'hidden-states'; calibration: 'none' | 'L0' | 'L1' | 'L2'; artifact?: string };
export type ModelVersionSource = 'provider-reported' | 'configured-pin';
export interface ModelCapability {
  model: string;
  /** Expected version; versionSource distinguishes a provider report from an operator pin. */
  version: string;
  /** Defaults to provider-reported. Native DSH cannot attest the response version. */
  versionSource?: ModelVersionSource;
  reasoningEfforts: string[];
}
export interface ProviderCapabilities {
  questionTypes: QuestionType[];
  maxChoices: number;
  maxScoreLevels: number;
  distributions: boolean;
  abstention: 'native' | 'validation-only';
  evidence: Evidence;
  models: ModelCapability[];
}
export interface ProviderResult {
  modelVersion: string;
  modelVersionSource?: ModelVersionSource;
  answers: Record<string, DecisionAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
}
export interface ProviderCall {
  request: DecisionRequest;
  model: ModelCapability;
  signal: AbortSignal;
}
export interface DecisionProvider {
  readonly id: string;
  readonly version: string;
  readonly capabilities: ProviderCapabilities;
  evaluate(call: ProviderCall): Promise<ProviderResult>;
}
export type DecisionErrorCode = 'invalid-output' | 'unsupported' | 'provider-error' | 'timeout' | 'cancelled' | 'circuit-open';
export interface DecisionReceipt {
  schemaVersion: 1;
  requestId: string;
  inputDigest: string;
  /** Digest of the complete request before provider capability/version augmentation. */
  requestDigest: string;
  stateHash: string;
  provider: string;
  providerVersion: string;
  model: string;
  /** Null means no valid response established the version under its declared source. */
  modelVersion: string | null;
  modelVersionSource: ModelVersionSource | null;
  questionVersions: Record<string, string>;
  evidence: Evidence;
  answers: Record<string, DecisionAnswer>;
  status: 'answered' | 'abstained';
  error?: { code: DecisionErrorCode; message: string };
  attempts: number;
  elapsedMs: number;
  usage?: { input_tokens: number; output_tokens: number };
}
export interface EngineOptions {
  defaultProvider: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  failureLimit?: number;
  cooldownMs?: number;
  maxReceipts?: number;
}
