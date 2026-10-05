import { createHash, createPublicKey, sign, verify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'

/** Produced by a trusted native host before agent/model/workload dispatch. */
export interface PreDispatchFailure { kind: 'native-provider-unavailable-v1'; code: 'NO_ADAPTER'; provider: string; model: string }
export function validatePreDispatchFailure(value: unknown): asserts value is PreDispatchFailure {
  insist(isRecord(value), 'INVALID_PRE_DISPATCH_FAILURE')
  const fields = ['kind','code','provider','model']
  insist(Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value,key)), 'INVALID_PRE_DISPATCH_FAILURE')
  insist(value.kind === 'native-provider-unavailable-v1' && value.code === 'NO_ADAPTER', 'INVALID_PRE_DISPATCH_FAILURE')
  for (const [key,max] of [['provider',100],['model',200]] as const) insist(typeof value[key] === 'string' && value[key].length > 0 && Buffer.byteLength(value[key]) <= max, 'INVALID_PRE_DISPATCH_FAILURE')
}

export type Role = 'planner' | 'executor' | 'both'
export type Operation = 'claim' | 'renew' | 'submit' | 'cancel' | 'receipt' | 'bindSession' | 'markRunning' | 'getRun' | 'getAttempt' | 'acknowledgeCancellation' | 'listWork' | 'observe' | 'delegate' | 'taskHistory' | 'taskWait' | 'taskNote' | 'taskReport' | 'heartbeat' | 'nodeStatus' | 'retryBeforeEffects' | 'offerApproval' | 'approvalStatus' | 'cancelApproval' | 'executorIdentity' | 'sessionContext' | 'selectTaskSession'
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
export type AuthorizedPeer = Pick<Peer, 'nodeId' | 'audience' | 'operations' | 'workspaces' | 'capabilities'>
export interface TransportIdentity { remoteAddress?: string; localAddress?: string; localPort?: number }
export interface RequestVerifier {
  readonly authMode: AuthMode
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
  insist(['claim','renew','submit','cancel','receipt','bindSession','markRunning','getRun','getAttempt','acknowledgeCancellation','listWork','observe','delegate','taskHistory','taskWait','taskNote','taskReport','heartbeat','nodeStatus','retryBeforeEffects','offerApproval','approvalStatus','cancelApproval','executorIdentity','sessionContext','selectTaskSession'].includes(String(e.operation)), 'UNKNOWN_OPERATION')
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
