import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {startHost} from './browser-native-project.mjs';

export async function testNativeStewardMedia(browser,{output}={}) {
  const host=await startHost(), context=await browser.newContext({viewport:{width:1440,height:1100},locale:'zh-CN'}),page=await context.newPage(),errors=[],calls=[];
  host.model.listModels=async provider=>['script','chosen'].map(id=>({provider,id,name:id==='chosen'?'Chosen fixture':'Scripted fixture'}));
  host.model.resolveModel=async(provider,id)=>({provider,id,name:id==='chosen'?'Chosen fixture':'Scripted fixture',inputModalities:['text','image'],reasoning:{efforts:[{id:'high',name:'High fixture'},{id:'low',name:'Low fixture'}]}});
  page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.url().includes('/api/taskPluginSettings/stewardSend'))calls.push(request.postDataJSON().payload.args.input);});
  const native=page.locator('[data-steward-native-host]'),editor=native.locator('[contenteditable=true]:visible'),input=native.locator('[data-steward-router-composer] input[type=file]');
  const topic=async()=>{await native.getByRole('button',{name:/^本条话题：/}).click();await page.getByRole('option',{name:/^闲聊/}).click();};
  const open=async()=>{await page.goto(host.url);await page.waitForFunction(()=>!document.querySelector('[data-dsh-boot]'));const preview=page.getByRole('dialog',{name:'预览版说明',exact:true});if(await preview.count())await preview.getByRole('button',{name:'继续',exact:true}).click();await page.getByRole('button',{name:'管家',exact:true}).click();await editor.waitFor();await native.getByRole('button',{name:/选择模型/}).waitFor();};
  const model=async name=>{await native.getByRole('button',{name:/选择模型/}).click();await page.getByRole('menuitem',{name:/^模型/}).click();await page.getByRole('menuitemradio',{name:new RegExp(name)}).click();};
  const file=(name,text)=>({name,mimeType:'text/plain',buffer:Buffer.from(text)});
  try {
    await open();const defaults=host.ctx.agentDefaultModel.currentSelection();await model('Chosen fixture');
    await native.getByRole('button',{name:/选择模型/}).click();await page.getByRole('menuitem',{name:/^推理/}).click();await page.getByRole('menuitemradio',{name:/High fixture/}).click();
    const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=1;return c.toDataURL('image/png').split(',')[1];});
    await topic();await input.setInputFiles({name:'tiny.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});await input.setInputFiles(file('proof.txt','BROWSER_ADMITTED_FILE_BYTES'));await native.getByText('proof.txt',{exact:true}).waitFor();
    if(output)await page.screenshot({path:join(output,'native-media-previews.png'),fullPage:true});
    host.model.script.push('MEDIA_CHOSEN_OK');await native.getByRole('button',{name:'发送消息',exact:true}).click();await native.getByText('MEDIA_CHOSEN_OK',{exact:true}).waitFor();
    assert.equal(calls.length,1);assert.equal(calls[0].text,'');assert.equal(calls[0].uploads.length,2);assert.equal(calls[0].selection.model,'chosen');assert.equal(calls[0].selection.reasoningEffort,'high');assert.equal(host.model.requests.at(-1).model,'chosen');assert.equal(host.model.requests.at(-1).reasoningEffort,'high');assert.match(JSON.stringify(host.model.requests.at(-1).messages),/"type":"image"/);assert.match(JSON.stringify(host.model.requests.at(-1).messages),/proof.txt/);assert.deepEqual(host.ctx.agentDefaultModel.currentSelection(),defaults);
    const message=host.ctx.taskSystem.steward.store.commandMessage('main',calls[0].commandId);assert.deepEqual(message.content.map(part=>part.type),['image','file']);
    await page.reload();await page.getByRole('button',{name:'管家',exact:true}).click();await editor.waitFor();await native.getByText('MEDIA_CHOSEN_OK',{exact:true}).waitFor();assert.equal(calls.length,1);await native.getByRole('button',{name:/选择模型.*Chosen fixture/}).waitFor();assert.equal(await native.getByText('proof.txt',{exact:true}).count(),1);
    await model('跟随目标会话');await topic();await input.setInputFiles(file('only.txt','FILE_ONLY'));host.model.script.push('FILE_ONLY_OK');await native.getByRole('button',{name:'发送消息',exact:true}).click();await native.getByText('FILE_ONLY_OK',{exact:true}).waitFor();assert.equal(calls.at(-1).selection,undefined);assert.equal(calls.at(-1).uploads.length,1);
    // Auto cannot infer a destination from an attachment alone. Preserve original bytes and original follow-target intent.
    await input.setInputFiles(file('ambiguous.txt','ORIGINAL_AUTO_FILE'));await native.getByRole('button',{name:'发送消息',exact:true}).click();await native.getByRole('button',{name:'恢复原文到输入框',exact:true}).waitFor();
    await input.setInputFiles(file('current.txt','CURRENT_UNSENT_FILE'));await native.getByRole('button',{name:'恢复原文到输入框',exact:true}).click();await native.getByText(/已有草稿/).waitFor();await native.getByText('current.txt',{exact:true}).waitFor();
    // Reload discards the explicitly unsent current draft, while the original immutable pending request remains recoverable.
    await page.reload();await page.getByRole('button',{name:'管家',exact:true}).click();await editor.waitFor();await model('Chosen fixture');await native.getByRole('button',{name:'恢复原文到输入框',exact:true}).click();await native.getByText('ambiguous.txt',{exact:true}).waitFor();await native.getByRole('button',{name:/选择模型.*跟随目标会话/}).waitFor();
    await topic();host.model.script.push('RESTORED_FILE_OK');await native.getByRole('button',{name:'发送消息',exact:true}).click();await native.getByText('RESTORED_FILE_OK',{exact:true}).waitFor();assert.equal(calls.at(-1).selection,undefined);
    // A lost ACK must reconcile the exact saved command and receipts after reload without a second submission.
    await topic();await input.setInputFiles(file('lost.txt','LOST_ACK_BYTES'));let held;
    await page.route('**/api/taskPluginSettings/stewardSend',async route=>{held=route.request().postDataJSON().payload.args.input;await route.fetch();await route.abort();});host.model.script.push('LOST_ACK_MEDIA_OK');await native.getByRole('button',{name:'发送消息',exact:true}).click();await native.getByText('LOST_ACK_MEDIA_OK',{exact:true}).waitFor();const before=calls.length;await page.unroute('**/api/taskPluginSettings/stewardSend');await page.reload();await page.getByRole('button',{name:'管家',exact:true}).click();await editor.waitFor();await native.getByText('LOST_ACK_MEDIA_OK',{exact:true}).waitFor();assert.equal(calls.length,before);assert.ok(host.ctx.taskSystem.steward.store.commandMessage('main',held.commandId));
    // Hold the final image-upload ACK across an authority change. The original capture cannot dispatch against the new authority.
    await topic();await input.setInputFiles({name:'held.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
    let releaseFinish,finishStarted;const started=new Promise(resolve=>finishStarted=resolve),release=new Promise(resolve=>releaseFinish=resolve);let finishReturned;
    const returned=new Promise(resolve=>finishReturned=resolve);
    await page.route('**/api/taskPluginSettings/stewardUpload',async route=>{if(route.request().postDataJSON().payload.args.input.kind!=='finish')return route.continue();const response=await route.fetch();finishStarted();await release;await route.fulfill({response}).catch(()=>{});finishReturned();});
    const beforeAuthority=calls.length;await native.getByRole('button',{name:'发送消息',exact:true}).click();await started;
    const originalPending=await page.evaluate(()=>Object.entries(localStorage).flatMap(([key,value])=>{try{return JSON.parse(value).filter?.(item=>item.request?.preparingAttachments&&item.request?.uploads?.length).map(item=>({key,request:item.request}))??[];}catch{return [];}}));assert.equal(originalPending.length,1);
    let changed;const changedResponse=new Promise(resolve=>changed=resolve);await page.route('**/api/taskPluginSettings/stewardReconcile',async route=>{const response=await route.fetch(),body=await response.json();const update=value=>{if(!value||typeof value!=='object')return;if(value.authorityId)value.authorityId='other-test-authority';Object.values(value).forEach(update);};update(body);await route.fulfill({response,json:body});changed();});await changedResponse;
    await page.waitForFunction(()=>Object.keys(localStorage).some(key=>key.includes('other-test-authority')));releaseFinish();await returned;
    await page.unroute('**/api/taskPluginSettings/stewardReconcile');await page.unroute('**/api/taskPluginSettings/stewardUpload');await page.reload();await page.getByRole('button',{name:'管家',exact:true}).click();await editor.waitFor();
    await native.getByRole('button',{name:'恢复原文到输入框',exact:true}).click();await native.locator('img').last().waitFor();assert.equal(calls.length,beforeAuthority);assert.equal(host.ctx.taskSystem.steward.store.commandMessage('main',originalPending[0].request.commandId),null);
    assert.deepEqual(errors,[]);if(output)await page.screenshot({path:join(output,'native-media-history.png'),fullPage:true});
    return {realNativeModelPicker:true,reasoningFrozen:true,globalDefaultUnchanged:true,imageAndFileOnly:true,reloadHistory:true,restoreRejectsFileOnlyDraft:true,restoreFollowTarget:true,lostAckNoReplay:true,heldUploadAuthorityIsolation:true};
  } catch(error) {if(output){await page.screenshot({path:join(output,'native-media-failure.png'),fullPage:true}).catch(()=>{});writeFileSync(join(output,'native-media-failure.txt'),(await page.locator('body').innerText())+'\n'+String(error.stack));}throw error;}
  finally {await context.close();await host.close();}
}
