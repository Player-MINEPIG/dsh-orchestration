import { createHash } from "node:crypto";
import { z } from "zod";
import { TaskLedger, TaskError, canonical } from "./ledger.js";
import { Workbench } from "./workbench.js";
import type { ExecutionRoute } from "./contracts.js";

const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export const scheduledPlanInput = z
  .object({
    commandId: z.string().min(1).max(200),
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().min(1).max(20000),
    projectId: z.string().trim().min(1),
    routeId: z.string().min(1).max(128).optional(),
    execution: z
      .object({
        kind: z.literal("workflow"),
        workflowId: z.string().min(1).max(120),
        input: z.json(),
      })
      .strict()
      .optional(),
    cadence: z.discriminatedUnion("mode", [
      z
        .object({
          mode: z.literal("interval"),
          minutes: z.number().int().min(1).max(527040),
        })
        .strict(),
      z
        .object({
          mode: z.literal("daily"),
          time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
          timeZone: z.string().min(1).max(100),
        })
        .strict(),
    ]),
  })
  .strict();
export const scheduledPlanControl = z
  .object({
    commandId: z.string().min(1).max(200),
    scheduleId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    enabled: z.boolean(),
  })
  .strict();

/** Uses the same authority and Workbench as ordinary Tasks, with no new scheduler. */
export class ScheduledPlans {
  private workbench: Workbench;
  constructor(private ledger: TaskLedger) {
    this.workbench = new Workbench(ledger);
  }
  options() {
    const data = this.ledger.snapshot(),
      routes = new Map<
        string,
        {
          id: string;
          label: string;
          workspaceLabel: string;
          route: ExecutionRoute;
        }
      >();
    for (const status of this.ledger.nodeStatuses()) {
      const node = this.ledger.getNode(status.nodeId);
      if (
        !node.enabled ||
        !node.roles.some((role) => role === "executor" || role === "both")
      )
        continue;
      const advertised = (
        status.providerStatus as
          | { executionRoutes?: ExecutionRoute[] }
          | undefined
      )?.executionRoutes;
      const candidates = Array.isArray(advertised)
        ? advertised.slice(0, 128)
        : [];
      for (const candidate of candidates) {
        if (!candidate || candidate.nodeId !== node.nodeId) continue;
        const route = Object.fromEntries(
          Object.entries(candidate).filter(([key]) =>
            [
              "nodeId",
              "provider",
              "model",
              "reasoningEffort",
              "backend",
              "requiredCapabilities",
            ].includes(key),
          ),
        ) as unknown as ExecutionRoute;
        if (
          route.backend !== undefined &&
          (typeof route.backend !== "string" ||
            !route.backend ||
            route.backend.length > 128)
        )
          continue;
        for (const workspace of data.workspaces ?? []) {
          if (
            workspace.nodeId !== node.nodeId ||
            workspace.state !== "ready" ||
            !node.workspaceIds.includes(workspace.workspaceId)
          )
            continue;
          const executable = { ...route, workspaceId: workspace.workspaceId };
          try {
            this.ledger.validateRoute(executable);
          } catch {
            continue;
          }
          const id = hash(executable);
          routes.set(id, {
            id,
            workspaceLabel: workspace.label,
            route: executable,
            label: `${node.nodeId} · ${route.model} · ${route.reasoningEffort ?? "默认"} · ${workspace.label}${status.state === "online" ? "" : " · 离线排队"}`,
          });
        }
      }
    }
    return {
      routes: [...routes.values()],
      workflows: this.ledger.workflowOptions?.() ?? [],
      projects: this.workbench
        .snapshot()
        .projects.filter((p) => p.state !== "archived")
        .map((p) => ({ id: p.projectId, title: p.title })),
    };
  }
  create(raw: unknown) {
    const input = scheduledPlanInput.parse(raw),
      { commandId, ...request } = input,
      requestHash = hash(request);
    const command = `scheduled-plan:${commandId}`;
    const prior = this.ledger.commandReceipt(command)?.value as
      | { taskId: string; scheduleId: string; requestHash: string }
      | undefined;
    if (prior && prior.requestHash !== requestHash)
      throw new TaskError("CONFLICT", "Schedule command reused");
    const wb = this.workbench.snapshot();
    if (
      !wb.projects.some(
        (p) => p.projectId === input.projectId && p.state !== "archived",
      )
    )
      throw new TaskError("NOT_FOUND", "Project unavailable");
    const selected = this.options().routes.find((r) => r.id === input.routeId);
    if (
      (!input.execution && !input.routeId) ||
      (input.execution && input.routeId)
    )
      throw new TaskError(
        "INVALID",
        "Choose Agent route or workflow execution",
      );
    if (
      input.execution &&
      !(this.ledger.workflowOptions?.() ?? []).some(
        (item) =>
          item.id === input.execution!.workflowId &&
          item.projectId === input.projectId,
      )
    )
      throw new TaskError(
        "WORKFLOW_PROJECT",
        "Workflow unavailable in this Project",
      );
    if (!prior && !selected && !input.execution)
      throw new TaskError(
        "CONFLICT",
        "Execution route changed; refresh before creating a plan",
      );
    if (input.cadence.mode === "daily") {
      try {
        new Intl.DateTimeFormat("en", {
          timeZone: input.cadence.timeZone,
        }).format();
      } catch {
        throw new TaskError("INVALID", "Invalid time zone");
      }
    }
    if (!prior && input.execution) {
      const preflight = this.ledger.workflowExecutionPreflight;
      if (!preflight || !this.ledger.workflowTaskConfiguration)
        throw new TaskError("UNAVAILABLE", "Workflow runtime unavailable");
      preflight(input.execution.workflowId);
    }
    const id = hash(command),
      [hour, minute] =
        input.cadence.mode === "daily" ? input.cadence.time.split(":") : [];
    const value =
      prior ??
      this.ledger.prepareScheduledPlan(command, {
        requestHash,
        taskId: `scheduled-task-${id}`,
        scheduleId: `scheduled-plan-${id}`,
        title: input.title,
        description: input.description,
        ...(input.execution
          ? {
              execution: {
                kind: "workflow" as const,
                workflowId: input.execution.workflowId,
              },
              workflowInput: input.execution.input,
            }
          : { route: selected!.route }),
        ...(input.cadence.mode === "interval"
          ? { intervalMs: input.cadence.minutes * 60000 }
          : {
              cron: `${Number(minute)} ${Number(hour)} * * *`,
              timeZone: input.cadence.timeZone,
            }),
      }).value;
    // A interrupted creation is safe to resume: no trigger can run until the
    // project association is durable, and replay cannot undo a later pause.
    {
      const backlogId = `scheduled-backlog:${input.projectId}`;
      this.workbench.manage(
        `scheduled-backlog:${input.projectId}`,
        "create_backlog",
        {
          backlogId,
          projectId: input.projectId,
          title: "定时计划",
          goal: "周期执行与历史记录",
        },
      );
      this.workbench.manage(`${command}:link`, "link_backlog_task", {
        backlogId,
        taskId: value.taskId,
      });
    }
    if (input.execution) {
      const configure =
        this.ledger.workflowTaskConfiguration ??
        (() => {
          throw new TaskError("UNAVAILABLE", "Workflow runtime unavailable");
        });
      configure({
        commandId: `${command}:workflow-binding`,
        projectId: input.projectId,
        taskId: value.taskId,
        workflowId: input.execution.workflowId,
        input: input.execution.input,
      });
    }
    this.ledger.controlScheduledPlan(`${command}:enable`, {
      scheduleId: value.scheduleId,
      expectedRevision: 1,
      enabled: true,
    });
    return { taskId: value.taskId, scheduleId: value.scheduleId };
  }
  control(raw: unknown) {
    const { commandId, ...input } = scheduledPlanControl.parse(raw);
    return this.ledger.controlScheduledPlan(
      `scheduled-plan-control:${commandId}`,
      input,
    ).value;
  }
}
