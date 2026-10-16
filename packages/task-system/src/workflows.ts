import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { TaskError, canonical, type TaskLedger } from "./ledger.js";
import type { ExecutionRoute, Json } from "./contracts.js";
import { scheduleInput } from "./schedule-window.js";
import {
  ProgramCatalog,
  type ProgramCatalogEntry,
  type ProgramRegistry,
} from "./workflow-programs.js";
import {
  CancelWorkflow,
  RetryWorkflowStep,
  SaveWorkflow,
  StartWorkflow,
  type WorkflowDefinition,
  type WorkflowRunView,
  type WorkflowSnapshot,
  type WorkflowStep,
  type WorkflowStepView,
} from "./workflow-contracts.js";

function fail(code: string, message: string): never {
  throw new TaskError(code, message);
}
function readPath(value: Json, path: string[]): Json {
  let current = value;
  for (const segment of path) {
    if (
      current === null ||
      typeof current !== "object" ||
      ["__proto__", "prototype", "constructor"].includes(segment) ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    )
      fail("WORKFLOW_INPUT", "Input path does not exist");
    current = Array.isArray(current)
      ? current[Number(segment)]!
      : current[segment]!;
    if (current === undefined)
      fail("WORKFLOW_INPUT", "Input path does not exist");
  }
  return structuredClone(current);
}
export class WorkflowRuntime {
  private readonly db;
  constructor(
    readonly ledger: TaskLedger,
    readonly programs: ProgramRegistry,
  ) {
    this.db = ledger.managementDatabase();
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS workflow_definitions(id TEXT PRIMARY KEY, data TEXT NOT NULL, next_due TEXT); CREATE TABLE IF NOT EXISTS workflow_runs(id TEXT PRIMARY KEY, data TEXT NOT NULL)",
    );
  }
  private definitions(): WorkflowDefinition[] {
    return this.rows<WorkflowDefinition>("workflow_definitions");
  }
  private rows<T>(table: "workflow_definitions" | "workflow_runs"): T[] {
    return this.db
      .prepare(`SELECT data FROM ${table} ORDER BY rowid DESC`)
      .all()
      .map((row) => JSON.parse(String(row.data)) as T);
  }
  private getRun(id: string): WorkflowRunView {
    const row = this.db
      .prepare("SELECT data FROM workflow_runs WHERE id=?")
      .get(id);
    if (!row) fail("NOT_FOUND", "Workflow execution not found");
    return JSON.parse(String(row.data)) as WorkflowRunView;
  }
  private writeRun(run: WorkflowRunView) {
    const previous = this.db
      .prepare("SELECT data FROM workflow_runs WHERE id=?")
      .get(run.workflowRunId);
    if (previous?.data === canonical(run)) return;
    run.updatedAt = this.ledger.managementNow();
    this.db
      .prepare(
        "INSERT INTO workflow_runs(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(run.workflowRunId, canonical(run));
  }
  private catalog(): ProgramCatalogEntry[] {
    const entries = this.ledger.nodeStatuses().flatMap((node) => {
      const status = node.providerStatus;
      if (
        !status ||
        typeof status !== "object" ||
        Array.isArray(status) ||
        !Array.isArray(status.programs)
      )
        return [];
      return status.programs.flatMap((value) => {
        const parsed = ProgramCatalog.safeParse(value);
        return parsed.success && parsed.data.nodeId === node.nodeId
          ? [parsed.data]
          : [];
      });
    });
    const local = this.programs.catalog();
    return [
      ...entries.filter((entry) => entry.nodeId !== this.programs.nodeId),
      ...local,
    ];
  }
  snapshot(): WorkflowSnapshot {
    return {
      definitions: this.definitions(),
      runs: this.db
        .prepare("SELECT data FROM workflow_runs ORDER BY rowid DESC LIMIT 20")
        .all()
        .map((row) => JSON.parse(String(row.data)) as WorkflowRunView),
      nodes: this.ledger.nodeStatuses(),
      workspaces: this.ledger
        .registeredNodes()
        .flatMap((node) => this.ledger.registeredWorkspaces(node.nodeId)),
      programs: this.catalog(),
      models: this.ledger.registeredNodes(),
    };
  }
  private validate(definition: WorkflowDefinition) {
    const steps = new Map(definition.steps.map((step) => [step.stepId, step]));
    if (steps.size !== definition.steps.length)
      fail("WORKFLOW_DAG", "Duplicate step identifier");
    const visiting = new Set<string>(),
      visited = new Set<string>();
    const visit = (step: WorkflowStep) => {
      if (visiting.has(step.stepId))
        fail("WORKFLOW_DAG", "Workflow dependencies contain a cycle");
      if (visited.has(step.stepId)) return;
      visiting.add(step.stepId);
      if (new Set(step.dependsOn).size !== step.dependsOn.length)
        fail("WORKFLOW_DAG", "Duplicate dependency");
      for (const id of step.dependsOn) {
        const upstream = steps.get(id);
        if (!upstream) fail("WORKFLOW_DAG", "Dependency does not exist");
        visit(upstream);
      }
      visiting.delete(step.stepId);
      visited.add(step.stepId);
    };
    const catalog = this.catalog();
    for (const step of definition.steps) {
      visit(step);
      for (const [key, binding] of Object.entries(step.inputs)) {
        if (["__proto__", "constructor", "prototype"].includes(key))
          fail("WORKFLOW_INPUT", "Unsafe input key");
        if (
          binding.kind === "step-output" &&
          !step.dependsOn.includes(binding.stepId)
        )
          fail(
            "WORKFLOW_INPUT",
            "Output binding must reference an explicit dependency",
          );
        if (
          binding.kind !== "literal" &&
          binding.path.some((segment) =>
            ["__proto__", "constructor", "prototype"].includes(segment),
          )
        )
          fail("WORKFLOW_INPUT", "Unsafe input path");
      }
      const node = this.ledger.getNode(step.nodeId),
        workspace = this.ledger.getWorkspace(step.workspaceId);
      if (
        !node.enabled ||
        !node.roles.some((role) => role !== "planner") ||
        workspace.nodeId !== step.nodeId ||
        workspace.state !== "ready" ||
        !node.workspaceIds.includes(step.workspaceId)
      )
        fail("WORKFLOW_ROUTE", "Executor workspace unavailable");
      if (step.execution.kind === "program") {
        const execution = step.execution;
        if (
          !catalog.some(
            (item) =>
              item.nodeId === step.nodeId &&
              item.programId === execution.programId &&
              item.version === execution.version,
          )
        )
          fail(
            "WORKFLOW_PROGRAM",
            "Program version is not registered on executor",
          );
      } else {
        const execution = step.execution;
        if (
          !node.models.some(
            (model) =>
              model.provider === execution.provider &&
              model.model === execution.model &&
              (!execution.reasoningEffort ||
                model.reasoningEfforts.includes(execution.reasoningEffort)),
          )
        )
          fail("WORKFLOW_MODEL", "Model route is not authorized on executor");
      }
    }
    if (definition.schedule)
      CronExpressionParser.parse(definition.schedule.cron, {
        tz: definition.schedule.timeZone,
        currentDate: this.ledger.managementNow(),
      }).next();
  }
  save(input: unknown): WorkflowDefinition {
    const command = SaveWorkflow.parse(input);
    return this.ledger.managementCommand(
      command.commandId,
      "save",
      command,
      () => {
        const old = this.definitions().find(
          (item) => item.workflowId === command.definition.workflowId,
        );
        if ((old?.revision ?? 0) !== command.expectedRevision)
          fail("CONFLICT", "Workflow definition changed");
        this.validate(command.definition);
        const definition = {
          ...command.definition,
          revision: (old?.revision ?? 0) + 1,
        };
        const schedule = definition.schedule;
        const next = schedule?.enabled
          ? CronExpressionParser.parse(schedule.cron, {
              tz: schedule.timeZone,
              currentDate: this.ledger.managementNow(),
            })
              .next()
              .toISOString()
          : null;
        this.db
          .prepare(
            "INSERT INTO workflow_definitions(id,data,next_due) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,next_due=excluded.next_due",
          )
          .run(definition.workflowId, canonical(definition), next);
        return definition;
      },
    );
  }
  start(input: unknown): WorkflowRunView {
    const command = StartWorkflow.parse(input);
    return this.ledger.managementCommand(
      command.commandId,
      "start",
      command,
      () => {
        const definition =
          this.definitions().find(
            (item) => item.workflowId === command.workflowId,
          ) ?? fail("NOT_FOUND", "Workflow not found");
        const now = this.ledger.managementNow();
        const run: WorkflowRunView = {
          workflowRunId: randomUUID(),
          workflowId: definition.workflowId,
          definitionRevision: definition.revision,
          title: definition.title,
          definition: structuredClone(definition),
          input: structuredClone(command.input),
          createdAt: now,
          updatedAt: now,
          state: "running",
          steps: definition.steps.map((step) => ({
            stepId: step.stepId,
            nodeId: step.nodeId,
            title: step.title,
            kind: step.execution.kind,
            state: "pending",
            attemptCount: 0,
          })),
        };
        this.writeRun(run);
        return run;
      },
    );
  }
  retry(input: unknown): WorkflowRunView {
    const command = RetryWorkflowStep.parse(input);
    return this.ledger.managementCommand(
      command.commandId,
      "retry",
      command,
      () => {
        const run = this.getRun(command.workflowRunId),
          step =
            run.steps.find((item) => item.stepId === command.stepId) ??
            fail("NOT_FOUND", "Workflow step not found");
        if (run.state === "cancelled")
          fail("CONFLICT", "Cancelled workflow cannot resume");
        if (
          !step.runId ||
          !["failed", "cancelled", "blocked"].includes(
            this.ledger.getRun(step.runId).state,
          )
        )
          fail("CONFLICT", "Retry requires proven terminal stopped execution");
        if (this.ledger.getRun(step.runId).state === "cancelled")
          delete step.taskId;
        step.retryFromRunId = step.runId;
        step.state = "pending";
        delete step.runId;
        delete step.reason;
        delete step.reportId;
        delete step.output;
        delete step.summary;
        delete step.sessionId;
        run.state = "running";
        for (const item of run.steps)
          if (item.state === "blocked" && !item.runId) {
            item.state = "pending";
            delete item.reason;
          }
        this.writeRun(run);
        return run;
      },
    );
  }
  cancel(input: unknown): WorkflowRunView {
    const command = CancelWorkflow.parse(input);
    const result = this.ledger.managementCommand(
      command.commandId,
      "cancel",
      command,
      () => {
        const run = this.getRun(command.workflowRunId);
        run.state = "cancelled";
        for (const step of run.steps) if (!step.runId) step.state = "cancelled";
        this.writeRun(run);
        return run;
      },
    );
    this.cancelTasks(result);
    return this.getRun(result.workflowRunId);
  }
  private cancelTasks(run: WorkflowRunView) {
    for (const step of run.steps)
      if (
        step.taskId &&
        step.runId &&
        !["succeeded", "partial", "failed", "cancelled"].includes(
          this.ledger.getRun(step.runId).state,
        )
      )
        this.ledger.cancel(
          `workflow-cancel:${run.workflowRunId}:${step.runId}`,
          {
            taskId: step.taskId,
            runId: step.runId,
            reason: "Workflow cancelled",
          },
        );
  }
  private route(step: WorkflowStep): ExecutionRoute {
    const common = {
      nodeId: step.nodeId,
      workspaceId: step.workspaceId,
      requiredCapabilities: [],
    };
    return step.execution.kind === "program"
      ? {
          ...common,
          provider: "registered-program",
          model: step.execution.programId,
          execution: step.execution,
        }
      : {
          ...common,
          provider: step.execution.provider,
          model: step.execution.model,
          ...(step.execution.reasoningEffort
            ? { reasoningEffort: step.execution.reasoningEffort }
            : {}),
        };
  }
  private failureReason(runId: string): string {
    const prior = this.ledger.getRun(runId);
    if (prior.resultValidationFailure)
      return prior.resultValidationFailure.issues.join("; ").slice(0, 10000);
    const event = this.ledger
      .history(prior.taskId)
      .events.filter(
        (event) => event.runId === runId && event.type === "run.settled",
      )
      .at(-1);
    const detail = event?.detail;
    return detail &&
      typeof detail === "object" &&
      !Array.isArray(detail) &&
      typeof detail.summary === "string"
      ? detail.summary
      : "Previous execution stopped without a valid result. Continue in the existing task session and inspect the failure before repeating effects.";
  }
  private resolvedInput(run: WorkflowRunView, step: WorkflowStep): Json {
    const result: Record<string, Json> = {};
    for (const [key, binding] of Object.entries(step.inputs))
      switch (binding.kind) {
        case "literal":
          result[key] = structuredClone(binding.value);
          break;
        case "workflow-input":
          result[key] = readPath(run.input, binding.path);
          break;
        case "step-output": {
          const source = run.steps.find(
            (item) => item.stepId === binding.stepId,
          );
          if (source?.output === undefined)
            fail(
              "WORKFLOW_INPUT",
              "Upstream did not produce structured output",
            );
          result[key] = readPath(source.output, binding.path);
          break;
        }
      }
    return result;
  }
  private refresh(step: WorkflowStepView) {
    if (!step.runId) return;
    const run = this.ledger.getRun(step.runId);
    step.state = run.state;
    const history = this.ledger.history(run.taskId);
    const settled = history.events
      .filter(
        (event) => event.runId === run.runId && event.type === "run.settled",
      )
      .at(-1)?.detail;
    const summary =
      settled &&
      typeof settled === "object" &&
      !Array.isArray(settled) &&
      typeof settled.summary === "string"
        ? settled.summary
        : undefined;
    if (summary) step.summary = summary;
    if (["failed", "blocked"].includes(run.state))
      step.reason =
        run.resultValidationFailure?.issues.join("; ") ||
        summary ||
        "Execution failed";
    const report = history.reports
      .filter((item) => item.runId === run.runId && item.kind === "result")
      .at(-1);
    if (report) {
      step.reportId = report.reportId;
      step.summary ??= report.body.slice(0, 4000);
      if (report.data !== undefined) step.output = report.data;
    }
    if (step.kind === "agent" && run.sessionIds.length)
      step.sessionId = run.sessionIds.at(-1);
    if (
      ["succeeded", "partial"].includes(run.state) &&
      step.output === undefined
    ) {
      step.state = "failed";
      step.reason = "Execution completed without structured report.data";
    }
    if (run.state === "uncertain")
      step.reason =
        "Execution outcome is unknown; it cannot be replayed safely";
  }
  private schedule() {
    const now = this.ledger.managementNow();
    const rows = this.db
      .prepare(
        "SELECT id,data,next_due FROM workflow_definitions WHERE next_due IS NOT NULL AND next_due<=? ORDER BY next_due LIMIT 16",
      )
      .all(now);
    for (const row of rows) {
      const definition = JSON.parse(String(row.data)) as WorkflowDefinition,
        schedule = definition.schedule!;
      const occurrenceAt = String(row.next_due);
      const input = scheduleInput(
        {
          input: {},
          calendarWindow: {
            timeZone: schedule.timeZone,
            dayOffset: schedule.dayOffset,
          },
        },
        occurrenceAt,
      );
      this.start({
        commandId: `workflow-schedule:${definition.workflowId}:${occurrenceAt}`,
        workflowId: definition.workflowId,
        input,
      });
      const next = CronExpressionParser.parse(schedule.cron, {
        tz: schedule.timeZone,
        currentDate: occurrenceAt,
      })
        .next()
        .toISOString();
      this.db
        .prepare(
          "UPDATE workflow_definitions SET next_due=? WHERE id=? AND next_due=?",
        )
        .run(next, definition.workflowId, occurrenceAt);
    }
  }
  tick({ scheduleEnabled = true } = {}) {
    this.ledger.assertManagementWritable();
    if (scheduleEnabled) this.schedule();
    for (const run of this.rows<WorkflowRunView>("workflow_runs")) {
      if (["succeeded", "partial", "failed"].includes(run.state)) continue;
      if (run.state === "cancelled") {
        this.cancelTasks(run);
        for (const step of run.steps) this.refresh(step);
        this.writeRun(run);
        continue;
      }
      for (const step of run.steps) this.refresh(step);
      for (const step of run.steps) {
        const definition = run.definition.steps.find(
          (item) => item.stepId === step.stepId,
        )!;
        if (
          step.state === "failed" &&
          step.runId &&
          definition.execution.kind === "agent" &&
          step.attemptCount <= definition.maxRetries &&
          this.ledger.getRun(step.runId).state === "failed"
        ) {
          this.writeRun(run);
          const updated = this.retry({
            commandId: `workflow-auto-retry:${run.workflowRunId}:${step.stepId}:${step.attemptCount}`,
            workflowRunId: run.workflowRunId,
            stepId: step.stepId,
          });
          Object.assign(run, updated);
        }
      }
      for (const definition of run.definition.steps) {
        const step = run.steps.find(
          (item) => item.stepId === definition.stepId,
        )!;
        if (
          step.runId ||
          !["pending", "waiting_device", "blocked"].includes(step.state)
        )
          continue;
        const dependencies = definition.dependsOn.map(
          (id) => run.steps.find((item) => item.stepId === id)!,
        );
        if (
          dependencies.some((item) =>
            ["failed", "uncertain", "cancelled", "blocked"].includes(
              item.state,
            ),
          )
        ) {
          step.state = "blocked";
          step.reason = "An upstream step needs attention";
          continue;
        }
        if (
          !dependencies.every((item) =>
            ["succeeded", "partial"].includes(item.state),
          )
        )
          continue;
        const node = this.ledger
          .nodeStatuses()
          .find((item) => item.nodeId === definition.nodeId);
        if (node?.state !== "online") {
          step.state = "waiting_device";
          step.reason = "Executor is offline or readiness is unknown";
          continue;
        }
        try {
          const input = this.resolvedInput(run, definition),
            taskId = step.taskId ?? randomUUID();
          const task = {
            taskId,
            title: definition.title,
            description:
              definition.execution.kind === "agent"
                ? definition.execution.instructions
                : `Registered program ${definition.execution.programId}@${definition.execution.version}`,
            workspaceId: definition.workspaceId,
            policy: {
              maxSafeRetries: 0,
              maxResultRetries: 0,
              settlementQuietMs: 0,
              allowedNodeIds: [definition.nodeId],
              allowedWorkspaceIds: [definition.workspaceId],
              allowedTools:
                definition.execution.kind === "agent"
                  ? [
                      ...new Set([
                        ...definition.execution.allowedTools,
                        ...(definition.execution.inputExposure === "tools"
                          ? ["workflow_input_read"]
                          : []),
                      ]),
                    ]
                  : [],
            },
            tags: ["workflow", run.workflowId],
            requiresConfirmation: false,
          };
          const configuration = {
            input,
            workflow: {
              workflowRunId: run.workflowRunId,
              workflowId: run.workflowId,
              definitionRevision: run.definitionRevision,
              stepId: step.stepId,
              ...(definition.execution.kind === "agent" &&
              definition.execution.inputExposure
                ? { inputExposure: definition.execution.inputExposure }
                : {}),
              ...(step.retryFromRunId
                ? {
                    retry: {
                      previousRunId: step.retryFromRunId,
                      reason: this.failureReason(step.retryFromRunId),
                    },
                  }
                : {}),
            },
          };
          this.ledger.workflowAdmission(
            `workflow-admit:${run.workflowRunId}:${step.stepId}:${step.attemptCount}`,
            {
              ...(!step.taskId ? { task } : {}),
              run: { taskId, route: this.route(definition), configuration },
            },
            (created, admitted) => {
              step.taskId = created.taskId;
              step.runId = admitted.runId;
              step.state = "queued";
              step.attemptCount++;
              delete step.reason;
              this.writeRun(run);
            },
          );
        } catch (error) {
          step.state = "blocked";
          step.reason = error instanceof Error ? error.message : String(error);
        }
      }
      if (
        run.steps.every((step) => ["succeeded", "partial"].includes(step.state))
      )
        run.state = run.steps.some((step) => step.state === "partial")
          ? "partial"
          : "succeeded";
      else if (
        run.steps.some((step) =>
          ["failed", "uncertain", "blocked", "cancelled"].includes(step.state),
        )
      )
        run.state = "needs_attention";
      else run.state = "running";
      this.writeRun(run);
    }
  }
}
