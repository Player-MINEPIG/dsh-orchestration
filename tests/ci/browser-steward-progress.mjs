import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {seedStewardProgress} from '../dsh/steward-progress-fixture.mjs';
import {startHost} from './browser-native-project.mjs';
export async function testStewardProgress(browser,{output}={}) {
 const host=await startHost({executionEnabled:true}),context=await browser.newContext({locale:'zh-CN',viewport:{width:1500,height:1000}}),page=await context.newPage(),errors=[];
 page.on('console',message=>{if(message.text().startsWith('steward-')||message.type()==='error')console.log(message.text());});page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);
 const service=host.ctx.taskSystem.steward,ledger=host.ctx.taskSystem.ledger,scope={kind:'project',projectId:host.created.projectId};
 try {
  const {original,report,task,selected}=await seedStewardProgress(host);
  const source=await service.sourceSession({conversationId:'main',scope});writeFileSync(join(source.binding.cwd,'项目资料.txt'),'这是当前项目的已有文件。');writeFileSync(join(source.binding.cwd,'普通会话保留.txt'),'普通会话原先打开的文件必须保留。');
  const other=await host.runtime.create({commandId:'progress-other-project',title:'另一话题',goal:'只用于隔离文件浏览验证'}),otherScope={kind:'project',projectId:other.projectId},otherSource=await service.sourceSession({conversationId:'main',scope:otherScope});writeFileSync(join(otherSource.binding.cwd,'另一份资料.txt'),'这是另一项目的文件。');
  const before=host.model.requests.length;
  await page.goto(host.url);await page.getByRole('dialog',{name:'预览版说明',exact:true}).getByRole('button',{name:'继续',exact:true}).click();
  const ordinaryWorkspace=host.ctx.workspaceRegistry.list().find(workspace=>workspace.sessionIds.includes(source.binding.sessionId));assert.ok(ordinaryWorkspace);
  const workspaceRow=page.locator(`[data-row-key="workspace:${ordinaryWorkspace.id}"]`);await workspaceRow.waitFor();if(await workspaceRow.getAttribute('aria-expanded')==='false')await workspaceRow.click();
  await page.locator(`[data-row-key="session:${source.binding.sessionId}"]`).click();await page.getByRole('button',{name:'打开右侧边栏',exact:true}).click();await page.getByRole('button',{name:/工作区文件/}).click();await page.locator('[data-files-state=tree]').waitFor();await page.getByRole('button',{name:'普通会话保留.txt',exact:true}).click();await page.getByText('普通会话原先打开的文件必须保留。',{exact:true}).waitFor();
  const ordinaryKey=`dsh.sidebar-right.v1.${source.binding.sessionId}`,ordinaryLayout=await page.evaluate(key=>localStorage.getItem(key),ordinaryKey);
  await page.getByRole('button',{name:'管家',exact:true}).click();
  const area=page.locator('[data-steward-native-host]'),progress=page.getByRole('region',{name:'任务进展：研究进展示例',exact:true});
  await progress.getByRole('button',{name:'查看研究报告',exact:true}).waitFor();assert.equal(await page.locator('[data-steward-progress-id]').count(),1);assert.equal(await progress.locator('.steward-progress-original:visible').count(),0);
  await area.locator('[contenteditable=true]:visible').fill('保留的草稿');const draft=await area.locator('[contenteditable=true]:visible').elementHandle();
  if(output)await page.screenshot({path:join(output,'progress-group.png'),fullPage:true});
  await progress.getByRole('button',{name:'查看研究报告',exact:true}).click();
  await page.getByText('这是既有工作文件，不是正式结果提交。',{exact:true}).waitFor();
  assert.equal(await area.isVisible(),true);
  assert.equal(await area.locator('[contenteditable=true]:visible').innerText(),'保留的草稿');assert.equal(await area.locator('[contenteditable=true]:visible').evaluate((node,previous)=>node===previous,draft),true);
  assert.equal(host.model.requests.length,before);
  if(output)await page.screenshot({path:join(output,'progress-native-file.png'),fullPage:true});
  if(await area.getByRole('button',{name:'收起原生文件侧栏',exact:true}).count())await area.getByRole('button',{name:'收起原生文件侧栏',exact:true}).click();await area.getByRole('button',{name:'打开原生文件侧栏',exact:true}).click();if(await page.getByRole('button',{name:'新标签页',exact:true}).count())await page.getByRole('button',{name:'新标签页',exact:true}).click();await page.getByRole('button',{name:/工作区文件/}).click();await page.locator('[data-files-state=tree]').waitFor();await page.getByRole('button',{name:'项目资料.txt',exact:true}).click();await page.getByText('这是当前项目的已有文件。',{exact:true}).waitFor();
  assert.equal(host.model.requests.length,before);
  if(output)await page.screenshot({path:join(output,'progress-native-files.png'),fullPage:true});
  await page.setViewportSize({width:700,height:900});await page.locator('[data-steward-native-rightbar] [data-sidebar-right-panel=fullscreen]:visible').waitFor();await page.locator('[data-steward-native-rightbar]').getByRole('button',{name:'收起右侧边栏',exact:true}).click();await page.setViewportSize({width:1500,height:1000});
  await progress.getByRole('button',{name:'查看研究报告',exact:true}).click();await page.getByText('这是既有工作文件，不是正式结果提交。',{exact:true}).waitFor();
  await progress.getByText('查看进展与依据',{exact:true}).click();assert.equal(await progress.locator('li').count(),original.length);
  await progress.locator('li').last().getByRole('button',{name:'查看进度记录',exact:true}).click();await page.getByRole('dialog',{name:'进度记录',exact:true}).waitFor();
  ledger.appendReport('progress-later-record',{taskId:task.taskId,title:'后续进度',kind:'progress',body:'这是一条新的检查记录。'});await service.reconcile({conversationId:'main'});
  await page.waitForFunction(count=>document.querySelectorAll('.steward-progress-history li').length===count,original.length+1);assert.equal(await page.getByRole('dialog',{name:'进度记录',exact:true}).isVisible(),true,'New notifications preserve the open record');assert.equal(await page.locator('[data-steward-progress-id]').count(),1);await page.getByRole('button',{name:'关闭进度记录',exact:true}).click();
  await area.getByRole('button',{name:'浏览话题',exact:true}).click();await page.getByRole('option',{name:/^另一话题/}).click();await area.locator(`[data-steward-browse-session="${otherSource.binding.sessionId}"]`).waitFor();
  if(await area.getByRole('button',{name:'收起原生文件侧栏',exact:true}).count())await area.getByRole('button',{name:'收起原生文件侧栏',exact:true}).click();await area.getByRole('button',{name:'打开原生文件侧栏',exact:true}).click();if(await page.getByRole('button',{name:'新标签页',exact:true}).count())await page.getByRole('button',{name:'新标签页',exact:true}).click();await page.getByRole('button',{name:/工作区文件/}).click();await page.locator('[data-files-state=tree]').waitFor();assert.equal(await page.getByRole('button',{name:'项目资料.txt',exact:true}).count(),0);await page.getByRole('button',{name:'另一份资料.txt',exact:true}).click();await page.getByText('这是另一项目的文件。',{exact:true}).waitFor();
  await progress.locator(':scope > .steward-progress-target').getByRole('button',{name:'查看研究报告',exact:true}).click();await page.getByText('这是既有工作文件，不是正式结果提交。',{exact:true}).waitFor();assert.equal(await area.locator('[contenteditable=true]:visible').evaluate((node,previous)=>node===previous,draft),true);assert.equal(await area.locator('[contenteditable=true]:visible').innerText(),'保留的草稿');assert.equal(await area.getByRole('button',{name:'本条话题：自动选择',exact:true}).count(),1);assert.equal(host.model.requests.length,before);
  if(output)await page.screenshot({path:join(output,'progress-native-cross-source.png'),fullPage:true});
  await area.locator('[contenteditable=true]:visible').fill('');await area.locator('.steward-native-user').first().getByRole('button',{name:'跳转原会话',exact:true}).click();await area.waitFor({state:'detached'});await page.locator('[contenteditable=true]:visible').waitFor();await page.getByText('普通会话原先打开的文件必须保留。',{exact:true}).waitFor();assert.equal(await page.evaluate(key=>localStorage.getItem(key),ordinaryKey),ordinaryLayout,'Steward uses separate layout persistence');assert.equal(await page.locator('[data-steward-native-rightbar]').count(),0);await page.getByRole('button',{name:'管家',exact:true}).click();await area.locator('[contenteditable=true]:visible').waitFor();await page.getByRole('region',{name:'任务进展：研究进展示例',exact:true}).waitFor();assert.equal(await page.locator('[data-steward-progress-id]').count(),1);assert.equal(host.model.requests.length,before);
  assert.deepEqual(errors,[]);return {notificationsGrouped:true,exactOriginalActions:true,nativeFilePreview:true,ledgerRecordSeparate:true,previewPreservesDraftAndTopic:true,nativeFilesBrowserSource:true,narrowNativeFullscreenAndClose:true,sourceSwitchIsolated:true,validReportFromOtherSource:true,newNoticePreservesOpenRecord:true,ordinarySessionRestored:true,preexistingOrdinaryFileTabAndLayoutPreserved:true,noInferenceFromPreview:true,reportId:report.reportId};
 }catch(error){if(output){await page.screenshot({path:join(output,'progress-failure.png'),fullPage:true}).catch(()=>{});writeFileSync(join(output,'progress-failure.txt'),(await page.locator('body').innerText())+'\n'+error.stack+'\n'+JSON.stringify(errors));}throw error;}
 finally{await context.close();await host.close();}
}
