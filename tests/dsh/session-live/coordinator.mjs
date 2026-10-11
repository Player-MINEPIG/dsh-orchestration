/** All VPS writes belong to the caller's isolated run directory. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { TaskLedger } from "../../../packages/task-system/dist/index.js";
import {
  RemoteGateway,
  RecoveryStore,
  TrustedNetworkVerifier,
  httpHandler,
} from "../../../packages/task-system/dist/remote/api.js";
import { Context } from "@deepseek-ai/cordis";
import { ProjectRuntime } from "../../../packages/task-system/dist/project-runtime.js";
import { ProjectCollaborationAuthority } from "../../../packages/task-system/dist/project-collaboration/authority.js";
import { createRegistrationServer,bearerNamespaceAuthorizer } from "../../../packages/task-system/dist/project-registration/http.js";
import { randomBytes } from "node:crypto";
const address=process.env.DSH_TEST_VPS_IP || "100.123.230.75", executorAddress=process.env.DSH_TEST_MBP_IP || "100.111.163.32";
const root = process.env.DSH_RECURSIVE_RUNTIME || process.cwd(),
  port = Number(process.env.DSH_RECURSIVE_PORT || 43971);
const ledger = TaskLedger.open(join(root, "coordinator.sqlite"), {
    role: "planner",
    nodeId: "vps",
  }),
  store = new RecoveryStore(join(root, "gateway.sqlite"));
const operations = [
  "claim",
  "renew",
  "submit",
  "cancel",
  "receipt",
  "bindSession",
  "markRunning",
  "getRun",
  "getAttempt",
  "acknowledgeCancellation",
  "listWork",
  "delegate",
  "taskHistory",
  "taskWait",
  "taskNote",
  "taskReport", "heartbeat", "nodeStatus", "projectCollaborate", "projectSnapshot", "executorIdentity", "sessionContext", "selectTaskSession", "sessionMessages", "sessionMessageReply",
];
const peer = {
  address:executorAddress, role:"executor",
  nodeId: "mbp",
  audience: "vps",
  operations,
  workspaces: ["mbp-workspace"],
  capabilities: ["native-dsh", "official-codex"],
};
const route = {
  nodeId: "mbp",
  provider: "deepseek-official",
  model: "deepseek-flash",
  reasoningEffort: "low",
  workspaceId: "mbp-workspace",
  requiredCapabilities: ["native-dsh"],
};
const codex = {
  ...route,
  provider: "codex",
  backend: "codex-luna-low",
  model: "gpt-6-luna",
  requiredCapabilities: ["official-codex"],
};
const at = ledger.snapshot().workspaces.find(w => w.workspaceId === "mbp-workspace")?.createdAt || new Date().toISOString();
ledger.registerWorkspace("live-workspace", {
  workspaceId: "mbp-workspace",
  nodeId: "mbp",
  path: readFileSync(join(root, "mbp-workspace.txt"), "utf8").trim(),
  label: "MBP isolated recursion workspace",
  state: "ready",
  createdAt: at,
});
ledger.registerNode("live-node", {
  nodeId: "mbp",
  roles: ["executor"],
  capabilities: peer.capabilities,
  models: [
    {
      provider: "deepseek-official",
      model: "deepseek-flash",
      reasoningEfforts: ["low"],
    },
    { provider: "codex", model: "gpt-6-luna", reasoningEfforts: ["low"] },
  ],
  workspaceIds: peer.workspaces,
  enabled: true,
  maxConcurrent: 8,
  lastSeenAt: at,
});
const ctx=new Context();
const runtime=new ProjectRuntime(ctx,ledger,"vps","planner");
const authority=new ProjectCollaborationAuthority(ledger);
runtime.collaboration=authority;
ledger.projectCollaborate=authority.projectCollaborate.bind(authority);
const network={listen:{address,port},allowHttp:true,allowedAddresses:[executorAddress],peers:[peer]};
const gateway=new RemoteGateway({role:'planner',nodeId:'vps',ledger,store,verifier:new TrustedNetworkVerifier({...network,audience:'vps'})});
const handler=httpHandler(gateway,{trustedNetwork:network});
const server=createServer((req,res)=>{
 if(req.socket.remoteAddress!==executorAddress || req.headers.host!==`${address}:${port}`){res.writeHead(403);res.end();return;}
 if(req.url==='/snapshot'){res.setHeader('content-type','application/json');res.end(JSON.stringify({...ledger.snapshot(),projectCollaborations:authority.collaborationSummaries()}));return;}
 void handler(req,res);
});
writeFileSync(join(root,'coordinator.pid'),String(process.pid));
server.listen(port,address,()=>console.log(JSON.stringify({address,port,authority:'session collaboration',seededTasks:0})));
const token=randomBytes(32).toString('hex');writeFileSync(join(root,'registration-token'),token,{mode:0o600});
const auth=bearerNamespaceAuthorizer(token,['local','generic-history']);
const intake=createRegistrationServer({ledger,authorize:req=>req.socket.remoteAddress===executorAddress?auth(req):false});intake.listen(port+1,address);
async function stop(){await new Promise(r=>server.close(r));await new Promise(r=>intake.close(r));await gateway.dispose();await runtime.close();await ctx.fiber.dispose();store.close();ledger.close();}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
