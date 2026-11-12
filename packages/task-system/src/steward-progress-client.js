function groupStewardNotifications(messages) {
  const groups = [];
  let previousKey = null;
  for (const message of messages) {
    const scope = message.scope, taskId = message.provenance?.taskId;
    const eligible = message.role === 'notification' && taskId && scope &&
      ['personal', 'workbench', 'project'].includes(scope.kind) &&
      (scope.kind !== 'project' || scope.projectId) && !message.gate && !message.presentation?.needsDecision;
    if (!eligible) {
      groups.push({ kind: 'message', message });
      previousKey = null;
      continue;
    }
    const key = JSON.stringify([scope.kind, scope.kind === 'project' ? scope.projectId : scope.kind === 'workbench' ? scope.topicId ?? null : null, taskId]);
    const previous = groups.at(-1);
    if (previous?.kind === 'progress' && previousKey === key) previous.messages.push(message);
    else groups.push({ kind: 'progress', id: message.id, messages: [message] });
    previousKey = key;
  }
  return groups;
}

function createStewardProgressRenderer(React) {
  const h = React.createElement;
  const summary = message => message.presentation?.summary?.trim() || '';
  const targets = message => (message.presentation?.targets ?? []).filter(target => target.kind === 'file' || target.kind === 'record');
  const formatTime = (at, full = false) => {
    const date = new Date(at);
    return Number.isNaN(date.getTime()) ? null : full ? date.toLocaleString() : date.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const styles = `.steward-progress{margin:16px 0;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);font:inherit}.steward-progress-heading,.steward-progress-target,.steward-progress-record-heading{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}.steward-progress-heading strong{font-weight:600}.steward-progress time,.steward-progress small{font-size:12px;color:var(--dsw-alias-label-caption)}.steward-progress p{margin:6px 0;white-space:pre-wrap;max-width:75ch}.steward-progress .steward-progress-open{font:inherit;color:var(--dsw-alias-text-brand,#4475d6);background:transparent;border:0;padding:3px 0;cursor:pointer;text-align:left;min-height:28px}.steward-progress .steward-progress-open:hover:not(:disabled){text-decoration:underline;text-underline-offset:3px}.steward-progress .steward-progress-open:disabled{opacity:.5;cursor:default}.steward-progress .steward-progress-open:focus-visible,.steward-progress summary:focus-visible{outline:2px solid var(--dsw-alias-text-brand,#4475d6);outline-offset:3px;border-radius:3px}.steward-progress details{margin-top:8px}.steward-progress summary{cursor:pointer;color:var(--dsw-alias-label-secondary);width:fit-content}.steward-progress ol{list-style:none;padding:0;margin:12px 0 0}.steward-progress li{padding:0 0 16px;min-width:0}.steward-progress li:last-child{padding-bottom:0}.steward-progress code{font-size:12px;overflow-wrap:anywhere}.steward-progress pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:8px 0}.steward-progress-actions{margin-top:6px}.steward-progress .steward-icon-row{flex-wrap:wrap}@media(max-width:640px){.steward-progress-heading,.steward-progress-target,.steward-progress-record-heading{gap:5px 10px}}`;

  return function Progress({ messages, renderActions = () => null, renderDecision = () => null, onOpen }) {
    if (!messages.length) return null;
    const latest = messages.at(-1), recent = [...messages].reverse();
    const presented = recent.find(message => message.presentation?.emphasis === 'state' && summary(message)) ?? recent.find(message => summary(message));
    const material = recent.find(message => message.presentation?.materialNotice?.trim());
    const title = recent.find(message => message.presentation?.taskTitle?.trim())?.presentation.taskTitle || '任务进展';
    const pending = !summary(latest);
    const primaryCandidates = recent.flatMap(message => targets(message).map(target => ({ message, target })));
    const primary = primaryCandidates.find(item => item.target.kind === 'file') ?? primaryCandidates.find(item => item.target.kind === 'record');
    const action = (message, target) => {
      const label = target.label || (target.kind === 'file' ? '查看文件' : '查看进度记录');
      return h('button', { key: target.id, type: 'button', className: 'steward-progress-open', disabled: typeof onOpen !== 'function',
        'aria-label': label,
        onClick: () => onOpen?.(message.id, target.id) }, label);
    };
    const primarySource = primary && primary.message !== latest ? '来自此前的进度说明' : null;
    const time = formatTime(latest.createdAt);
    return h('section', { className: 'steward-progress', 'aria-label': `任务进展：${title}`, 'data-steward-progress-id': messages[0].id },
      h('style', null, styles),
      h('div', { className: 'steward-progress-heading' }, h('strong', null, title), time && h('time', { dateTime: latest.createdAt }, time)),
      h('p', { className: 'steward-progress-summary' }, presented ? summary(presented) : '正在读取这项工作的进展…'),
      pending && presented && h('small', { role: 'status' }, '正在读取最新进展…'),
      material && h('p', { className: 'steward-progress-material' }, material.presentation.materialNotice),
      messages.filter(message=>message.gate).map(message=>h('div',{key:message.id},renderDecision(message))),
      primary && h('div', { className: 'steward-progress-target' }, action(primary.message, primary.target), primarySource && h('small', null, primarySource)),
      h('details', { className: 'steward-progress-history' }, h('summary', null, '查看进展与依据'),
        h('ol', null, messages.map(message => {
          const at = formatTime(message.createdAt, true), runId = message.provenance?.runId;
          return h('li', { key: message.id, 'data-message-id': message.id },
            h('div', { className: 'steward-progress-record-heading' }, at && h('time', { dateTime: message.createdAt }, at),
              runId ? h('span', null, '执行 ', h('code', null, runId)) : h('span', null, '任务级记录（未关联某次执行）')),
            h('p', null, summary(message) || '这条进展的说明尚未读取。'),
            targets(message).length > 0 && h('div', { className: 'steward-progress-target' }, targets(message).map(target => action(message, target))),
            h('div', { className: 'steward-progress-actions steward-icon-row' }, renderActions(message, true)),
            h('details', { className: 'steward-progress-original' }, h('summary', null, '原始记录与依据'), h('pre', null, message.text)));
        }))));
  };
}
