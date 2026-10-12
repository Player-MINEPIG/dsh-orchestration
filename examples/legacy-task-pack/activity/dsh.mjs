function text(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(x => x?.type === 'text').map(x => x.text ?? '').join('\n') : '';
}

/** Read through the host's persistence service; no database or JSONL-format dependency. */
export async function collectDsh({ persistence, window, signal, excludedSessionIds = [], maxSessions = 1000, maxEvents = 200000 }) {
  const entries = [], errors = [], excluded = new Set(excludedSessionIds), start = Date.parse(window.start), end = Date.parse(window.end);
  const sessions = await persistence.list({ signal });
  if (sessions.length > maxSessions) throw new Error('DSH daily session bound exceeded');
  let count = 0;
  for (const session of sessions) {
    signal?.throwIfAborted();
    if (session.header.origin === 'subagent' || excluded.has(session.header.id) || session.header.createdAt >= end) continue;
    let handle;
    try {
      handle = await persistence.open(session.header.id, 'read', { signal });
      const turns = new Map(); let offset = handle.inheritedEventCount, currentTurn;
      while (true) {
        const { events } = await handle.read(offset, 512, { signal }); if (!events.length) break;
        count += events.length; if (count > maxEvents) throw new Error('DSH daily event bound exceeded');
        for (const event of events) {
          if (event.time >= end) continue;
          if (event.type === 'turn/start') currentTurn = event.data.turn;
          const turn = event.data.turn ?? currentTurn;
          if (turn === undefined) continue;
          const item = turns.get(turn) ?? { sourceRef: `dsh:${handle.id}:${turn}`, runtime: 'dsh', sessionId: handle.id, turnId: String(turn), title: '', request: '', answer: '', state: 'inProgress', startedAt: null, completedAt: null, inWindow: false };
          if (event.type === 'user/message' && event.data.source?.kind === 'user') {
            item.request = (item.request + (item.request ? '\n' : '') + text(event.data.content)).slice(0, 6001);
            item.startedAt ??= new Date(event.time).toISOString();
            item.title ||= item.request.slice(0, 200);
          }
          if (event.type === 'assistant/message') item.answer = text(event.data.message?.content).slice(0, 6001);
          if (event.type === 'turn/end') { item.completedAt = new Date(event.time).toISOString(); item.state = event.data.reason?.type ?? event.data.reason?.kind ?? 'ended'; }
          if (event.time >= start && ['user/message', 'assistant/message', 'turn/end'].includes(event.type)) item.inWindow = true;
          turns.set(turn, item);
        }
        offset = events.at(-1).seq + 1;
      }
      for (const { inWindow, ...item } of turns.values()) if (inWindow && item.request.trim()) entries.push({ ...item, request: item.request.slice(0, 6000), answer: item.answer.slice(0, 6000), truncated: item.request.length > 6000 || item.answer.length > 6000 });
    } catch (error) { signal?.throwIfAborted(); errors.push({ source: `dsh:${session.header.id}`, error: error.message }); }
    finally { await handle?.close(); }
  }
  return { runtime: 'dsh', method: 'official-session-persistence', window, entries, errors, usage: { observability: 'unavailable', reason: 'Daily report currently summarizes work rather than estimating unverified token costs' } };
}
