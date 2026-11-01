import type { DatabaseSync } from 'node:sqlite';
/** Header tables are derivative. Old binaries keep them current through SQL-only triggers. */
export function prepareWorkflowReadIndex(db:DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS workflow_run_headers(id TEXT PRIMARY KEY,workflow_id TEXT NOT NULL,task_id TEXT,project_id TEXT,created_at TEXT NOT NULL,state TEXT NOT NULL,seq INTEGER NOT NULL,data TEXT NOT NULL,runnable INTEGER NOT NULL,run_id TEXT);
    CREATE INDEX IF NOT EXISTS workflow_header_run ON workflow_run_headers(run_id,state,id);
    CREATE INDEX IF NOT EXISTS workflow_due ON workflow_definitions(next_due,id);
    CREATE INDEX IF NOT EXISTS workflow_header_runnable ON workflow_run_headers(runnable,seq DESC,id);
    CREATE INDEX IF NOT EXISTS workflow_header_history ON workflow_run_headers(workflow_id,seq DESC);
    CREATE INDEX IF NOT EXISTS workflow_header_task ON workflow_run_headers(task_id,seq DESC);
    CREATE TABLE IF NOT EXISTS workflow_definition_headers(id TEXT PRIMARY KEY,project_id TEXT,title TEXT NOT NULL,description TEXT NOT NULL,revision INTEGER NOT NULL,result_steps TEXT,node_ids TEXT NOT NULL,step_count INTEGER NOT NULL,seq INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS workflow_definition_project ON workflow_definition_headers(project_id,seq DESC);`);
  const fields=['workflowRunId','workflowId','projectId','taskId','runId','definitionRevision','title','createdAt','state'];
  const runSelect=(source:string,seq:string)=>`${source}.id,json_extract(${source}.data,'$.workflowId'),json_extract(${source}.data,'$.taskId'),json_extract(${source}.data,'$.projectId'),json_extract(${source}.data,'$.createdAt'),json_extract(${source}.data,'$.state'),${seq},json_object(${fields.flatMap(field=>[`'${field}'`,`json_extract(${source}.data,'$.${field}')`]).join(',')}),CASE WHEN json_extract(${source}.data,'$.state') NOT IN ('succeeded','partial','failed','cancelled') OR (json_extract(${source}.data,'$.state')='cancelled' AND EXISTS(SELECT 1 FROM json_each(${source}.data,'$.steps') step WHERE json_extract(step.value,'$.state') IN ('queued','running','uncertain'))) THEN 1 ELSE 0 END,json_extract(${source}.data,'$.runId')`;
  const definitionSelect=(source:string,seq:string)=>`${source}.id,json_extract(${source}.data,'$.projectId'),json_extract(${source}.data,'$.title'),substr(json_extract(${source}.data,'$.description'),1,300),json_extract(${source}.data,'$.revision'),json_extract(${source}.data,'$.resultStepIds'),(SELECT json_group_array(DISTINCT json_extract(j.value,'$.nodeId')) FROM json_each(${source}.data,'$.steps') j),json_array_length(${source}.data,'$.steps'),${seq}`;
  for(const [table,header,select] of [['workflow_runs','workflow_run_headers',runSelect],['workflow_definitions','workflow_definition_headers',definitionSelect]] as const) {
    const columns=table==='workflow_runs'?['workflow_id','task_id','project_id','created_at','state','seq','data','runnable','run_id']:['project_id','title','description','revision','result_steps','node_ids','step_count','seq'];
    for(const operation of ['INSERT','UPDATE'] as const)db.exec(`CREATE TRIGGER IF NOT EXISTS demand_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN ${operation==='UPDATE'?`DELETE FROM ${header} WHERE id=OLD.id AND OLD.id<>NEW.id;`:''} INSERT INTO ${header} SELECT ${select('NEW','NEW.rowid')} ON CONFLICT(id) DO UPDATE SET ${columns.map(column=>`${column}=excluded.${column}`).join(',')}; END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS demand_${table}_delete AFTER DELETE ON ${table} BEGIN DELETE FROM ${header} WHERE id=OLD.id; END;`);
    db.exec(`INSERT INTO ${header} SELECT ${select('s','s.rowid')} FROM ${table} s WHERE NOT EXISTS(SELECT 1 FROM ${header} h WHERE h.id=s.id);`);
  }
}
