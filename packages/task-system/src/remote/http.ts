import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse, Server } from 'node:http'
import { byteLimit, DEFAULT_MAX_BODY_BYTES, DEFAULT_MAX_RESPONSE_BYTES, insist, ProtocolError } from './protocol.js'
import type { RemoteGateway } from './gateway.js'
import { networkAuthority, networkPeer, validateTrustedNetwork } from './trusted-network.js'
import type { TrustedNetworkPolicy } from './trusted-network.js'

export function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}
export function assertTransport(socket: { encrypted?: boolean; remoteAddress?: string; localAddress?: string }, allowLoopbackHttp: boolean): void {
  insist(socket.encrypted === true || (allowLoopbackHttp && isLoopback(socket.remoteAddress) && isLoopback(socket.localAddress)), 'TLS_REQUIRED', 403)
}
export function assertEndpoint(endpoint: string, allowLoopbackHttp = false): URL {
  const url = new URL(endpoint)
  insist(!url.username && !url.password && !url.hash && !url.search, 'INVALID_ENDPOINT')
  insist(url.protocol === 'https:' || (allowLoopbackHttp && url.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(url.hostname)), 'TLS_REQUIRED', 403)
  return url
}
/** Request adapter shared by the existing host carrier and explicit network carrier. */
export function httpHandler(gateway: RemoteGateway, options: { maxBodyBytes?: number; maxResponseBytes?: number; bodyTimeoutMs?: number; allowLoopbackHttp?: boolean; trustedNetwork?: TrustedNetworkPolicy } = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const max = byteLimit(options.maxBodyBytes,DEFAULT_MAX_BODY_BYTES)
  const maxResponse = byteLimit(options.maxResponseBytes,DEFAULT_MAX_RESPONSE_BYTES)
  const network = options.trustedNetwork ? validateTrustedNetwork(options.trustedNetwork) : undefined
  insist(gateway.authMode === (network ? 'trusted-network' : 'ed25519'),'AUTH_MODE_MISMATCH')
  return async (req,res) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (network) {
        networkPeer(network,req.socket)
        insist(req.headers.host === networkAuthority(network.listen),'HOST_DENIED',403)
        insist(req.headers.origin === undefined,'ORIGIN_DENIED',403)
        insist(!Object.keys(req.headers).some(name => name === 'forwarded' || name.startsWith('x-forwarded-')),'PROXY_HEADERS_DENIED',403)
        // Reject duplicate authority/origin fields rather than rely on Node's merge rules.
        insist(req.rawHeaders.filter((_,index) => index % 2 === 0).filter(name => name.toLowerCase() === 'host').length === 1,'HOST_DENIED',403)
      } else assertTransport(req.socket, options.allowLoopbackHttp ?? false)
      insist(req.method === 'POST', 'METHOD_NOT_ALLOWED', 405)
      insist(req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() === 'application/json', 'JSON_REQUIRED', 415)
      insist(!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity', 'ENCODING_DENIED', 415)
      const length = req.headers['content-length']
      if (length !== undefined) insist(/^\d+$/.test(length) && Number(length) <= max, 'BODY_LIMIT', 413)
      let bytes = 0
      const chunks: Buffer[] = []
      timer = setTimeout(() => { req.destroy(new Error('Request body timeout')) }, options.bodyTimeoutMs ?? 30000)
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
        bytes += buffer.length; insist(bytes <= max, 'BODY_LIMIT', 413); chunks.push(buffer)
      }
      clearTimeout(timer); timer = undefined
      const receipt = await gateway.handle(Buffer.concat(chunks),network ? { remoteAddress: req.socket.remoteAddress,localAddress: req.socket.localAddress,localPort: req.socket.localPort } : undefined)
      const response = JSON.stringify(receipt)
      insist(Buffer.byteLength(response) <= maxResponse,'RESPONSE_LIMIT',413)
      res.writeHead(receipt.state === 'done' ? 200 : 202, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(response)
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(error instanceof ProtocolError ? error.status : 400, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ error: error instanceof ProtocolError ? error.code : 'REQUEST_FAILED' }))
      }
    } finally { if (timer) clearTimeout(timer) }
  }
}

/** Dedicated carrier owned by the embedding host; never a daemon or wildcard listener. */
export async function startTrustedNetworkCarrier(gateway: RemoteGateway, options: TrustedNetworkPolicy & { routePath: string; maxBodyBytes?: number; maxResponseBytes?: number; bodyTimeoutMs?: number }): Promise<{ server: Server; close(): Promise<void> }> {
  const policy = validateTrustedNetwork(options)
  insist(/^\/[A-Za-z0-9/_-]+$/.test(options.routePath),'INVALID_ROUTE')
  const handler = httpHandler(gateway,{ ...options,trustedNetwork: policy })
  const server = createServer((req,res) => {
    if (req.url !== options.routePath) { res.writeHead(404,{ 'content-type': 'application/json','cache-control': 'no-store' }); res.end('{"error":"NOT_FOUND"}'); return }
    void handler(req,res)
  })
  server.requestTimeout = options.bodyTimeoutMs ?? 30000
  server.headersTimeout = Math.min(10000,server.requestTimeout)
  server.keepAliveTimeout = 1000
  let closed: Promise<void> | undefined
  const close = (): Promise<void> => closed ??= new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections() })
  try {
    await new Promise<void>((resolve,reject) => {
      const fail = (error: Error): void => reject(error)
      server.once('error',fail)
      server.listen({ host: policy.listen.address,port: policy.listen.port,ipv6Only: true },() => { server.removeListener('error',fail); resolve() })
    })
  } catch (error) { await close(); throw error }
  return { server,close }
}
