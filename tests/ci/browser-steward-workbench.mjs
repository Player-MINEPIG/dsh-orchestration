import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { startHost } from './browser-native-project.mjs';

export async function testStewardWorkbench(browser,{output}={}) {
 const host=await startHost(),context=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1100}}),page=await context.newPage(),errors=[],calls=[];
 const native=page.locator('[data-steward-native-host]'),editor=native.locator('[contenteditable=true]:visible');page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.url().includes('/api/taskPluginSettings/stewardSend'))calls.push(request.postDataJSON().payload.args.input);});
 try{
  const req=createRequire(join(process.env.DSH_OFFICIAL_ROOT,'package.json'));await host.ctx.loader.create({id:'browser-workbench-files',name:pathToFileURL(req.resolve('@deepseek-ai/dsh-tool-fs')).href,config:{read:true,write:true,edit:true,readImage:true}});await host.ctx.loader.await();
  await page.goto(host.url);await page.getByRole('dialog',{name:'预览版说明',exact:true}).getByRole('button',{name:'继续',exact:true}).click();await page.getByRole('button',{name:'管家',exact:true}).click();await editor.waitFor();
  await native.getByRole('button',{name:/^本条话题：/}).click();await page.getByRole('option',{name:/^管家工作区/}).waitFor();await page.getByRole('option',{name:/^管家工作区/}).click();
  const globalModel=host.ctx.agentDefaultModel.currentSelection();host.model.script.push({name:'write',args:{file_path:'requirements.md',content:'# 管家工作区草案\n尚未归属项目的需求与资料。'}},'已把需求草案保存在管家工作区。');await editor.fill('先在你的工作区整理需求草案');await native.getByRole('button',{name:'发送消息',exact:true}).click();await native.getByText('已把需求草案保存在管家工作区。',{exact:true}).waitFor();
  const workbench=host.ctx.taskSystem.steward.store.commandMessage('main',calls[0].commandId);assert.equal(workbench.scope.kind,'workbench');assert.equal(readFileSync(join(workbench.source.cwd,'requirements.md'),'utf8').startsWith('# 管家工作区草案'),true);
  host.model.script.push(()=>{throw Error('Scripted provider outage')},'自动分流暂不可用，我已在管家工作区接住这项研究。');await editor.fill('准备一次尚未归属项目的研究');await native.getByRole('button',{name:'发送消息',exact:true}).click();await native.getByText('自动分流暂不可用，我已在管家工作区接住这项研究。',{exact:true}).waitFor();await native.locator('[data-route-reason=provider]').waitFor();assert.ok(await native.getByText(/自动分流服务暂不可用，已由管家工作区承接/).count());
  await editor.fill('保留正在编辑的内容');const node=await editor.elementHandle();await native.getByRole('button',{name:'浏览话题',exact:true}).click();await page.getByRole('option',{name:/^闲聊/}).click();assert.equal(await editor.evaluate((element,original)=>element===original,node),true);assert.equal(await editor.innerText(),'保留正在编辑的内容');await native.getByRole('button',{name:/^本条话题：自动选择/}).waitFor();await editor.fill('');
  await native.getByRole('button',{name:'浏览话题',exact:true}).click();await page.getByRole('option',{name:/^管家工作区/}).click();await native.getByRole('tab',{name:'任务',exact:true}).click();await native.getByRole('tab',{name:'任务',exact:true}).waitFor();assert.equal(await native.getByText(/unknown session/).count(),0);await native.getByRole('tab',{name:'对话',exact:true}).click();
  await page.reload();await page.getByRole('button',{name:'管家',exact:true}).click();await editor.waitFor();await native.locator('[data-route-reason=provider]').waitFor();assert.equal(calls.length,2);assert.deepEqual(host.ctx.agentDefaultModel.currentSelection(),globalModel);assert.deepEqual(errors,[]);
  if(output)await page.screenshot({path:join(output,'steward-workbench.png'),fullPage:true});
  return {nativeWorkbenchTopic:true,realNativeSession:true,isolatedPersistentCwd:true,nativeFileArtifact:true,classifierFailureHonestReceipt:true,personalBrowseDoesNotRetargetSend:true,editorNodePreserved:true,nativeTasksTab:true,reloadWithoutReplay:true,globalModelUnchanged:true};
 }catch(error){if(output){await page.screenshot({path:join(output,'steward-workbench-failure.png'),fullPage:true}).catch(()=>{});writeFileSync(join(output,'steward-workbench-failure.txt'),(await page.locator('body').innerText())+'\n'+String(error.stack));}throw error;}
 finally{await context.close();await host.close();}
}
