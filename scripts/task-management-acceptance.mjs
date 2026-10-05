#!/usr/bin/env node
/** Real-device acceptance preparation/inspection only. DSH owns dispatch and settlement. */
import {closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {TaskLedger, canonical} from '../packages/task-system/dist/ledger.js';
import {Workbench} from '../packages/task-system/dist/workbench.js';
import {NATIVE_PROVIDER_UNAVAILABLE_SUMMARY} from '../packages/task-system/dist/contracts.js';
import {createDashboardServer} from '../dashboard/server.mjs';
import {managementAdapter} from '../dashboard/management.mjs';

export const ORIGINAL = Object.freeze({
  templateId: 'tpl_pc-au-game-daily-report', scheduleId: 'pc-au-game-daily-report',
  cron: '0 6 * * *', timeZone: 'Asia/Shanghai', schemaId: 'game_daily_report.v1',
  producer: '/Users/PMP_PC_AU/AppData/Local/hermes/scripts/auto_mas_daily_report.py',
  producerPlaceholder: '${PC_AU_HERMES_HOME}/scripts/auto_mas_daily_report.py',
});
const FORMAT = 'dsh-task-management-acceptance.v1';
const insist = (condition, message) => { if (!condition) throw new Error(message); };
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const ident = value => typeof value === 'string' && /^[\w][\w:./@-]{0,199}$/.test(value);
const required = (value, name) => { insist(typeof value === 'string' && value.trim(), `${name} is required`); return value; };
const manifestPath = db => `${db}.acceptance.json`;
function absolute(value, name) {
  required(value, name);
  insist(isAbsolute(value) && resolve(value) === value && value !== ':memory:', `${name} must be an explicit normalized absolute path`);
  return value;
}
function regularFile(file) {
  const stat = lstatSync(file);
  insist(stat.isFile() && !stat.isSymbolicLink(), `${file} must be a regular file, not a symlink`);
  return stat;
}
function readJson(file) {
  regularFile(file);
  insist(lstatSync(file).size <= 2_000_000, 'JSON input exceeds 2 MB');
  return JSON.parse(readFileSync(file, 'utf8'));
}
function saveManifest(manifest, initial = false) {
  const target = manifestPath(manifest.database.path);
  const data = `${JSON.stringify(manifest, null, 2)}\n`;
  if (initial) writeFileSync(target, data, {flag: 'wx', mode: 0o600});
  else {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, data, {flag: 'wx', mode: 0o600}); renameSync(temporary, target); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
}
export function readManifest(db) {
  absolute(db, '--db');
  const manifest = readJson(manifestPath(db));
  insist(manifest.format === FORMAT && manifest.database?.path === db && manifest.database.databaseId, 'Not an acceptance database manifest');
  const stat = regularFile(db);
  insist(realpathSync(db) === db && String(stat.dev) === manifest.file.dev && String(stat.ino) === manifest.file.ino,
    'Database file identity changed; do not point acceptance at an existing/production database');
  return manifest;
}
const options = (manifest, readOnly = false) => ({role: 'planner', nodeId: manifest.authorityNodeId, readOnly,
  reportDestinations: [], alertDestinations: [], approvalDestinations: [], lifecycleDestinations: []});

export function initialize({db, authorityNode, executorJournal, label}) {
  absolute(db, '--db'); absolute(executorJournal, '--executor-journal');
  insist(db !== executorJournal, 'Authority database and MBP executor journal must be separate paths');
  insist(ident(authorityNode), '--authority-node must be the inspected authority node ID');
  required(label, '--label');
  insist(realpathSync(dirname(db)) === dirname(db), 'Database parent must exist and have no symlink components');
  for (const suffix of ['', '-wal', '-shm', '.acceptance.json', '.acceptance.lock'])
    insist(!existsSync(`${db}${suffix}`), `Refusing existing path: ${db}${suffix}`);
  // Exclusive creation prevents silently adopting a production or previous acceptance ledger.
  closeSync(openSync(db, 'wx', 0o600));
  const ledger = TaskLedger.open(db, {role: 'planner', nodeId: authorityNode});
  try { ledger.snapshot(); } finally { ledger.close(); }
  const stat = regularFile(db);
  const manifest = {format: FORMAT, database: {databaseId: randomUUID(), label, path: db},
    file: {dev: String(stat.dev), ino: String(stat.ino)}, authorityNodeId: authorityNode,
    executorJournal, createdAt: new Date().toISOString()};
  saveManifest(manifest, true);
  return {status: 'initialized', database: manifest.database, executorJournal, next: 'Start the inspected DSH acceptance profiles, then seed'};
}
function walk(value, visit) {
  visit(value);
  if (Array.isArray(value)) value.forEach(item => walk(item, visit));
  else if (record(value)) Object.values(value).forEach(item => walk(item, visit));
}
/** Input is a normalized, reviewed export of the original VPS task, not a test fixture. */
export function validateSource(source) {
  insist(source?.format === 'dsh-task-management-source.v1', 'Expected normalized original VPS source export');
  insist(record(source.source) && required(source.source.label, 'source.label') && Number.isFinite(Date.parse(source.source.exportedAt)), 'Source provenance is required');
  insist(record(source.task) && ident(source.task.taskId), 'Original task.taskId must come from the VPS export');
  required(source.task.title, 'original task.title');
  insist(typeof source.task.description === 'string', 'Original task.description is required');
  const {template, schedule} = source;
  insist(template?.templateId === ORIGINAL.templateId && Number.isInteger(template.version) && template.version > 0, 'Wrong original template identity/version');
  insist(schedule?.scheduleId === ORIGINAL.scheduleId && schedule.taskId === source.task.taskId &&
    schedule.templateId === template.templateId && schedule.templateVersion === template.version,
  'Original task/template/schedule identities do not agree');
  insist(schedule.enabled === false && schedule.cron === ORIGINAL.cron && schedule.timeZone === ORIGINAL.timeZone,
    'Exported acceptance schedule must be disabled, at 0 6 * * * / Asia/Shanghai');
  insist(record(template.defaults) && record(schedule.input), 'Original template defaults and schedule input must be objects');
  // Do not rebuild a result schema, inject a fallback, or substitute another producer.
  // Legacy defaults are preserved software configuration, not adapter input fields.
  const input = structuredClone(schedule.input);
  let producer = false, schema = false, manual = false;
  walk([template.defaults, input], item => {
    if (typeof item === 'string' && (item.includes(ORIGINAL.producer) || item === ORIGINAL.producerPlaceholder)) producer = true;
    if (record(item) && Object.hasOwn(item, 'manual_json_fallback')) {
      insist(item.manual_json_fallback === false, 'manual_json_fallback must remain false'); manual = true;
    }
  });
  walk([template.resultContract, template.defaults, input], item => { if (item === ORIGINAL.schemaId) schema = true; });
  insist(producer && schema && manual, 'Export must retain the original producer, game_daily_report.v1, and manual_json_fallback=false in actual configuration');
  walk(source, item => {
    if (record(item)) for (const key of Object.keys(item))
      insist(!/^(?:api[_-]?key|password|passwd|secret|access[_-]?token|authorization|private[_-]?key)$/i.test(key), 'Do not include credentials in the source export');
  });
  return {template, input};
}
function sourceMetadata(source) {
  const metadata = structuredClone(source);
  if (record(metadata.contractReference)) delete metadata.contractReference.sourceCode;
  return metadata;
}


export function seed({db, templateJson, node, provider, model, workspace, reasoningEffort, requiredCapabilities, allowedTools, maxRuntimeMs}) {
  const manifest = readManifest(db);
  const source = readJson(absolute(templateJson, '--template-json'));
  const {template, input} = validateSource(source);
  for (const [name, value] of Object.entries({node, provider, model, workspace})) required(value, `--${name}`);
  insist(Array.isArray(requiredCapabilities) && requiredCapabilities.every(ident), 'Explicit --required-capabilities is required (use - for none)');
  insist(Array.isArray(allowedTools) && allowedTools.every(ident), 'Explicit --allowed-tools is required (use - for none)');
  insist(Number.isSafeInteger(maxRuntimeMs) && maxRuntimeMs >= 100 && maxRuntimeMs <= 86400000, 'Explicit --max-runtime-ms must be 100..86400000');
  const route = {nodeId: node, provider, model, workspaceId: workspace, requiredCapabilities,
    ...(reasoningEffort ? {reasoningEffort} : {})};
  const lock = `${db}.acceptance.lock`;
  closeSync(openSync(lock, 'wx', 0o600));
  let ledger;
  try {
    ledger = TaskLedger.open(db, options(manifest));
    // These objects MUST already have been registered from the real inspected DSH configuration.
    ledger.validateRoute(route);
    const status = ledger.nodeStatuses().find(row => row.nodeId === node);
    insist(status?.state === 'online' && status.source === 'authenticated-peer' && status.runtimeReady === true,
      'A fresh authenticated MBP DSH runtime heartbeat is required; this script never invents an executor');
    insist(node !== manifest.authorityNodeId, 'Acceptance requires the remote MBP executor, not the authority node');
    insist(ledger.snapshot().schedules.length === 0 && ledger.deliveries().length === 0, 'Acceptance database must contain no schedules or notifications');
    if (!manifest.seed) insist(ledger.snapshot().tasks.length === 0 && ledger.snapshot().runs.length === 0, 'Refusing a non-empty acceptance workload');
    const prefix = `acceptance:${manifest.database.databaseId}`;
    const planned = {taskId: source.task.taskId, runId: `${prefix}:run`, domainId: `${prefix}:domain`,
      projectId: `${prefix}:project`, backlogId: `${prefix}:backlog`, templateRef: {templateId: template.templateId, version: template.version},
      route, allowedTools, maxRuntimeMs, source: sourceMetadata(source.source),
      exportedSchedule: {scheduleId: source.schedule.scheduleId, cron: source.schedule.cron, timeZone: source.schedule.timeZone, enabled: false},
      ...(source.source.contractReference ? {semanticValidation: {status: 'not-established',
        sourceModule: source.source.contractReference.sourceModule, entrypoint: source.source.contractReference.entrypoint}} : {})};
    if (manifest.seed) insist(canonical(manifest.seed) === canonical(planned), 'Seed identity/route/source changed; use the exact prior command for recovery');
    else { manifest.seed = planned; saveManifest(manifest); }
    const cmd = suffix => `${prefix}:${suffix}`;
    const workbench = new Workbench(ledger);
    ledger.updateTemplate(cmd('template'), template);
    workbench.manage(cmd('domain'), 'create_domain', {domainId: planned.domainId, title: '日常自动化', summary: '原 VPS 二游日常任务的隔离互联验收'});
    workbench.manage(cmd('project'), 'create_project', {projectId: planned.projectId, title: '二游日常', state: 'active',
      goal: '保留原任务与模板配置，验证 VPS 派活、MBP DSH 执行和可追溯结果', nextStep: '检查实际执行归属、报告和失败原因'});
    workbench.manage(cmd('domain-project'), 'link_domain_project', {domainId: planned.domainId, projectId: planned.projectId});
    workbench.manage(cmd('backlog'), 'create_backlog', {backlogId: planned.backlogId, projectId: planned.projectId,
      title: '原二游日常任务可跨设备执行并展示真实结果', goal: '缺脚本、日志或供应商能力时保留真实失败证据', priority: 'normal',
      acceptanceCriteria: [{criterionId: 'real-device-chain', kind: 'manual_check', description: '核对真实设备 Task/Run/Attempt/Report 与新库 WebUI', requiredEvidence: '真实 DSH 会话、MBP journal、数据库及 UI；失败也必须如实展示'}]});
    ledger.createTask(cmd('task'), {taskId: source.task.taskId, title: source.task.title, description: source.task.description,
      workspaceId: workspace, tags: ['real-device-acceptance', ORIGINAL.templateId],
      policy: {allowedNodeIds: [node], allowedWorkspaceIds: [workspace], allowedTools, maxRuntimeMs}});
    workbench.manage(cmd('backlog-task'), 'link_backlog_task', {backlogId: planned.backlogId, taskId: planned.taskId});
    workbench.manage(cmd('project-workspace'), 'link_project_workspace', {projectId: planned.projectId, workspaceId: workspace, isDefault: true});
    const note = ledger.appendReport(cmd('note'), {reportId: `${prefix}:note`, taskId: planned.taskId, kind: 'note',
      title: '隔离互联验收要求', body: [
        '这是原 VPS 二游日常任务的独立数据库验收。保持原 producer 定义和 manual_json_fallback=false；不得编造脚本、日志、报告或成功。实际缺失或权限不足时，通过原生 task_settle 如实提交失败及已有证据；不要改变计划或发送通知。',
        '如果原生 Agent 已实际运行并观察到缺失，请在 task_settle 的 reportTitle/reportBody 中仅记录真实失败及已有证据；不要填写或伪造 game_daily_report.v1 游戏结果 data。根本未启动模型时保留宿主的系统事件，不补造 Agent 报告。',
        'Template.defaults 保留原软件配置，不是本次 Run.input；执行 route 只使用本次显式授权的真实 MBP 节点/模型/workspace。不要用原设备/原模型声明覆盖它。',
        ...(template.defaults.report_producer ? [`原 producer 定义：${JSON.stringify(template.defaults.report_producer)}；PC_AU_HERMES_HOME 未在本次导出中解析，不得猜成 MBP 路径；未指定业务日期时不得编造 --date。`] : []),
        ...(template.defaults.sourceExecutionRoute ? [`历史软件路由（不是本次执行授权）：${JSON.stringify(template.defaults.sourceExecutionRoute)}`] : []),
        ...(source.source.normalization ? [`导出适配说明：${JSON.stringify(source.source.normalization)}`] : []),
        ...(source.source.contractReference ? ['原 Python 语义校验仅有参考声明，本流程未执行或注册它。成功/partial 游戏结果不能被本次验收视为语义已验证；先如实验证实际阻塞或失败。'] : []),
      ].join('\n')}).value;
    const run = ledger.createRun(cmd('run'), {runId: planned.runId, taskId: planned.taskId, route,
      configuration: {templateRef: planned.templateRef, input, notifyUserOnTerminal: false, reporting: 'none', trigger: 'manual-real-device-acceptance'},
      contextNotes: [note.reportId]}).value;
    return {status: 'seeded', runState: ledger.getRun(run.runId).state, database: manifest.database, taskId: planned.taskId, runId: run.runId,
      templateRef: planned.templateRef, route, originalScheduleUntouched: true, notifications: 'off',
      note: 'Only the real DSH remote plugin may claim, execute and settle this run'};
  } finally { ledger?.close(); unlinkSync(lock); }
}

export function inspectPersisted(manifest, ledger) {
  const seed = manifest.seed;
  insist(seed, 'Database is initialized but not seeded');
  const snapshot = ledger.snapshot(), workbench = new Workbench(ledger).snapshot();
  const task = snapshot.tasks.find(row => row.taskId === seed.taskId);
  const run = snapshot.runs.find(row => row.runId === seed.runId);
  insist(task && run && run.taskId === task.taskId, 'Seeded Task/Run not found; seed may need exact-command recovery');
  insist(canonical(run.route) === canonical(seed.route), 'Persisted route differs from the inspected route');
  insist(canonical(run.configuration.templateRef) === canonical(seed.templateRef), 'Run must pin the original template version');
  insist(run.configuration.notifyUserOnTerminal === false && snapshot.schedules.length === 0 && ledger.deliveries().length === 0, 'Schedule/notification isolation violated');
  insist(workbench.domainProjects.some(x => x.domainId === seed.domainId && x.projectId === seed.projectId) &&
    workbench.backlogs.some(x => x.backlogId === seed.backlogId && x.projectId === seed.projectId) &&
    workbench.backlogTasks.some(x => x.backlogId === seed.backlogId && x.taskId === task.taskId), 'Management chain is incomplete');
  const attempts = snapshot.attempts.filter(row => row.runId === run.runId);
  const reports = snapshot.reports.filter(row => row.runId === run.runId && row.taskId === task.taskId);
  const events = snapshot.events.filter(row => row.runId === run.runId && ['run.settled', 'run.pre_dispatch_failed'].includes(row.type));
  const actual = attempts.find(row => row.attemptId === run.currentAttemptId) ?? attempts.at(-1);
  for (const attempt of attempts) insist(attempt.nodeId === seed.route.nodeId && attempt.taskId === task.taskId, 'Actual execution owner differs from the authorized MBP route');
  const resultReport = reports.findLast(row => row.kind === 'result' && row.attemptId === actual?.attemptId);
  // Only the core's explicit, lease-bound pre-agent event establishes this path.
  // A text mention of NO_ADAPTER or a later unknown stream failure does not.
  const preDispatch = events.findLast(row => row.type === 'run.pre_dispatch_failed' && row.taskId === task.taskId &&
    row.detail?.origin === 'native-adapter' && row.detail.phase === 'before-agent-start' && row.detail.code === 'NO_ADAPTER' &&
    row.detail.provider === seed.route.provider && row.detail.model === seed.route.model &&
    row.detail.attemptId === actual?.attemptId && row.detail.nodeId === actual?.nodeId &&
    row.detail.summary === NATIVE_PROVIDER_UNAVAILABLE_SUMMARY);
  const systemBlock = run.state === 'blocked' && Boolean(preDispatch) && reports.length === 0;
  const systemFailure = systemBlock ? {eventId: preDispatch.eventId, type: preDispatch.type, taskId: preDispatch.taskId,
    runId: preDispatch.runId, detail: Object.fromEntries(['origin', 'phase', 'code', 'provider', 'model', 'attemptId', 'nodeId', 'summary'].map(key => [key, preDispatch.detail[key]]))} : undefined;
  const diagnostics = [...events.map(row => row.detail?.summary), resultReport?.body].filter(x => typeof x === 'string' && x.trim()).map(x => x.slice(0, 5000));
  let status = 'pending';
  const missing = [];
  if (!['queued', 'running'].includes(run.state)) {
    if (!actual?.executionId || !Number.isSafeInteger(actual.fence) || actual.fence < 1) missing.push('Actual fenced attempt executionId');
    if (!systemBlock && !actual?.sessionId) missing.push('Actual native sessionId');
    if (!systemBlock && !resultReport) missing.push('Persisted result Report bound to the actual Attempt');
    if (systemBlock && actual?.state !== 'settled') missing.push('Pre-dispatch block must have a settled actual Attempt');
    if (run.state === 'uncertain') missing.push('Uncertain outcome requires reconciliation; no success/failure is inferred');
    if (run.state !== 'succeeded' && !diagnostics.length) missing.push('Failure/cancellation/partial diagnostic');
    if (run.state === 'succeeded' && resultReport?.schemaId !== ORIGINAL.schemaId) missing.push('Successful report schemaId game_daily_report.v1');
    if (['succeeded', 'partial'].includes(run.state) && seed.semanticValidation?.status === 'not-established')
      missing.push('Original Python semantic validation is not established; structural JSON Schema is not semantic acceptance');
    status = missing.length ? 'inconclusive' : 'persisted';
  }
  return {status, database: manifest.database, taskId: task.taskId, taskState: task.state,
    runId: run.runId, runState: run.state, currentAttemptId: actual?.attemptId, plannedRoute: run.route,
    evidenceKind: systemBlock ? 'system-pre-dispatch-block' : resultReport ? 'workload-report' : 'not-established',
    workloadExecution: systemBlock ? 'not-started' : resultReport ? 'reported' : 'unknown',
    ...(systemFailure ? {systemFailure} : {}),
    ...(seed.semanticValidation ? {semanticValidation: seed.semanticValidation} : {}),
    attempts: attempts.map(({attemptId, nodeId, state, sessionId, executionId, fence}) => ({attemptId, nodeId, state, sessionId, executionId, fence})),
    reports: reports.map(({reportId, attemptId, kind, schemaId, body}) => ({reportId, attemptId, kind, schemaId, excerpt: body.slice(0, 5000)})),
    diagnostics, missing, humanAcceptance: 'not asserted'};
}
function validateUiUrl(value) {
  const url = new URL(value);
  insist(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) &&
    !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith('/api/workbench'),
  '--ui-url must be the explicit loopback /api/workbench URL (use an already authorized tunnel if remote)');
  return url;
}
export async function verify({db, uiUrl, journalEvidence}) {
  const manifest = readManifest(db), ledger = TaskLedger.open(db, options(manifest, true));
  let result;
  try { result = inspectPersisted(manifest, ledger); } finally { ledger.close(); }
  if (uiUrl) {
    const response = await fetch(validateUiUrl(uiUrl), {redirect: 'error', signal: AbortSignal.timeout(10000)});
    insist(response.ok, `UI API returned HTTP ${response.status}`);
    const ui = await response.json();
    insist(ui.schemaVersion === 'management.v1' && canonical(ui.database) === canonical(result.database), 'UI points at a different database');
    const uiRun = ui.runs.find(x => x.runId === result.runId), uiTask = ui.tasks.find(x => x.taskId === result.taskId);
    insist(uiRun?.state === result.runState && uiTask?.state === result.taskState, 'UI Task/Run differs from persisted state; rerun after in-flight changes');
    for (const attempt of result.attempts) insist(ui.attempts.some(row => ['attemptId', 'nodeId', 'state', 'sessionId', 'executionId', 'fence'].every(key => row[key] === attempt[key])), 'UI actual Attempt is missing or stale');
    for (const report of result.reports) insist(ui.reports.some(row => row.reportId === report.reportId && row.attemptId === report.attemptId && row.schemaId === report.schemaId && row.body?.slice(0, 5000) === report.excerpt), 'UI Report content/schema/diagnostic is missing or stale');
    if (result.systemFailure) {
      const expected = result.systemFailure;
      insist(ui.events?.some(row => row.eventId === expected.eventId && row.type === expected.type &&
        row.taskId === expected.taskId && row.runId === expected.runId &&
        Object.entries(expected.detail).every(([key, value]) => row.detail?.[key] === value)),
      'UI system-origin pre-dispatch reason/ownership is missing or stale');
    }
    result.ui = {verified: true, url: uiUrl};
  } else result.missing.push('UI API not checked; pass --ui-url');
  if (journalEvidence) {
    const evidence = readJson(absolute(journalEvidence, '--journal-evidence'));
    insist(evidence.format === 'dsh-task-management-journal.v1' && evidence.databaseId === manifest.database.databaseId &&
      evidence.runId === result.runId && evidence.path === manifest.executorJournal, 'Wrong MBP journal evidence identity');
    const actual = result.attempts.find(row => row.attemptId === result.currentAttemptId);
    insist(actual && evidence.dispatches.some(row => row.attemptId === actual.attemptId && row.nodeId === actual.nodeId &&
      row.fence === actual.fence && row.executionId === actual.executionId && row.state === 'acknowledged' &&
      (result.evidenceKind === 'system-pre-dispatch-block' && !actual.sessionId || row.sessionId === actual.sessionId)),
    'MBP journal has no matching acknowledged fenced native dispatch');
    result.journal = {verified: true, path: evidence.path};
  } else result.missing.push('MBP journal not checked; pass --journal-evidence');
  if (result.status === 'persisted') result.status = result.missing.length ? 'inconclusive' : 'verified';
  return result;
}

/** Run on the MBP; read only. Does not initialize, recover, dispatch or alter its journal. */
export function inspectJournal({manifestFile, journal}) {
  const manifest = readJson(absolute(manifestFile, '--manifest'));
  absolute(journal, '--journal'); regularFile(journal);
  insist(manifest.format === FORMAT && manifest.seed && journal === manifest.executorJournal && journal !== manifest.database.path, 'Journal must match the separately selected MBP path');
  const db = new DatabaseSync(journal, {readOnly: true});
  try {
    insist(Number(db.prepare('PRAGMA user_version').get().user_version) === 1, 'Unsupported remote journal schema');
    const rows = db.prepare("SELECT data FROM dispatches WHERE json_extract(data,'$.lease.runId')=?").all(manifest.seed.runId);
    const dispatches = rows.map(({data}) => JSON.parse(data)).map(row => ({attemptId: row.attemptId, state: row.state,
      nodeId: row.lease.nodeId, fence: row.lease.fence, executionId: row.lease.executionId, sessionId: row.sessionId}));
    return {format: 'dsh-task-management-journal.v1', databaseId: manifest.database.databaseId, runId: manifest.seed.runId,
      path: journal, observedAt: new Date().toISOString(), dispatches};
  } finally { db.close(); }
}
export async function serve({db, port}) {
  const manifest = readManifest(db);
  insist(Number.isInteger(port) && port >= 1024 && port <= 65535 && ![8443, 3098, 18440].includes(port), 'Choose an explicit unprivileged test UI port, not 8443/3098/18440');
  const ledger = TaskLedger.open(db, options(manifest));
  const server = createDashboardServer({snapshot: () => ledger.snapshot(), management: managementAdapter(ledger, new Workbench(ledger)),
    databaseIdentity: manifest.database, localRole: 'manager', accessLabel: '隔离验收库', accessDescription: '仅本机 · 私有任务管理'});
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { ledger.close(); throw error; }
  const close = () => { server.close(() => ledger.close()); server.closeIdleConnections(); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  return {status: 'serving', database: manifest.database, url: `http://127.0.0.1:${port}/manage.html`, api: `http://127.0.0.1:${port}/api/workbench`};
}
const HELP = `Real-device acceptance (Node >=24; npm run build first)
  init --db NEW_ABSOLUTE_PATH --authority-node REAL_ID --executor-journal MBP_ABSOLUTE_PATH --label LABEL
  seed --db PATH --template-json VPS_EXPORT --node REAL_ID --provider REAL_PROVIDER --model REAL_MODEL
       --workspace REGISTERED_ID --required-capabilities LIST_OR_- --allowed-tools LIST_OR_- --max-runtime-ms NUMBER [--reasoning-effort VALUE]
  serve --db PATH --port TEST_PORT
  verify --db PATH [--ui-url http://127.0.0.1:PORT/api/workbench] [--journal-evidence MBP_EVIDENCE_JSON]
  journal --manifest COPIED_ACCEPTANCE_JSON --journal MBP_ABSOLUTE_PATH
No device registration, custom dispatcher, fabricated credentials, schedule enablement or notification is performed.
Verify exit codes: 0 = full persisted + UI + journal check; 2 = pending/inconclusive; 1 = rejected/error.
`;
export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === 'help') { console.log(HELP); return; }
  const allowed = {
    init: ['db','authority-node','executor-journal','label'],
    seed: ['db','template-json','node','provider','model','workspace','required-capabilities','allowed-tools','max-runtime-ms','reasoning-effort'],
    serve: ['db','port'], verify: ['db','ui-url','journal-evidence'], journal: ['manifest','journal'],
  }[command];
  insist(allowed, 'Unknown acceptance command');
  const parsed = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i].replace(/^--/, '');
    insist(args[i] === `--${name}` && allowed.includes(name) && !Object.hasOwn(parsed, name) && args[i + 1] && !args[i + 1].startsWith('--'), `Unknown, duplicate or missing option: ${args[i]}`);
    parsed[name] = args[i + 1];
  }
  const list = name => parsed[name] === undefined ? undefined : parsed[name] === '-' ? [] : parsed[name].split(',');
  const opts = {db: parsed.db, authorityNode: parsed['authority-node'], executorJournal: parsed['executor-journal'], label: parsed.label,
    templateJson: parsed['template-json'], node: parsed.node, provider: parsed.provider, model: parsed.model, workspace: parsed.workspace,
    requiredCapabilities: list('required-capabilities'), allowedTools: list('allowed-tools'), maxRuntimeMs: Number(parsed['max-runtime-ms']),
    reasoningEffort: parsed['reasoning-effort'], port: Number(parsed.port), uiUrl: parsed['ui-url'], journalEvidence: parsed['journal-evidence'],
    manifestFile: parsed.manifest, journal: parsed.journal};
  const result = await ({init: initialize, seed, serve, verify, journal: inspectJournal})[command](opts);
  console.log(JSON.stringify(result, null, 2));
  if (command === 'verify' && result.status !== 'verified') process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { console.error(`Acceptance stopped: ${error.message}`); process.exitCode = 1; });
