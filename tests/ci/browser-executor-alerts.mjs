import {demandReadMethods} from "../../packages/task-system/dist/demand-reads.js";
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeHarness } from '../dsh/native-harness.mjs';
import { RecoveryStore } from '../../packages/task-system/dist/remote/store.js';
import { RemoteExecutionService, Config } from '../../packages/task-system/dist/remote/index.js';
import { TaskPluginSettings } from '../../packages/task-system/dist/settings.js';

export async function testExecutorAlerts(browser, { output } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-browser-alerts-'));
  const h = await createNativeHarness({ dir, config: { role: 'executor', nodeId: 'MBP', schedulerEnabled: false, autoExecute: false } });
  let store = new RecoveryStore(join(dir, 'recovery.sqlite'));
  const remote = new RemoteExecutionService(h.ctx, Config({ role: 'executor', nodeId: 'MBP', paused: false, pollIntervalMs: 0, workspaces: [] }), h.ledger, store);
  const settings = Object.assign(Object.create(TaskPluginSettings.prototype), { ctx: h.ctx });
  const row = (id, state, outcome) => ({ attemptId: id, state, claim: { task: { taskId: id, title: { blocked: '历史受阻分析', active: '正在执行的本机任务', pending: '结果等待回传' }[id], description: 'CI isolated workload' }, run: { runId: `run-${id}`, taskId: id, state: 'blocked', updatedAt: '2026-10-23T00:00:00Z', route: { nodeId: 'MBP' } }, attempt: { attemptId: id } }, lease: { runId: `run-${id}`, attemptId: id, nodeId: 'MBP', fence: 1 }, sessionId: `session-${id}`, result: { outcome, summary: '保留的原始结果' }, receipt: { commandId: `result-${id}`, acceptedAt: '2026-10-23T00:00:00Z', value: {} } });
  const original = row('blocked', 'acknowledged', 'blocked');
  for (const record of [original, row('active', 'dispatching', 'unknown'), row('pending', 'result', 'blocked')]) store.createDispatch(record);
  store.saveOutbound('old-claim', { operation: 'claim', payload: { runId: 'legacy-run' }, state: 'uncertain', endpoint: 'https://old-scheduler.invalid/', audience: 'old' });
  const calls = [];
  const html = readFileSync(new URL('../../packages/task-system/dist/project-page.html', import.meta.url), 'utf8');
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/page') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(html); return; }
      if (request.url === '/rpc' && request.method === 'POST') {
        let body = ''; for await (const chunk of request) { body += chunk; assert.ok(body.length < 10000); }
        const { method, input } = JSON.parse(body);
        assert.ok([...demandReadMethods, 'setExecutorAlertDisposition'].includes(method), 'browser fixture rejects other mutations');
        calls.push({ method, input });
        const value = await settings[method](demandReadMethods.includes(method)?{...input,view:'executor'}:input);
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ value })); return;
      }
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><html><body style="margin:0"><iframe title="Task center" src="/page" style="width:100vw;height:100vh;border:0"></iframe><script>addEventListener('message',async event=>{const x=event.data;if(x?.channel!=='dsh-project-runtime')return;if(x.method==='ready'){event.source.postMessage({channel:x.channel,method:'active',input:{active:true,generation:1}},'*');return;}if(!x.id)return;const result=await(await fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:x.method,input:x.method==='projectSnapshot'?{view:'executor'}:x.input})})).json();event.source.postMessage({channel:x.channel,id:x.id,...result},location.origin);});</script></body></html>`);
    } catch (error) { response.statusCode = 400; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ error: error.message, errorCode: error.details?.reason })); }
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const frame = page.frameLocator('iframe');
    const card=title=>frame.locator('[data-action="task"]').filter({has:frame.getByRole('heading',{name:title,exact:true})});
    const open=async title=>{await card(title).first().click();return frame.getByRole('dialog');};
    const close=async()=>frame.getByRole('button',{name:'关闭详情',exact:true}).click();
    const historical=card('历史受阻分析');
    let detail=await open('历史受阻分析');
    await detail.getByText('保留的原始结果',{exact:true}).waitFor();
    await close();
    for(const title of ['正在执行的本机任务','结果等待回传']){
      detail=await open(title);assert.equal(await detail.getByRole('button',{name:'确认本机提醒',exact:true}).count(),0);await close();
    }
    assert.equal(await frame.getByRole('heading',{name:'本机领取记录提醒',exact:true}).count(),1);
    const snapshot=await settings.projectSnapshot({view:'executor'});
    assert.equal(snapshot.viewContext.unresolvedClaims[0].alert.canAcknowledge,true);
    for(const run of snapshot.runs.filter(run=>run.id!=='run-blocked'))await assert.rejects(settings.setExecutorAlertDisposition({recordId:run.alert.recordId,fingerprint:run.alert.fingerprint,acknowledged:true}),error=>error.details.reason==='ALERT_STILL_ACTIVE');
    detail=await open('历史受阻分析');await detail.getByRole('button',{name:'确认本机提醒',exact:true}).click();
    const dialog=frame.getByRole('dialog');await dialog.getByRole('button',{name:'关闭窗口',exact:true}).click();
    assert.equal(calls.filter(call=>call.method==='setExecutorAlertDisposition').length,0);
    detail=await open('历史受阻分析');await detail.getByRole('button',{name:'确认本机提醒',exact:true}).click();await dialog.getByRole('button',{name:'确认',exact:true}).click();
    await historical.waitFor({state:'detached'});assert.deepEqual(store.dispatch('blocked'),original);assert.equal(calls.filter(call=>call.method==='setExecutorAlertDisposition').length,1);
    store.close();store=new RecoveryStore(join(dir,'recovery.sqlite'));remote.store=store;await page.reload();
    await frame.getByRole('heading',{name:/本机执行记录/}).waitFor();assert.equal(await historical.count(),0);
    await frame.getByRole('button',{name:'查看已处理历史',exact:true}).click();detail=await open('历史受阻分析');await detail.getByText(/本机提醒已确认于/).waitFor();await detail.getByRole('button',{name:'撤销本机确认',exact:true}).click();await dialog.getByRole('button',{name:'确认',exact:true}).click();
    detail=await open('历史受阻分析');await detail.getByRole('button',{name:'确认本机提醒',exact:true}).waitFor();await close();
    await frame.getByRole('button',{name:'隐藏已处理历史',exact:true}).click();await page.reload();detail=await open('历史受阻分析');await detail.getByRole('button',{name:'确认本机提醒',exact:true}).waitFor();
    assert.deepEqual(store.dispatch('blocked'),original);assert.deepEqual(calls.filter(call=>call.method==='setExecutorAlertDisposition').map(call=>call.input.acknowledged),[true,false]);
    assert.deepEqual(errors, []);
    return { name: 'executor alerts', persistentConfirmation: true, reversible: true, activeAndUndeliveredBlocked: true, originalEvidencePreserved: true };
  } catch (error) {
    if (output) await page.screenshot({ path: join(output, 'executor-alerts-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await context.close();
    await new Promise(resolve => server.close(resolve));
    await remote.dispose(); await h.dispose(); store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
