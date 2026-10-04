import { isIP } from 'node:net'
import { identifier, insist } from './protocol.js'
import type { AuthorizedPeer, CommandEnvelope, Role, TransportIdentity } from './protocol.js'

export interface NetworkEndpoint { address: string; port: number }
export interface TrustedNetworkPeer extends AuthorizedPeer { address: string; role: Role }
export interface TrustedNetworkPolicy {
  listen: NetworkEndpoint
  /** Explicit acknowledgement that the operator supplies a trusted network. */
  allowHttp: true
  /** Exact operator-maintained snapshot; no CIDRs or discovery. */
  allowedAddresses: readonly string[]
  peers: readonly TrustedNetworkPeer[]
}
export interface TrustedNetworkTarget extends NetworkEndpoint { localAddress: string; allowHttp: true }

export function exactAddress(value: string | undefined): string {
  insist(typeof value === 'string' && !value.includes('%') && isIP(value) !== 0, 'LITERAL_IP_REQUIRED')
  if (isIP(value) === 4) return value
  const address = new URL(`http://[${value}]/`).hostname.slice(1,-1)
  // Node exposes IPv4 sockets as mapped IPv6 on some platforms.
  if (address.startsWith('::ffff:')) {
    const parts = address.slice(7).split(':')
    if (parts.length === 2) {
      const high = parseInt(parts[0]!,16), low = parseInt(parts[1]!,16)
      return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`
    }
  }
  return address
}
export function validateNetworkEndpoint(endpoint: NetworkEndpoint): NetworkEndpoint {
  const address = exactAddress(endpoint.address)
  insist(address !== '0.0.0.0' && address !== '::' && address !== '255.255.255.255', 'WILDCARD_ADDRESS_DENIED')
  insist(Number.isSafeInteger(endpoint.port) && endpoint.port >= 1 && endpoint.port <= 65535, 'INVALID_NETWORK_PORT')
  return { address,port: endpoint.port }
}
export function networkAuthority(endpoint: NetworkEndpoint): string {
  return `${isIP(endpoint.address) === 6 ? `[${endpoint.address}]` : endpoint.address}:${endpoint.port}`
}
export function validateTrustedNetwork(policy: TrustedNetworkPolicy): TrustedNetworkPolicy {
  insist(policy?.allowHttp === true, 'TRUSTED_NETWORK_OPT_IN_REQUIRED')
  const listen = validateNetworkEndpoint(policy.listen)
  insist(Array.isArray(policy.allowedAddresses) && policy.allowedAddresses.length > 0 && policy.allowedAddresses.length <= 1024, 'NETWORK_ALLOWLIST_REQUIRED')
  const allowedAddresses = policy.allowedAddresses.map(exactAddress)
  insist(new Set(allowedAddresses).size === allowedAddresses.length, 'DUPLICATE_NETWORK_ADDRESS')
  insist(Array.isArray(policy.peers) && policy.peers.length > 0 && policy.peers.length <= 1024, 'NETWORK_PEERS_REQUIRED')
  const peers = policy.peers.map(peer => {
    const address = exactAddress(peer.address)
    insist(allowedAddresses.includes(address),'PEER_NOT_ALLOWLISTED')
    insist(identifier(peer.nodeId) && identifier(peer.audience),'INVALID_PEER')
    insist(['planner','executor','both'].includes(peer.role),'INVALID_PEER_ROLE')
    insist([peer.operations,peer.workspaces,peer.capabilities].every(values => Array.isArray(values) && values.length <= 128 && values.every(identifier)), 'INVALID_PEER_GRANTS')
    return Object.freeze({ ...peer,address,operations: Object.freeze([...peer.operations]),workspaces: Object.freeze([...peer.workspaces]),capabilities: Object.freeze([...peer.capabilities]) })
  })
  insist(new Set(peers.map(peer => peer.address)).size === peers.length,'DUPLICATE_NETWORK_PEER')
  // One source address owns one sequence stream and logical executor identity.
  insist(new Set(peers.map(peer => peer.nodeId)).size === peers.length,'DUPLICATE_NETWORK_NODE')
  return Object.freeze({ listen: Object.freeze(listen),allowHttp: true,allowedAddresses: Object.freeze(allowedAddresses),peers: Object.freeze(peers) })
}
export function networkPeer(policy: TrustedNetworkPolicy, transport?: TransportIdentity): TrustedNetworkPeer {
  insist(transport,'NETWORK_TRANSPORT_REQUIRED',403)
  insist(exactAddress(transport.localAddress) === policy.listen.address && transport.localPort === policy.listen.port,'NETWORK_LISTENER_DENIED',403)
  const address = exactAddress(transport.remoteAddress)
  insist(policy.allowedAddresses.includes(address),'NETWORK_ADDRESS_DENIED',403)
  const peer = policy.peers.find(candidate => candidate.address === address)
  insist(peer,'NETWORK_PEER_REQUIRED',403)
  return peer
}
/** Optional transport-auth adapter. Tailscale itself remains an operator concern. */
export class TrustedNetworkVerifier {
  readonly authMode = 'trusted-network' as const
  readonly policy: TrustedNetworkPolicy
  private readonly audience: string
  constructor(options: TrustedNetworkPolicy & { audience: string }) {
    insist(identifier(options.audience),'INVALID_AUDIENCE')
    this.audience = options.audience
    this.policy = validateTrustedNetwork(options)
  }
  verify(envelope: CommandEnvelope, now = Date.now(), transport?: TransportIdentity): AuthorizedPeer {
    insist(envelope.version === 2 && envelope.authMode === 'trusted-network' && !('signature' in envelope) && !('keyId' in envelope),'AUTH_MODE_MISMATCH',401)
    const peer = networkPeer(this.policy,transport)
    insist(peer.role === 'executor' || peer.role === 'both','EXECUTOR_ROLE_REQUIRED',403)
    insist(peer.nodeId === envelope.nodeId,'WRONG_NODE',403)
    insist(envelope.audience === this.audience && peer.audience === this.audience,'WRONG_AUDIENCE',403)
    insist(envelope.issuedAt <= now + 5000 && envelope.expiresAt >= now && envelope.issuedAt >= now - 60000 && envelope.expiresAt > envelope.issuedAt && envelope.expiresAt - envelope.issuedAt <= 60000,'STALE_REQUEST',401)
    insist(peer.operations.includes(envelope.operation),'OPERATION_DENIED',403)
    return peer
  }
}
