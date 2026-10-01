// SPDX-License-Identifier: MIT
// Independent format implementation; see README.md for provenance and limits.
import { SourceError, assertRows, normalizeWindow, parseTime, iso, inWindow, object,
  clip, zeroTokens, addTokens, failure, isHuman, jsonLines } from './common.mjs';

const codexCollectorMarkers = ['codex daily work summary', 'codex-daily-work-summary', '昨天我在codex里做了些什么', '昨天我在 codex 里做了些什么'];
const hermesCollectorMarkers = ['codex-daily-work-summary', 'agent_daily_node_report', 'agent daily report', 'agent 日报', 'codex 当日对话与任务探测'];
const marked = (value, markers) => markers.some(marker => value.toLowerCase().includes(marker.toLowerCase()));
const textOf = content => Array.isArray(content) ? content.filter(item => ['input_text', 'output_text', 'text'].includes(item?.type) && typeof item.text === 'string').map(item => item.text.trim()).filter(Boolean).join('\n\n') : '';
const quality = errors => ({ complete: errors.length === 0, errors });
const tokenResult = (tokens, errors) => ({ ...tokens, observability: errors.length ? 'partial' : 'exact' });

export function scanCodexRecords(records, { window: inputWindow, messageLimit = 6000, injectedPrefixes } = {}) {
  const window = normalizeWindow(inputWindow), end = Date.parse(window.end);
  const groups = new Map(), tokens = zeroTokens(), snapshots = [];
  let current = 'unattributed:0', ordinal = 0, truncated = 0;
  for (const { record } of records) {
    const time = parseTime(record?.timestamp), payload = object(record?.payload);
    if (time === null || time >= end) continue; // A report must never leak future completion evidence.
    const inside = inWindow(time, window);
    if (record.type === 'event_msg' && payload.type === 'token_count' && inside) {
      addTokens(tokens, payload.info?.last_token_usage);
      if (payload.rate_limits && typeof payload.rate_limits === 'object') {
        const raw = payload.rate_limits;
        const limitWindow = item => item && typeof item === 'object' ? {
          used_percent: item.used_percent ?? null, window_minutes: item.window_minutes ?? null,
          resets_at: iso(parseTime(item.resets_at)),
        } : null;
        snapshots.push({ observed_at: iso(time), limit_id: raw.limit_id ?? null, plan_type: raw.plan_type ?? null,
          primary: limitWindow(raw.primary), secondary: limitWindow(raw.secondary), credits: raw.credits ?? null });
      }
      continue;
    }
    if (record.type !== 'response_item' || payload.type !== 'message' || !['user', 'assistant'].includes(payload.role)) continue;
    const text = textOf(payload.content);
    if (!text) continue;
    const explicit = payload.internal_chat_message_metadata_passthrough?.turn_id ?? payload.turn_id;
    if (payload.role === 'user') current = explicit ? String(explicit) : `unattributed:${++ordinal}`;
    const id = explicit ? String(explicit) : current;
    if (payload.role === 'user' && !isHuman(text, injectedPrefixes)) {
      // Do not promote assistant output responding solely to an injected user block.
      if (!groups.has(id)) groups.set(id, { ignored: true, users: [], finals: [], progress: [], times: [] });
      continue;
    }
    if (!groups.has(id)) groups.set(id, { ignored: false, users: [], finals: [], progress: [], times: [] });
    const group = groups.get(id);
    if (payload.role === 'user') group.ignored = false;
    if (group.ignored) continue;
    const item = { timestamp: iso(time), ...clip(text, messageLimit), in_window: inside, before_window_end: true };
    if (item.truncated) truncated++;
    if (inside) group.times.push(time);
    if (payload.role === 'user') group.users.push(item);
    else if (payload.phase === 'final_answer') group.finals.push(item);
    else if (payload.phase === 'commentary') group.progress.push(item);
  }
  const turns = [];
  for (const [turn_id, group] of groups) {
    if (!group.times.length || group.ignored) continue;
    const inUsers = group.users.filter(item => item.in_window);
    const final_answers = group.finals.filter(item => item.in_window);
    const progress = group.progress.filter(item => item.in_window);
    turns.push({ turn_id, first_activity: iso(Math.min(...group.times)), last_activity: iso(Math.max(...group.times)),
      user_requests: inUsers.length ? inUsers : group.users.slice(-1), final_answers,
      latest_progress: final_answers.length ? null : (progress.at(-1) ?? null), has_final_answer: final_answers.length > 0 });
  }
  turns.sort((a, b) => a.first_activity.localeCompare(b.first_activity));
  const times = turns.flatMap(turn => [Date.parse(turn.first_activity), Date.parse(turn.last_activity)]);
  return { active: turns.length > 0, first_activity: times.length ? iso(Math.min(...times)) : null,
    last_activity: times.length ? iso(Math.max(...times)) : null, turns, turn_count: turns.length,
    completed_turn_count: turns.filter(turn => turn.has_final_answer).length, truncated_message_count: truncated,
    tokens, rate_limit_snapshots: snapshots };
}

/** Exactly one threads export or SQLite file; every rollout is an explicit scoped file. */
export async function readCodexDaily({ scope, window: inputWindow, threadsFile, database, rolloutPaths = {},
  excludeSessionIds = [], includeSubagents = false, collectorMarkers = codexCollectorMarkers, injectedPrefixes } = {}) {
  const window = normalizeWindow(inputWindow), errors = [], exclusions = new Set(excludeSessionIds);
  const top = [], subagents = [], omitted = [], allTokens = zeroTokens(), topTokens = zeroTokens(), subTokens = zeroTokens(), snapshots = [];
  let rows, activeCount = 0;
  try {
    if (Boolean(threadsFile) === Boolean(database)) throw new SourceError('config', 'Supply exactly one Codex threadsFile or database');
    rows = database ? await scope.sqlite(database, query => query('SELECT id,title,created_at,updated_at,source,rollout_path,tokens_used,archived FROM threads')) : assertRows((await scope.json(threadsFile)).threads, scope, 'threads');
  } catch (error) {
    return { schema_version: 'codex_daily_activity.v1', window, counts: null, top_level_sessions: [], subagent_sessions: [],
      token_totals_all_sessions: { observability: 'unavailable' }, token_totals_top_level_sessions: { observability: 'unavailable' },
      token_totals_subagent_sessions: { observability: 'unavailable' }, account_usage: { observability: 'unavailable', snapshot_count: 0, first: null, last: null }, data_quality: quality([failure(error)]) };
  }
  const seen = new Set();
  for (const row of rows) {
    const session_id = String(row.id ?? '');
    if (!session_id || seen.has(session_id)) { errors.push({ code: 'duplicate', message: 'Missing or repeated session ID' }); continue; }
    seen.add(session_id);
    if (exclusions.has(session_id)) continue;
    let scan;
    try {
      const path = rolloutPaths[session_id] ?? row.rollout_path;
      if (!path) throw new SourceError('missing', `No explicit rollout supplied for ${session_id}`);
      const parsed = jsonLines(await scope.read(path), scope);
      errors.push(...parsed.errors.map(error => ({ ...error, session_id })));
      scan = scanCodexRecords(parsed.records, { window, messageLimit: scope.limits.maxMessageChars, injectedPrefixes });
    } catch (error) { errors.push({ ...failure(error), session_id }); continue; }
    snapshots.push(...scan.rate_limit_snapshots);
    delete scan.rate_limit_snapshots;
    if (!scan.active) continue;
    activeCount++;
    addTokens(allTokens, scan.tokens);
    if (marked(String(row.title ?? ''), collectorMarkers)) { omitted.push(session_id); continue; }
    const created = parseTime(row.created_at);
    const item = { session_id, title: String(row.title ?? ''), source: row.source ?? null, created_at: iso(created),
      created_in_window: inWindow(created, window), database_archived_now: Boolean(row.archived), ...scan };
    if (Object.hasOwn(object(row.source), 'subagent') || row.source === 'subagent') { subagents.push(item); addTokens(subTokens, scan.tokens); }
    else { top.push(item); addTokens(topTokens, scan.tokens); }
  }
  top.sort((a, b) => a.first_activity.localeCompare(b.first_activity));
  subagents.sort((a, b) => a.first_activity.localeCompare(b.first_activity));
  snapshots.sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  const turns = top.flatMap(session => session.turns), newCount = top.filter(session => session.created_in_window).length;
  return { schema_version: 'codex_daily_activity.v1', window,
    counts: { top_level_session_count: top.length, new_session_count: newCount, continued_session_count: top.length - newCount,
      user_turn_count: turns.length, completed_turn_count_by_final_answer: turns.filter(turn => turn.has_final_answer).length,
      subagent_session_count: subagents.length, active_session_count_all: activeCount },
    token_totals_all_sessions: tokenResult(allTokens, errors), token_totals_top_level_sessions: tokenResult(topTokens, errors), token_totals_subagent_sessions: tokenResult(subTokens, errors),
    account_usage: { observability: snapshots.length ? 'partial' : 'unavailable', snapshot_count: snapshots.length,
      first: snapshots[0] ?? null, last: snapshots.at(-1) ?? null, snapshots, scope: 'Account snapshots emitted inside the supplied report window' },
    top_level_sessions: top, subagent_sessions: includeSubagents ? subagents : [],
    excluded: { subagents_from_human_work_counts: true, collector_session_ids: omitted, explicit_session_ids: [...exclusions] }, data_quality: quality(errors) };
}

export function scanHermesMessages(rows, { sessionId, window: inputWindow, messageLimit = 6000, injectedPrefixes,
  blockedMarkers = ['等待授权', '等待批准', 'waiting_for_approval', '需要你批准', '需要用户批准'],
  failedMarkers = ['任务失败', '未能完成', '执行失败', 'failed'] } = {}) {
  const window = normalizeWindow(inputWindow), end = Date.parse(window.end), turns = [], activity = [];
  let current = null, truncated = 0;
  const finish = () => {
    if (!current?.active) return;
    const text = current.final_answer?.text ?? '';
    current.status = !current.final_answer ? 'running' : marked(text, blockedMarkers) ? 'blocked' : marked(text, failedMarkers) ? 'failed' : 'completed';
    delete current.active;
    turns.push(current);
  };
  for (const row of [...rows].sort((a, b) => Number(a.id) - Number(b.id))) {
    const time = parseTime(row.timestamp);
    if (time === null || time >= end) continue;
    const inside = inWindow(time, window), role = String(row.role ?? ''), raw = String(row.content ?? '').trim();
    if (role === 'user' && raw) {
      finish(); current = null;
      if (!isHuman(raw, injectedPrefixes)) continue;
      const request = clip(raw, messageLimit); truncated += Number(request.truncated);
      current = { turn_id: `${sessionId}:m${row.id}`, user_message_id: Number(row.id), started_at: iso(time), ended_at: null,
        first_activity: inside ? iso(time) : null, last_activity: inside ? iso(time) : null,
        request, final_answer: null, tool_calls: [], active: inside };
    } else if (current && ['assistant', 'tool'].includes(role)) {
      current.active ||= inside;
      if (inside) { current.first_activity ??= iso(time); current.last_activity = iso(time); }
      if (inside && role === 'tool' && row.tool_name) current.tool_calls.push(String(row.tool_name));
      if (inside && role === 'assistant' && raw && row.finish_reason === 'stop') {
        const text = clip(raw, messageLimit); truncated += Number(text.truncated);
        current.final_answer = { timestamp: iso(time), ...text }; current.ended_at = iso(time);
      }
    }
    if (current && inside && ['user', 'assistant', 'tool'].includes(role)) activity.push(time);
  }
  finish();
  return { turns, activity, truncated };
}

async function hermesInput(scope, file, database) {
  if (Boolean(file) === Boolean(database)) throw new SourceError('config', 'Supply exactly one Hermes exportFile or database');
  if (file) {
    const data = await scope.json(file);
    return { ...data, sessions: assertRows(data.sessions, scope, 'sessions'), messages: assertRows(data.messages, scope, 'messages') };
  }
  return scope.sqlite(database, query => ({
    sessions: query('SELECT id,source,title,origin_json,started_at,ended_at,end_reason,message_count,tool_call_count,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens FROM sessions'),
    messages: query('SELECT id,session_id,role,content,timestamp,finish_reason,tool_name FROM messages ORDER BY id'),
  }));
}
function ackMap(rows) {
  const map = new Map();
  for (const row of rows ?? []) {
    const id = String(row.session_id), turn = row.turn_id ?? object(row.payload_json).origin?.turn_id;
    if (!map.has(id)) map.set(id, new Set());
    if (turn) map.get(id).add(String(turn));
  }
  return map;
}

export async function readHermesDaily({ scope, window: inputWindow, exportFile, database, workerDatabase, ackDatabase,
  profile = 'default', includeNonDefaultProfile = false, collectorMarkers = hermesCollectorMarkers,
  serviceSources = ['tool', 'cron'], injectedPrefixes } = {}) {
  const window = normalizeWindow(inputWindow), base = { schema_version: 'hermes_daily_activity.v1', window, profile };
  const unavailable = (errors, extra = {}) => ({ ...base, ...extra, local_unregistered_sessions: [], service_sessions: [], counts: null,
    usage_local_sessions: { observability: 'unavailable' }, data_quality: quality(errors) });
  if (profile !== 'default' && !includeNonDefaultProfile) return unavailable([{ code: 'profile', message: 'Non-default profile intentionally excluded' }], { skipped: true, skip_reason: 'non_default_profile' });
  const errors = [];
  let data;
  try { data = await hermesInput(scope, exportFile, database); } catch (error) { return unavailable([failure(error)]); }
  let workerBindings = object(data.worker_bindings), acknowledged = ackMap(data.ack_bindings);
  if (workerDatabase) {
    try {
      const rows = await scope.sqlite(workerDatabase, query => query("SELECT key,value FROM state_meta WHERE key LIKE 'worker_session_task:%'"));
      workerBindings = Object.fromEntries(rows.map(row => [row.key.slice('worker_session_task:'.length), object(row.value)]));
    } catch (error) { errors.push(failure(error)); }
  }
  if (ackDatabase) {
    try { acknowledged = ackMap(await scope.sqlite(ackDatabase, query => query('SELECT b.session_id,b.task_id,b.run_id,b.candidate_id,b.updated_at,o.payload_json FROM candidate_bindings b LEFT JOIN outbox o ON o.candidate_id=b.candidate_id ORDER BY b.updated_at'))); }
    catch (error) { errors.push(failure(error)); }
  }
  const local = [], service = [], usage = zeroTokens(), seen = new Set();
  let inexact = 0, truncated = 0;
  const messages = new Map();
  for (const row of data.messages) { const id = String(row.session_id); if (!messages.has(id)) messages.set(id, []); messages.get(id).push(row); }
  for (const row of data.sessions) {
    const session_id = String(row.id ?? '');
    if (!session_id || seen.has(session_id)) { errors.push({ code: 'duplicate', message: 'Missing or repeated Hermes session ID' }); continue; }
    seen.add(session_id);
    const scan = scanHermesMessages(messages.get(session_id) ?? [], { sessionId: session_id, window, messageLimit: scope.limits.maxMessageChars, injectedPrefixes });
    if (!scan.turns.length) continue;
    const origin = object(row.origin_json), title = String(row.title ?? ''), source = String(row.source ?? '').toLowerCase();
    const collector = marked(`${title}\n${scan.turns[0].request.text}`, collectorMarkers);
    const classification = collector ? 'collector' : Object.hasOwn(workerBindings, session_id) ? 'worker_binding' : serviceSources.includes(source) ? `source:${source}` : /^task[-_]/.test(title) ? 'worker_task_title' : ['task_id', 'root_task_id', 'worker_id', 'run_id', 'subagent'].some(key => Object.hasOwn(origin, key)) ? 'worker_origin' : 'local_interactive';
    const item = { session_id, source, title, session_started_at: iso(parseTime(row.started_at)), session_ended_at: iso(parseTime(row.ended_at)), end_reason: row.end_reason ?? null,
      first_activity: iso(Math.min(...scan.activity)), last_activity: iso(Math.max(...scan.activity)), classification, worker_binding: workerBindings[session_id] ?? null };
    const counts = turns => ({ turn_count: turns.length, completed_turn_count: turns.filter(turn => turn.status === 'completed').length });
    if (classification !== 'local_interactive') { service.push({ ...item, ...counts(scan.turns), turns: [] }); continue; }
    const ack = acknowledged.get(session_id) ?? new Set(), excluded = scan.turns.filter(turn => ack.has(turn.turn_id)), remainder = scan.turns.filter(turn => !ack.has(turn.turn_id));
    if (excluded.length) service.push({ ...item, classification: 'observer_registry_ack', ...counts(excluded), acknowledged_turn_ids: excluded.map(turn => turn.turn_id), turns: [] });
    if (!remainder.length) continue;
    local.push({ ...item, classification: excluded.length ? 'local_interactive_unacknowledged' : item.classification,
      first_activity: remainder.map(turn => turn.first_activity).sort()[0], last_activity: remainder.map(turn => turn.last_activity).sort().at(-1), ...counts(remainder), turns: remainder });
    truncated += scan.truncated;
    const counters = { input_tokens: row.input_tokens, output_tokens: row.output_tokens, cached_input_tokens: row.cache_read_tokens,
      cache_write_input_tokens: row.cache_write_tokens, reasoning_output_tokens: row.reasoning_tokens };
    const incompleteCounters = Object.values(counters).some(value => !Number.isSafeInteger(value) || value < 0);
    if (incompleteCounters) errors.push({ code: 'usage', session_id, message: 'Whole-session token counters are incomplete; observed counters are a partial lower bound' });
    counters.total_tokens = ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_input_tokens'].reduce((sum, key) => sum + (Number.isSafeInteger(counters[key]) && counters[key] >= 0 ? counters[key] : 0), 0);
    addTokens(usage, counters);
    const start = parseTime(row.started_at), end = parseTime(row.ended_at);
    if (incompleteCounters || excluded.length || !inWindow(start, window) || end === null || end < Date.parse(window.start) || end > Date.parse(window.end)) inexact++;
  }
  local.sort((a, b) => a.first_activity.localeCompare(b.first_activity));
  service.sort((a, b) => a.first_activity.localeCompare(b.first_activity));
  const turns = local.flatMap(session => session.turns);
  return { ...base, skipped: false, local_unregistered_sessions: local, service_sessions: service,
    counts: { local_unregistered_session_count: local.length, local_user_turn_count: turns.length, local_completed_turn_count: turns.filter(turn => turn.status === 'completed').length,
      local_running_turn_count: turns.filter(turn => turn.status === 'running').length, local_failed_turn_count: turns.filter(turn => turn.status === 'failed').length,
      local_blocked_turn_count: turns.filter(turn => turn.status === 'blocked').length, service_session_count_excluded: service.length },
    usage_local_sessions: { input_tokens: usage.input_tokens, cached_input_tokens: usage.cached_input_tokens, cache_write_tokens: usage.cache_write_input_tokens,
      output_tokens: usage.output_tokens, reasoning_tokens: usage.reasoning_output_tokens, total_tokens: usage.total_tokens,
      observability: inexact || errors.length ? 'partial' : 'exact', inexact_session_count: inexact,
      scope: 'Whole-session counters; cross-window sessions and ACK remainder are partial, never per-turn spend' },
    data_quality: { ...quality(errors), truncated_message_count: truncated } };
}
