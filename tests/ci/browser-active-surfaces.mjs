import assert from 'node:assert/strict';
import {join} from 'node:path';
import {startHost} from './browser-native-project.mjs';
import {ProgramRegistry} from '../../packages/task-system/dist/workflow-programs.js';
import {ExecutorWorker} from '../../packages/task-system/dist/remote/worker.js';
import {RecoveryStore} from '../../packages/task-system/dist/remote/store.js';
import {Workbench} from '../../packages/task-system/dist/workbench.js';
import {createDashboardServer} from '../../dashboard/server.mjs';
import {managementAdapter} from '../../dashboard/management.mjs';

const contrast = ({background,foreground}) => {
  const luminance=color=>color.match(/\d+/g).slice(0,3).map(Number).map(value=>{const channel=value/255;return channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4;}).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
  return (Math.max(luminance(background),luminance(foreground))+.05)/(Math.min(luminance(background),luminance(foreground))+.05);
};

export async function startActiveSurfacesHost() {
  const host=await startHost({withJev:true});
  const ledger=host.ctx.taskSystem.ledger,workbench=new Workbench(ledger),flows=host.ctx.taskSystem.workflows;
  const task=ledger.createTask('surface-task',{title:'Review the retained execution evidence',description:'First evidence line\nSecond evidence line'}).value;
  ledger.appendReport('surface-report',{taskId:task.taskId,title:'Multiline verification report',body:'First report line\nSecond report line',sessionId:'surface-inspection'});
  workbench.manage('surface-link','link_backlog_task',{backlogId:'pr:'+host.created.projectId,taskId:task.taskId});
  const registry=new ProgramRegistry('surface-worker');
  registry.register({programId:'surface.verify',version:'1',title:'Inspect evidence',inputSchema:{type:'object'},outputSchema:{type:'object'},execute:async()=>({data:{verified:true},summary:'First verified output line\nSecond verified output line'})});
  ledger.registerWorkspace('surface-workspace',{workspaceId:'surface-workspace',nodeId:'surface-worker',path:host.directory,label:'Disposable program workspace',state:'ready',createdAt:new Date().toISOString()});
  ledger.registerNode('surface-node',{nodeId:'surface-worker',roles:['executor'],enabled:true,capabilities:[],models:[],workspaceIds:['surface-workspace'],lastSeenAt:new Date().toISOString(),maxConcurrent:1});
  ledger.recordNodeHeartbeat('surface-heartbeat',{nodeId:'surface-worker',sampledAt:Date.now(),runtimeReady:true,activeExecutions:0,providerStatus:{state:'not-probed',providers:[],programs:registry.catalog()},source:'host-local'});
  const store=new RecoveryStore(join(host.directory,'surface-worker.sqlite'));
  const worker=new ExecutorWorker({ledger,store,provider:registry.provider(),policy:{role:'executor',nodeId:'surface-worker',capabilities:[],workspaces:[{nodeId:'surface-worker',workspaceId:'surface-workspace',path:host.directory,allowedRoot:host.directory}]},ttlMs:10000,maxResultBytes:100000});
  flows.save({commandId:'surface-workflow',expectedRevision:0,definition:{workflowId:'surface-flow',projectId:host.created.projectId,revision:0,title:'Review and handover',description:'Disposable workflow; no model invocation',stages:[{stageId:'review',title:'Review evidence',nodeId:'surface-worker',position:{x:40,y:40}}],steps:[{stepId:'review-step',stageId:'review',title:'Inspect retained evidence',nodeId:'surface-worker',workspaceId:'surface-workspace',position:{x:0,y:0},dependsOn:[],inputs:{},execution:{kind:'program',programId:'surface.verify',version:'1'},maxRetries:0}],calls:[]}});
  const run=flows.start({commandId:'surface-run',workflowId:'surface-flow',input:{}});flows.tick();
  await worker.pollOnce(1,{waitForCompletion:true});flows.tick();
  assert.equal(flows.snapshot().runs.find(row=>row.workflowRunId===run.workflowRunId)?.state,'succeeded');
  const dashboard=createDashboardServer({snapshot:()=>ledger.snapshot(),management:managementAdapter(ledger,workbench),databaseIdentity:{databaseId:'surface-browser',label:'Disposable browser verification',path:join(host.directory,'tasks.sqlite')},localRole:'manager'});
  await new Promise(resolve=>dashboard.listen(0,'127.0.0.1',resolve));
  const dashboardUrl=`http://127.0.0.1:${dashboard.address().port}`;
  return {host,ledger,workbench,flows,task,dashboard,dashboardUrl,run,async close(){await worker.dispose();store.close();await host.close();}};
}

export async function testActiveSurfaces(browser,{output}={}) {
  const {host,ledger,workbench,flows,task,dashboard,dashboardUrl,run,close}=await startActiveSurfacesHost();
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN',reducedMotion:'reduce'});
  const page=await context.newPage(),errors=[];
  page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  const capture=async(name,target=page)=>{if(output)await target.screenshot({path:join(output,`${name}.png`),fullPage:true});};
  const theme=async value=>page.evaluate(value=>document.documentElement.style.colorScheme=value,value);
  const noOverflow=async root=>assert.ok(await root.evaluate(element=>element.scrollWidth<=element.clientWidth+1),'Content wraps inside its surface');
  const readable=async button=>{
    const colors=await button.evaluate(async element=>{await Promise.all(element.getAnimations().map(animation=>animation.finished));const style=getComputedStyle(element);return{background:style.backgroundColor,foreground:style.color};});
    assert.ok(contrast(colors)>=4.5,`Primary action readability: ${JSON.stringify(colors)}`);
  };
  try {
    await page.goto(host.url);await page.waitForFunction(()=>!document.querySelector('[data-dsh-boot]'));
    const preview=page.getByRole('dialog',{name:'预览版说明',exact:true});await preview.getByRole('button',{name:'继续',exact:true}).click();
    await page.getByRole('button',{name:'项目与任务',exact:true}).click();
    const frame=page.frameLocator('iframe[title="项目与任务"]');
    console.log('active surfaces: official Host and disposable data ready');
    for(const width of [1440,390]){
      if(width===390)await page.getByRole('button',{name:'收起侧边栏',exact:true}).click();
      await page.setViewportSize({width,height:1000});
      for(const mode of ['light','dark']){
        await theme(mode);
        await frame.locator(`html[data-theme=${mode}]`).waitFor();
        await frame.getByRole('button',{name:'项目',exact:true}).click();
        await frame.getByText('Native browser project',{exact:true}).first().waitFor();
        await noOverflow(frame.locator('body'));await capture(`official-projects-${width}-${mode}`);
        await frame.getByText('Native browser project',{exact:true}).first().click();
        await frame.getByRole('button',{name:'项目对话',exact:true}).waitFor();
        await capture(`official-project-${width}-${mode}`);
        await frame.getByRole('button',{name:'任务',exact:true}).click();
        await frame.getByRole('button',{name:'完整面板',exact:true}).click();
        await frame.locator('[data-action="panel-tab"][data-id="tasks"]').click();
        await frame.getByText('Review the retained execution evidence',{exact:true}).first().waitFor();
        await noOverflow(frame.locator('body'));await capture(`official-fullpanel-${width}-${mode}`);
        await frame.locator('.topbar [data-action="nav-back"]').first().click();
      }
    }
    console.log('active surfaces: projects and full panel passed');
    await page.setViewportSize({width:1440,height:1000});
    await frame.getByRole('button',{name:'项目',exact:true}).click();await frame.getByText('Native browser project',{exact:true}).first().click();
    await frame.getByRole('button',{name:'新建工作流',exact:true}).click();
    const workflow=page.frameLocator('iframe[title="项目工作流"]');
    await workflow.locator('#workflow-title').waitFor();
    await workflow.locator('#workflow-title').fill('Review and handover — updated');
    const workflowSaved=page.waitForResponse(response=>response.url().includes('/api/taskPluginSettings/saveWorkflow')&&response.ok());
    await workflow.locator('#save-workflow').click();await workflowSaved;
    assert.equal(flows.snapshot().definitions.find(row=>row.workflowId==='surface-flow').title,'Review and handover — updated');
    for(const width of [1440,390])for(const mode of ['light','dark']){
      await page.setViewportSize({width,height:1000});await theme(mode);
      await workflow.locator(`html[data-theme=${mode}]`).waitFor();
      await noOverflow(workflow.locator('body'));await capture(`official-workflow-${width}-${mode}`);
    }
    await workflow.locator('#history').selectOption(run.workflowRunId);
    await workflow.locator('#run-state').getByText('已完成',{exact:true}).waitFor();
    await capture('official-workflow-run-detail');
    console.log('active surfaces: workflow save, completed program run and themes passed');
    await page.getByRole('button',{name:'插件',exact:true}).click();
    await page.getByRole('button',{name:'账号菜单',exact:true}).click();
    await page.getByRole('menuitem',{name:'设置',exact:true}).click();
    await page.getByRole('button',{name:'JEV',exact:true}).click();
    const jev=page.locator('.dshjev-card');await jev.locator('.dshjev-input').first().waitFor();
    const model=jev.getByLabel('Model override',{exact:false});
    await model.fill('multilingual');await jev.getByRole('button',{name:'Discard',exact:true}).click();
    await model.fill('english');await jev.getByRole('button',{name:'Save',exact:true}).click();
    await jev.getByText('Saved.',{exact:true}).waitFor();
    await jev.getByRole('button',{name:'Reload',exact:true}).click();assert.equal(await model.inputValue(),'english');
    assert.equal(await jev.locator('input[type=password]').inputValue(),'','Credentials remain undisclosed');
    for(const width of [1440,390])for(const mode of ['light','dark']){
      await page.setViewportSize({width,height:1000});await theme(mode);await page.locator(`.dshjev-card[data-theme=${mode}]`).waitFor();
      await model.fill('multilingual');await readable(jev.getByRole('button',{name:'Save',exact:true}));
      await noOverflow(jev);
      if(width===390)assert.ok(await page.getByRole('dialog').locator(':scope > nav').evaluate(element=>element.getBoundingClientRect().height<190),'Mobile settings navigation leaves room for the form');
      await capture(`official-jev-${width}-${mode}`);await jev.getByRole('button',{name:'Discard',exact:true}).click();
    }
    await jev.evaluate(element=>{for(let node=element.parentElement;node;node=node.parentElement)if(node.scrollHeight>node.clientHeight)node.scrollTop=0;});
    await capture('official-jev-mobile-top');
    await page.goto(dashboardUrl+'/');await page.locator('.task-card').first().waitFor();
    for(const width of [1440,390])for(const mode of ['light','dark']){
      await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:mode});
      await noOverflow(page.locator('html'));await capture(`dashboard-${width}-${mode}`);
    }
    await page.goto(dashboardUrl+'/#task/'+task.taskId+'/reports');
    await page.locator('.report-content').waitFor();
    assert.equal(await page.locator('.report-content').first().evaluate(element=>getComputedStyle(element).whiteSpace),'pre-wrap');
    assert.match(await page.locator('.report-content').first().textContent(),/First report line\nSecond report line/);
    await capture('dashboard-report-multiline');
    await page.goto(dashboardUrl+'/manage.html');await page.getByText('Disposable browser verification',{exact:true}).waitFor();
    await page.getByRole('button',{name:'新建领域',exact:true}).click();
    const dialog=page.locator('#management-dialog');await dialog.locator('[name=title]').fill('Browser design review');
    await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.waitFor({state:'hidden'});
    assert.ok(workbench.snapshot().domains.some(row=>row.title==='Browser design review'));
    for(const width of [1440,390])for(const mode of ['light','dark']){
      await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:mode});
      await noOverflow(page.locator('html'));await capture(`management-${width}-${mode}`);
      await page.getByRole('button',{name:'新建领域',exact:true}).click();
      await readable(dialog.locator('#form-save'));await capture(`management-form-${width}-${mode}`);
      await dialog.getByRole('button',{name:'取消',exact:true}).click();
    }
    await page.goto(dashboardUrl+'/manage.html#task/'+task.taskId);
    await page.locator('.management-record').first().waitFor();
    const evidence=page.locator('.management-record p').filter({hasText:'First report line'}).first();
    await evidence.waitFor();assert.equal(await evidence.evaluate(element=>getComputedStyle(element).whiteSpace),'pre-wrap');
    assert.match(await evidence.textContent(),/First report line\nSecond report line/);await capture('management-report-multiline');
    assert.equal(host.model.requests.length,0,'Surface inspection does not invoke a model');assert.deepEqual(errors,[]);
    return {officialHost:true,projects:true,fullpanel:true,workflowSaved:true,completedProgramRun:true,multilineReports:true,jevSaved:true,dashboardReadOnly:true,managementSaved:true,themes:['light','dark'],widths:[1440,390],paidCalls:0};
  }catch(error){await capture('active-surfaces-failure').catch(()=>{});throw error;}
  finally{await context.close();await new Promise(resolve=>{dashboard.close(resolve);dashboard.closeAllConnections();});await close();}
}
