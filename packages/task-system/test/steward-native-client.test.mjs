import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const createJournal = runInNewContext(`${readFileSync(new URL('../src/steward-native-client.js', import.meta.url), 'utf8')}\ncreateStewardDisplayJournal`);
const message = (seq, role = 'user') => ({ id: `canonical-${seq}`, seq, role, commandId: role === 'user' ? `command-${seq}` : null, text: `Canonical message ${seq}`, createdAt: '2026-11-03T00:00:00Z' });

test('display journal keeps immutable canonical identity and native optimistic correlation without copying inference history', () => {
  const journal = createJournal(), appended = [];
  journal.subscribe(rows => appended.push(...rows));
  journal.sync([message(40), message(50, 'assistant')]);
  assert.equal(journal.records.length, 10);
  assert.equal(journal.cursor, 9);
  assert.deepEqual(Array.from(journal.records, row => row.event.seq), Array.from({ length: 10 }, (_, index) => index));
  const user = journal.records.find(row => row.event.type === 'user/message').event.data;
  assert.equal(user.id, 'canonical-40');
  assert.equal(user.source.rpcId, 'command-40');
  journal.sync([{ ...message(40), revision: 8, state: { kind: 'completed' } }, message(50, 'assistant')]);
  assert.equal(appended.length, 10, 'State revisions belong to receipt slots and do not duplicate canonical text');
  journal.sync([message(40), message(50, 'assistant'), message(80)]);
  assert.equal(appended.length, 15);
  assert.equal(journal.records.filter(row => row.event.type === 'user/message' && row.event.data.source.rpcId === 'command-40').length, 1);
});

test('fresh display windows cap canonical history independently of project-native sequence spaces', () => {
  const journal = createJournal();
  journal.sync(Array.from({ length: 320 }, (_, index) => message(320 - index)));
  assert.equal(journal.ids.length, 300);
  assert.equal(journal.records.length, 1500);
  assert.equal(journal.records[0].event.seq, 0);
  assert.equal(journal.records.at(-1).event.seq, journal.cursor);
  const users = journal.records.filter(row => row.event.type === 'user/message');
  assert.equal(users[0].event.data.id, 'canonical-21');
  assert.equal(users.at(-1).event.data.id, 'canonical-320');
  assert.deepEqual(Array.from(journal.records, row => row.event.seq), Array.from({ length: 1500 }, (_, index) => index));
});
