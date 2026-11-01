import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TaskLedger} from '../../dist/ledger.js';
import {ProjectRuntime} from '../../dist/project-runtime.js';

export function demandProductFixture(t){
 const dir=mkdtempSync(join(tmpdir(),'demand-products-')),ledger=TaskLedger.open(join(dir,'tasks.sqlite'),{nodeId:'central'}),runtime=new ProjectRuntime({get:()=>undefined},ledger,'central','both'),db=ledger.managementDatabase();
 t.after(()=>{ledger.close();rmSync(dir,{recursive:true,force:true});});
 const put=db.prepare('INSERT INTO entities(kind,id,parent,state,data) VALUES(?,?,?,?,?)');
 return {ledger,runtime,db,task(id,overrides={}){return ledger.createTask(id.replaceAll(' ','-'),{title:id,description:'selected description '+id,...overrides}).value;},run(task,id,state='succeeded',extra={}){const value={runId:id,taskId:task.taskId,state,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-02T00:00:00Z',sessionIds:[],route:{nodeId:'worker',provider:'offline',model:'script',requiredCapabilities:[]},...extra};put.run('run',id,task.taskId,state,JSON.stringify(value));return value;},report(task,run,id,kind='result',extra={}){const value={reportId:id,taskId:task.taskId,runId:run.runId,kind,title:id,body:'selected body '+id,createdAt:'2026-01-02T00:00:00Z',recordedAt:'2026-01-02T00:00:00Z',...extra};put.run('report',id,task.taskId,null,JSON.stringify(value));return value;},read(method,input={},scope){for(let i=0;i<100;i++){try{return runtime.demandRead(method,input,scope);}catch(error){if(error.code!=='READ_MODEL_UPDATING')throw error;}}throw Error('read model did not make progress');}};
}

