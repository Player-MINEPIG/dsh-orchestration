import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {managementSnapshot,readManagementCommand} from './management.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const PUBLIC=path.join(HERE,'public');
const STATIC=new Map([['','index.html'],['index.html','index.html'],['app.js','app.js'],['model.js','model.js'],['client.js','client.js'],['styles.css','styles.css'],['favicon.svg','favicon.svg'],['manage.html','manage.html'],['management-app.js','management-app.js'],['management-model.js','management-model.js'],['management-client.js','management-client.js'],['management.css','management.css']]);
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
const LOOPBACK=new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
const PRIVATE_KEYS=/password|passwd|secret|token|api.?key|authorization|cookie|system.?prompt|chain.?of.?thought|private.?notes/i;
const normalBase=value=>{const raw=value||'/';if(!/^\/[a-zA-Z0-9/_-]*$/.test(raw)||raw.includes('//'))throw new Error('basePath must be a simple absolute URL path');return raw==='/'?'/':raw.replace(/\/$/,'')+'/';};
function redact(value){if(Array.isArray(value))return value.map(redact);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!PRIVATE_KEYS.test(key)).map(([key,item])=>[key,redact(item)]));return value;}
function pick(record,fields){return Object.fromEntries(fields.filter(key=>record[key]!==undefined).map(key=>[key,record[key]]));}
/** Keep the shared query shape; omit operational credentials, raw settings, and unstructured event payloads. */
export function dashboardSnapshot(source){
  return {
    schemaVersion:source.schemaVersion,generatedAt:source.generatedAt,
    source:pick(source.source,['kind','label','observedAt','staleAfterMs']),
    tasks:(source.tasks||[]).map(x=>({...pick(x,['taskId','title','description','state','kind','createdAt','updatedAt','parentTaskId','workspaceId','tags','admissionState','admissionRevision']),...(x.source?{source:pick(x.source,['observedAt','importedAt','originalCreatedAt','label'])}:{})})),
    runs:(source.runs||[]).map(x=>({...pick(x,['runId','taskId','state','createdAt','updatedAt','sessionIds','outcome','validation','reviewStatus','occurrenceId','cancellationRequested']),...(x.route?{route:pick(x.route,['nodeId','provider','model','reasoningEffort','workspaceId','requiredCapabilities'])}:{}),configuration:{}})),
    reports:(source.reports||[]).map(x=>pick(x,['reportId','taskId','runId','attemptId','sessionId','revision','previousReportId','title','body','createdAt','recordedAt','artifactIds','kind'])),
    artifacts:(source.artifacts||[]).map(x=>pick(x,['artifactId','taskId','reportId','name','mediaType','uri','sha256','bytes','createdAt','finalized'])),
    templates:(source.templates||[]).map(x=>({...pick(x,['templateId','version','name','description']),inputSchema:redact(x.inputSchema),defaults:{},resultContract:{}})),
    events:(source.events||[]).map(x=>({...pick(x,['eventId','taskId','runId','type','at']),detail:x.detail&&typeof x.detail==='object'?pick(x.detail,['summary','message','title']):{}})),
    ...(Array.isArray(source.workspaces)?{workspaces:source.workspaces.map(x=>pick(x,['workspaceId','nodeId','path','label','state','createdAt']))}:{}),
    ...(Array.isArray(source.schedules)?{schedules:source.schedules.map(x=>pick(x,['scheduleId','taskId','templateId','templateVersion','enabled','intervalMs','nextDueAt','overlap']))}:{})
  };
}
function securityHeaders(res){
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
 res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
}
function send(res,code,body,type='text/plain; charset=utf-8',method='GET'){res.writeHead(code,{'Content-Type':type});res.end(method==='HEAD'?undefined:body);}
/**
 * Portable Node handler for DSH/another authenticated host. The default is local-only.
 * authorize(req) must validate the host's existing session before returning true.
 * No token creation, credential persistence, or database of its own.
 * Optional management requires an existing ledger adapter, named database and a trusted manager role.
 */
export function createDashboardHandler({snapshot,basePath='/',authorize,requireSessionExpiry=false,accessLabel='云电脑本地视图',accessDescription='只读 · 不对公网开放',refreshIntervalMs=15000,management,localRole='viewer',managementOrigin,databaseIdentity}={}){
 if(typeof snapshot!=='function')throw new Error('snapshot callback is required');
 if(requireSessionExpiry&&typeof authorize!=='function')throw new Error('Session expiry requires an authenticated host adapter');
 if(management&&(!databaseIdentity?.databaseId||!databaseIdentity?.label||!path.isAbsolute(databaseIdentity?.path||'')))throw new Error('Management requires an explicit database identity and path');
 if(management&&authorize&&!managementOrigin)throw new Error('Authenticated management requires an explicit managementOrigin');
 if(managementOrigin){const url=new URL(managementOrigin);if(!['http:','https:'].includes(url.protocol)||url.origin!==managementOrigin)throw new Error('managementOrigin must be an exact HTTP(S) origin');}
 if(!['viewer','manager'].includes(localRole))throw new Error('Invalid localRole');
 const base=normalBase(basePath);
 return async(req,res)=>{
  securityHeaders(res);
  try{
   let session;
   if(authorize){
    try{session=await authorize(req);}catch{session=false;}
    if(!session||(requireSessionExpiry&&(!Number.isFinite(session.expiresAt)||session.expiresAt<=Date.now()))){send(res,401,'Authentication required');return;}
    if(Number.isFinite(session.expiresAt))res.setHeader('X-DSH-Session-Expires-At',new Date(session.expiresAt).toISOString());
   }
   else{
    const hostname=(req.headers.host||'').toLowerCase().replace(/:\d+$/,'');
    if(!LOOPBACK.has(req.socket.remoteAddress)||!['127.0.0.1','localhost','[::1]'].includes(hostname)){send(res,403,'Local access only');return;}
   }
   let pathname;
   try{pathname=new URL(req.url,'http://localhost').pathname;}catch{send(res,400,'Invalid URL');return;}
   if(base!=='/'&&pathname===base.slice(0,-1)){res.writeHead(308,{Location:base});res.end();return;}
   if(!pathname.startsWith(base)){send(res,404,'Not found');return;}
   const relative=pathname.slice(base.length);
   const canManage=Boolean(management?.manage&&(authorize?session?.role==='manager':localRole==='manager'));
   if(relative==='api/manage'&&req.method==='POST'&&management){
    if(!canManage){send(res,403,JSON.stringify({error:'Management role required'}),'application/json; charset=utf-8');return;}
    const expectedOrigin=managementOrigin||`http://${req.headers.host}`;
    if(req.headers.origin!==expectedOrigin||req.headers['x-dsh-management']!=='1'||(req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin')){send(res,403,JSON.stringify({error:'Same-origin management request required'}),'application/json; charset=utf-8');return;}
    try{
     const body=await readManagementCommand(req);
     if(Number.isFinite(session?.expiresAt)&&session.expiresAt<=Date.now()){send(res,401,JSON.stringify({error:'Authentication expired'}),'application/json; charset=utf-8');return;}
     const receipt=await management.manage(body.commandId,body.operation,body.data);
     // Mutation replies expose receipt metadata only; refreshed projections own visible records.
     send(res,200,JSON.stringify({commandId:receipt.commandId,acceptedAt:receipt.acceptedAt}),'application/json; charset=utf-8');
    }catch(error){
     const codes={CONFLICT:409,NOT_FOUND:404,INVALID:400,VALIDATION:400,SCHEMA:400,TERMINAL:409,STATE:409,FORBIDDEN:403,POLICY:403};
     const status=error.status||codes[error.code]||503;
     send(res,status,JSON.stringify({error:error.status?error.message:'Management command was rejected',code:error.code||'INVALID_COMMAND'}),'application/json; charset=utf-8');
    }
    return;
   }
   if(!['GET','HEAD'].includes(req.method)){res.setHeader('Allow','GET, HEAD');send(res,405,'Read-only dashboard');return;}
   if(relative==='api/workbench'&&management){send(res,200,JSON.stringify(managementSnapshot(await snapshot(),await management.snapshot(),databaseIdentity,{canManage})),'application/json; charset=utf-8',req.method);return;}
   if(relative==='api/health'){send(res,200,JSON.stringify({ok:true,readOnly:!canManage,managementEnabled:Boolean(management)}),'application/json; charset=utf-8',req.method);return;}
   if(relative==='api/snapshot'){send(res,200,JSON.stringify(dashboardSnapshot(await snapshot())),'application/json; charset=utf-8',req.method);return;}
   if(relative==='config.js'){
    const config={apiBase:base+'api',refreshIntervalMs,requireSessionExpiry,title:'DSH · 任务看板',accessLabel,accessDescription,managementEnabled:Boolean(management)};
    send(res,200,`window.DSH_DASHBOARD_CONFIG=Object.freeze(${JSON.stringify(config).replace(/</g,'\\u003c')});`,'text/javascript; charset=utf-8',req.method);return;
   }
   const asset=STATIC.get(relative);if(!asset){send(res,404,'Not found');return;}
   send(res,200,await readFile(path.join(PUBLIC,asset)),TYPES[path.extname(asset)],req.method);
  }catch(error){console.error('[dashboard] Task data source unavailable');if(!res.headersSent)send(res,503,JSON.stringify({error:'Task data source unavailable'}),'application/json; charset=utf-8');else res.end();}
 };
}
export function createDashboardServer(options){return http.createServer(createDashboardHandler(options));}

async function main(){
 const args=process.argv.slice(2),argument=(name,fallback)=>{const index=args.indexOf(name);return index<0?fallback:args[index+1];};
 const ledgerPath=path.resolve(argument('--ledger',path.join(HERE,'../.runtime/tasks.sqlite')));
 const port=Number(argument('--port','4317'));if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid port');
 const basePath=argument('--base-path','/');normalBase(basePath);
 if(args.includes('--host'))throw new Error('Standalone dashboard is loopback-only. Use an authenticated host adapter for deployment.');
 const {TaskLedger}=await import('../packages/task-system/dist/ledger.js');
 const ledger=TaskLedger.open(ledgerPath,{readOnly:true});
 const server=createDashboardServer({snapshot:()=>ledger.snapshot(),basePath});
 server.listen(port,'127.0.0.1',()=>console.log(`DSH task dashboard: http://127.0.0.1:${port}${normalBase(basePath)} (read-only, loopback-only)`));
 let closing=false;const close=()=>{if(closing)return;closing=true;server.close(()=>{ledger.close?.();process.exit(0);});server.closeIdleConnections();};
 process.on('SIGTERM',close);process.on('SIGINT',close);server.on('error',error=>{console.error(error.message);ledger.close?.();process.exitCode=1;});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(`Dashboard could not start: ${error.message}`);process.exitCode=1;});
