import type { Context } from '@deepseek-ai/cordis';
import { Service } from '@deepseek-ai/cordis';
export type Question = {type:'choice';instructions:string;criteria:Record<string,string|null>} | {type:'noul';instructions:string;criteria?:{true:string;false:string}} | {type:'score';instructions:string;criteria:string[]};
/** Values are protocol parsed. Consumers validate candidates and business semantics. */
export interface Answer {type:string; [field:string]: unknown}
export interface AskRequest {provider?:string;model?:string;reasoningEffort?:string;state:string;questions:Record<string,Question>}
export interface AskResult {provider:string;model:string;answers:Record<string,Answer>;usage?:{input_tokens?:number;output_tokens?:number;[field:string]:unknown}}
export interface DecisionModelPort {ask(request:AskRequest,options?:{signal?:AbortSignal}):Promise<AskResult>}
export interface ModelProfile {id:string;name?:string;provider:string;model?:string;nativeProvider?:string;reasoningEffort?:string;baseUrl?:string;credential?:string}
export interface JevConfig {enabled?:boolean;provider?:string;model?:string;nativeProvider?:string;reasoningEffort?:string;baseUrl?:string;credential?:string;profiles?:ModelProfile[];timeoutMs?:number;maxStateChars?:number;maxQuestions?:number;dataDir?:string;dailyCallLimit?:number;dailyTokenLimit?:number;maxOutputTokens?:number;maxOutputBytes?:number}
export class DecisionModels extends Service implements DecisionModelPort {
  constructor(ctx:Context,ask:DecisionModelPort['ask'],getConfig:()=>JevConfig);
  ask: DecisionModelPort['ask']; readonly activeCount:number; config():JevConfig;
}
export const name:string;
export const inject:string[];
export const Config:unknown;
export const NS:string;
export const BRIDGE_PREFIX:string;
export const PROVIDERS:Record<string,{id:string;label:string;url:string;model:string;credential:string;[field:string]:unknown}>;
export function apply(ctx:Context,config:JevConfig):void;
export function createDecisionCaller(getCredentials:()=>unknown,getConfig:()=>JevConfig,getLedger?:()=>unknown,getLlm?:()=>unknown):DecisionModelPort['ask'];
declare module '@deepseek-ai/cordis' {interface Context {decisionModels:DecisionModels}}
