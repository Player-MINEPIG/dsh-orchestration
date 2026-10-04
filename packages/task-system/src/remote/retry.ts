import { identifier, insist, isRecord } from './protocol.js'
import type { SafeRetryWitness } from './ports.js'

/** Evidence schema only. The coordinator owns tool eligibility, budget and transition. */
export function validateRetryWitness(value: unknown, sessionId?: string): asserts value is SafeRetryWitness {
  insist(isRecord(value),'INVALID_RETRY_WITNESS')
  const completed = value.kind === 'dsh-owned-completed-tools-v1'
  const fields = ['kind','sessionId','fromSeq','toSeq','terminalSeq','turn','code','toolCallCount','toolDispatchCount','complete','quiescent','persisted','disposed',...(completed ? ['toolResultCount','completedTools'] : [])]
  insist(Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value,key)),'INVALID_RETRY_WITNESS_FIELDS')
  insist((completed || value.kind === 'dsh-owned-zero-tools-v1') && identifier(value.sessionId) && (sessionId === undefined || value.sessionId === sessionId),'INVALID_RETRY_SESSION')
  for (const key of ['fromSeq','toSeq','terminalSeq','turn']) insist(Number.isSafeInteger(value[key]) && Number(value[key]) >= 0,'INVALID_RETRY_SEQUENCE')
  insist(Number(value.toSeq) > Number(value.fromSeq) && Number(value.terminalSeq) >= Number(value.fromSeq) && Number(value.terminalSeq) < Number(value.toSeq),'INVALID_RETRY_SEQUENCE')
  insist(typeof value.code === 'string' && ['RATE_LIMIT','SERVER','TRANSPORT','TIMEOUT'].includes(value.code),'INVALID_RETRY_CODE')
  insist(value.complete === true && value.quiescent === true && value.persisted === true && value.disposed === true,'RETRY_EFFECTS_NOT_EXCLUDED')
  if (!completed) {
    insist(value.toolCallCount === 0 && value.toolDispatchCount === 0,'RETRY_EFFECTS_NOT_EXCLUDED')
    return
  }
  insist(Number.isSafeInteger(value.toolCallCount) && Number(value.toolCallCount) >= 1 && Number(value.toolCallCount) <= 32 && value.toolDispatchCount === value.toolCallCount && value.toolResultCount === value.toolCallCount,'RETRY_TOOLS_NOT_CLOSED')
  insist(Array.isArray(value.completedTools) && value.completedTools.length === value.toolCallCount,'RETRY_TOOLS_NOT_CLOSED')
  for (const tool of value.completedTools) {
    insist(isRecord(tool) && Object.keys(tool).length === 2 && Object.hasOwn(tool,'name') && Object.hasOwn(tool,'argumentsDigest'),'INVALID_COMPLETED_TOOL_FIELDS')
    insist(typeof tool.name === 'string' && tool.name.length <= 200 && /^[\w][\w:./@-]*$/.test(tool.name),'INVALID_COMPLETED_TOOL_NAME')
    insist(typeof tool.argumentsDigest === 'string' && /^[a-f0-9]{64}$/.test(tool.argumentsDigest),'INVALID_ARGUMENTS_DIGEST')
  }
}
