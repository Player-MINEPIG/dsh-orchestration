import type { IncomingMessage, ServerResponse } from 'node:http'
import { byteLimit, DEFAULT_MAX_BODY_BYTES, DEFAULT_MAX_RESPONSE_BYTES, insist, ProtocolError } from './protocol.js'
import type { RemoteGateway } from './gateway.js'

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
/** Adapter for the existing host's webServer.register; never binds its own socket. */
export function httpHandler(gateway: RemoteGateway, options: { maxBodyBytes?: number; maxResponseBytes?: number; bodyTimeoutMs?: number; allowLoopbackHttp?: boolean } = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const max = byteLimit(options.maxBodyBytes,DEFAULT_MAX_BODY_BYTES)
  const maxResponse = byteLimit(options.maxResponseBytes,DEFAULT_MAX_RESPONSE_BYTES)
  return async (req,res) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      assertTransport(req.socket, options.allowLoopbackHttp ?? false)
      insist(req.method === 'POST', 'METHOD_NOT_ALLOWED', 405)
      insist(req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() === 'application/json', 'JSON_REQUIRED', 415)
      insist(!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity', 'ENCODING_DENIED', 415)
      const length = req.headers['content-length']
      if (length !== undefined) insist(/^\d+$/.test(length) && Number(length) <= max, 'BODY_LIMIT', 413)
      let bytes = 0
      const chunks: Buffer[] = []
      timer = setTimeout(() => { req.destroy(new Error('Request body timeout')) }, options.bodyTimeoutMs ?? 10000)
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
        bytes += buffer.length; insist(bytes <= max, 'BODY_LIMIT', 413); chunks.push(buffer)
      }
      clearTimeout(timer); timer = undefined
      const receipt = await gateway.handle(Buffer.concat(chunks))
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
