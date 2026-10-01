import { digest, identifier, insist } from './protocol.js'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { CapturedText, WorkspaceBinding } from './ports.js'
import type { RemoteLedgerClient } from './client.js'

export type ObservationText = Pick<CapturedText,'sessionId'|'sourceRevision'|'title'|'body'|'observedAt'|'truncated'|'cwd'>
const inside = (root: string, child: string): boolean => { const rel = relative(root,child); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) }
/** Opt-in observation sink; immutable host-captured cwd is checked before any transmission. */
export function observationForwarder(remote: RemoteLedgerClient, config: WorkspaceBinding) {
  insist(identifier(config.workspaceId),'INVALID_OBSERVATION_WORKSPACE')
  insist(isAbsolute(config.path) && isAbsolute(config.allowedRoot),'OBSERVATION_BINDING_REQUIRED')
  return async (input: ObservationText, options?: { signal?: AbortSignal }) => {
    insist(!options?.signal?.aborted,'TRANSPORT_ABORTED',503)
    if (!input.cwd || !isAbsolute(input.cwd)) return { state: 'local-only' as const,reason: 'missing-source-workspace' }
    try {
      const [cwd,path,root] = await Promise.all([realpath(input.cwd),realpath(config.path),realpath(config.allowedRoot)])
      if (!inside(root,path) || !inside(path,cwd) || !inside(root,cwd) || !(await stat(cwd)).isDirectory()) return { state: 'local-only' as const,reason: 'outside-authorized-workspace' }
    } catch { return { state: 'local-only' as const,reason: 'unavailable-source-workspace' } }
    insist(!options?.signal?.aborted,'TRANSPORT_ABORTED',503)
    return await remote.observe(`observe-${digest([config.workspaceId,input.sessionId,input.sourceRevision])}`,
      { workspaceId: config.workspaceId,sessionId: input.sessionId,sourceRevision: input.sourceRevision,title: input.title,body: input.body,observedAt: input.observedAt,truncated: input.truncated },options)
  }
}
