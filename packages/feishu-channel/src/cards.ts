import type { Task, Run, Report, Alert, ApprovalRequest } from '@dsh-task/task-system/contracts';
import type { ActionBinding, Json, Outbound } from './contracts.js';

const short = (text: string, max = 3500): string => text.length <= max ? text : `${text.slice(0, max)}\n[Excerpt; use task history for the complete report]`;
export function taskCard(task: Task, run?: Run, report?: Report, actions: ActionBinding[] = []): Outbound {
  const status = run ? `Run: ${run.state}${run.cancellationRequested ? ' (cancellation requested)' : ''}` : `Task: ${task.state}`;
  const confirmation = task.confirmation;
  const canConfirm = !report && confirmation?.required && confirmation.state === 'pending' && (!run || run.state === 'queued');
  const lines = [status, `Task ID: ${task.taskId}`, ...(run ? [`Run ID: ${run.runId}`] : []),
    `Task visibility: ${task.admissionState ?? 'admitted'} · admission revision ${task.admissionRevision ?? 1}`,
    ...(confirmation?.required ? [`Task confirmation: ${confirmation.state} · revision ${confirmation.revision}`] : []),
    ...(canConfirm ? [run ? 'Confirmation covers only this current run plan. Every new or changed plan requires fresh confirmation.' : 'No run is queued. Approving this task does not preapprove a later run plan.'] : []),
    ...(report ? [`Report: ${report.reportId} · revision ${report.revision}`, short(report.body)] : [short(task.description || task.title)]),
    'Delivery is separate from task outcome.', `/task status ${task.taskId}`,
    `/task ${task.admissionState === 'dismissed' ? 'restore' : 'dismiss'} ${task.taskId} ${task.admissionRevision ?? 1}`,
    ...(canConfirm ? [`/task approve ${task.taskId} ${confirmation.revision}`, `/task reject ${task.taskId} ${confirmation.revision}`] : []),
    ...(run?.state === 'blocked' ? [`/task continue ${task.taskId} ${run.runId}`] : []),
    ...(run && ['queued', 'running', 'blocked'].includes(run.state) ? [`/task cancel ${task.taskId} ${run.runId}`] : []),
    ...(report?.artifactIds.length ? [`Stored artifacts: ${report.artifactIds.join(', ')}. Attachments have not been uploaded to Feishu.`] : [])];
  const elements: Json[] = [{ tag: 'div', text: { tag: 'plain_text', content: lines.join('\n') } }];
  if (actions.length) elements.push({ tag: 'column_set', columns: actions.map(action => ({
    tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'button', text: { tag: 'plain_text', content: action.action }, type: ['cancel', 'reject'].includes(action.action) ? 'danger' : 'default',
      behaviors: [{ type: 'callback', value: { dsh_action: action.token } }] }],
  })) });
  return { card: { schema: '2.0', config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: short(report?.title ?? task.title, 150) }, template: 'blue' }, body: { elements } } };
}

export function cardTokens(body: Outbound): string[] {
  const tokens: string[] = [];
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const obj = value as Record<string, unknown>;
    if (typeof obj.dsh_action === 'string') tokens.push(obj.dsh_action);
    Object.values(obj).forEach(visit);
  }
  if (body.card) visit(body.card);
  return tokens;
}

export function alertCard(alert: Alert): Outbound {
  const lines = [
    `Status: ${alert.status} · severity: ${alert.severity}`,
    `Alert ID: ${alert.alertId} · revision ${alert.revision}`,
    `Cycle: ${alert.cycle} · occurrences: ${alert.occurrences}`,
    ...(alert.taskId ? [`Task ID: ${alert.taskId}`] : []),
    ...(alert.nodeId ? [`Node ID: ${alert.nodeId}`] : []),
    alert.body.length > 3500 ? `${alert.body.slice(0, 3500)}\n[Excerpt; full text is retained in the alert ledger]` : alert.body,
    `Last observed: ${alert.lastSeenAt}`,
    ...(alert.acknowledgedAt ? [`Acknowledged: ${alert.acknowledgedAt}`] : []),
    ...(alert.resolvedAt ? [`Resolved: ${alert.resolvedAt}`] : []),
    ...(alert.actor ? [`Last decision by: ${alert.actor}`] : []),
    ...(alert.reason ? [`Decision reason: ${alert.reason.slice(0, 1000)}`] : []),
    'Alert acknowledgment and resolution do not change task execution outcomes.',
    `/alert show ${alert.alertId}`,
    ...(alert.status === 'open' ? [`/alert ack ${alert.alertId} ${alert.revision}`] : []),
    ...(alert.status !== 'resolved' ? [`/alert resolve ${alert.alertId} ${alert.revision}`] : []),
  ];
  return { card: {
    schema: '2.0', config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `Alert: ${alert.title.slice(0, 140)}` }, template: alert.severity === 'critical' ? 'red' : alert.severity === 'warning' ? 'orange' : 'blue' },
    body: { elements: [{ tag: 'div', text: { tag: 'plain_text', content: lines.join('\n') } }] },
  } };
}

/** Only the ledger's captured safe description is shown; raw tool arguments are never read. */
export function approvalCard(approval: ApprovalRequest, actions: ActionBinding[] = []): Outbound {
  const pending = approval.state === 'pending' && approval.expiresAt > Date.now();
  const lines = [
    `Runtime approval: ${approval.state}${approval.state === 'pending' && !pending ? ' (deadline elapsed)' : ''} · revision ${approval.revision}`,
    `Request ID: ${approval.requestId}`,
    `Tool: ${approval.toolName}`,
    `Concrete action: ${approval.description}`,
    `Arguments digest: ${approval.argumentsDigest}`,
    `Task: ${approval.taskId} · run: ${approval.runId}`,
    `Attempt: ${approval.attemptId} · node: ${approval.nodeId} · fence: ${approval.fence}`,
    `Execution: ${approval.executionId}`,
    `Session: ${approval.sessionId} · agent: ${approval.agentId} · call: ${approval.callId}`,
    `Expires: ${new Date(approval.expiresAt).toISOString()}`,
    'A decision applies once to this exact live native tool call. It does not approve future calls or confirm task completion.',
    ...(!approval.allowRemoteOnce ? ['This action cannot be allowed remotely. Review it in the host approval UI; remote denial remains available.'] : []),
    `/approval show ${approval.requestId}`,
    ...(pending && approval.allowRemoteOnce ? [`/approval once ${approval.requestId} ${approval.revision}`] : []),
    ...(pending ? [`/approval deny ${approval.requestId} ${approval.revision}`] : []),
  ];
  const elements: Json[] = [{ tag: 'div', text: { tag: 'plain_text', content: lines.join('\n') } }];
  if (actions.length) elements.push({ tag: 'column_set', columns: actions.map(action => ({
    tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'button', text: { tag: 'plain_text', content: action.action === 'approval-once' ? 'Allow once' : 'Deny' }, type: action.action === 'approval-deny' ? 'danger' : 'default',
      behaviors: [{ type: 'callback', value: { dsh_action: action.token } }] }],
  })) });
  return { card: { schema: '2.0', config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: 'Runtime tool approval' }, template: 'orange' }, body: { elements } } };
}

export function lifecycleCard(task: Task, kind: 'lifecycle.created' | 'lifecycle.terminal', run?: Run, report?: Report): Outbound {
  const lines = [kind === 'lifecycle.created' ? 'Task creation recorded. This message anchors later terminal updates.' : `Run terminal state: ${run?.state}`,
    `Task ID: ${task.taskId} · current task state: ${task.state}`,
    ...(run ? [`Run ID: ${run.runId}`] : []),
    ...(report ? [`Report: ${report.reportId} · revision ${report.revision}`, short(report.body)] : [short(task.description || task.title)]),
    'Message delivery is independent of execution outcome.', `/task status ${task.taskId}`,
    ...(report ? [`/task report ${task.taskId} ${report.reportId}`] : []),
  ];
  return { card: { schema: '2.0', config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `${kind === 'lifecycle.created' ? 'Task created' : `Run ${run?.state}`}: ${task.title.slice(0, 110)}` }, template: 'blue' },
    body: { elements: [{ tag: 'div', text: { tag: 'plain_text', content: lines.join('\n') } }] },
  } };
}
