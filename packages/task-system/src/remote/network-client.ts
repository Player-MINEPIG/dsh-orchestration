import { request } from 'node:http'
import { Readable } from 'node:stream'
import { insist } from './protocol.js'
import { exactAddress, networkAuthority, validateNetworkEndpoint } from './trusted-network.js'
import type { TrustedNetworkTarget } from './trusted-network.js'

export function validateNetworkTarget(endpoint: string, target: TrustedNetworkTarget): { endpoint: URL; target: TrustedNetworkTarget } {
  insist(target?.allowHttp === true,'TRUSTED_NETWORK_OPT_IN_REQUIRED')
  const destination = validateNetworkEndpoint(target)
  const localAddress = exactAddress(target.localAddress)
  validateNetworkEndpoint({ address: localAddress,port: destination.port })
  const url = new URL(endpoint)
  insist(url.protocol === 'http:' && !url.username && !url.password && !endpoint.includes('?') && !endpoint.includes('#'),'INVALID_NETWORK_ENDPOINT')
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1,-1) : url.hostname
  insist(exactAddress(hostname) === destination.address && Number(url.port || '80') === destination.port,'NETWORK_TARGET_DENIED',403)
  // A second parser must not reinterpret unusual numeric, escaped, or DNS hosts.
  const authority = endpoint.match(/^http:\/\/([^/]+)/)?.[1]
  insist(authority === networkAuthority(destination),'NETWORK_TARGET_DENIED',403)
  return { endpoint: url,target: Object.freeze({ ...destination,localAddress,allowHttp: true }) }
}

/** No DNS, proxy environment, connection pooling, redirect, or fetch substitution. */
export function trustedNetworkFetch(target: TrustedNetworkTarget): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    insist(!(input instanceof Request),'INVALID_NETWORK_ENDPOINT')
    // URL serialisation elides :80 after the constructor has required it.
    const serialized = input instanceof URL && input.protocol === 'http:' && !input.port
      ? `http://${input.username || input.password ? `${input.username}:${input.password}@` : ''}${input.hostname}:80${input.pathname}${input.search}${input.hash}`
      : String(input)
    const checked = validateNetworkTarget(serialized,target)
    insist(init?.method === 'POST' && typeof init.body === 'string','INVALID_NETWORK_REQUEST')
    const body = init.body
    return await new Promise<Response>((resolve,reject) => {
      const req = request(checked.endpoint,{
        method: 'POST',agent: false,localAddress: checked.target.localAddress,signal: init.signal ?? undefined,
        headers: { 'content-type': 'application/json','content-length': Buffer.byteLength(body),'host': networkAuthority(checked.target) },
      },res => {
        if (!res.statusCode || res.statusCode >= 300 && res.statusCode < 400) { res.destroy(); reject(new Error('NETWORK_REDIRECT_DENIED')); return }
        const headers = new Headers()
        for (const [key,value] of Object.entries(res.headers)) if (value !== undefined) headers.set(key,Array.isArray(value) ? value.join(', ') : value)
        try { resolve(new Response(res.statusCode === 204 || res.statusCode === 304 ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>,{ status: res.statusCode,headers })) }
        catch (error) { res.destroy(); reject(error) }
      })
      req.once('error',reject)
      req.once('socket',socket => {
        socket.once('connect',() => {
          try {
            insist(exactAddress(socket.remoteAddress) === checked.target.address && socket.remotePort === checked.target.port && exactAddress(socket.localAddress) === checked.target.localAddress,'NETWORK_TARGET_DENIED',403)
            req.end(body)
          } catch (error) { req.destroy(error instanceof Error ? error : new Error('NETWORK_TARGET_DENIED')) }
        })
      })
    })
  }) as typeof fetch
}
