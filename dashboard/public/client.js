import {validateSnapshot} from './model.js';

export class DashboardLoadError extends Error {
  constructor(kind,message) { super(message); this.name='DashboardLoadError'; this.kind=kind; }
}

/** Same-origin browser session only. Login redirects are handled by a top-level reload. */
export async function loadSnapshot(url,{origin,fetcher=fetch,signal,requireSessionExpiry=false}={}) {
  const target=new URL(url);
  if(target.origin!==origin) throw new DashboardLoadError('configuration','任务 API 必须与页面同域');
  let response;
  try { response=await fetcher(target,{headers:{Accept:'application/json'},credentials:'same-origin',cache:'no-store',redirect:'manual',signal}); }
  catch(error) { throw new DashboardLoadError('connection',error.name==='AbortError'?'任务数据源连接超时':'暂时无法连接任务数据源'); }
  if(response.type==='opaqueredirect'||response.redirected||[301,302,303,307,308,401,403].includes(response.status)) throw new DashboardLoadError('authentication','登录已失效或当前账号没有访问权限');
  if(!response.ok) throw new DashboardLoadError('connection',`读取失败（HTTP ${response.status}）`);
  if(!(response.headers.get('content-type')||'').toLowerCase().includes('application/json')) throw new DashboardLoadError('authentication','未收到任务数据，请重新验证登录');
  const expiresAt=Date.parse(response.headers.get('x-dsh-session-expires-at'));
  if(requireSessionExpiry&&(!Number.isFinite(expiresAt)||expiresAt<=Date.now())) throw new DashboardLoadError('authentication','登录已到期，请重新验证身份');
  let snapshot;
  try { snapshot=validateSnapshot(await response.json()); }
  catch { throw new DashboardLoadError('data','任务数据格式暂不可用'); }
  if(requireSessionExpiry&&expiresAt<=Date.now()) throw new DashboardLoadError('authentication','登录已到期，请重新验证身份');
  return {snapshot,expiresAt:Number.isFinite(expiresAt)?expiresAt:null};
}
