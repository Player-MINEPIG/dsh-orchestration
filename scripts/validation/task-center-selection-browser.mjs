import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const { chromium } = await import(process.env.DSH_PLAYWRIGHT_MODULE || 'playwright');
const output = resolve(process.env.DSH_SELECTION_OUTPUT || '/private/tmp/dsh-task-center-selection');
mkdirSync(output, { recursive: true });
const candidate = readFileSync(new URL('../../packages/task-system/dist/project-page.html', import.meta.url), 'utf8');
const baseline = process.env.DSH_BASELINE_PROJECT_PAGE && readFileSync(process.env.DSH_BASELINE_PROJECT_PAGE, 'utf8');
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const results = [];
const selectedTitle = 'Stable selected task title';
const task = (id, title, status = 'running', time = '2026-10-23T00:00:00Z') => ({ id, title, status, time, project: 'unassigned' });
try {
 for (const [label, html] of [...(baseline ? [['baseline', baseline]] : []), ['candidate', candidate]]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let reads = 0, failure = false;
  let snapshot = { projects: [], settings: { root: null, revision: 0 }, tasks: [{...task('selected', selectedTitle),report:'Stable report paragraph',reportId:'report-selected'}, task('other', 'Other task')], nodes: [] };
  await page.exposeFunction('fixtureRead', () => {
   reads++;
   return failure ? { error: 'Temporary read failure' } : { value: { ...snapshot, nodes: [{ observedAt: reads }] } };
  });
  await page.addInitScript(() => {
   window.postMessage = async request => {
    if (request?.channel !== 'dsh-project-runtime' || request.method !== 'projectSnapshot') return;
    const response = await window.fixtureRead();
    window.dispatchEvent(new MessageEvent('message', { source: window, data: { channel: 'dsh-project-runtime', id: request.id, ...response } }));
   };
  });
  await page.route('http://localhost:43191/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto('http://localhost:43191/');
  await page.getByText(selectedTitle, { exact: true }).waitFor();
  const selectTitle = async () => page.evaluate(() => {
   const node = document.querySelector('[data-action="task"][data-id="selected"] h3').firstChild;
   const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 15);
   getSelection().removeAllRanges(); getSelection().addRange(range);
   window.selectedTextNode = node; window.selectedCard = node.closest ? node.closest('button') : node.parentElement.closest('button');
  });
  const selectedState = async () => page.evaluate(() => ({
   text: getSelection().toString(), nodeConnected: selectedTextNode.isConnected,
   sameNode: document.querySelector('[data-action="task"][data-id="selected"] h3')?.firstChild === selectedTextNode,
  }));
  await selectTitle();
  const initial = await selectedState();
  await page.waitForTimeout(6300);
  const heartbeat = await selectedState();
  if (label === 'baseline') {
   assert.equal(heartbeat.text, ''); assert.equal(heartbeat.nodeConnected, false);
   results.push({ label, reads, initial, heartbeat }); await page.close(); continue;
  }
  assert.deepEqual(heartbeat, initial);
  snapshot = { ...snapshot, tasks: [task('other', 'Other task updated', 'review'), task('new', 'New task'), {...task('selected', selectedTitle),report:'Stable report paragraph',reportId:'report-selected'}] };
  await page.getByText('Other task updated', { exact: true }).waitFor();
  await page.getByText('New task', { exact: true }).waitFor();
  const concurrentUpdate = await selectedState(); assert.deepEqual(concurrentUpdate, initial);
  assert.equal(await page.locator('[data-action="task"][data-id="other"]').getByText('待确认', { exact: true }).count(), 1);
  snapshot = { ...snapshot, tasks: [{...task('selected', selectedTitle),report:'Stable report paragraph',reportId:'report-selected'}, task('new', 'New task'), task('other', 'Other task updated', 'review')] };
  await page.waitForTimeout(3200);
  const reordered = await selectedState(); assert.deepEqual(reordered, initial);
  assert.equal(await page.locator('.board-cards').filter({has: page.locator('[data-id="selected"]')}).locator('button').first().getAttribute('data-id'), 'selected');
  failure = true;
  await page.getByText(/Temporary read failure/).waitFor();
  assert.deepEqual(await selectedState(), initial);
  failure = false;
  await page.getByText(/Temporary read failure/).waitFor({ state: 'detached' });
  const recovered = await selectedState(); assert.deepEqual(recovered, initial);
  await page.screenshot({ path: resolve(output, 'selection-with-updated-other-task.png') });
  await page.locator('[data-action="task"][data-id="selected"]').first().click();
  await page.getByRole('dialog').waitFor();
  await page.evaluate(() => {
   const node = document.querySelector('.report-markdown p').firstChild;
   const range = document.createRange(); range.selectNodeContents(node); getSelection().removeAllRanges(); getSelection().addRange(range);
   window.selectedReportNode = node;
  });
  snapshot = { ...snapshot, tasks: snapshot.tasks.map(t => t.id === 'selected' ? {...t,maxResultRetries:4,reportHistory:[{title:'Prior report',body:'Older report body'}]} : t) };
  await page.getByText('自动重新执行最多 4 次', {exact:false}).waitFor();
  await page.getByText('Older report body', {exact:true}).waitFor({state:'attached'});
  assert.equal(await page.evaluate(() => selectedReportNode.isConnected && getSelection().toString()), 'Stable report paragraph');
  await page.screenshot({path:resolve(output,'selected-report-with-updated-details.png')});
  snapshot = { ...snapshot, tasks: snapshot.tasks.map(t => t.id === 'selected' ? {...t,report:'Updated report paragraph'} : t) };
  await page.getByText('Updated report paragraph', {exact:true}).waitFor();
  assert.notEqual(await page.evaluate(() => getSelection().toString()), 'Stable report paragraph');
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await selectTitle();
  snapshot = { ...snapshot, tasks: snapshot.tasks.map(t => t.id === 'selected' ? { ...t, title: 'Selected title changed' } : t) };
  await page.getByText('Selected title changed', { exact: true }).waitFor();
  assert.notEqual((await selectedState()).text, initial.text);
  snapshot = { ...snapshot, tasks: snapshot.tasks.filter(t => t.id !== 'selected') };
  await page.getByText('Selected title changed', { exact: true }).waitFor({ state: 'detached' });
  assert.equal((await selectedState()).nodeConnected, false);
  await page.evaluate(() => {
   const fixture = document.createElement('span'); fixture.id = 'elapsed-fixture';
   fixture.dataset.runtimeStart = '2026-10-23T00:00:00Z'; fixture.dataset.runtimeEnd = '2026-10-23T00:02:00Z';
   document.getElementById('overlays').append(fixture);
   updateElapsed(); window.elapsedNode = fixture.firstChild;
   const range = document.createRange(); range.selectNodeContents(elapsedNode); getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  const timerText = await page.evaluate(() => getSelection().toString());
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => document.getElementById('elapsed-fixture').firstChild === elapsedNode && getSelection().toString()), timerText);
  assert.deepEqual(errors, []);
  results.push({ label, reads, initial, heartbeat, concurrentUpdate, reordered, recovered, unchangedElapsedNodeRetained: true, firstClickOpensTask: true, selectedReportSurvivesOtherDetailsUpdate: true, changedAndRemovedTextNotRestored: true });
  await page.close();
 }
 writeFileSync(resolve(output, 'browser.json'), JSON.stringify(results, null, 2) + '\n');
 console.log(JSON.stringify(results));
} finally { await browser.close(); }
