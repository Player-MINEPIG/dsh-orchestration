import type { Template } from '../contracts.js'
import type { Claim, Run } from './ports.js'
import { insist, isRecord, canonicalData, canonicalSchema } from './protocol.js'

type ContextClaim = Pick<Claim, 'executionContext'> & {
  run: Pick<Run, 'configuration' | 'contextNotes'>
}

/** Select only immutable context named by this run. The coordinator supplies the
 * resolved bodies in its authenticated claim; a worker must never resolve these
 * IDs against its own unrelated ledger or silently drop missing context. */
export function resolvedClaimContext(claim: ContextClaim): NonNullable<Claim['executionContext']> {
  const configuration = isRecord(claim.run.configuration) ? claim.run.configuration : undefined
  let template: Template | undefined
  if (configuration?.templateRef !== undefined) {
    const ref = configuration.templateRef
    insist(isRecord(ref) && typeof ref.templateId === 'string' && Number.isSafeInteger(ref.version) && Number(ref.version) >= 1, 'INVALID_TEMPLATE_REFERENCE')
    template = claim.executionContext?.template
    insist(template && template.templateId === ref.templateId && template.version === ref.version, 'EXECUTION_TEMPLATE_CONTEXT_REQUIRED')
  } else if (configuration?.template !== undefined) {
    // Imported embedded snapshots remain authoritative even when a registry
    // happens to contain a different template under the same historical ID.
    insist(isRecord(configuration.template), 'INVALID_TEMPLATE_SNAPSHOT')
    template = configuration.template as unknown as Template
  }
  if (template) {
    canonicalSchema(template.inputSchema)
    canonicalSchema(template.resultContract)
    canonicalData(template.defaults)
  }
  if (configuration?.input !== undefined) canonicalData(configuration.input)
  if (configuration?.trigger !== undefined) canonicalData(configuration.trigger)
  const notes = claim.run.contextNotes ?? []
  insist(Array.isArray(notes) && notes.length <= 128, 'EXECUTION_CONTEXT_LIMIT')
  const supplied = claim.executionContext?.reports ?? []
  insist(Array.isArray(supplied) && supplied.length <= 128, 'EXECUTION_CONTEXT_LIMIT')
  const reports = notes.map(note => {
    if (typeof note !== 'string') {
      insist(isRecord(note) && typeof note.reportId === 'string' && typeof note.body === 'string' && typeof note.actor === 'string', 'INVALID_CONTEXT_SNAPSHOT')
      return { reportId: note.reportId, body: note.body, actor: note.actor }
    }
    const matches = supplied.filter(report => report.reportId === note)
    insist(matches.length === 1, 'EXECUTION_REPORT_CONTEXT_REQUIRED')
    const report = matches[0]!
    insist(typeof report.body === 'string' && typeof report.actor === 'string', 'INVALID_REPORT_CONTEXT')
    return { reportId: report.reportId, body: report.body, actor: report.actor }
  })
  return { ...(template ? { template } : {}), reports }
}
