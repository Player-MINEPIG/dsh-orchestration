/** Shared, versioned contract used by plugins and the read-only dashboard. */
export const SCHEMA_VERSION = '1' as const;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type TaskState = 'inbox'|'ready'|'running'|'waiting'|'completed'|'failed'|'cancelled'|'archived';
export type RunState = 'queued'|'running'|'blocked'|'succeeded'|'failed'|'cancelled'|'uncertain';
export type Role = 'planner'|'executor'|'both';
export type Outcome = 'success'|'partial'|'failure'|'blocked'|'unknown';
export interface Source { kind: 'explicit-import'|'task-system'; label: string; observedAt: string; staleAfterMs: number; }
export interface Task { taskId:string; title:string; description:string; state:TaskState; kind:'ad_hoc'|'scheduled'|'observed'; createdAt:string; updatedAt:string; parentTaskId?:string; workspaceId?:string; tags:string[]; }
export interface ExecutionRoute { nodeId:string; provider:string; model:string; reasoningEffort?:string; workspaceId?:string; requiredCapabilities:string[]; }
export interface Run { runId:string; taskId:string; state:RunState; createdAt:string; updatedAt:string; sessionIds:string[]; outcome?:Outcome; route?:ExecutionRoute; occurrenceId?:string; configuration:Json; currentAttemptId?:string; cancellationRequested?:boolean; }
export interface Attempt { attemptId:string; taskId:string; runId:string; nodeId:string; fence:number; leaseExpiresAt:string; state:'leased'|'running'|'settled'|'cancelled'|'expired'|'uncertain'; createdAt:string; updatedAt:string; sessionId?:string; }
export interface Report { reportId:string; taskId:string; runId?:string; attemptId?:string; sessionId?:string; revision:number; previousReportId?:string; title:string; body:string; createdAt:string; recordedAt:string; artifactIds:string[]; kind:'progress'|'result'|'review'|'observation'; }
export interface Artifact { artifactId:string; taskId:string; reportId?:string; name:string; mediaType:string; uri?:string; sha256?:string; bytes?:number; createdAt:string; finalized:boolean; }
export interface Event { eventId:string; taskId?:string; runId?:string; type:string; at:string; detail:Json; }
export interface Template { templateId:string; version:number; name:string; description:string; inputSchema:Json; defaults:Json; resultContract:Json; }
export interface Schedule { scheduleId:string; taskId:string; templateId:string; templateVersion:number; enabled:boolean; intervalMs:number; nextDueAt:string; overlap:'skip'|'queue'; input:Json; }
export interface Workspace { workspaceId:string; nodeId:string; path:string; label:string; state:'ready'|'planned'|'failed'; createdAt:string; }
export interface NodeCapability { nodeId:string; roles:Role[]; capabilities:string[]; models:{provider:string;model:string;reasoningEfforts:string[]}[]; workspaceIds:string[]; enabled:boolean; lastSeenAt:string; }
export interface Delivery { deliveryId:string; taskId:string; reportId?:string; destination:string; kind:string; payload:Json; state:'pending'|'sending'|'sent'|'uncertain'|'failed'; attempts:number; nextAttemptAt:string; receipt?:Json; claimToken?:string; leaseExpiresAt?:string; }
export interface Snapshot { schemaVersion:'1'; generatedAt:string; source:Source; tasks:Task[]; runs:Run[]; reports:Report[]; artifacts:Artifact[]; templates:Template[]; events:Event[]; }
export interface Claim { attempt:Attempt; run:Run; task:Task; }
export interface LeaseRef { runId:string; attemptId:string; nodeId:string; fence:number; }
export interface Settlement extends LeaseRef { outcome:Outcome; summary:string; report?:{title:string;body:string;artifactIds?:string[]}; notifications?:{destination:string;kind:string;payload:Json}[]; }
export interface Receipt<T=Json> { commandId:string; acceptedAt:string; value:T; }
