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
import { Workbench } from "../../../packages/task-system/dist/workbench.js";
import { createRegistrationServer,bearerNamespaceAuthorizer } from "../../../packages/task-system/dist/project-registration/http.js";
import { randomBytes } from "node:crypto";
const address=process.env.DSH_TEST_VPS_IP || "100.123.230.75", executorAddress=process.env.DSH_TEST_MBP_IP || "100.111.163.32";
const root = process.env.DSH_RECURSIVE_RUNTIME || process.cwd(),
  port = Number(process.env.DSH_RECURSIVE_PORT || 43871);
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
  "taskReport", "projectSnapshot", "executorIdentity", "sessionContext", "selectTaskSession", "sessionMessages", "sessionMessageReply",
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
const wb=new Workbench(ledger);
const project=wb.manage("live-project","create_project",{projectId:"runtime-recursion-20261011",title:"VPS → MBP → Codex 递归联调",goal:"通过原插件面板观察 Tailscale 直连递归任务",description:"隔离真实联调",state:"active",nextStep:"检查父子任务和下级结果",acceptanceCriteria:[]}).value;
wb.manage("live-ws","link_project_workspace",{projectId:project.projectId,workspaceId:"mbp-workspace",isDefault:true});
const backlog=wb.manage("live-backlog","create_backlog",{backlogId:"runtime-live-backlog",projectId:project.projectId,title:"真实递归验收",goal:"多种执行任务",state:"open",priority:"normal",acceptanceCriteria:[]}).value;
const policy = {
  allowedNodeIds: ["mbp"],
  allowedWorkspaceIds: ["mbp-workspace"],
  allowedTools: ["task_dispatch", "task_note", "write", "read"],
  allowedBackends: ["codex-luna-low"],
  maxRuntimeMs: 180000,
  maxDepth: 3,
  maxChildren: 4,
  maxDescendants: 8,
  settlementQuietMs: 0,
};
const seeds = [
  [
    "ordinary",
    "普通 MBP DSH 实际产物",
    "Write ordinary-analysis.txt in the assigned workspace with three concrete acceptance criteria for recursive task delegation (identity, permissions, quiescence). Then task_settle success with a report containing those criteria.",
  ],
  [
    "independent",
    "独立 Codex 分析交付",
    `Use task_dispatch exactly once, with title "独立 Codex 风险分析", description "Return a markdown review with three concrete lease/fence risks and mitigations; no tools needed", route ${JSON.stringify(codex)}, display {"requested":"task","complexity":"independent"}. Then task_settle partial with report summarizing that execution is dispatched and final user acceptance is pending. Do not pretend child has completed.`,
  ],
  [
    "step",
    "Codex 小步骤",
    `Use task_dispatch exactly once, title "小步骤：核查验收边界", description "Return a three-row table distinguishing execution completion, director acceptance and user acceptance; no tools needed", route ${JSON.stringify(codex)}, display {"requested":"step","complexity":"small"}. Then task_settle partial with a report explaining delegated pending review. Do not create extra tasks.`,
  ],
  [
    "recursive",
    "DSH → DSH → Codex 下一级",
    `Use task_dispatch exactly once to create a DSH child with title "下一级 DSH 协调", route ${JSON.stringify(route)}, display {"requested":"task"}, description: 'Use task_dispatch exactly once with title 下一级Codex验证, description Return a concise Chinese checklist for safe result recovery, route ${JSON.stringify(codex)}, display {"requested":"step"}. Then task_settle partial with an honest summary of delegated pending review.' Then task_settle partial with a report.`,
  ],
  [
    "cancel",
    "取消直到静止",
    "Write cancellation-started.txt saying a real DSH attempt started. Then read ordinary-analysis.txt, check task_history and explain the acceptance boundary in a report. Use no subagents.",
  ],
];
const seeded = seeds.map(([key, title, description], rank) => {
  const task = ledger.createTask("live-task-" + key, {
    title,
    description,
    workspaceId: "mbp-workspace",
    policy,
  }).value;
  wb.manage("live-link-"+key,"link_backlog_task",{backlogId:backlog.backlogId,taskId:task.taskId});
  const run = ledger.createRun("live-run-" + key, {
    taskId: task.taskId,
    route,
  }).value;
  return { key, taskId: task.taskId, runId: run.runId };
});
writeFileSync(join(root, "coordinator.pid"), String(process.pid));
writeFileSync(join(root, "seeds.json"), JSON.stringify(seeded, null, 2));
const network={listen:{address,port},allowHttp:true,allowedAddresses:[executorAddress],peers:[peer]};
const gateway = new RemoteGateway({
  role: "planner",
  nodeId: "vps",
  ledger,
  store,
  verifier: new TrustedNetworkVerifier({ ...network, audience: "vps" }),
});
const handler = httpHandler(gateway, { trustedNetwork:network });
const server = createServer((req, res) => {
  if(req.socket.remoteAddress!==executorAddress || req.headers.host!==`${address}:${port}`){res.writeHead(403);res.end();return;}
  if (req.url === "/snapshot") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(ledger.snapshot()));
    return;
  }
  void handler(req, res);
});
let cancelled = false;
const timer = setInterval(() => {
  const s = seeded.find((s) => s.key === "cancel"),
    run = ledger.getRun(s.runId);
  if (!cancelled && run.state === "running") {
    ledger.cancel("live-cancel", {
      taskId: s.taskId,
      runId: s.runId,
      reason: "Exercise cancellation before final commitment",
    });
    cancelled = true;
  }
  writeFileSync(
    join(root, "snapshot.json"),
    JSON.stringify(ledger.snapshot(), null, 2),
  );
}, 500);
server.listen(port, address, () =>
  console.log(
    JSON.stringify({ port, projectId: project.projectId, seeds: seeded }),
  ),
);
const token=randomBytes(32).toString("hex");writeFileSync(join(root,"registration-token"),token,{mode:0o600});
const namespaces=["mbp-local-live","mbp-pv-history","generic-history"];
const auth=bearerNamespaceAuthorizer(token,namespaces);
const intake=createRegistrationServer({ledger,authorize:req=>req.socket.remoteAddress===executorAddress ? auth(req) : false});
intake.listen(43872,address);
async function stop() {
  clearInterval(timer);
  await new Promise((r) => server.close(r));
  await gateway.dispose();
  writeFileSync(
    join(root, "snapshot.json"),
    JSON.stringify(ledger.snapshot(), null, 2),
  );
  await new Promise(r=>intake.close(r));
  await runtime.close();
  await ctx.fiber.dispose();
  store.close();
  ledger.close();
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
