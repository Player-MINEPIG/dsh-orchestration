import type {} from "@deepseek-ai/dsh-session-persistence-jsonl";
import { Context } from "@deepseek-ai/cordis";
import {
  SessionId,
  foldSurface,
  deriveEventMessage,
} from "@deepseek-ai/dsh-session";
import { createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdirSync,
  realpathSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { TaskLedger, TaskError, canonical } from "./ledger.js";
import { Workbench } from "./workbench.js";
import { WorkspaceManager } from "./workspaces.js";
import type { TaskPlanner, PlanningInput } from "./planning.js";
import type { ExecutionRoute, Json, Role } from "./contracts.js";

const digest = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
const now = () => new Date().toISOString();
const text = (v: unknown, limit: number) => {
  if (typeof v !== "string" || !v.trim() || v.length > limit)
    throw new TaskError("INVALID", "Invalid text length");
  return v.trim();
};
const TOOLS = [
  "task_nodes",
  "task_plan",
  "task_query",
  "task_history",
  "task_children",
];
interface ProjectRow {
  taskId?: string;
  id: string;
  command: string;
  digest: string;
  root: string;
  cwd: string;
  title: string;
  goal: string;
  session: string;
  generation: number;
  state: string;
}
interface TurnRow {
  command: string;
  digest: string;
  owner: string;
  session: string;
  text: string;
  state: string;
  error: string | null;
  created: string;
}
export interface ProjectAgentOptions {
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
}

/** Authenticated owner operations. Model tools never select a directory or project ID. */
export class ProjectRuntime {
  collaboration?: import("./project-collaboration/authority.js").ProjectCollaborationAuthority;
  private readonly db;
  private readonly workbench: Workbench;
  private readonly jobs = new Map<
    string,
    { done: Promise<void>; abort: AbortController }
  >();
  private accepting = true;
  planner?: TaskPlanner;
  private readonly temporaryCreations = new Map<
    string,
    { digest: string; done: Promise<{ taskId: string; dispatchState: string }> }
  >();
  private readonly adhocCreations = new Map<string, Promise<ProjectRow>>();
  private readonly creations = new Map<
    string,
    { digest: string; done: Promise<{ projectId: string }> }
  >();
  constructor(
    private ctx: Context,
    readonly ledger: TaskLedger,
    private nodeId: string,
    private role: Role,
    private agentOptions: ProjectAgentOptions | null = null,
  ) {
    this.db = ledger.managementDatabase();
    this.workbench = new Workbench(ledger);
    ledger.projectSnapshot = (nodeId) => this.snapshotForNode(nodeId) as unknown as import("./contracts.js").Json;
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS pr_settings(id INTEGER PRIMARY KEY CHECK(id=1),root TEXT,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pr_models(owner TEXT PRIMARY KEY,selection TEXT,revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO pr_settings VALUES(1,NULL,0);
      CREATE TABLE IF NOT EXISTS pr_projects(id TEXT PRIMARY KEY,command TEXT UNIQUE NOT NULL,digest TEXT NOT NULL,root TEXT NOT NULL,cwd TEXT NOT NULL,title TEXT NOT NULL,goal TEXT NOT NULL,session TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pr_adhoc(id TEXT PRIMARY KEY,task TEXT UNIQUE NOT NULL,root TEXT NOT NULL,cwd TEXT NOT NULL,session TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pr_sessions(session TEXT PRIMARY KEY,owner TEXT NOT NULL,generation INTEGER NOT NULL,summary TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pr_turns(command TEXT PRIMARY KEY,digest TEXT NOT NULL,owner TEXT NOT NULL,session TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,error TEXT,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pr_dispatch(task TEXT PRIMARY KEY,decision TEXT NOT NULL,candidates TEXT NOT NULL,state TEXT NOT NULL,run TEXT,generation INTEGER NOT NULL,attempted TEXT NOT NULL,updated TEXT NOT NULL);`);
    // Existing project sessions keep their IDs; the column now names the
    // conversation owner, which can be a real project or a temporary task.
    for (const table of ["pr_sessions", "pr_turns"]) {
      if (
        this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((c) => c.name === "project")
      )
        this.db.exec(`ALTER TABLE ${table} RENAME COLUMN project TO owner`);
    }
    this.db
      .prepare(
        "UPDATE pr_turns SET state='interrupted',error='HOST_RESTART' WHERE state IN ('queued','running')",
      )
      .run();
    this.db
      .prepare("UPDATE pr_projects SET state='ready' WHERE state='handoff'")
      .run();
    // Reconcile a committed dispatch whose project link was interrupted by exit.
    for (const row of this.db
      .prepare("SELECT data FROM entities WHERE kind='decision'")
      .all()) {
      const record = JSON.parse(String(row.data)) as {
        decisionId: string;
        input?: PlanningInput;
      };
      if (!record.input?.projectId && !record.input?.taskId) continue;
      const p = this.db
        .prepare("SELECT id FROM pr_projects WHERE id=?")
        .get(record.input.projectId ?? "");
      const applied = this.ledger.commandReceipt(
        `apply-decision:${record.decisionId}`,
      )?.value as { taskId?: string; deferred?: boolean } | undefined;
      if (p && applied?.taskId)
        this.workbench.manage(
          `pr:${record.input.projectId}:task:${applied.taskId}`,
          "link_backlog_task",
          { backlogId: `pr:${record.input.projectId}`, taskId: applied.taskId },
        );
      if (
        (p || record.input?.taskId === applied?.taskId) &&
        applied?.taskId &&
        applied.deferred
      )
        this.enqueueDecision(record.decisionId, applied.taskId);
    }
  }
  private authorize() {
    this.ledger.assertManagementWritable();
    if (!this.accepting || this.role === "executor")
      throw new TaskError(
        "FORBIDDEN",
        "Project scheduling requires an active planner",
      );
  }
  settings() {
    return this.db
      .prepare("SELECT root,revision FROM pr_settings WHERE id=1")
      .get() as { root: string | null; revision: number };
  }
  saveSettings(input: { root: string; expectedRevision: number }) {
    this.authorize();
    if (!isAbsolute(text(input.root, 4096)))
      throw new TaskError("INVALID", "Project root must be absolute");
    if (this.settings().revision !== input.expectedRevision)
      throw new TaskError("CONFLICT", "Project settings changed");
    mkdirSync(input.root, { recursive: true });
    const root = realpathSync(input.root);
    const result = this.db
      .prepare(
        "UPDATE pr_settings SET root=?,revision=revision+1 WHERE id=1 AND revision=?",
      )
      .run(root, input.expectedRevision);
    if (!result.changes)
      throw new TaskError("CONFLICT", "Project settings changed");
    return this.settings();
  }
  private project(id: string): ProjectRow {
    const row = this.db
      .prepare("SELECT * FROM pr_projects WHERE id=?")
      .get(id) as unknown as ProjectRow | undefined;
    if (!row) throw new TaskError("NOT_FOUND", "Project runtime not found");
    return row;
  }
  private modelSelection(owner: string) {
    const row = this.db
      .prepare("SELECT selection,revision FROM pr_models WHERE owner=?")
      .get(owner) as { selection: string | null; revision: number } | undefined;
    return {
      selection: row?.selection
        ? (JSON.parse(row.selection) as ProjectAgentOptions)
        : null,
      revision: row?.revision ?? 0,
    };
  }
  async modelCatalog() {
    this.authorize();
    const llm = this.ctx.get("llm");
    if (!llm) throw new TaskError("CONFIGURATION", "Model service unavailable");
    const providers = await Promise.all(
      llm.listProviders().map(async (provider) => ({
        id: provider.id,
        name: provider.name,
        models: await Promise.all(
          (await llm.listModels(provider.id)).map(async (model) => {
            const info = await llm.resolveModelInfo(provider.id, model.id);
            return {
              id: model.id,
              name: model.name,
              reasoningEfforts:
                info?.reasoning?.efforts?.map((e) => e.id) ?? [],
            };
          }),
        ),
      })),
    );
    return { providers, defaultSelection: this.agentOptions };
  }
  async selectModel(input: {
    projectId?: string;
    taskId?: string;
    expectedRevision: number;
    selection: ProjectAgentOptions | null;
  }) {
    this.authorize();
    if (!!input.projectId === !!input.taskId)
      throw new TaskError("INVALID", "Select one conversation owner");
    const p = input.taskId
      ? this.adhoc(input.taskId)
      : this.project(input.projectId!);
    if (
      this.db
        .prepare(
          "SELECT command FROM pr_turns WHERE owner=? AND state IN ('queued','running')",
        )
        .get(p.id)
    )
      throw new TaskError("BUSY", "Conversation is responding");
    if (this.modelSelection(p.id).revision !== input.expectedRevision)
      throw new TaskError("CONFLICT", "Conversation model changed");
    if (input.selection) {
      const catalog = await this.modelCatalog(),
        provider = catalog.providers.find(
          (row) => row.id === input.selection!.provider,
        ),
        model = provider?.models.find(
          (row) => row.id === input.selection!.model,
        );
      if (
        !model ||
        (input.selection.reasoningEffort &&
          !model.reasoningEfforts.includes(
            ReasoningEffortId(input.selection.reasoningEffort),
          ))
      )
        throw new TaskError(
          "INVALID",
          "Conversation model or effort is unavailable",
        );
    }
    this.authorize();
    // Recheck after model metadata reads; an accepted turn retains its chosen model.
    if (
      this.db
        .prepare(
          "SELECT command FROM pr_turns WHERE owner=? AND state IN ('queued','running')",
        )
        .get(p.id)
    )
      throw new TaskError("BUSY", "Conversation is responding");
    if (this.modelSelection(p.id).revision !== input.expectedRevision)
      throw new TaskError("CONFLICT", "Conversation model changed");
    this.db
      .prepare(
        "INSERT INTO pr_models VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET selection=excluded.selection,revision=excluded.revision",
      )
      .run(
        p.id,
        input.selection ? canonical(input.selection) : null,
        input.expectedRevision + 1,
      );
    return this.modelSelection(p.id);
  }
  private options(owner?: string) {
    const selected =
      (owner ? this.modelSelection(owner).selection : null) ??
      this.agentOptions;
    if (!selected?.provider || !selected.model)
      throw new TaskError(
        "CONFIGURATION",
        "Project conversation model is not configured",
      );
    const { reasoningEffort, ...options } = selected;
    return {
      ...options,
      ...(reasoningEffort
        ? { reasoningEffort: ReasoningEffortId(reasoningEffort) }
        : {}),
    };
  }
  private agents() {
    if (
      !this.ctx.get("agents") ||
      !this.ctx.get("sessions") ||
      !this.ctx.get("sessionPersistence")
    )
      throw new TaskError(
        "CONFIGURATION",
        "Native session services are unavailable",
      );
    return this.ctx.get("agents") as Context["agents"];
  }
  private exclusiveFile(path: string, contents: string) {
    if (!existsSync(path))
      writeFileSync(path, contents, { flag: "wx", mode: 0o600 });
    else if (readFileSync(path, "utf8") !== contents)
      throw new TaskError("CONFLICT", "Project context file already differs");
  }
  create(input: { commandId: string; title: string; goal: string }) {
    this.authorize();
    const key = text(input.commandId, 200),
      hash = digest(input),
      existing = this.creations.get(key);
    if (existing) {
      if (existing.digest !== hash)
        throw new TaskError("CONFLICT", "Project command reused");
      return existing.done;
    }
    const done = this.createOwned(input).finally(() =>
      this.creations.delete(key),
    );
    this.creations.set(key, { digest: hash, done });
    return done;
  }
  private async createOwned(input: {
    commandId: string;
    title: string;
    goal: string;
  }) {
    this.authorize();
    this.agents();
    this.options();
    const command = text(input.commandId, 200),
      title = text(input.title, 500),
      goal = text(input.goal, 20000);
    const hash = digest({ title, goal });
    let p = this.db
      .prepare("SELECT * FROM pr_projects WHERE command=?")
      .get(command) as unknown as ProjectRow | undefined;
    if (p && p.digest !== hash)
      throw new TaskError("CONFLICT", "Project command reused");
    if (!p) {
      const root = this.settings().root;
      if (!root)
        throw new TaskError("CONFIGURATION", "Set the project root first");
      const id = randomUUID(),
        session = `project-${randomUUID()}`,
        cwd = join(root, `project-${id}`);
      this.db
        .prepare("INSERT INTO pr_projects VALUES(?,?,?,?,?,?,?,?,1,?)")
        .run(id, command, hash, root, cwd, title, goal, session, "creating");
      p = this.project(id);
    }
    if (p.state === "ready") {
      await this.syncWorkspaces();
      return { projectId: p.id };
    }
    this.workbench.manage(`pr:${p.id}:project`, "create_project", {
      projectId: p.id,
      title,
      goal,
      description: goal,
      state: "active",
      nextStep: "向统筹端描述下一项工作",
    });
    this.workbench.manage(`pr:${p.id}:backlog`, "create_backlog", {
      backlogId: `pr:${p.id}`,
      projectId: p.id,
      title: "项目任务",
      goal,
    });
    const manager = new WorkspaceManager(this.ledger, this.nodeId, [
      { id: "project-root", path: p.root, allowCreate: true },
    ]);
    const workspace = manager.provision(`pr:${p.id}:directory`, {
      workspaceId: `pr:${p.id}:planner`,
      rootId: "project-root",
      relativePath: `project-${p.id}`,
      label: title,
      mode: "create",
    });
    this.workbench.manage(`pr:${p.id}:workspace`, "link_project_workspace", {
      projectId: p.id,
      workspaceId: workspace.workspaceId,
      isDefault: true,
    });
    this.exclusiveFile(
      join(p.cwd, "PROJECT.md"),
      `# ${title}\n\n${goal}\n\nProject ID: ${p.id}\n`,
    );
    this.exclusiveFile(
      join(p.cwd, "TOOLS.md"),
      `# 统筹工具\n\n${TOOLS.join(", ")}\n\n优先将工作派发给合适的闲置执行端。没有在线执行端时持久排队，等待上线。此目录用于项目上下文；执行端使用其已授权的本地工作区。纯调度端不得执行工作负载。\n`,
    );
    if (
      !(await (
        this.ctx.get("sessionPersistence") as Context["sessionPersistence"]
      ).stat(SessionId(p.session)))
    ) {
      const handle = await this.agents().create({
        sessionId: SessionId(p.session),
        meta: { cwd: p.cwd },
        agentOptions: this.options(),
      });
      try {
        await (this.ctx.get("sessions") as Context["sessions"]).flush(
          handle.agent.session,
        );
      } finally {
        await handle.dispose();
      }
    }
    this.db
      .prepare("INSERT OR IGNORE INTO pr_sessions VALUES(?,?,?,?,?)")
      .run(p.session, p.id, 1, "", now());
    this.db
      .prepare("UPDATE pr_projects SET state='ready' WHERE id=?")
      .run(p.id);
    await this.syncWorkspaces();
    return { projectId: p.id };
  }
  /** Register project grouping in DSH, independently of executor workspace grants. */
  async syncWorkspaces() {
    const registry = this.ctx.get("workspaceRegistry") as unknown as
      | {
          create(
            path: string,
            title?: string,
          ): Promise<{ attachSession(session: SessionId): Promise<void> }>;
        }
      | undefined;
    if (!registry) return;
    for (const row of this.db
      .prepare("SELECT * FROM pr_projects WHERE state='ready'")
      .all() as unknown as ProjectRow[]) {
      if (!existsSync(row.cwd)) continue;
      await this.syncWorkspacesFor(row);
    }
  }
  private async syncWorkspacesFor(row: ProjectRow) {
    const registry = this.ctx.get("workspaceRegistry") as unknown as
      | {
          create(
            path: string,
            title?: string,
          ): Promise<{ attachSession(session: SessionId): Promise<void> }>;
        }
      | undefined;
    if (!registry) return;
    const workspace = await registry.create(row.cwd, row.title);
    for (const session of this.db
      .prepare(
        "SELECT session FROM pr_sessions WHERE owner=? ORDER BY generation",
      )
      .all(row.id))
      await workspace.attachSession(SessionId(String(session.session)));
  }
  createTemporary(input: {
    commandId: string;
    title: string;
    description: string;
  }) {
    this.authorize();
    const key = text(input.commandId, 200),
      hash = digest(input),
      existing = this.temporaryCreations.get(key);
    if (existing) {
      if (existing.digest !== hash)
        throw new TaskError("CONFLICT", "Temporary command reused");
      return existing.done;
    }
    const done = this.createTemporaryOwned(input).finally(() =>
      this.temporaryCreations.delete(key),
    );
    this.temporaryCreations.set(key, { digest: hash, done });
    return done;
  }
  private async createTemporaryOwned(input: {
    commandId: string;
    title: string;
    description: string;
  }) {
    this.agents();
    this.options();
    if (!this.settings().root || !this.planner)
      throw new TaskError(
        "CONFIGURATION",
        "Configure project root and planner first",
      );
    const command = text(input.commandId, 200),
      title = text(input.title, 500),
      description = text(input.description, 20000);
    const task = this.ledger.createTask(`temporary-task:${command}`, {
      title,
      description,
    }).value;
    await this.prepareTaskConversation(task.taskId);
    const requestId = `temporary-plan:${command}`;
    if (this.ledger.commandReceipt(`apply-decision:${requestId}`)) {
      this.enqueueDecision(requestId, task.taskId);
      return { taskId: task.taskId, dispatchState: "queued" };
    }
    // Creation remains visible if routing needs clarification or a provider fails.
    // Replaying the creation command always refers to this same Task.
    try {
      const existing = this.ledger.getDecision(requestId);
      const decision = await this.planner.plan(
        (existing?.input as unknown as PlanningInput) ?? {
          requestId,
          taskId: task.taskId,
          title,
          description,
        },
      );
      this.authorize();
      if (decision.routingStatus !== "ready")
        return { taskId: task.taskId, dispatchState: "needs-planning" };
      this.planner.apply(requestId, { deferExecution: true });
      this.enqueueDecision(requestId, task.taskId);
      return { taskId: task.taskId, dispatchState: "queued" };
    } catch {
      return { taskId: task.taskId, dispatchState: "needs-planning" };
    }
  }
  private taskProject(taskId: string) {
    const wb = this.workbench.snapshot();
    const link = wb.backlogTasks.find((t) => t.taskId === taskId);
    return wb.backlogs.find((b) => b.backlogId === link?.backlogId)?.projectId;
  }
  private adhoc(taskId: string): ProjectRow {
    const task = this.ledger.getTask(taskId);
    if (this.taskProject(taskId))
      throw new TaskError("FORBIDDEN", "Use the task's project conversation");
    const row = this.db
      .prepare("SELECT * FROM pr_adhoc WHERE task=?")
      .get(taskId) as unknown as ProjectRow | undefined;
    if (!row)
      throw new TaskError(
        "NOT_FOUND",
        "Temporary task conversation not prepared",
      );
    return {
      ...row,
      taskId,
      title: task.title,
      goal: task.description || task.title,
    };
  }
  async prepareTaskConversation(taskId: string) {
    this.authorize();
    const projectId = this.taskProject(taskId);
    if (projectId) return this.conversation(projectId);
    let job = this.adhocCreations.get(taskId);
    if (!job) {
      job = this.createAdhoc(taskId).finally(() =>
        this.adhocCreations.delete(taskId),
      );
      this.adhocCreations.set(taskId, job);
    }
    return this.readConversation(await job);
  }
  private async createAdhoc(taskId: string) {
    this.agents();
    this.options();
    const task = this.ledger.getTask(taskId);
    if (this.taskProject(taskId))
      throw new TaskError("FORBIDDEN", "Use the task's project conversation");
    if (!this.db.prepare("SELECT id FROM pr_adhoc WHERE task=?").get(taskId)) {
      const root = this.settings().root;
      if (!root)
        throw new TaskError("CONFIGURATION", "Set the project root first");
      // A planner context directory, never registered as a user project or executor workspace.
      const id = `adhoc:${taskId}`,
        cwd = join(
          root,
          "temporary-tasks",
          `task-${digest(taskId).slice(0, 32)}`,
        );
      this.db
        .prepare("INSERT INTO pr_adhoc VALUES(?,?,?,?,?,1,'creating')")
        .run(id, taskId, root, cwd, `adhoc-${randomUUID()}`);
    }
    const p = this.adhoc(taskId);
    if (p.state === "ready") return p;
    mkdirSync(p.cwd, { recursive: true, mode: 0o700 });
    this.exclusiveFile(
      join(p.cwd, "TOOLS.md"),
      `# 临时任务规划\n\nTask ID: ${taskId}\n${TOOLS.join(", ")}\n仅保留轻量调度上下文。沿用原任务 ID，不创建同名任务。纯调度端不得执行工作负载。\n`,
    );
    if (
      !(await (
        this.ctx.get("sessionPersistence") as Context["sessionPersistence"]
      ).stat(SessionId(p.session)))
    ) {
      const handle = await this.agents().create({
        sessionId: SessionId(p.session),
        meta: { cwd: p.cwd },
        agentOptions: this.options(),
      });
      try {
        await (this.ctx.get("sessions") as Context["sessions"]).flush(
          handle.agent.session,
        );
      } finally {
        await handle.dispose();
      }
    }
    this.db
      .prepare("INSERT OR IGNORE INTO pr_sessions VALUES(?,?,?,?,?)")
      .run(p.session, p.id, 1, "", now());
    this.db
      .prepare("UPDATE pr_adhoc SET state='ready' WHERE task=?")
      .run(taskId);
    return this.adhoc(taskId);
  }
  taskForSession(session: string): string | undefined {
    return (
      this.db
        .prepare(
          "SELECT a.task FROM pr_sessions s JOIN pr_adhoc a ON a.id=s.owner WHERE s.session=?",
        )
        .get(session) as { task: string } | undefined
    )?.task;
  }
  async taskConversation(taskId: string) {
    return this.prepareTaskConversation(taskId);
  }
  sendTask(input: { taskId: string; commandId: string; text: string }) {
    this.authorize();
    this.agents();
    return this.sendOwned(
      this.adhoc(input.taskId),
      input.commandId,
      input.text,
    );
  }
  projectForSession(session: string): string | undefined {
    return (
      this.db
        .prepare(
          "SELECT s.owner FROM pr_sessions s JOIN pr_projects p ON p.id=s.owner WHERE s.session=?",
        )
        .get(session) as { owner: string } | undefined
    )?.owner;
  }
  /** Final deterministic ownership check before dispatch, including attach decisions. */
  assertDecisionScope(session: string, requestId: string) {
    const projectId = this.projectForSession(session);
    const input = this.ledger.getDecision(requestId)?.input as unknown as
      | PlanningInput
      | undefined;
    if (projectId !== input?.projectId && (projectId || input?.projectId))
      throw new TaskError("FORBIDDEN", "Decision belongs to another project");
    const taskId = this.taskForSession(session);
    if (taskId !== input?.taskId && (taskId || (!projectId && input?.taskId)))
      throw new TaskError(
        "FORBIDDEN",
        "Decision belongs to another temporary task",
      );
    if (projectId || taskId) {
      const turn = this.db
        .prepare(
          "SELECT command FROM pr_turns WHERE session=? AND state='running'",
        )
        .get(session) as { command: string } | undefined;
      if (!turn || requestId !== `project-message:${turn.command}`)
        throw new TaskError("FORBIDDEN", "Use the current message request ID");
      const proposal = this.ledger.getDecision(requestId)?.proposal as
        | { attachTaskId?: string }
        | undefined;
      if (
        proposal?.attachTaskId &&
        !(taskId ? [taskId] : this.projectTaskIds(projectId!)).includes(
          proposal.attachTaskId,
        )
      )
        throw new TaskError(
          "FORBIDDEN",
          "Cannot attach a task from another project",
        );
    }
  }
  assertProposalScope(
    session: string,
    input: {
      requestId: string;
      route?: unknown;
      workspaceId?: unknown;
      provider?: unknown;
      model?: unknown;
      reasoningEffort?: unknown;
    },
  ) {
    if (!this.projectForSession(session) && !this.taskForSession(session))
      return;
    const turn = this.db
      .prepare(
        "SELECT command FROM pr_turns WHERE session=? AND state='running'",
      )
      .get(session) as { command: string } | undefined;
    if (!turn || input.requestId !== `project-message:${turn.command}`)
      throw new TaskError("FORBIDDEN", "Use the current message request ID");
    if (
      input.route ||
      input.workspaceId ||
      input.provider ||
      input.model ||
      input.reasoningEffort
    )
      throw new TaskError(
        "FORBIDDEN",
        "Project dispatch uses the configured decision catalog",
      );
  }
  linkTask(session: string, taskId: string) {
    const id = this.projectForSession(session);
    if (id)
      this.workbench.manage(`pr:${id}:task:${taskId}`, "link_backlog_task", {
        backlogId: `pr:${id}`,
        taskId,
      });
  }
  enqueueDecision(decisionId: string, taskId: string) {
    this.authorize();
    const record = this.ledger.getDecision(decisionId);
    const input = record?.input as unknown as PlanningInput | undefined;
    const proposal = record?.proposal as unknown as {
      modelRoute?: {
        executorId: string;
        provider: string;
        model: string;
        reasoningEffort?: string;
      };
      fallbackRoutes?: {
        executorId: string;
        provider: string;
        model: string;
        reasoningEffort?: string;
      }[];
    };
    const applied = this.ledger.commandReceipt(`apply-decision:${decisionId}`)
      ?.value as { taskId?: string; deferred?: boolean } | undefined;
    if (
      (!input?.projectId && input?.taskId !== taskId) ||
      applied?.taskId !== taskId ||
      !applied.deferred
    )
      return;
    const prior = this.db
      .prepare("SELECT decision FROM pr_dispatch WHERE task=?")
      .get(taskId) as { decision: string } | undefined;
    if (prior && prior.decision !== decisionId) {
      const order = (id: string) =>
        Number(
          this.db
            .prepare(
              "SELECT rowid FROM entities WHERE kind='decision' AND id=?",
            )
            .get(id)?.rowid ?? 0,
        );
      // Replanning pending work replaces its recommendation, but startup
      // reconciliation of an older receipt must never restore an older route.
      if (order(decisionId) <= order(prior.decision)) return;
    }
    const candidates = [
      ...(proposal.modelRoute ? [proposal.modelRoute] : []),
      ...(proposal.fallbackRoutes ?? []),
    ].map((r) => ({
      nodeId: r.executorId,
      provider: r.provider,
      model: r.model,
      ...(r.reasoningEffort ? { reasoningEffort: r.reasoningEffort } : {}),
      requiredCapabilities: [],
      ...(input.route && r === proposal.modelRoute ? input.route : {}),
    }));
    this.db
      .prepare(
        `INSERT INTO pr_dispatch VALUES(?,?,?,'inbox',NULL,0,'[]',?)
         ON CONFLICT(task) DO UPDATE SET decision=excluded.decision,candidates=excluded.candidates,state='inbox',run=NULL,attempted='[]',updated=excluded.updated
         WHERE pr_dispatch.decision<>excluded.decision`,
      )
      .run(taskId, decisionId, canonical(candidates), now());
    this.tick();
  }
  /** Persisted inbox admission; only pre-claim unavailability may move to the next candidate. */
  tick() {
    if (!this.accepting) return;
    // Task requeue is the durable source of truth. Repair the dispatch view even
    // if the host stopped between the operator command and queue admission.
    for (const pending of this.db
      .prepare(
        "SELECT task FROM pr_dispatch WHERE state<>'inbox' AND task IN (SELECT id FROM entities WHERE kind='task' AND state='inbox')",
      )
      .all()) {
      if (
        !this.ledger
          .snapshot()
          .runs.some(
            (r) =>
              r.taskId === pending.task &&
              ["queued", "running", "uncertain"].includes(r.state),
          )
      )
        this.db
          .prepare(
            "UPDATE pr_dispatch SET state='inbox',run=NULL,attempted='[]',updated=? WHERE task=?",
          )
          .run(now(), String(pending.task));
    }
    const rows = this.db
      .prepare(
        "SELECT * FROM pr_dispatch WHERE state IN ('inbox','assigned') ORDER BY rowid",
      )
      .all() as unknown as {
      task: string;
      decision: string;
      candidates: string;
      state: string;
      run: string | null;
      generation: number;
      attempted: string;
      updated: string;
    }[];
    for (const row of rows) {
      let data = this.ledger.snapshot();
      const task = data.tasks.find((t) => t.taskId === row.task);
      if (!task) continue;
      if (row.state === "assigned" && row.run) {
        const run = this.ledger.getRun(row.run);
        if (run.state === "queued") {
          const health = this.ledger
            .nodeStatuses()
            .find((n) => n.nodeId === run.route?.nodeId);
          if (
            health?.state !== "online" &&
            Date.now() - Date.parse(row.updated) > 15000 &&
            !run.currentAttemptId &&
            !(data.attempts ?? []).some((a) => a.runId === run.runId)
          ) {
            try {
              this.ledger.returnUnclaimedToInbox(`pr:unclaimed:${run.runId}`, {
                taskId: row.task,
                runId: run.runId,
              });
            } catch {
              continue;
            }
            this.db
              .prepare(
                "UPDATE pr_dispatch SET state='inbox',run=NULL,updated=? WHERE task=?",
              )
              .run(now(), row.task);
          } else continue;
        } else if (run.state === "cancelled" && task.state === "inbox") {
          this.db
            .prepare(
              "UPDATE pr_dispatch SET state='inbox',run=NULL,updated=? WHERE task=?",
            )
            .run(now(), row.task);
        } else {
          this.db
            .prepare("UPDATE pr_dispatch SET state=?,updated=? WHERE task=?")
            .run(
              run.state === "running" ? "executing" : "settled",
              now(),
              row.task,
            );
          continue;
        }
        data = this.ledger.snapshot();
      }
      const active = data.runs.find(
        (r) =>
          r.taskId === row.task &&
          ["queued", "running", "uncertain"].includes(r.state),
      );
      if (active) {
        this.db
          .prepare(
            "UPDATE pr_dispatch SET state='assigned',run=?,updated=? WHERE task=?",
          )
          .run(active.runId, now(), row.task);
        continue;
      }
      if (
        ["cancelled", "archived", "completed", "failed"].includes(
          this.ledger.getTask(row.task).state,
        )
      ) {
        this.db
          .prepare("UPDATE pr_dispatch SET state='stopped' WHERE task=?")
          .run(row.task);
        continue;
      }
      const checks: { nodeId: string; reason: string }[] = [];
      for (const route of JSON.parse(row.candidates) as ExecutionRoute[]) {
        try {
          this.ledger.validateRoute(route);
        } catch {
          checks.push({ nodeId: route.nodeId, reason: "ineligible" });
          continue;
        }
        const health = this.ledger
          .nodeStatuses()
          .find((n) => n.nodeId === route.nodeId);
        if (health?.state !== "online") {
          checks.push({ nodeId: route.nodeId, reason: "offline" });
          continue;
        }
        const reservations = data.runs.filter(
          (r) =>
            r.route?.nodeId === route.nodeId &&
            r.state === "queued" &&
            !r.historyOnly &&
            !r.observationOnly,
        ).length;
        if (
          (health.availableSlots ?? 1) - reservations <= 0 ||
          (health.activeExecutions ?? health.activeClaims) >=
            (health.maxConcurrent ?? 1)
        ) {
          checks.push({ nodeId: route.nodeId, reason: "busy" });
          continue;
        }
        try {
          // Reserve the idempotency generation before creating the Run. A host
          // crash between ledger commit and dispatch bookkeeping must not reuse
          // the old command after an unclaimed Run returns to the inbox.
          const { generation } = this.db
            .prepare(
              "UPDATE pr_dispatch SET generation=generation+1 WHERE task=? RETURNING generation",
            )
            .get(row.task) as { generation: number };
          const run = this.ledger.createRun(
            `pr:dispatch:${row.task}:${generation}`,
            {
              taskId: row.task,
              route,
              configuration: { decisionId: row.decision, reporting: "summary" },
            },
          ).value;
          checks.push({ nodeId: route.nodeId, reason: "assigned" });
          this.db
            .prepare(
              "UPDATE pr_dispatch SET state='assigned',run=?,generation=?,attempted=?,updated=? WHERE task=?",
            )
            .run(run.runId, generation, canonical(checks), now(), row.task);
          break;
        } catch {
          checks.push({ nodeId: route.nodeId, reason: "rejected" });
        }
      }
      const current = this.db
        .prepare("SELECT state FROM pr_dispatch WHERE task=?")
        .get(row.task) as { state: string };
      if (current.state === "inbox" && canonical(checks) !== row.attempted)
        this.db
          .prepare("UPDATE pr_dispatch SET attempted=?,updated=? WHERE task=?")
          .run(canonical(checks), now(), row.task);
    }
  }
  private projectTaskIds(id: string) {
    const wb = this.workbench.snapshot();
    const backlogs = new Set(
      wb.backlogs.filter((b) => b.projectId === id).map((b) => b.backlogId),
    );
    return wb.backlogTasks
      .filter((t) => backlogs.has(t.backlogId))
      .map((t) => t.taskId);
  }
  send(input: { projectId: string; commandId: string; text: string }) {
    this.authorize();
    this.agents();
    return this.sendOwned(
      this.project(input.projectId),
      input.commandId,
      input.text,
    );
  }
  private sendOwned(p: ProjectRow, commandId: string, contents: string) {
    const message = text(contents, 20000),
      command = text(commandId, 200);
    const agentOptions = this.options(p.id);
    if (p.state !== "ready")
      throw new TaskError("CONFLICT", "Project is not ready");
    const hash = digest(
      p.taskId
        ? { taskId: p.taskId, text: message }
        : { projectId: p.id, text: message },
    );
    const existing = this.db
      .prepare("SELECT * FROM pr_turns WHERE command=?")
      .get(command) as unknown as TurnRow | undefined;
    if (existing) {
      if (existing.digest !== hash)
        throw new TaskError("CONFLICT", "Message command reused");
      return { commandId: command, state: existing.state };
    }
    if (
      this.db
        .prepare(
          "SELECT command FROM pr_turns WHERE owner=? AND state IN ('queued','running')",
        )
        .get(p.id)
    )
      throw new TaskError("BUSY", "Project conversation is responding");
    this.db
      .prepare("INSERT INTO pr_turns VALUES(?,?,?,?,?,?,NULL,?)")
      .run(command, hash, p.id, p.session, message, "queued", now());
    const abort = new AbortController();
    const done = this.respond(p, command, message, abort.signal, agentOptions)
      .catch(() => {
        this.db
          .prepare(
            "UPDATE pr_turns SET state='failed',error='CONVERSATION_FAILED' WHERE command=?",
          )
          .run(command);
      })
      .finally(() => this.jobs.delete(command));
    this.jobs.set(command, { done, abort });
    return { commandId: command, state: "queued" };
  }
  private async respond(
    p: ProjectRow,
    command: string,
    message: string,
    signal: AbortSignal,
    agentOptions: ReturnType<ProjectRuntime["options"]>,
  ) {
    let terminalError = false;
    let handle: Awaited<ReturnType<Context["agents"]["resume"]>> | undefined;
    const timeout = AbortSignal.timeout(120000),
      combined = AbortSignal.any([signal, timeout]);
    try {
      this.db
        .prepare("UPDATE pr_turns SET state='running' WHERE command=?")
        .run(command);
      const summary = (
        this.db
          .prepare("SELECT summary FROM pr_sessions WHERE session=?")
          .get(p.session) as { summary: string }
      ).summary;
      const related = this.snapshot()
        .tasks.filter((t) =>
          p.taskId ? t.id === p.taskId : t.project === p.id,
        )
        .map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          stateLabel: t.stateLabel,
          manualCompletion: t.manualCompletion,
          materialsStatus: t.materialsStatus,
          run: t.run,
          report: t.report,
          runId: t.runId,
          canRetry: t.canRetry,
          canReconcile: t.canReconcile,
          retryDisabledReason: t.retryDisabledReason,
        }));
      handle = await this.agents().resume({
        resumeSessionId: SessionId(p.session),
        agentOptions,
        signal: combined,
        setup: (agentCtx, agent) => {
          agentCtx.on("agent/error", () => {
            terminalError = true;
          });
          let steps = 0;
          agentCtx.on("agent/pre-step", async (_payload, next) => {
            if (++steps > 12)
              throw new TaskError("LIMIT", "Project turn step limit");
            return await next();
          });
          agentCtx.tools.restrict({ allow: TOOLS });
          agentCtx.tools.guard((exec) =>
            exec.agent === agent && TOOLS.includes(exec.name)
              ? undefined
              : "Project dispatch tools only",
          );
          agentCtx.systemPrompt.section({
            name: "project-runtime",
            order: 99,
            interpolate: false,
            text: () =>
              `${p.taskId ? `你负责临时任务 ${p.taskId} 的规划。所有执行规划必须沿用此 Task ID，不创建新任务；结果不确定时先核实；只有明确授权重新执行后才使用重试，不得把补问结果当成重跑授权。` : ""}你负责「${p.title}」的统筹。目标：${p.goal}\n${summary}\n已有任务：${JSON.stringify(related)}\n工作区：${p.cwd}，仅存项目上下文。你可以调用 ${TOOLS.join(", ")} 调度其他执行端。用户授权创建的任务优先交给适合的在线闲置执行端；没有在线执行端时，选择注册的合适执行端排队等待上线。纯调度端不得接单或自行完成工作负载。执行端自己选择其授权工作区，不要把调度端目录设为执行约束。不要指定 route/provider/model/effort，让 task_plan 的决策服务选择。任务先登记，再按推荐的执行端顺序尝试。都不在线、忙碌或不可接单时保留 inbox，宿主会在执行端上线后自动派发。已经开始或结果不确定的任务不重复派发；先检查相关任务状态。仅当用户明确要重新执行时，才指引用户使用“核实并确认已停止”和“重新尝试派发”。没有 result 报告仅表示调度账本未收到完成证据，不得断言执行端没有完成。若用户要求不重跑、只通信、询问现状或补传回执，不得 propose/apply，也不得把重新派发描述为唯一取回结果的方法。当前这些统筹工具只能读取调度账本和规划任务，没有向执行端会话发送普通消息或从已停止会话补取回执的工具；不得谎称已发消息或编造报告。此时可以如实解释已有记录，并指引用户在输入框的“对话对象”中选择执行端原会话直接发送消息；普通聊天不代表正式完成回执。只有用户明确授权执行规划时，才使用 requestId="project-message:${command}"，先 propose，再 apply 相同 ID，apply 登记 Task 和持久候选顺序；只有执行端能接单时才创建 Run。不要重复派发。只调用一次 apply。提交后简短回复已排队或派发，完成与否必须依据真实报告或账本中用户的人工确认；补交内容会更新执行报告展示，不改写历史 Run 结果。若为普通交流或澄清可直接回复。`,
          });
        },
      });
      const cancel = () =>
        handle?.agent.cancel({ kind: "hook", reason: "Project turn stopped" });
      combined.addEventListener("abort", cancel, { once: true });
      handle.agent.followup(
        createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: message }],
        }),
      );
      try {
        await handle.agent.whenIdle();
      } finally {
        combined.removeEventListener("abort", cancel);
      }
      combined.throwIfAborted();
      if (terminalError)
        throw new TaskError(
          "CONVERSATION_FAILED",
          "Native conversation failed",
        );
      await (this.ctx.get("sessions") as Context["sessions"]).flush(
        handle.agent.session,
      );
      this.db
        .prepare(
          "UPDATE pr_turns SET state='completed',error=NULL WHERE command=?",
        )
        .run(command);
    } catch (error) {
      this.db
        .prepare("UPDATE pr_turns SET state='failed',error=? WHERE command=?")
        .run(
          signal.aborted
            ? "HOST_STOPPED"
            : timeout.aborted
              ? "TIMEOUT"
              : "CONVERSATION_FAILED",
          command,
        );
    } finally {
      if (handle) {
        try {
          await (this.ctx.get("sessions") as Context["sessions"]).flush(
            handle.agent.session,
          );
        } finally {
          await handle.dispose();
        }
      }
    }
  }
  async conversation(projectId: string) {
    return this.readConversation(this.project(projectId));
  }
  sendExecutorMessage(input: {
    projectId?: string;
    taskId: string;
    nodeId: string;
    sessionId: string;
    commandId: string;
    text: string;
  }) {
    this.authorize();
    if (
      input.projectId &&
      !this.projectTaskIds(input.projectId).includes(input.taskId)
    )
      throw new TaskError("FORBIDDEN", "Task does not belong to this project");
    return this.ledger.queueSessionMessage(input.commandId, {
      taskId: input.taskId,
      nodeId: input.nodeId,
      sessionId: input.sessionId,
      text: input.text,
    });
  }
  private async readConversation(p: ProjectRow) {
    const handle = await (
      this.ctx.get("sessionPersistence") as Context["sessionPersistence"]
    ).open(SessionId(p.session), "read");
    let messages: {
      role: string;
      text: string;
      id: string;
      time?: string;
      executor?: string;
      sessionId?: string;
      state?: string;
    }[] = [];
    try {
      const { events } = await handle.read();
      const projection = foldSurface(events);
      messages = projection.nodes
        .flatMap((seq) => {
          const event = events[seq];
          const message =
            event && deriveEventMessage(event, projection.projectedMessages);
          if (
            !message ||
            String(message.source.kind) === "runtime-context" ||
            !["user", "assistant"].includes(message.role)
          )
            return [];
          const body = message.content
            .filter((c) => c.type === "text")
            .map((c) => (c.type === "text" ? c.text : ""))
            .join("\n");
          return body
            ? [
                {
                  role: message.role,
                  text: body,
                  id: message.id,
                  time: new Date(event!.time).toISOString(),
                },
              ]
            : [];
        })
        .slice(-200);
    } finally {
      await handle.close();
    }
    const tasks = p.taskId ? [p.taskId] : this.projectTaskIds(p.id);
    const executorTargets = tasks.flatMap((taskId) =>
      this.ledger
        .sessionMessageTargets(taskId)
        .map((s) => ({ ...s, title: this.ledger.getTask(taskId).title })),
    );
    for (const taskId of tasks)
      for (const m of this.ledger.sessionMessages(taskId)) {
        messages.push({
          id: `direct:${m.messageId}`,
          role: "user",
          text: m.text,
          time: m.createdAt,
          executor: m.nodeId,
          sessionId: m.sessionId,
          state: m.state,
        });
        if (m.reply)
          messages.push({
            id: `direct-reply:${m.messageId}`,
            role: "assistant",
            text: m.reply,
            time: m.updatedAt,
            executor: m.nodeId,
            sessionId: m.sessionId,
            state: m.state,
          });
      }
    messages.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
    return {
      executorTargets,
      projectId: p.taskId ? null : p.id,
      taskId: p.taskId ?? null,
      conversationModel: {
        ...this.modelSelection(p.id),
        effective: this.modelSelection(p.id).selection ?? this.agentOptions,
      },
      workspace: p.cwd,
      sessionId: p.session,
      generation: p.generation,
      messages,
      sessions: this.db
        .prepare(
          "SELECT session,generation,summary,created FROM pr_sessions WHERE owner=? ORDER BY generation DESC",
        )
        .all(p.id),
      turns: this.db
        .prepare(
          "SELECT command,state,error,text FROM pr_turns WHERE session=? ORDER BY rowid DESC LIMIT 20",
        )
        .all(p.session),
    };
  }
  async handoff(projectId: string) {
    this.authorize();
    const p = this.project(projectId);
    if (
      this.db
        .prepare(
          "SELECT command FROM pr_turns WHERE owner=? AND state IN ('running','queued')",
        )
        .get(p.id)
    )
      throw new TaskError("BUSY", "Wait for the current response");
    if (p.state !== "ready")
      throw new TaskError("BUSY", "Project is changing its session");
    const locked = this.db
      .prepare(
        "UPDATE pr_projects SET state='handoff' WHERE id=? AND state='ready'",
      )
      .run(p.id);
    if (!locked.changes)
      throw new TaskError("BUSY", "Project is changing its session");
    try {
      const history = await this.conversation(p.id);
      const tasks = this.snapshot().tasks.filter((t) =>
        p.taskId ? t.id === p.taskId : t.project === p.id,
      );
      const summary = `项目目标：${p.goal}\n原统筹会话：${p.session}\n未完成任务（沿用原任务，不要重复创建）：${JSON.stringify(tasks.filter((t) => t.status !== "done"))}\n完成任务的报告引用：${JSON.stringify(tasks.filter((t) => t.status === "done").map((t) => ({ taskId: t.id, run: t.run, reportId: t.reportId })))}\n近期对话（用于审查约束与下一步）：${JSON.stringify(history.messages.slice(-16)).slice(-24000)}`;
      const session = `project-${randomUUID()}`,
        generation = p.generation + 1;
      const handle = await this.agents().create({
        sessionId: SessionId(session),
        meta: { cwd: p.cwd },
        agentOptions: this.options(),
      });
      try {
        await (this.ctx.get("sessions") as Context["sessions"]).flush(
          handle.agent.session,
        );
      } finally {
        await handle.dispose();
      }
      this.db
        .prepare("INSERT INTO pr_sessions VALUES(?,?,?,?,?)")
        .run(session, p.id, generation, summary, now());
      this.db
        .prepare(
          "UPDATE pr_projects SET session=?,generation=? WHERE id=? AND session=?",
        )
        .run(session, generation, p.id, p.session);
      await this.syncWorkspacesFor(p);
      return { sessionId: session, generation };
    } finally {
      this.db
        .prepare(
          "UPDATE pr_projects SET state='ready' WHERE id=? AND state='handoff'",
        )
        .run(p.id);
    }
  }
  review(input: { commandId: string; taskId: string }) {
    this.authorize();
    const run = this.ledger
      .snapshot()
      .runs.filter((r) => r.taskId === input.taskId)
      .at(-1);
    if (!run) throw new TaskError("NOT_FOUND", "Task has no run");
    return this.ledger.reviewRun(input.commandId, {
      runId: run.runId,
      decision: "accepted",
      reason: "在任务中心审核通过",
    });
  }
  actOnTask(input: {
    commandId: string;
    taskId: string;
    expectedVersion: string;
    runId: string | null;
    confirmationRevision: number;
    action:
      | "complete-materials"
      | "complete"
      | "handle"
      | "restore"
      | "cancel"
      | "approve"
      | "accept"
      | "reject"
      | "confirm-stopped"
      | "status"
      | "retry";
  }) {
    this.authorize();
    const view = this.ledger.taskActionState(input.taskId),
      task = this.ledger.getTask(input.taskId);
    if (input.action === "retry") return this.retryTask(input);
    const common = {
      taskId: input.taskId,
      expectedActionVersion: input.expectedVersion,
    };
    if (input.action === "complete" || input.action === "complete-materials")
      return this.ledger.confirmTaskCompletion(input.commandId, {
        ...common,
        requireMaterials: input.action === "complete-materials",
      });
    // Let each ledger command perform its own transactional version check and idempotency.
    if (input.action === "handle" || input.action === "restore")
      return this.ledger.setTaskHandled(input.commandId, {
        ...common,
        handled: input.action === "handle",
      });
    if (input.action === "cancel") {
      if (!view.canCancel && !this.ledger.commandReceipt(input.commandId))
        throw new TaskError("CONFLICT", "Task cannot be cancelled");
      return this.ledger.cancel(input.commandId, {
        ...common,
        reason: "用户在任务中心取消任务",
      });
    }
    if (input.action === "approve") {
      if (
        !view.confirmationPending &&
        !this.ledger.commandReceipt(input.commandId)
      )
        throw new TaskError(
          "CONFLICT",
          "Task is not awaiting execution approval",
        );
      return this.ledger.setTaskConfirmation(input.commandId, {
        ...common,
        expectedRevision: input.confirmationRevision,
        approved: true,
        actor: "operator:task-center",
        reason: "用户在任务中心批准执行",
      });
    }
    const run = input.runId ? this.ledger.getRun(input.runId) : null;
    if (run && run.taskId !== input.taskId)
      throw new TaskError("FORBIDDEN", "Run belongs to another task");
    if (
      run &&
      !this.ledger.commandReceipt(input.commandId) &&
      this.ledger
        .snapshot()
        .runs.filter((r) => r.taskId === input.taskId)
        .at(-1)?.runId !== run.runId
    )
      throw new TaskError("CONFLICT", "Task changed; refresh before acting");
    if (!run) throw new TaskError("NOT_FOUND", "Task has no run");
    if (input.action === "status")
      return this.ledger.requestExecutionStatus(input.commandId, {
        runId: run.runId,
        expectedActionVersion: input.expectedVersion,
      });
    if (input.action === "confirm-stopped") {
      if (!view.canReconcile && !this.ledger.commandReceipt(input.commandId))
        throw new TaskError(
          "CONFLICT",
          "Execution does not await stop verification",
        );
      return this.ledger.resolveUncertain(input.commandId, {
        runId: run.runId,
        outcome: task.state === "cancelled" ? "cancelled" : "failed",
        reason: "用户已核实执行端停止，确认此运行已经结束",
        expectedActionVersion: input.expectedVersion,
      });
    }
    return this.ledger.reviewRun(input.commandId, {
      runId: run.runId,
      decision: input.action === "accept" ? "accepted" : "rejected",
      reason: "用户在任务中心审核结果",
      expectedActionVersion: input.expectedVersion,
    });
  }
  private async retryTask(input: {
    commandId: string;
    taskId: string;
    expectedVersion: string;
  }) {
    const requestId = `task-retry:${text(input.commandId, 200)}`;
    const prior = this.ledger.commandReceipt(`apply-decision:${requestId}`);
    if (prior) {
      const record = this.ledger.getDecision(requestId)
        ?.input as unknown as PlanningInput;
      if (
        record.taskId !== input.taskId ||
        record.expectedActionVersion !== input.expectedVersion
      )
        throw new TaskError("CONFLICT", "Retry command reused");
      this.enqueueDecision(requestId, input.taskId);
      return prior;
    }
    const view = this.ledger.taskActionState(input.taskId);
    if (view.version !== input.expectedVersion)
      throw new TaskError("CONFLICT", "Task changed; refresh before acting");
    if (!view.canRetry)
      throw new TaskError("CONFLICT", "Task is not safe to dispatch again");
    if (!this.planner)
      throw new TaskError("CONFIGURATION", "Task planner unavailable");
    const task = this.ledger.getTask(input.taskId),
      projectId = this.taskProject(input.taskId);
    // Operator retry keeps the last execution choice while it remains legal.
    // Queue admission still checks live readiness, capacity and Task policy.
    const previous = this.ledger
      .snapshot()
      .runs.filter((r) => r.taskId === input.taskId)
      .at(-1);
    let route = previous?.route && { ...previous.route };
    // Derived workspace choices remain executor-owned. newRun resolves this
    // Task's bound session workspace; do not promote it to a Task constraint.
    if (route && !task.workspaceId) delete route.workspaceId;
    if (route) {
      try {
        this.ledger.validateRoute(route);
      } catch {
        route = undefined;
      }
    }
    await this.planner.plan({
      requestId,
      taskId: input.taskId,
      expectedActionVersion: input.expectedVersion,
      ...(route ? { route } : {}),
      ...(projectId ? { projectId } : {}),
      title: task.title,
      description: task.description,
      ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
    });
    this.authorize();
    const receipt = this.planner.apply(requestId, { deferExecution: true });
    this.enqueueDecision(requestId, input.taskId);
    return receipt;
  }
  snapshot() {
    const wb = this.workbench.snapshot(),
      data = this.ledger.snapshot();
    const projectCollaborations = this.collaboration?.collaborationSummaries() ?? [];
    const runtimes = new Map(
      (
        this.db
          .prepare("SELECT * FROM pr_projects")
          .all() as unknown as ProjectRow[]
      ).map((p) => [p.id, p]),
    );
    const taskProjects = new Map(
      wb.backlogTasks.map((link) => [
        link.taskId,
        wb.backlogs.find((b) => b.backlogId === link.backlogId)?.projectId,
      ]),
    );
    for (const t of data.tasks) {
      let parent = t.parentTaskId;
      const seen = new Set<string>();
      while (!taskProjects.get(t.taskId) && parent && !seen.has(parent)) {
        seen.add(parent);
        if (taskProjects.get(parent)) taskProjects.set(t.taskId, taskProjects.get(parent));
        parent = data.tasks.find(x => x.taskId === parent)?.parentTaskId;
      }
    }
    const projects = wb.projects.map((p) => {
      const collaboration = projectCollaborations.find(c => c.projectId === p.projectId);
      const runtime = runtimes.get(p.projectId),
        workspace = wb.projectWorkspaces.find(
          (w) => w.projectId === p.projectId && w.isDefault,
        );
      return {
        id: p.projectId,
        title: p.title,
        description: p.description,
        goal: p.goal,
        next: p.nextStep || "继续项目工作",
        stage:
          runtime?.state === "ready"
            ? "正在推进"
            : runtime
              ? "准备工作区"
              : collaboration ? "会话协作" : "历史项目",
        workspace:
          runtime?.cwd || collaboration?.cwd ||
          (data.workspaces ?? []).find(
            (w) => w.workspaceId === workspace?.workspaceId,
          )?.path ||
          "未绑定",
        session: runtime?.generation || 0,
        sessionId: runtime?.session || null,
        context: 0,
        phase: p.state,
        messages: [],
        canChat: runtime?.state === "ready",
      };
    });
    const dispatches = new Map(
      (
        this.db.prepare("SELECT * FROM pr_dispatch").all() as unknown as {
          task: string;
          candidates: string;
          state: string;
          attempted: string;
        }[]
      ).map((r) => [r.task, r]),
    );
    const tasks = data.tasks.map((t) => {
      const dispatch = dispatches.get(t.taskId);
      const runs = data.runs.filter((r) => r.taskId === t.taskId),
        run = runs.at(-1);
      const supplementaryReports = data.reports.filter(
        (r) =>
          r.taskId === t.taskId &&
          !!run &&
          r.runId === run.runId &&
          r.kind === "note" &&
          r.data &&
          typeof r.data === "object" &&
          !Array.isArray(r.data) &&
          r.data.supplemental === true,
      );
      const resultReports = data.reports.filter(
        (r) =>
          r.taskId === t.taskId &&
          !!run &&
          r.runId === run.runId &&
          r.kind === "result",
      );
      // A supplement updates the report view, not the historical execution outcome.
      const report = supplementaryReports.at(-1) ?? resultReports.at(-1);
      const reportHistory = [...resultReports, ...supplementaryReports].filter(
        (r) => r.reportId !== report?.reportId,
      );

      const attention = this.ledger.taskActionState(t.taskId);
      const cancelled = t.state === "cancelled";
      const manual = t.state === "completed" ? t.manualCompletion : undefined;
      const materialRequest = manual?.requestMessageId
        ? (this.ledger
            .sessionMessages(t.taskId)
            .filter((m) => m.supplementFor === manual.decisionId)
            .at(-1) ?? this.ledger.getSessionMessage(manual.requestMessageId))
        : undefined;
      const materialsStatus = !manual
        ? null
        : manual.materials !== "pending"
          ? "closed"
          : supplementaryReports.length
            ? "received"
            : materialRequest?.state === "failed"
              ? "failed"
              : materialRequest?.state === "uncertain"
                ? "uncertain"
                : "requested";
      const materialsLabel = {
        received: "已收到材料，待核对",
        requested: "已请求补交，等待回复",
        failed: "补交请求失败",
        uncertain: "补交回复未确认",
        closed: "已完成人工确认",
      }[materialsStatus ?? "closed"];

      const status = manual
        ? "done"
        : cancelled
          ? attention.uncertain
            ? "error"
            : attention.active
              ? "cancelling"
              : "cancelled"
          : t.state === "archived"
            ? "archived"
            : t.state === "inbox" && dispatch?.state === "inbox"
              ? "queued"
              : attention.confirmationPending ||
                  run?.reviewStatus === "pending_user"
                ? "review"
                : attention.handled
                  ? "handled"
                  : run?.reviewStatus === "rejected"
                    ? "error"
                    : run?.state === "succeeded" || t.state === "completed"
                      ? "done"
                      : ["failed", "partial", "uncertain", "blocked"].includes(
                            run?.state || "",
                          ) || t.state === "failed"
                        ? "error"
                        : run?.state === "running"
                          ? "running"
                          : run?.state === "cancelled"
                            ? "cancelled"
                            : "queued";
      return {
        id: t.taskId,
        parentTaskId: t.parentTaskId ?? null,
        parentRunId: t.parentRunId ?? null,
        delegationDisplay: t.delegationDisplay?.mode ?? "task",
        observationOnly: t.kind === "observed" || !!run?.observationOnly,
        project: taskProjects.get(t.taskId) || "unassigned",
        title: t.title,
        description: t.description,
        status,
        actionVersion: attention.version,
        runId: run?.runId ?? null,
        executionStartedAt: run?.executionStartedAt ?? null,
        executionEndedAt:
          run && !["queued", "running"].includes(run.state)
            ? run.updatedAt
            : null,
        canRequestStatus:
          run?.state === "running" && !run.cancellationRequested,
        progressRequest:
          data.attempts?.find((a) => a.attemptId === run?.currentAttemptId)
            ?.progressRequest ?? null,
        confirmationRevision: t.confirmation?.revision ?? 1,
        canHandle: attention.canHandle && !attention.handled,
        canConfirm:
          t.kind !== "observed" &&
          (attention.canHandle ||
            attention.canCancel ||
            manual?.materials === "pending"),
        canComplete:
          t.kind !== "observed" &&
          (attention.canHandle || manual?.materials === "pending"),
        canRequestMaterials:
          attention.canHandle &&
          !!data.attempts?.find(
            (a) =>
              a.attemptId === run?.currentAttemptId &&
              this.ledger
                .sessionMessageTargets(t.taskId)
                .some(
                  (s) =>
                    s.nodeId === a.nodeId &&
                    s.sessionId === a.sessionId &&
                    s.workspaceId,
                ),
          ),
        manualCompletion: manual ?? null,
        supplementaryReports,
        materialsStatus,
        materialsLabel: manual ? materialsLabel : null,
        materialRequestState: materialRequest?.state ?? null,
        reportHistory,
        reportSource: supplementaryReports.some(
          (r) => r.reportId === report?.reportId,
        )
          ? "supplement"
          : "execution",
        reportUpdatedAt: report?.recordedAt ?? null,
        canCancel: attention.canCancel,
        canRetry: attention.canRetry,
        retryDisabledReason: attention.canRetry
          ? null
          : attention.uncertain
            ? "执行结果不确定，请先核实执行端"
            : attention.active
              ? "已有待领取或正在执行的运行，不能重复派发"
              : attention.confirmationPending ||
                  run?.reviewStatus === "pending_user"
                ? "请先批准执行或审核结果"
                : run?.state === "partial"
                  ? "部分完成，请先明确剩余工作"
                  : t.state === "inbox"
                    ? "已在等待派发，无需重复提交"
                    : "仅已结束的失败或受阻任务可重新派发",
        conversationKind: taskProjects.get(t.taskId) ? "project" : "temporary",
        canRestore: attention.handled,
        canReconcile: attention.canReconcile,
        confirmationPending: attention.confirmationPending,
        stateLabel: manual
          ? manual.materials === "pending"
            ? `已完成 · ${materialsLabel}`
            : "已完成 · 人工确认"
          : cancelled && attention.uncertain
            ? "取消待核实"
            : attention.confirmationPending
              ? "待批准执行"
              : run?.reviewStatus === "pending_user" && !cancelled
                ? "待审核结果"
                : t.state === "inbox" && dispatch?.state === "inbox"
                  ? "待派发"
                  : run?.state === "queued"
                    ? "待领取"
                    : null,
        runStatus:
          run?.state === "cancelled"
            ? "cancelled"
            : run?.state === "succeeded"
              ? "done"
              : run?.state === "running"
                ? "running"
                : [
                      "failed",
                      "cancelled",
                      "partial",
                      "uncertain",
                      "blocked",
                    ].includes(run?.state || "")
                  ? "error"
                  : "queued",
        resultStatus: report
          ? manual
            ? materialsStatus === "received"
              ? "review"
              : "done"
            : run?.reviewStatus === "pending_user" && !cancelled
              ? "review"
              : run?.state === "succeeded"
                ? "done"
                : "error"
          : "queued",
        runState: run?.state ?? null,
        node: run?.route?.nodeId || (run?.observationOnly ? "来源执行（仅观察）" : "待选择执行端"),
        model: run?.route?.model || (run?.observationOnly ? "来源未声明" : "待选择"),
        effort: run?.route?.reasoningEffort || "默认",
        report:
          report?.body ||
          (() => {
            const settled = data.events.findLast(
              (event) =>
                event.runId === run?.runId && event.type === "run.settled",
            );
            const detail = settled?.detail;
            const summary =
              detail && typeof detail === "object" && !Array.isArray(detail)
                ? detail.summary
                : undefined;
            return typeof summary === "string"
              ? `执行回执：${summary}`
              : "尚未收到执行报告";
          })(),
        reportId: report?.reportId || null,
        artifact: report?.title || "等待执行报告",
        time: t.updatedAt,
        run: run?.runId || "待创建",
        nativeState: t.state,
        dispatchState: dispatch?.state ?? null,
        recommendation: dispatch ? JSON.parse(dispatch.candidates) : [],
        candidateChecks: dispatch ? JSON.parse(dispatch.attempted) : [],
        reviewStatus: run?.reviewStatus || null,
      };
    });
    // Explicit public views only. Never expose Run.configuration or provider credentials.
    return {
      settings: this.settings(),
      viewContext: {role:"planner",scope:"all",nodeId:this.nodeId,observedAt:data.generatedAt},
      projectCollaborations,
      projectRegistrations: (data.projectRegistrations ?? []).map(r => ({
        registrationId:r.registrationId,projectId:r.projectId,namespace:r.namespace,mode:r.mode,
        sourceRevision:r.sourceRevision,observedAt:r.observedAt,staleAfterMs:r.staleAfterMs,
        origin:{harness:r.origin.harness},central:r.central,
        unknownOriginalTimes:r.packet.project.createdAt===null,
        sourceAcceptance:r.packet.outcomes.map(o=>({title:o.title,acceptance:o.acceptance})),
        artifactAvailability:r.packet.artifacts.map(a=>({uri:a.uri,availability:a.availability})),
      })),
      attempts: (data.attempts ?? []).map(a=>({attemptId:a.attemptId,taskId:a.taskId,runId:a.runId,nodeId:a.nodeId,fence:a.fence,state:a.state,sessionId:a.sessionId,executionId:a.executionId})),
      projects,
      tasks,
      nodes: this.ledger.nodeStatuses().map((n) => ({
        nodeId: n.nodeId,
        state: n.state,
        availableSlots: n.availableSlots ?? null,
      })),
      runs: data.runs.map((r) => {
        // Only this Run's current attempt result carries executor diagnostics.
        // Notes, older attempts and historical source reports cannot claim a live runtime.
        const candidate = !r.observationOnly && r.route?.backend
          ? data.reports.findLast(report => report.runId === r.runId && report.attemptId === r.currentAttemptId && report.kind === "result")?.data
          : undefined;
        const evidence = candidate && typeof candidate === "object" && !Array.isArray(candidate) && candidate.backend === r.route?.backend ? candidate : {};
        const diagnostic = (key: string) => typeof evidence[key] === "string" && evidence[key].length <= 256 ? evidence[key] : null;
        return {
        runtimeVersion: diagnostic("cliVersion"),
        runtimeSource: diagnostic("cliSource"),
        actualModel: diagnostic("verifiedModel"),
        actualReasoningEffort: diagnostic("verifiedReasoningEffort"),
        productThreadId: diagnostic("productThreadId"),
        id: r.runId,
        parentRunId:r.parentRunId ?? null,
        parentTaskId:data.tasks.find(t=>t.taskId===r.taskId)?.parentTaskId ?? null,
        outcome:r.outcome ?? null,
        observationOnly:!!r.observationOnly,
        executionDriver:(r.observationOnly ? "source" : r.route?.backend ? "official-codex" : "dsh"),
        reasoningEffort:r.route?.reasoningEffort ?? null,
        sessionIds:r.sessionIds,
        taskId: r.taskId,
        state: r.state,
        node: r.route?.nodeId || null,
        model: r.route?.model || null,
        reviewStatus: r.reviewStatus ?? null,
      }; }),
      reports: data.reports.map((r) => ({
        id: r.reportId,
        taskId: r.taskId,
        runId: r.runId,
        title: r.title,
        body: r.body,
      })),
      artifacts: wb.artifacts.map((a) => ({ id: a.artifactId, ...a })),
      milestones: wb.milestones,
      schedules: (data.schedules ?? []).map((s) => ({
        scheduleId: s.scheduleId,
        enabled: s.enabled,
      })),
      sampledAt: now(),
    };
  }
  /** Central authority projection: authenticated peer selects its own node scope. */
  snapshotForNode(nodeId: string) {
    const all = this.snapshot(), raw = this.ledger.snapshot(), wb = this.workbench.snapshot();
    const projectIds = new Set(wb.projectWorkspaces.filter(w=>w.nodeId===nodeId).map(w=>w.projectId));
    for (const c of all.projectCollaborations) if (c.ownerNodeId === nodeId) projectIds.add(c.projectId);
    const ownedProjects = new Set(all.projectCollaborations.filter(c => c.ownerNodeId === nodeId).map(c => c.projectId));
    const workspaceIds = new Set((raw.workspaces ?? []).filter(w=>w.nodeId===nodeId).map(w=>w.workspaceId));
    const ids = new Set<string>();
    for (const t of all.tasks) if (ownedProjects.has(t.project)) ids.add(t.id);
    for(const r of raw.runs) if(r.route?.nodeId===nodeId) ids.add(r.taskId);
    for(const a of raw.attempts ?? []) if(a.nodeId===nodeId) ids.add(a.taskId);
    for(const t of raw.tasks) if(t.workspaceId && workspaceIds.has(t.workspaceId)) ids.add(t.taskId);
    let changed=true;
    while(changed){changed=false;for(const t of raw.tasks)if(t.parentTaskId&&ids.has(t.parentTaskId)&&!ids.has(t.taskId)){ids.add(t.taskId);changed=true;}}
    // Ancestors supply context, without granting visibility into unrelated sibling branches.
    for(const taskId of [...ids]){let t=raw.tasks.find(t=>t.taskId===taskId);const seen=new Set<string>();while(t?.parentTaskId&&!seen.has(t.parentTaskId)){seen.add(t.parentTaskId);ids.add(t.parentTaskId);t=raw.tasks.find(x=>x.taskId===t!.parentTaskId);}}
    const tasks=all.tasks.filter(t=>ids.has(t.id)).map(t=>({...t,canHandle:false,canConfirm:false,canComplete:false,canRequestMaterials:false,canCancel:false,canRetry:false,canRestore:false,canReconcile:false,canRequestStatus:false}));
    for(const t of tasks)if(t.project!=="unassigned")projectIds.add(t.project);
    const runs=all.runs.filter(r=>ids.has(r.taskId)),runIds=new Set(runs.map(r=>r.id));
    return {...all,settings:{enabled:false},projects:all.projects.filter(p=>projectIds.has(p.id)).map(p=>({...p,canChat:false,sessionId:null})),tasks,runs,
      attempts:all.attempts.filter(a=>runIds.has(a.runId)),reports:all.reports.filter(r=>ids.has(r.taskId)),
      artifacts:all.artifacts.filter(a=>a.taskId&&ids.has(a.taskId)),milestones:all.milestones.filter(m=>projectIds.has(m.projectId)),schedules:[],
      projectCollaborations:all.projectCollaborations.filter(c=>c.ownerNodeId===nodeId),
      projectRegistrations:all.projectRegistrations.filter(r=>projectIds.has(r.projectId)),
      nodes:all.nodes.filter(n=>n.nodeId===nodeId||runs.some(r=>r.node===n.nodeId)),
      viewContext:{role:"executor",scope:"node",nodeId,observedAt:all.sampledAt},
    };
  }
  async close() {
    this.accepting = false;
    await Promise.allSettled([...this.creations.values()].map((j) => j.done));
    for (const job of this.jobs.values()) job.abort.abort();
    await Promise.allSettled([...this.jobs.values()].map((j) => j.done));
  }
}
