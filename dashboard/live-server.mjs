/** Loopback origin for an independently authorized Access + Tunnel deployment. */
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {accessConfiguration,createAccessAuthorizer} from './access.mjs';
import {createDashboardServer} from './server.mjs';

export function liveConfiguration(env=process.env) {
  const ledgerPath=env.DSH_DASHBOARD_LEDGER;
  if(!ledgerPath || !path.isAbsolute(ledgerPath)) throw new Error('DSH_DASHBOARD_LEDGER must be the absolute path of the existing TaskLedger');
  const port=Number(env.DSH_DASHBOARD_PORT||4317);
  if(!Number.isInteger(port)||port<1024||port>65535||port===18440) throw new Error('Use an unprivileged dashboard port distinct from the remote command service');
  const basePath=env.DSH_DASHBOARD_BASE_PATH||'/';
  if(!/^\/[a-zA-Z0-9/_-]*$/.test(basePath)||basePath.includes('//')) throw new Error('Invalid dashboard base path');
  const access={teamDomain:env.CF_ACCESS_TEAM_DOMAIN,audience:env.CF_ACCESS_AUD,ownerEmail:env.CF_ACCESS_OWNER_EMAIL,publicOrigin:env.DSH_DASHBOARD_PUBLIC_ORIGIN};
  accessConfiguration(access);
  return {ledgerPath,port,basePath,access};
}

async function main() {
  const args=process.argv.slice(2);
  if(args.some(arg=>arg!=='--check')) throw new Error('Only --check is supported; configure the origin through its environment file');
  const config=liveConfiguration();
  const {TaskLedger}=await import('../packages/task-system/dist/index.js');
  const ledger=TaskLedger.open(config.ledgerPath,{readOnly:true});
  // Fail before listening if this is an absent/incompatible ledger; never initialize one here.
  ledger.snapshot();
  if(args.includes('--check')) { ledger.close(); console.log('Configuration and existing ledger are readable; authentication and public routing have not been tested.'); return; }
  const server=createDashboardServer({snapshot:()=>ledger.snapshot(),basePath:config.basePath,authorize:createAccessAuthorizer(config.access),requireSessionExpiry:true,accessLabel:'私人任务看板',accessDescription:'Cloudflare Access · 仅本人 · 只读'});
  server.listen(config.port,'127.0.0.1',()=>console.log(`Dashboard origin listening on 127.0.0.1:${config.port}; all requests require an owner Access JWT`));
  let closing=false;
  const close=()=>{if(closing)return;closing=true;server.close(()=>{ledger.close();process.exit(0);});server.closeIdleConnections();};
  process.on('SIGTERM',close);process.on('SIGINT',close);
  server.on('error',()=>{console.error('Dashboard origin failed to listen');ledger.close();process.exitCode=1;});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(()=>{console.error('Dashboard could not start: check the non-secret configuration, Node version, and existing ledger access');process.exitCode=1;});
