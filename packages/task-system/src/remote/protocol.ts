import { createHash, createPublicKey, sign, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { z } from 'zod'

/** Produced by a trusted native host before agent/model/workload dispatch. */
export interface PreDispatchFailure { kind: 'native-provider-unavailable-v1'; code: 'NO_ADAPTER'; provider: string; model: string }
export function validatePreDispatchFailure(value: unknown): asserts value is PreDispatchFailure {
  insist(isRecord(value), 'INVALID_PRE_DISPATCH_FAILURE')
  const fields = ['kind','code','provider','model']
  insist(Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value,key)), 'INVALID_PRE_DISPATCH_FAILURE')
  insist(value.kind === 'native-provider-unavailable-v1' && value.code === 'NO_ADAPTER', 'INVALID_PRE_DISPATCH_FAILURE')
  for (const [key,max] of [['provider',100],['model',200]] as const) insist(typeof value[key] === 'string' && value[key].length > 0 && Buffer.byteLength(value[key]) <= max, 'INVALID_PRE_DISPATCH_FAILURE')
}

/** A trusted host has drained the session; its candidate report was rejected, not accepted. */
export interface ResultValidationFailure { kind: 'native-result-validation-failure-v1'; code: 'SCHEMA_VALIDATION' | 'RESULT_VALIDATION'; issues: string[]; sessionId: string; quiescent: true; sessionPersisted: true }
export function validateResultValidationFailure(value: unknown): asserts value is ResultValidationFailure {
  insist(isRecord(value), 'INVALID_RESULT_VALIDATION_FAILURE')
  const fields=['kind','code','issues','sessionId','quiescent','sessionPersisted']
  insist(Object.keys(value).length===fields.length&&fields.every(k=>Object.hasOwn(value,k)), 'INVALID_RESULT_VALIDATION_FAILURE')
  insist(value.kind==='native-result-validation-failure-v1'&&['SCHEMA_VALIDATION','RESULT_VALIDATION'].includes(String(value.code))&&value.quiescent===true&&value.sessionPersisted===true, 'INVALID_RESULT_VALIDATION_FAILURE')
  insist(typeof value.sessionId==='string'&&value.sessionId.length>0&&value.sessionId.length<=200, 'INVALID_RESULT_VALIDATION_FAILURE')
  insist(Array.isArray(value.issues)&&value.issues.length<=10&&value.issues.every(x=>typeof x==='string'&&x.length<=1000), 'INVALID_RESULT_VALIDATION_FAILURE')
}

const executorWorkspace = z
  .object({
    workspaceId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    nodeId: z.string().min(1).max(128),
    label: z.string().min(1).max(500),
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (path) =>
          !/[\u0000-\u001f]/.test(path) &&
          (posix.isAbsolute(path)
            ? posix.normalize(path) === path
            : win32.isAbsolute(path) && win32.normalize(path) === path),
      ),
    state: z.enum(["ready", "unavailable", "revoked"]),
  })
  .strict();
export type ExecutorWorkspaceMetadata = z.infer<typeof executorWorkspace>;
export function executorWorkspaces(
  value: unknown,
  nodeId: string,
): ExecutorWorkspaceMetadata[] {
  const parsed = z.array(executorWorkspace).max(64).safeParse(value);
  insist(parsed.success, "INVALID_EXECUTOR_WORKSPACES");
  insist(
    parsed.data.every((workspace) => workspace.nodeId === nodeId),
    "WORKSPACE_NODE_MISMATCH",
    403,
  );
  insist(
    new Set(parsed.data.map((workspace) => workspace.workspaceId)).size ===
      parsed.data.length,
    "DUPLICATE_EXECUTOR_WORKSPACE",
  );
  return parsed.data;
}

export type Role = 'planner' | 'executor' | 'both'
export const EXECUTOR_OPERATIONS = ['claim', 'renew', 'submit', 'cancel', 'receipt', 'bindSession', 'markRunning', 'getRun', 'executionDisposition', 'getAttempt', 'acknowledgeCancellation', 'listWork', 'observe', 'delegate', 'taskHistory', 'taskWait', 'taskNote', 'taskReport', 'heartbeat', 'nodeStatus', 'retryBeforeEffects', 'offerApproval', 'approvalStatus', 'cancelApproval', 'executorIdentity', 'sessionContext', 'selectTaskSession', 'sessionMessages', 'sessionMessageReply', 'projectSnapshot', 'projectCollaborate', 'executionModelRequests', 'completeExecutionModels', 'executionModelView', 'reportAdmission'] as const
export type Operation = typeof EXECUTOR_OPERATIONS[number]
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024
export const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024
export const MAX_WIRE_BYTES = 16 * 1024 * 1024
// Content and its protocol/storage wrappers have distinct bounded budgets.
// A schema can contain properties/items/allOf layers that are not workload data.
export const MAX_DATA_JSON_DEPTH = 16
export const MAX_TEMPLATE_SCHEMA_DEPTH = 24
export const MAX_PROTOCOL_JSON_DEPTH = 32 // schema budget + at most 8 envelope/receipt/storage layers
export function byteLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback
  insist(Number.isSafeInteger(limit) && limit >= 1024 && limit <= MAX_WIRE_BYTES,'INVALID_BYTE_LIMIT')
  return limit
}
export interface Envelope {
  version: 1
  keyId: string
  nodeId: string
  audience: string
  commandId: string
  nonce: string
  sequence: number
  issuedAt: number
  expiresAt: number
  operation: Operation
  payload: Record<string, Json>
  signature: string
}
export interface Peer {
  keyId: string
  nodeId: string
  publicKey: string | KeyObject
  audience: string
  operations: readonly Operation[]
  workspaces: readonly string[]
  capabilities: readonly string[]
}
export type AuthMode = 'ed25519' | 'trusted-network'
/** Network identity is supplied by the transport, never by these wire fields. */
export type TrustedNetworkEnvelope = Omit<Envelope, 'version' | 'keyId' | 'signature'> & { version: 2; authMode: 'trusted-network' }
export type CommandEnvelope = Envelope | TrustedNetworkEnvelope
export type AuthorizedPeer = Pick<Peer, 'nodeId' | 'audience' | 'operations' | 'workspaces' | 'capabilities'> & { managedAccess?: true; networkSource?: string }
export interface TransportIdentity { remoteAddress?: string; localAddress?: string; localPort?: number }
export interface RequestVerifier {
  readonly authMode: AuthMode
  admitIdentity?(envelope: CommandEnvelope, peer: AuthorizedPeer): void
  verify(envelope: CommandEnvelope, now?: number, transport?: TransportIdentity): AuthorizedPeer
}
export class ProtocolError extends Error {
  code: string
  status: number
  constructor(code: string, status = 400) { super(code); this.name = 'ProtocolError'; this.code = code; this.status = status }
}
export function insist(value: unknown, code: string, status = 400): asserts value {
  if (!value) throw new ProtocolError(code, status)
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}
export function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}
function encodeCanonical(value: unknown, depth: number, maxDepth: number): string {
  insist(depth <= maxDepth, 'MAX_DEPTH')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') { insist(Number.isFinite(value), 'INVALID_NUMBER'); return JSON.stringify(value) }
  if (Array.isArray(value)) { insist(value.length <= 256, 'ARRAY_LIMIT'); return `[${value.map(v => encodeCanonical(v, depth + 1, maxDepth)).join(',')}]` }
  insist(isRecord(value), 'INVALID_JSON')
  const keys = Object.keys(value).sort()
  insist(keys.length <= 64 && !keys.some(k => ['__proto__', 'prototype', 'constructor'].includes(k)), 'INVALID_KEYS')
  return `{${keys.map(k => `${JSON.stringify(k)}:${encodeCanonical(value[k], depth + 1, maxDepth)}`).join(',')}}`
}
/** Common transport/storage encoding. Ordering/signing bytes are unchanged. */
export function canonical(value: unknown, depth = 0): string { insist(Number.isInteger(depth) && depth >= 0 && depth <= MAX_PROTOCOL_JSON_DEPTH,'MAX_DEPTH'); return encodeCanonical(value, depth, MAX_PROTOCOL_JSON_DEPTH) }
/** Ordinary user/model JSON retains the original 16-level content limit. */
export function canonicalData(value: unknown): string { return encodeCanonical(value, 0, MAX_DATA_JSON_DEPTH) }
/** Schema-only content budget; this does not grant a larger workload payload. */
export function canonicalSchema(value: unknown): string { return encodeCanonical(value, 0, MAX_TEMPLATE_SCHEMA_DEPTH) }
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex') }
export function signingBytes(envelope: Omit<Envelope, 'signature'> | Envelope): Buffer {
  const { signature: _signature, ...unsigned } = envelope as Envelope
  return Buffer.from(`dsh-task-remote/v1\n${canonical(unsigned)}`)
}
export function signEnvelope(envelope: Omit<Envelope, 'signature'>, privateKey: KeyObject): Envelope {
  insist(privateKey.asymmetricKeyType === 'ed25519', 'ED25519_REQUIRED')
  return { ...envelope, signature: sign(null, signingBytes(envelope), privateKey).toString('base64url') }
}
export function parseEnvelope(body: Uint8Array | string, maxBodyBytes = DEFAULT_MAX_BODY_BYTES): Envelope {
  return parseCommandEnvelope(body, 'ed25519', maxBodyBytes) as Envelope
}
export function parseCommandEnvelope(body: Uint8Array | string, authMode: AuthMode, maxBodyBytes = DEFAULT_MAX_BODY_BYTES): CommandEnvelope {
  insist(authMode === 'ed25519' || authMode === 'trusted-network','AUTH_MODE_MISMATCH',401)
  insist(Buffer.byteLength(body) <= byteLimit(maxBodyBytes,DEFAULT_MAX_BODY_BYTES), 'BODY_LIMIT', 413)
  let e: unknown
  try { e = JSON.parse(typeof body === 'string' ? body : new TextDecoder('utf-8', { fatal: true }).decode(body)) } catch { throw new ProtocolError('INVALID_JSON') }
  insist(isRecord(e), 'INVALID_ENVELOPE')
  const required = ['version','nodeId','audience','commandId','nonce','sequence','issuedAt','expiresAt','operation','payload',...(authMode === 'ed25519' ? ['keyId','signature'] : ['authMode'])]
  insist(Object.keys(e).length === required.length && required.every(k => Object.hasOwn(e, k)), 'ENVELOPE_FIELDS')
  if (authMode === 'ed25519') insist(e.version === 1, 'UNSUPPORTED_VERSION')
  else insist(e.version === 2 && e.authMode === 'trusted-network', 'AUTH_MODE_MISMATCH', 401)
  for (const key of ['nodeId', 'audience', 'commandId', 'nonce',...(authMode === 'ed25519' ? ['keyId'] : [])]) insist(identifier(e[key]), `INVALID_${key}`)
  insist(Number.isSafeInteger(e.sequence) && Number(e.sequence) > 0, 'INVALID_SEQUENCE')
  insist(Number.isSafeInteger(e.issuedAt) && Number.isSafeInteger(e.expiresAt), 'INVALID_TIME')
  insist(['claim','renew','submit','cancel','receipt','bindSession','markRunning','getRun','executionDisposition','getAttempt','acknowledgeCancellation','listWork','observe','delegate','taskHistory','taskWait','taskNote','taskReport','heartbeat','nodeStatus','retryBeforeEffects','offerApproval','approvalStatus','cancelApproval','executorIdentity','sessionContext','selectTaskSession','sessionMessages','sessionMessageReply','projectSnapshot','projectCollaborate','executionModelRequests','completeExecutionModels','executionModelView','reportAdmission'].includes(String(e.operation)), 'UNKNOWN_OPERATION')
  insist(isRecord(e.payload), 'INVALID_PAYLOAD')
  if (authMode === 'ed25519') insist(typeof e.signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(e.signature), 'INVALID_SIGNATURE', 401)
  canonical(e)
  return e as unknown as CommandEnvelope
}
export class IdentityVerifier {
  readonly authMode = 'ed25519' as const
  private peers: Map<string, Peer & { key: KeyObject }>
  audience: string
  maxAgeMs: number
  clockSkewMs: number
  constructor(options: { audience: string; peers: readonly Peer[]; maxAgeMs?: number; clockSkewMs?: number }) {
    insist(identifier(options.audience), 'INVALID_AUDIENCE')
    this.audience = options.audience; this.maxAgeMs = options.maxAgeMs ?? 60000; this.clockSkewMs = options.clockSkewMs ?? 5000
    insist(this.maxAgeMs > 0 && this.maxAgeMs <= 300000 && this.clockSkewMs >= 0 && this.clockSkewMs <= 30000, 'TIME_POLICY')
    this.peers = new Map()
    for (const peer of options.peers) {
      insist(identifier(peer.keyId) && identifier(peer.nodeId) && !this.peers.has(peer.keyId), 'INVALID_PEER')
      const key = typeof peer.publicKey === 'string' ? createPublicKey(peer.publicKey) : peer.publicKey
      insist(key.type === 'public' && key.asymmetricKeyType === 'ed25519', 'ED25519_PUBLIC_KEY_REQUIRED')
      this.peers.set(peer.keyId, { ...peer, operations: [...peer.operations], workspaces: [...peer.workspaces], capabilities: [...peer.capabilities], key })
    }
  }
  verify(envelope: CommandEnvelope, now = Date.now()): Peer {
    insist(envelope.version === 1 && !('authMode' in envelope), 'AUTH_MODE_MISMATCH', 401)
    const peer = this.peers.get(envelope.keyId)
    insist(peer, 'UNKNOWN_KEY', 401)
    insist(peer.nodeId === envelope.nodeId, 'WRONG_NODE', 403)
    insist(envelope.audience === this.audience && peer.audience === this.audience, 'WRONG_AUDIENCE', 403)
    insist(envelope.issuedAt <= now + this.clockSkewMs && envelope.expiresAt >= now && envelope.issuedAt >= now - this.maxAgeMs && envelope.expiresAt > envelope.issuedAt && envelope.expiresAt - envelope.issuedAt <= this.maxAgeMs, 'STALE_REQUEST', 401)
    insist(verify(null, signingBytes(envelope), peer.key, Buffer.from(envelope.signature, 'base64url')), 'BAD_SIGNATURE', 401)
    insist(peer.operations.includes(envelope.operation), 'OPERATION_DENIED', 403)
    return peer
  }
}
