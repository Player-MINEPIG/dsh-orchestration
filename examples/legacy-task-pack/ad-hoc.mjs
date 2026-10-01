// SPDX-License-Identifier: MIT
import { canonicalJson, ReportContractError } from './reporting.mjs';
const inputs = new WeakMap();
const check = (value, message) => { if (!value) throw new ReportContractError(message); };
const text = (value, label, limit = 1000) => { check(typeof value === 'string' && value.trim() && value.length <= limit, `Invalid bounded ${label}`); return value; };
const exact = (value, keys, label) => { check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)), `Invalid ${label} fields`); };
const number = (value, label) => { check(Number.isSafeInteger(value) && value >= 0, `Invalid ${label}`); return value; };
const statuses = ['completed', 'ongoing', 'failed', 'blocked', 'uncertain'];
const tokens = value => {
  const result = {};
  for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens']) result[key] = value?.[key] === null || value?.[key] === undefined ? null : number(value[key], key);
  result.observability = value?.observability ?? (Object.values(result).some(v => v === null) ? 'unavailable' : 'partial');
  check(['exact', 'partial', 'unavailable'].includes(result.observability), 'Invalid token observability');
  return result;
};
const errors = source => (source?.data_quality?.errors ?? []).map(e => String(e.message ?? e).slice(0, 1000));
/** Capture compact immutable reader evidence. No source paths or raw message text enter the report. */
export function createDailyWorkInput({ nodeId, codex, hermes, semantic, language = 'zh' }) {
  text(nodeId, 'node ID', 256); check(['zh', 'en'].includes(language), 'Unsupported summary language');
  check(codex?.schema_version === 'codex_daily_activity.v1' && hermes?.schema_version === 'hermes_daily_activity.v1', 'Reviewed Codex and Hermes reader outputs are required');
  const window = codex.window;
  check(window && Date.parse(window.start) < Date.parse(window.end) && canonicalJson(window) === canonicalJson(hermes.window), 'Collector report windows differ');
  const evidence = [], sessions = [];
  for (const [runtime, rows] of [['codex', codex.top_level_sessions], ['hermes', hermes.local_unregistered_sessions]]) {
    check(Array.isArray(rows), 'Missing reader session inventory');
    const seen = new Set();
    for (const session of rows) {
      text(session.session_id, 'session ID', 512); check(!seen.has(session.session_id), 'Repeated reader session'); seen.add(session.session_id);
      const started = runtime === 'codex' ? session.created_at : session.session_started_at;
      check(Number.isFinite(Date.parse(started)), 'Missing source session creation time');
      sessions.push({ runtime, session_id: session.session_id, new_in_window: Date.parse(started) >= Date.parse(window.start) && Date.parse(started) < Date.parse(window.end) });
      check(Array.isArray(session.turns), 'Missing reader turn inventory');
      for (const turn of session.turns) {
        text(turn.turn_id, 'turn ID', 512);
        const hasFinal = runtime === 'codex' ? turn.has_final_answer === true : Boolean(turn.final_answer);
        evidence.push({ source_ref: `${runtime}:${session.session_id}:${turn.turn_id}`, runtime, session_id: session.session_id, turn_id: turn.turn_id, has_final_answer: hasFinal, source_status: runtime === 'hermes' && statuses.includes(turn.status) ? turn.status : hasFinal ? 'completed' : 'ongoing' });
      }
    }
  }
  check(evidence.length <= 4096 && new Set(evidence.map(t => t.source_ref)).size === evidence.length, 'Repeated or excessive source turn evidence');
  if (codex.counts) {
    check(codex.counts.top_level_session_count === sessions.filter(s => s.runtime === 'codex').length && codex.counts.user_turn_count === evidence.filter(t => t.runtime === 'codex').length, 'Codex counts disagree with included turn evidence');
    check(codex.counts.new_session_count === sessions.filter(s => s.runtime === 'codex' && s.new_in_window).length && codex.counts.continued_session_count === sessions.filter(s => s.runtime === 'codex' && !s.new_in_window).length, 'Codex session age counts disagree with evidence');
  }
  if (hermes.counts) check(hermes.counts.local_user_turn_count === evidence.filter(t => t.runtime === 'hermes').length && hermes.counts.local_unregistered_session_count === sessions.filter(s => s.runtime === 'hermes').length, 'Hermes counts disagree with included turn evidence');
  const notes = [...errors(codex), ...errors(hermes)];
  const complete = codex.data_quality?.complete === true && hermes.data_quality?.complete === true && codex.counts !== null && hermes.counts !== null;
  return { schema_version: 'daily_work_summary_input.v1', node_id: nodeId, language, window: structuredClone(window), source_evidence: evidence, sessions,
    usage: { codex_all: tokens(codex.token_totals_all_sessions), codex_top_level: tokens(codex.token_totals_top_level_sessions), hermes_local: tokens(hermes.usage_local_sessions) },
    data_quality: { complete, status: complete ? 'complete' : !codex.counts && !hermes.counts ? 'unavailable' : 'partial', notes: [...notes, ...(codex.counts === null ? ['Codex source unavailable'] : []), ...(hermes.counts === null ? ['Hermes source unavailable'] : [])] }, semantic: structuredClone(semantic) };
}
export function buildDailyWorkSummary(input) {
  exact(input, ['schema_version', 'node_id', 'language', 'window', 'source_evidence', 'sessions', 'usage', 'data_quality', 'semantic'], 'daily-work builder input');
  check(input.schema_version === 'daily_work_summary_input.v1', 'Unknown daily-work input schema'); text(input.node_id, 'node ID', 256); check(['zh', 'en'].includes(input.language), 'Invalid report language');
  check(input.window && Number.isFinite(Date.parse(input.window.start)) && Date.parse(input.window.start) < Date.parse(input.window.end), 'Invalid report window');
  check(Array.isArray(input.source_evidence) && input.source_evidence.length <= 4096 && Array.isArray(input.sessions), 'Invalid source inventory');
  const source = new Map();
  for (const item of input.source_evidence) {
    exact(item, ['source_ref', 'runtime', 'session_id', 'turn_id', 'has_final_answer', 'source_status'], 'source turn');
    text(item.source_ref, 'turn reference', 1600); text(item.session_id, 'session', 512); text(item.turn_id, 'turn', 512);
    check(['codex', 'hermes'].includes(item.runtime) && item.source_ref === `${item.runtime}:${item.session_id}:${item.turn_id}` && typeof item.has_final_answer === 'boolean' && statuses.includes(item.source_status) && !source.has(item.source_ref), 'Invalid or repeated source reference');
    source.set(item.source_ref, item);
  }
  const sessionIds = new Set();
  for (const session of input.sessions) { exact(session, ['runtime', 'session_id', 'new_in_window'], 'session evidence'); check(['codex', 'hermes'].includes(session.runtime) && typeof session.new_in_window === 'boolean', 'Invalid session evidence'); const key = `${session.runtime}:${session.session_id}`; check(!sessionIds.has(key), 'Repeated session evidence'); sessionIds.add(key); }
  check([...source.values()].every(t => sessionIds.has(`${t.runtime}:${t.session_id}`)), 'Turn belongs to missing session');
  exact(input.semantic, ['turns', 'groups', 'attention'], 'summary semantic input');
  check(Array.isArray(input.semantic.turns) && input.semantic.turns.length === source.size && Array.isArray(input.semantic.groups) && input.semantic.groups.length <= 100 && Array.isArray(input.semantic.attention) && input.semantic.attention.length <= 100, 'Invalid semantic inventory');
  const turns = new Map();
  for (const turn of input.semantic.turns) {
    exact(turn, ['source_ref', 'status'], 'semantic turn'); const original = source.get(turn.source_ref);
    check(original && !turns.has(turn.source_ref) && statuses.includes(turn.status), 'Invented/repeated semantic turn');
    check(turn.status !== 'completed' || original.has_final_answer && !['failed', 'blocked', 'uncertain'].includes(original.source_status), 'Completed turn lacks trustworthy final evidence');
    turns.set(turn.source_ref, turn.status);
  }
  const partition = new Set(), groupIds = new Set();
  const themes = input.semantic.groups.map(group => {
    exact(group, ['group_id', 'title', 'importance', 'turn_refs', 'accomplishments'], 'summary group'); text(group.group_id, 'group ID', 256); text(group.title, 'theme title', 500);
    check(!groupIds.has(group.group_id), 'Repeated theme ID'); groupIds.add(group.group_id); number(group.importance, 'importance'); check(group.importance <= 100, 'Importance exceeds range');
    check(Array.isArray(group.turn_refs) && group.turn_refs.length && Array.isArray(group.accomplishments) && group.accomplishments.length >= 2 && group.accomplishments.length <= 5, 'Theme needs turn evidence and 2–5 concrete accomplishments/decisions');
    group.accomplishments.forEach(value => text(value, 'accomplishment'));
    for (const ref of group.turn_refs) { check(source.has(ref) && !partition.has(ref), 'Invented/repeated theme evidence'); partition.add(ref); }
    return { theme_id: group.group_id, title: group.title, importance: group.importance, turn_count: group.turn_refs.length, completed_turn_count: group.turn_refs.filter(ref => turns.get(ref) === 'completed').length, share_percent: Math.round(group.turn_refs.length / source.size * 10000) / 100, accomplishments: [...group.accomplishments], turn_refs: [...group.turn_refs] };
  });
  check(partition.size === source.size, 'Missing source turns from semantic partition'); themes.sort((a, b) => b.turn_count - a.turn_count || b.importance - a.importance || a.theme_id.localeCompare(b.theme_id));
  const attention = input.semantic.attention.map(item => {
    exact(item, ['title', 'detail', 'turn_refs'], 'attention item'); text(item.title, 'attention title', 500); text(item.detail, 'attention detail');
    check(Array.isArray(item.turn_refs) && item.turn_refs.length && new Set(item.turn_refs).size === item.turn_refs.length && item.turn_refs.every(ref => source.has(ref) && turns.get(ref) !== 'completed'), 'Attention needs actual unresolved turn evidence');
    return structuredClone(item);
  });
  const userTurns = Object.fromEntries(statuses.map(s => [s, [...turns.values()].filter(value => value === s).length])); userTurns.total = source.size;
  const countSessions = runtime => { const rows = input.sessions.filter(s => s.runtime === runtime); return { total: rows.length, new: rows.filter(s => s.new_in_window).length, continued: rows.filter(s => !s.new_in_window).length }; };
  const report = { schema_version: 'daily_work_summary.v1', device_id: input.node_id, language: input.language, window: structuredClone(input.window), summary: { theme_count: themes.length, sessions: { codex: countSessions('codex'), hermes: countSessions('hermes') }, session_evidence: structuredClone(input.sessions), user_turns: userTurns }, themes, attention,
    source_evidence: input.source_evidence.map(turn => ({ ...structuredClone(turn), summary_status: turns.get(turn.source_ref) })), usage: { codex_all: tokens(input.usage.codex_all), codex_top_level: tokens(input.usage.codex_top_level), hermes_local: tokens(input.usage.hermes_local) }, data_quality: structuredClone(input.data_quality) };
  check(['complete', 'partial', 'unavailable'].includes(report.data_quality.status) && typeof report.data_quality.complete === 'boolean' && report.data_quality.complete === (report.data_quality.status === 'complete') && Array.isArray(report.data_quality.notes) && report.data_quality.notes.every(n => typeof n === 'string' && n.length <= 1000), 'Invalid source data quality');
  inputs.set(report, structuredClone(input)); return report;
}
export const getDailyWorkInput = report => structuredClone(inputs.get(report));
export function validateDailyWorkSummary(report) {
  exact(report, ['schema_version', 'device_id', 'language', 'window', 'summary', 'themes', 'attention', 'source_evidence', 'usage', 'data_quality'], 'daily-work report');
  check(report.schema_version === 'daily_work_summary.v1' && Array.isArray(report.themes), 'Invalid daily-work report schema');
  // Recreate semantic decisions from the report and compare every derived field.
  // Per-turn conservative status is retained by the builder input; direct reports must contain it in evidence.
  for (const turn of report.source_evidence) check(turn.summary_status && statuses.includes(turn.summary_status), 'Missing conservative per-turn summary status');
  const input = { schema_version: 'daily_work_summary_input.v1', node_id: report.device_id, language: report.language, window: report.window,
    source_evidence: report.source_evidence.map(({ summary_status, ...turn }) => turn), sessions: report.summary.session_evidence,
    usage: report.usage, data_quality: report.data_quality,
    semantic: { turns: report.source_evidence.map(turn => ({ source_ref: turn.source_ref, status: turn.summary_status })), groups: report.themes.map(theme => ({ group_id: theme.theme_id, title: theme.title, importance: theme.importance, turn_refs: theme.turn_refs, accomplishments: theme.accomplishments })), attention: report.attention } };
  const rebuilt = buildDailyWorkSummary(input); check(canonicalJson(rebuilt) === canonicalJson(report), 'Daily-work derived counts/shares/evidence differ'); return report;
}
export function renderDailyWorkSummary(report) {
  validateDailyWorkSummary(report);
  const s = report.summary, zh = report.language === 'zh';
  const headline = zh ? `${report.window.date} 共推进 ${s.theme_count} 个工作主题，涉及 ${s.sessions.codex.total} 个顶层 Codex 会话（${s.sessions.codex.new} 个新建、${s.sessions.codex.continued} 个延续）；完成 ${s.user_turns.completed}/${s.user_turns.total} 个用户任务。` : `${report.window.date}: ${s.theme_count} work themes, ${s.sessions.codex.total} top-level Codex sessions (${s.sessions.codex.new} new, ${s.sessions.codex.continued} continued); ${s.user_turns.completed}/${s.user_turns.total} user tasks completed.`;
  const body = [headline, ...report.themes.map(t => `${t.title}\n${zh ? '任务' : 'Tasks'} ${t.completed_turn_count}/${t.turn_count} · ${t.share_percent}%\n${t.accomplishments.map(a => `- ${a}`).join('\n')}\n${zh ? '证据' : 'Evidence'}: ${t.turn_refs.map(ref => { const e = report.source_evidence.find(item => item.source_ref === ref); return `${e.runtime}:${e.session_id.slice(-12)}/${e.turn_id.slice(-12)}`; }).join(', ')}`), ...(report.attention.length ? [zh ? '需关注' : 'Needs attention', ...report.attention.map(a => `${a.title}: ${a.detail}`)] : []), `${zh ? '数据补充' : 'Data'}: Codex ${s.sessions.codex.total}/${s.sessions.codex.new}/${s.sessions.codex.continued}; Hermes ${s.sessions.hermes.total}/${s.sessions.hermes.new}/${s.sessions.hermes.continued}; ${report.data_quality.status}`, `${zh ? '按用户任务（turn）数估算，不是时间占比' : 'Shares are included user-turn counts, not time spent'}`, ...['codex_all', 'codex_top_level', 'hermes_local'].map(key => `${key}: input ${report.usage[key].input_tokens ?? '?'} / cached ${report.usage[key].cached_input_tokens ?? '?'} / output ${report.usage[key].output_tokens ?? '?'} / total ${report.usage[key].total_tokens ?? '?'} (${report.usage[key].observability})`), ...report.data_quality.notes].join('\n\n');
  return { title: zh ? `每日工作回顾 · ${report.window.date}` : `Daily work review · ${report.window.date}`, body, card: { schema: '2.0', header: { title: { tag: 'plain_text', content: headline }, template: report.data_quality.complete ? 'blue' : 'yellow' }, body: { elements: [{ tag: 'markdown', content: body }] } } };
}
