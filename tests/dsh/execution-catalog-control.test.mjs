import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { ScriptedModel } from "./scripted-model.mjs";
import { createNativeHarness } from "./native-harness.mjs";
import * as remotePlugin from "../../packages/task-system/dist/remote/index.js";

async function until(predicate, message) {
  const end = Date.now() + 6000;
  while (!predicate()) {
    assert.ok(Date.now() < end, message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function config(value) {
  const parsed = remotePlugin.Config(value);
  parsed.executionLimits =
    parsed.executionLimits?.get?.() ?? parsed.executionLimits;
  return parsed;
}

test(
  "real outbound control requests full catalogs with work polling disabled and preserves last good on failure",
  { timeout: 25000 },
  async () => {
    const planner = await createNativeHarness({
        config: { role: "planner", nodeId: "planner" },
      }),
      executor = await createNativeHarness({
        config: { role: "executor", nodeId: "worker" },
      });
    let serverFiber,
      clientFiber,
      calls = 0,
      fail = false;
    executor.adapter.listModels = async () => {
      calls++;
      if (fail) throw new Error("catalog unavailable");
      return ["one", "two", "three", "four"].map((id) => ({
        provider: "test-offline",
        id,
        name: id,
      }));
    };
    executor.adapter.resolveModel = async (provider, id) => ({
      provider,
      id,
      name: id,
      reasoning: { efforts: [{ id: "high", name: "High" }] },
    });
    try {
      const port = await unusedPort();
      serverFiber = await planner.ctx.plugin(
        remotePlugin,
        config({
          role: "planner",
          nodeId: "planner",
          authMode: "trusted-network",
          statePath: join(planner.dir, "network.sqlite"),
          exposeHttp: true,
          routePath: "/commands",
          audience: "planner",
          trustedNetwork: {
            listen: { address: "127.0.0.1", port },
            allowHttp: true,
            allowedAddresses: ["127.0.0.1"],
            peers: [
              {
                address: "127.0.0.1",
                nodeId: "",
                role: "executor",
                audience: "planner",
                operations: [],
                workspaces: [],
                capabilities: [],
              },
            ],
          },
        }),
      );
      await serverFiber.await();
      clientFiber = await executor.ctx.plugin(
        remotePlugin,
        config({
          role: "executor",
          nodeId: "worker",
          authMode: "trusted-network",
          statePath: join(executor.dir, "network.sqlite"),
          exposeHttp: false,
          audience: "planner",
          pollIntervalMs: 0,
          taskSessionsEnabled: true,
          coordinator: {
            authMode: "trusted-network",
            endpoint: `http://127.0.0.1:${port}/commands`,
            audience: "planner",
            heartbeatIntervalMs: 0,
            trustedNetwork: {
              address: "127.0.0.1",
              port,
              localAddress: "127.0.0.1",
              allowHttp: true,
            },
            nativeRoutes: [
              {
                provider: "test-offline",
                models: [
                  { model: "one", reasoningEfforts: [] },
                  { model: "two", reasoningEfforts: [] },
                ],
              },
            ],
          },
        }),
      );
      await clientFiber.await();
      await until(() => {
        try {
          return !!planner.ledger.getNode("worker");
        } catch {
          return false;
        }
      }, "outbound identity pairing");
      assert.equal(calls, 0, "identity and heartbeat never discover models");
      const request = planner.ledger.executionModels.request("http-request", {
        nodeId: "worker",
      }).catalog.request;
      await until(
        () =>
          planner.ledger.executionModels.view("worker").catalog.snapshot
            ?.revision === request.requestId,
        "catalog roundtrip",
      );
      const ready = planner.ledger.executionModels.view("worker");
      assert.equal(ready.catalog.state, "fresh");
      assert.equal(ready.catalog.snapshot.models.length, 8);
      assert.equal(ready.catalog.snapshot.temporaryWorkspaceReady, false);
      assert.equal(calls, 1);
      assert.ok(
        planner.ledger
          .getNode("worker")
          .models.some((model) => model.model === "four"),
      );
      const authorityView =
        await executor.ctx.remoteExecution.coordinatorLedger.executionModelView(
          "worker",
        );
      assert.deepEqual(
        authorityView,
        ready,
        "external owned model directory is the scheduler authority view",
      );
      await assert.rejects(
        executor.ctx.remoteExecution.coordinatorLedger.executionModelView(
          "planner",
        ),
        { code: "WRONG_CLIENT_NODE" },
      );
      const choice = ready.catalog.snapshot.models.find(
        (model) => model.model === "four" && model.reasoningEffort === "high",
      );
      planner.ledger.executionModels.setDefault("http-default", {
        nodeId: "worker",
        expectedRevision: 0,
        expectedCatalogRevision: ready.catalog.snapshot.revision,
        choice,
      });
      await executor.ctx.remoteExecution.heartbeatNow();
      assert.equal(calls, 1);
      const heartbeat = planner.ledger
        .nodeStatuses()
        .find((node) => node.nodeId === "worker");
      assert.equal(heartbeat.providerStatus.executionRoutes, undefined);
      assert.ok(Array.isArray(heartbeat.providerStatus.programs));
      fail = true;
      const retry = planner.ledger.executionModels.request("http-failure", {
        nodeId: "worker",
      }).catalog.request;
      await until(
        () => !planner.ledger.executionModels.pending("worker").length,
        "partial response returns",
      );
      const stale = planner.ledger.executionModels.view("worker");
      assert.equal(stale.catalog.state, "stale");
      assert.equal(
        stale.catalog.snapshot.revision,
        ready.catalog.snapshot.revision,
      );
      assert.equal(stale.catalog.positiveSnapshot.revision, retry.requestId);
      assert.deepEqual(stale.policy.choice, choice);
      assert.equal(stale.catalog.positiveSnapshot.complete, false);
      const release =
        await executor.ctx.remoteExecution.beginConfigurationEdit();
      const before = calls;
      planner.ledger.executionModels.request("http-paused", {
        nodeId: "worker",
      });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.equal(calls, before, "configuration gate pauses outbound control");
      release();
      await until(
        () => calls > before,
        "control resumes after configuration gate",
      );
      await until(
        () => !planner.ledger.executionModels.pending("worker").length,
        "resumed response finishes",
      );
      const broken = new ScriptedModel([]);
      broken.listModels = async () => {
        throw new Error("unrelated provider offline");
      };
      executor.ctx.llm.registerAdapter(["unrelated-broken"], broken);
      fail = false;
      executor.adapter.listModels = async () => {
        calls++;
        return [{ provider: "test-offline", id: "flash", name: "Flash" }];
      };
      executor.ctx.taskSystem.executionDirectories.save({
        root: executor.dir,
        expectedRevision: 0,
      });
      const partial = planner.ledger.executionModels.request("http-positive", {
        nodeId: "worker",
      }).catalog.request;
      await until(
        () =>
          planner.ledger.executionModels.view("worker").catalog.positiveSnapshot
            ?.revision === partial.requestId,
        "partial positive catalog returns",
      );
      const positive = planner.ledger.executionModels.view("worker");
      assert.equal(positive.catalog.state, "stale");
      assert.equal(positive.catalog.positiveSnapshot.complete, false);
      assert.equal(
        positive.catalog.positiveSnapshot.temporaryWorkspaceReady,
        true,
      );
      const task = planner.ledger.createTask("partial-task", {
        title:
          "Execute a positively discovered route despite unrelated provider failure",
      }).value;
      const run = planner.ledger.createRun("partial-run", {
        taskId: task.taskId,
        route: {
          nodeId: "worker",
          provider: "test-offline",
          model: "flash",
          reasoningEffort: "high",
          requiredCapabilities: [],
        },
        executionModel: { origin: "explicit", policyRevision: "0" },
      }).value;
      assert.equal(planner.ledger.getRun(run.runId).dispatchIssue, undefined);
      let publicNodes;
      executor.adapter.script.push(
        { name: "task_nodes", args: {} },
        (options) => {
          const response = options.messages.findLast(
            (message) => message.role === "tool",
          );
          assert.equal(
            response.isError,
            false,
            JSON.stringify(response.content),
          );
          publicNodes = JSON.parse(
            response.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n"),
          );
          assert.equal(publicNodes.nodes.length, 1);
          assert.equal(publicNodes.nodes[0].nodeId, "worker");
          assert.deepEqual(
            publicNodes.nodes[0].policy.choice,
            choice,
            "public task_nodes reads scheduler policy",
          );
          assert.equal(
            executor.ledger.executionModels.view("worker").policy.choice,
            undefined,
            "local executor ledger has no scheduler policy",
          );
          return {
            name: "task_submit_result",
            args: {
              outcome: "success",
              summary:
                "Public task_nodes read authority policy before partial route success",
            },
          };
        },
      );
      const gateway = planner.ctx.remoteExecution.gateway,
        handle = gateway.handle.bind(gateway);
      const transportErrors = [],
        arrivals = [];
      let releaseControl,
        delaying = false,
        armed = true;
      gateway.handle = async (body, ...rest) => {
        const envelope = JSON.parse(
          typeof body === "string" ? body : Buffer.from(body).toString(),
        );
        if (armed && envelope.operation === "executionModelRequests") {
          armed = false;
          delaying = true;
          await new Promise((resolve) => {
            releaseControl = resolve;
          });
        }
        arrivals.push(envelope.operation);
        try {
          return await handle(body, ...rest);
        } catch (error) {
          transportErrors.push(error.code);
          throw error;
        }
      };
      const control = executor.ctx.remoteExecution.modelControl.pollNow();
      await until(() => delaying, "control request delayed before admission");
      const heartbeatConcurrent = executor.ctx.remoteExecution.heartbeatNow();
      const workConcurrent =
        executor.ctx.remoteExecution.nativeWorker.pollOnce(1);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(
        arrivals.includes("heartbeat"),
        false,
        "heartbeat waits behind the earlier node sequence",
      );
      releaseControl();
      const [, , results] = await Promise.all([
        control,
        heartbeatConcurrent,
        workConcurrent,
      ]);
      assert.ok(arrivals.includes("heartbeat"));
      assert.ok(arrivals.includes("claim"));
      assert.ok(
        !transportErrors.includes("OUT_OF_ORDER"),
        JSON.stringify(transportErrors),
      );
      gateway.handle = handle;
      assert.equal(
        results.length,
        1,
        JSON.stringify(planner.ledger.getRun(run.runId)),
      );
      assert.equal(
        results[0].value.state,
        "acknowledged",
        JSON.stringify(results),
      );
      assert.equal(planner.ledger.getRun(run.runId).state, "succeeded");
      assert.equal(executor.adapter.requests[0].model, "flash");
      assert.ok(
        publicNodes,
        "real external-owned public tool ran before settlement",
      );
      planner.ledger.registerWorkspace("missing-local-binding", {
        workspaceId: "bound-on-authority",
        nodeId: "worker",
        path: executor.dir,
        label: "Authority binding",
        state: "ready",
        createdAt: new Date().toISOString(),
      });
      planner.ledger.registerNode("grant-explicit-binding", {
        ...planner.ledger.getNode("worker"),
        workspaceIds: ["bound-on-authority"],
      });
      const blockedTask = planner.ledger.createTask("blocked-binding-task", {
        title: "Report binding before claim",
      }).value;
      const blockedRun = planner.ledger.createRun("blocked-binding-run", {
        taskId: blockedTask.taskId,
        route: {
          nodeId: "worker",
          workspaceId: "bound-on-authority",
          provider: "test-offline",
          model: "flash",
          reasoningEffort: "high",
          requiredCapabilities: [],
        },
        executionModel: { origin: "explicit", policyRevision: "0" },
      }).value;
      assert.deepEqual(
        await executor.ctx.remoteExecution.nativeWorker.pollOnce(1),
        [],
      );
      const admission = planner.ledger.getRun(blockedRun.runId);
      assert.equal(admission.state, "queued");
      assert.equal(admission.currentAttemptId, undefined);
      assert.equal(admission.dispatchIssue.code, "WORKSPACE_BINDING_REQUIRED");
      assert.equal(admission.dispatchIssue.source, "executor");
      assert.equal(
        planner.ledger.snapshot().attempts.length,
        1,
        "preclaim report creates no attempt",
      );
      await until(
        () => !planner.ledger.executionModels.pending("worker").length,
        "public tool refresh finishes",
      );
      let discoveryStarted = false,
        releaseDiscovery;
      executor.adapter.listModels = () => {
        discoveryStarted = true;
        return new Promise((resolve) => {
          releaseDiscovery = resolve;
        });
      };
      planner.ledger.executionModels.request("slow-discovery", {
        nodeId: "worker",
      });
      const slowControl = executor.ctx.remoteExecution.modelControl.pollNow();
      await until(() => discoveryStarted, "long directory discovery starts");
      await executor.ctx.remoteExecution.heartbeatNow();
      assert.equal(
        typeof releaseDiscovery,
        "function",
        "heartbeat completes while model discovery is unresolved",
      );
      const resumeConfiguration = await Promise.race([
        executor.ctx.remoteExecution.beginConfigurationEdit(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("configuration drain blocked by discovery")),
            1500,
          ),
        ),
      ]);
      await slowControl;
      releaseDiscovery([
        { provider: "test-offline", id: "flash", name: "Flash" },
      ]);
      resumeConfiguration();
      await executor.ctx.remoteExecution.heartbeatNow();
    } finally {
      await clientFiber?.dispose();
      await serverFiber?.dispose();
      await executor.dispose();
      await planner.dispose();
    }
  },
);
