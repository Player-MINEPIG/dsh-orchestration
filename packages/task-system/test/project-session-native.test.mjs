import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
import { SessionId } from "@deepseek-ai/dsh-session";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fixture } from "./fixtures/registration.mjs";
import { ScriptedModel } from "../../../tests/dsh/scripted-model.mjs";
import { Workbench } from "../dist/workbench.js";
import { TaskLedger } from "../dist/ledger.js";
import {
  createRegistrationServer,
  bearerNamespaceAuthorizer,
} from "../dist/project-registration/http.js";
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
async function harness(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), "registration-command-")),
    ctx = new Context();
  await ctx.plugin(Loader, {
    baseUrl: pathToFileURL(resolve(repoRoot, "package.json")).href,
  });
  await ctx.loader.root.update([
    { id: "llm", name: "@deepseek-ai/dsh-llm" },
    { id: "sessions", name: "@deepseek-ai/dsh-session" },
    { id: "projection", name: "@deepseek-ai/dsh-session-projection" },
    { id: "prompt", name: "@deepseek-ai/dsh-system-prompt" },
    { id: "tools", name: "@deepseek-ai/dsh-tools" },
    { id: "agents", name: "@deepseek-ai/dsh-agent" },
    {
      id: "agent-loop",
      name: "@deepseek-ai/dsh-agent-loop",
      config: { agents: [] },
    },
    { id: "commands", name: "@deepseek-ai/dsh-commands" },
    {
      id: "task",
      name: pathToFileURL(
        resolve(repoRoot, "packages/task-system/dist/dsh-plugin.js"),
      ).href,
      config: {
        databasePath: join(dir, "central.sqlite"),
        role: "planner",
        nodeId: "local",
        keepAlive: false,
        schedulerEnabled: false,
        autoExecute: false,
      },
    },
    {
      id: "registration",
      name: pathToFileURL(
        resolve(
          repoRoot,
          "packages/task-system/dist/project-registration/plugin.js",
        ),
      ).href,
      config: { namespaces: ["fixture/local"], ...config },
    },
  ]);
  await ctx.loader.await();
  const model = new ScriptedModel([]);
  ctx.llm.registerAdapter(["command-test"], model);
  const handle = await ctx.agents.create({
    sessionId: SessionId("local-project-command"),
    meta: { cwd: dir },
    agentOptions: { provider: "command-test", model: "unused" },
  });
  mkdirSync(join(dir, ".dsh"));
  return {
    ctx,
    dir,
    model,
    handle,
    packet: join(dir, ".dsh/project-registration.json"),
    invoke: async (line) => {
      const result = await ctx.commands.execute(
        handle.agent,
        line,
        [],
        new AbortController().signal,
      );
      assert.ok(result, "official registry resolves project command");
      return result.result;
    },
    close: async () => {
      await ctx.fiber.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { assembleContextFor } from "@deepseek-ai/dsh-agent";
test("official /project activates skill for this session only; real tools sync/submit and leave revokes mode without model calls", async () => {
  const h = await harness();
  const section = async agent => (await h.ctx.systemPrompt.assemble(assembleContextFor(agent))).sections.find(s => s.name === "session-project-collaboration")?.text ?? "";
  const invokeTool = (name,args,id) => h.ctx.tools.execute({name,arguments:args,callId:ToolCallId(id),agent:h.handle.agent,signal:new AbortController().signal});
  try {
    h.ctx.taskSystem.ledger.registerNode("local-planner", { nodeId: "local", roles: ["planner"], enabled: true, models: [], capabilities: [], workspaceIds: [] });
    assert.equal(await section(h.handle.agent), "");
    assert.equal((await invokeTool("project_status",{},"before-start")).isError,true);
    const activated=await h.invoke("/project");
    assert.equal(activated.kind,"success",activated.text);
    assert.match(await section(h.handle.agent),/project_dispatch/);
    const status=JSON.parse((await h.invoke("/project status")).text);
    assert.equal(status.collaboration.binding.state,"active");
    const other=await h.ctx.agents.create({sessionId:SessionId("unrelated-session"),meta:{cwd:h.dir},agentOptions:{provider:"command-test",model:"unused"}});
    assert.equal(await section(other.agent),"");
    for(const [name,args] of [["project_nodes",{}],["project_status",{}],["project_progress",{requestId:"stage-1",summary:"Prepared evidence and tests"}],["project_finish",{requestId:"finish-1",summary:"Completed evidence ready for user review"}]]) {
      const result=await invokeTool(name,args,name); assert.equal(result.isError,false,JSON.stringify(result));
    }
    const nativeStatus=await invokeTool("project_status",{},"after-finish");
    assert.equal(nativeStatus.value.binding.state,"pending_review");
    h.ctx.taskSystem.ledger.registerWorkspace("test-worker-workspace", {workspaceId:"worker-workspace",nodeId:"worker",path:h.dir,label:"Test worker workspace",state:"ready",createdAt:new Date().toISOString()});
    h.ctx.taskSystem.ledger.registerNode("test-worker", {nodeId:"worker",roles:["executor"],enabled:true,capabilities:[],models:[{provider:"fixture",model:"fixture",reasoningEfforts:["low"]}],workspaceIds:["worker-workspace"]});
    const dispatchArgs={requestId:"work-1",title:"One requested task",description:"Perform the authorized test task",routeJson:JSON.stringify({nodeId:"worker",provider:"fixture",model:"fixture",reasoningEffort:"low",workspaceId:"worker-workspace",requiredCapabilities:[]})};
    const dispatched=await invokeTool("project_dispatch",dispatchArgs,"dispatch-first");
    assert.equal(dispatched.isError,false,JSON.stringify(dispatched));
    const replay=await invokeTool("project_dispatch",dispatchArgs,"dispatch-new-tool-call");
    assert.equal(replay.isError,false,JSON.stringify(replay));
    assert.equal(replay.value.taskId,dispatched.value.taskId);
    assert.equal(h.ctx.taskSystem.ledger.snapshot().tasks.length,1);
    assert.equal((await h.invoke("/project leave")).kind,"success");
    assert.equal(await section(h.handle.agent),"");
    assert.equal((await invokeTool("project_progress",{requestId:"stage-2",summary:"forbidden"},"after-leave")).isError,true);
    assert.equal(h.model.requests.length,0);
  } finally {await h.close();}
});
