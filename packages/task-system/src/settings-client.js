/* Official DSH browser-half protocol; dependencies come from its shared platform. */
window.__ModuleLoader__.load({
  id: "@dsh-task/task-system",
  factory(require) {
    const React = require("react");
    const {
      SettingsForm,
      SettingsFormModel,
      SettingsValueField,
      Switch,
      Button,
    } = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = React.createElement;
    const keys = [
      "schedulerEnabled",
      "autoExecute",
      "maxConcurrent",
      "executionTimeoutMs",
      "healthAlerts",
      "localHeartbeatIntervalMs",
    ];
    const ranges = {
      maxConcurrent: [1, 32],
      executionTimeoutMs: [100, 86400000],
      localHeartbeatIntervalMs: [100, 3600000],
    };
    const booleanKeys = new Set([
      "schedulerEnabled",
      "autoExecute",
      "healthAlerts",
    ]);
    const NS = "taskPluginSettings";
    const en = {
      startupEditable: "Role, workspace and scheduler connection",
      startupTask: "Task-service startup settings",
      startupRemote: "Existing scheduler connection",
      startupSave: "Save and restart plugin",
      startupSaving: "Saving and restarting…",
      startupSaved: "Saved; current configuration was read again.",
      startupSaveFailed:
        "Save or configuration read could not be confirmed. Refresh to check; your draft is retained. Running work or a changed configuration may block this save.",
      startupReadFailed:
        "Could not read editable startup settings. Refresh to retry.",
      startupRefresh: "Refresh startup settings",
      startupUnavailable: "This profile has no editable task-service entry.",
      startupReadonly:
        "This Host does not allow startup edits from this connection.",
      startupRestartHint:
        "Startup edits use a separate save. Saving restarts the affected plugin; it does not restart DSH. Identity, credentials and remote permissions stay under their existing owners.",
      startupUnconfigured:
        "No existing authenticated scheduler connection is configured. Set up an authorized connection through the official secure configuration flow before editing it here.",
      startupEndpointHint:
        "For an existing trusted-network connection, the endpoint must match the exact target address and port. Connection changes are blocked while work is active, claimed or uncertain.",
      startupMigration: "Save and restart: enable Task session protocol",
      startupMigrationHint:
        "Upgrade only after this existing peer has been explicitly granted executorIdentity, sessionContext and selectTaskSession. This action does not grant those permissions.",
      startupInvalid: "Enter valid values before saving.",
      audience: "Scheduler audience",
      targetAddress: "Trusted target address",
      targetPort: "Trusted target port",
      targetLocalAddress: "Local connection address",
      discardDraft: "Discard draft",
      title: "Task system",
      summary: "Local runtime settings and read-only deployment details.",
      runtime: "Local runtime",
      safety:
        "These controls affect the local task-system service. Remote work polling is independent: turning off local automatic execution does not pause remote claims or stop running tasks.",
      schedulerEnabled: "Admit due schedules locally",
      schedulerEnabledHint:
        "Queues due schedules on this planner; it does not itself execute a workload. Off does not cancel already queued runs.",
      autoExecute: "Automatically execute the local queue",
      autoExecuteHint:
        "Admits queued local runs on the next maintenance tick. Remote polling and configured safe retries are separate; this is not a node-wide pause.",
      maxConcurrent: "Local automatic-execution limit",
      maxConcurrentHint:
        "Maximum admissions by the local automatic runner. Existing node capacity and task policies may impose a lower limit; remote-worker concurrency is separate.",
      executionTimeoutMs: "Native execution budget (ms)",
      executionTimeoutMsHint:
        "Used when a new native attempt starts, including attempts claimed remotely. A running attempt keeps its existing timer; task policy may impose a shorter budget.",
      healthAlerts: "Reconcile node-health alerts",
      healthAlertsHint:
        "Runs planner-side health reconciliation during maintenance. It does not change alert destinations.",
      localHeartbeatIntervalMs: "Local ledger heartbeat interval (ms)",
      localHeartbeatIntervalMsHint:
        "Sampled at maintenance ticks for the configured local node. This is not the remote coordinator heartbeat interval.",
      commandLineConfigOverride: "Command-line config override",
      homePatch: "Home-level patch",
      overlayWarning:
        "A command-line layer replaces this task-system config. Saves are blocked by the Host. Move the entire task-system config into this isolated profile before editing; keep the original safety values unchanged.",
      homeWarning:
        "A home-level patch exists. If it overrides task-system.config, it takes precedence and the Host refuses saves. The profile path below is the save destination.",
      deployment: "Current deployment · read only",
      startupHint:
        "This section shows effective startup settings. Role, workspace and existing connection changes use the separate startup form. Identity, database paths, tool permissions and credentials remain read only.",
      nodeId: "Internal node ID",
      schedulerId: "Scheduler ID",
      executorId: "Assigned executor ID",
      identityTitle: "Scheduler-bound executor identity · read only",
      identityHint:
        "The scheduler assigns a stable executor ID to an already authorized peer. A connection to another scheduler has its own identity; this page does not edit IDs or grant access.",
      identityNone: "No scheduler-confirmed executor identity is available.",
      rolePlanner: "Scheduler",
      roleExecutor: "Executor",
      roleBoth: "Scheduler and executor",
      workspaceTitle: "Sessions and workspace",
      defaultWorkspaceId: "Default workspace ID",
      sessionDecisionEnabled: "Use session/workspace decisions",
      workspaceHint:
        "The default workspace must already be registered locally. Changes apply after restart. Without a valid decision, execution uses the default Task session and workspace policy.",
      decisionHint:
        "Decision adapters reuse @dsh-task/typed-decisions: DSH LLM, Typesafe Jev, or a registered AnyJev adapter. Configure the existing typed-decisions profile entry; this page does not create provider credentials.",
      settingsPending:
        "This Host has not loaded the session/workspace settings interface yet.",
      queueTitle: "Local task queue · read only",
      queueHint:
        "Runs recorded for this local node. Refresh only reads the queue; it does not claim, execute or cancel work.",
      queueLoading: "Reading the local queue…",
      queueFailed:
        "Could not read the local queue. Refresh to retry; an unavailable queue is not an empty queue.",
      queueRefresh: "Refresh local queue",
      queueEmpty: "No pending local runs were recorded at this sample.",
      queueSampledAt: "Sampled at",
      queueTruncated: "The result is bounded. Additional runs are not shown.",
      queueTask: "Task / Run",
      queueState: "State",
      sessionId: "Session ID",
      workspaceId: "Workspace ID",
      stateQueued: "Queued",
      stateRunning: "Running",
      stateBlocked: "Blocked",
      stateUncertain: "Uncertain",
      queryIdentity: "Query my executor ID from the scheduler",
      identityFailed:
        "Could not confirm the executor identity. Check the existing scheduler connection and its explicit authorization; no access was granted.",
      role: "Role",
      databasePath: "Task database",
      profilePatch: "Profile configuration",
      keepAlive: "Maintenance enabled",
      maintenanceIntervalMs: "Maintenance tick (ms)",
      leaseTtlMs: "Lease TTL (ms)",
      executionTools: "Execution-tool allowlist",
      remoteTitle: "Remote worker · read only",
      remoteNone: "No remote-execution service is loaded in this profile.",
      endpoint: "Coordinator endpoint",
      pollIntervalMs: "Remote poll interval (ms)",
      concurrency: "Remote-worker concurrency",
      polling: "Automatic remote polling",
      authMode: "Authentication mode",
      taskSessionsEnabled: "Task session protocol enabled",
      taskSessionHint:
        "Existing connections retain their current session protocol until an explicit authorized migration. This page does not upgrade permissions.",
      remoteHint:
        "Automatic remote polling is controlled by task-remote-execution.pollIntervalMs: 0 disables polling after restart. Already claimed work and direct/manual dispatch are separate. This page has no remote-pause switch.",
      loading: "Reading current deployment…",
      loadFailed:
        "Could not read deployment details. Retry; no values were changed.",
      refresh: "Refresh deployment details",
      none: "Not configured",
      yes: "On",
      no: "Off",
      overridden: "Overridden",
      reset: "Reset to default",
      invalidNumber:
        "Enter a whole number in the allowed range, or leave blank to reset.",
      unavailable:
        "The task-system entry is not loaded or this profile does not expose editable settings.",
      readOnly: "This deployment exposes read-only settings.",
      save: "Save",
      saving: "Saving…",
      saveFailed:
        "The Host rejected the save: values may be invalid, stale, or overridden by a home/command-line config layer. Your edits are retained; check the deployment details and reload this page for current values.",
      savedHint:
        "Edits are staged until Save. Leaving this page discards unsaved changes. Saved runtime settings persist in this profile and do not restart the task service.",
    };
    const zh = {
      startupEditable: "角色、工作区与调度端连接",
      startupTask: "任务服务启动配置",
      startupRemote: "已有调度端连接",
      startupSave: "保存并重启插件",
      startupSaving: "保存并重启中…",
      startupSaved: "已保存，并已重新读取当前配置。",
      startupSaveFailed:
        "未能确认保存或重新读取，请刷新核对；草稿已保留。运行中的工作或已变化的配置可能阻止保存。",
      startupReadFailed: "未能读取可编辑启动配置，请刷新重试。",
      startupRefresh: "刷新启动配置",
      startupUnavailable: "此 profile 没有可编辑的任务服务条目。",
      startupReadonly: "当前宿主不允许通过此连接编辑启动配置。",
      startupRestartHint:
        "启动配置单独保存；保存会重启受影响的插件，不会重启 DSH。身份、凭据和远端权限由原配置流程管理。",
      startupUnconfigured:
        "尚未配置已有认证的调度端连接。请先通过官方安全配置流程登记已授权连接，再在此编辑。",
      startupEndpointHint:
        "已有 trusted-network 连接的调度端地址须与精确目标地址和端口一致。存在运行中、已领取或状态未确认的工作时不能改变连接。",
      startupMigration: "保存并重启：启用 Task 会话协议",
      startupMigrationHint:
        "仅在此已有 peer 已获 executorIdentity、sessionContext、selectTaskSession 明确授权后升级。此操作不会授予这些权限。",
      startupInvalid: "请先填写有效值再保存。",
      audience: "调度端受众标识（audience）",
      targetAddress: "已授权目标地址",
      targetPort: "已授权目标端口",
      targetLocalAddress: "本机连接地址",
      discardDraft: "丢弃草稿",
      title: "任务系统",
      summary: "管理本机运行设置，查看当前部署与远程领取配置。",
      runtime: "本机运行设置",
      safety:
        "这些开关只控制本机 task-system 服务。远程轮询独立运行：关闭本机自动执行不会暂停远程领取，也不会停止正在运行的任务。",
      schedulerEnabled: "接收本机到期计划",
      schedulerEnabledHint:
        "由规划节点把到期计划加入队列，不等于执行任务。关闭后，已排队的运行不会被取消。",
      autoExecute: "自动执行本机队列",
      autoExecuteHint:
        "在下一次维护轮询时接收本机待执行运行。远程领取及已配置的安全重试独立工作；这不是整个节点的暂停按钮。",
      maxConcurrent: "本机自动执行并发上限",
      maxConcurrentHint:
        "只限制本机自动执行器的接收数量。节点容量和任务策略仍可能更严格；远程执行器的并发独立配置。",
      executionTimeoutMs: "原生执行预算（毫秒）",
      executionTimeoutMsHint:
        "新原生尝试开始时读取，包括远程领取的尝试。已运行尝试保留原计时器；任务策略可设置更短预算。",
      healthAlerts: "检查节点健康告警",
      healthAlertsHint:
        "由规划节点在维护轮询中检查健康状态，不改变告警接收位置。",
      localHeartbeatIntervalMs: "本地账本心跳间隔（毫秒）",
      localHeartbeatIntervalMsHint:
        "维护轮询按此间隔记录已配置本机节点的心跳，不是向远端协调器发送心跳的间隔。",
      commandLineConfigOverride: "命令行 config 覆写",
      homePatch: "Home 级配置文件",
      overlayWarning:
        "当前命令行覆盖层替换了 task-system 的 config，宿主会拒绝保存。请先把完整 task-system 配置移入这个独立 profile，保留原安全值；只删掉覆盖层中的几个字段无效。",
      homeWarning:
        "检测到 Home 级配置文件。如其中覆写 task-system.config，其优先级高于 profile，宿主会拒绝保存。下方 profile 路径是正常保存位置。",
      deployment: "当前部署 · 只读",
      startupHint:
        "以下显示实际启动配置。角色、工作区和已有连接由独立启动表单保存；节点身份、数据库路径、工具授权和凭据仍为只读。",
      nodeId: "内部节点 ID",
      schedulerId: "调度端 ID",
      executorId: "调度端分配的执行端 ID",
      identityTitle: "调度端绑定的执行端身份 · 只读",
      identityHint:
        "调度端为已授权的执行端分配固定 ID。连接到不同调度端使用各自的身份；此页不编辑 ID，也不授予访问权限。",
      identityNone: "尚无调度端确认的执行端身份。",
      rolePlanner: "调度端",
      roleExecutor: "执行端",
      roleBoth: "调度端和执行端",
      workspaceTitle: "会话与工作区",
      defaultWorkspaceId: "默认工作区 ID",
      sessionDecisionEnabled: "使用会话／工作区决策",
      workspaceHint:
        "默认工作区须已在本机登记；改变后重启生效。没有有效决策时，执行采用默认的 Task 会话和工作区策略。",
      decisionHint:
        "决策复用 @dsh-task/typed-decisions：普通 DSH LLM、Typesafe Jev 或已注册的 AnyJev adapter。请配置已有 typed-decisions profile 条目；此页不新建 provider 凭据。",
      settingsPending: "当前宿主尚未加载会话／工作区设置接口。",
      queueTitle: "本机任务队列 · 只读",
      queueHint:
        "查看当前宿主记录的本机运行。刷新只读取队列，不领取、执行或取消任务。",
      queueLoading: "正在读取本机队列…",
      queueFailed: "未能读取本机队列，请刷新重试；接口不可用不表示队列为空。",
      queueRefresh: "刷新本机队列",
      queueEmpty: "本次读取没有待处理的本机运行。",
      queueSampledAt: "读取时间",
      queueTruncated: "返回数量有限，另有运行未显示。",
      queueTask: "任务／运行",
      queueState: "状态",
      sessionId: "会话 ID",
      workspaceId: "工作区 ID",
      stateQueued: "已排队",
      stateRunning: "运行中",
      stateBlocked: "已阻塞",
      stateUncertain: "状态未确认",
      queryIdentity: "向调度端查询本机执行端 ID",
      identityFailed:
        "未能确认执行端身份。请检查现有调度端连接及明确授权；没有授予任何新权限。",
      role: "角色",
      databasePath: "任务数据库",
      profilePatch: "Profile 配置文件",
      keepAlive: "维护轮询",
      maintenanceIntervalMs: "维护轮询间隔（毫秒）",
      leaseTtlMs: "租约时长（毫秒）",
      executionTools: "允许的执行工具",
      remoteTitle: "远程执行器 · 只读",
      remoteNone: "当前 profile 未加载远程执行服务。",
      endpoint: "协调器地址",
      pollIntervalMs: "远程领取间隔（毫秒）",
      concurrency: "远程执行并发",
      polling: "自动远程领取",
      authMode: "认证方式",
      taskSessionsEnabled: "Task 会话协议已启用",
      taskSessionHint:
        "旧连接继续使用原会话流程；显式授权迁移后才能升级。此页不扩展远端授权。",
      remoteHint:
        "自动远程领取由 task-remote-execution.pollIntervalMs 控制：设为 0 并重启后停用轮询。已领取任务与直接／手动派发独立处理。此页没有远程暂停开关。",
      loading: "正在读取当前部署…",
      loadFailed: "未能读取部署详情，请重试；没有修改任何配置。",
      refresh: "刷新部署详情",
      none: "未配置",
      yes: "开启",
      no: "关闭",
      overridden: "已覆盖",
      reset: "恢复默认",
      invalidNumber: "请填写范围内的整数；留空表示恢复默认。",
      unavailable: "任务系统条目未加载，或此 profile 未提供可编辑设置。",
      readOnly: "当前部署的设置只读。",
      save: "保存",
      saving: "保存中…",
      saveFailed:
        "保存被拒绝：值可能无效、已在别处更改，或被 Home／命令行 config 覆写。已保留你的编辑；请检查部署详情，重新进入本页可读取最新值。",
      savedHint:
        "修改仅在点击保存后生效。离开页面会丢弃未保存修改；已保存的运行设置写入当前 profile，不会重启任务服务。",
    };
    function fieldSpec(field) {
      return {
        field,
        format: (value) => (value === undefined ? "" : String(value)),
        parse(text) {
          if (text === "") return { kind: "clear" };
          if (booleanKeys.has(field))
            return text === "true" || text === "false"
              ? { kind: "set", value: text === "true" }
              : undefined;
          const n = Number(text),
            [min, max] = ranges[field];
          return text.trim() !== "" &&
            Number.isSafeInteger(n) &&
            n >= min &&
            n <= max
            ? { kind: "set", value: n }
            : undefined;
        },
      };
    }
    class Controller {
      constructor(scope) {
        this.form = new SettingsFormModel(scope, keys.map(fieldSpec));
        this.store = this.form.bind(() => ({
          ...this.form.shell(),
          fields: Object.fromEntries(
            keys.map((key) => [key, this.form.field(key)]),
          ),
        }));
      }
      inject() {
        return { hooks: { taskSettings: this.store }, ...this.form.actions() };
      }
      dispose() {
        this.form.dispose();
      }
    }
    const descriptor = {
      id: "@dsh-task/task-system#taskPluginSettings/describe",
      service: "taskPluginSettings",
      namespace: "taskPluginSettings",
      method: "describe",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "@dsh-task/task-system#ReadonlySettings",
        create: () => ({
          parse(value) {
            if (
              !value ||
              typeof value.nodeId !== "string" ||
              typeof value.databasePath !== "string" ||
              !["planner", "executor", "both"].includes(value.role)
            )
              throw new Error("Invalid task settings snapshot");
            return value;
          },
        }),
      },
    };
    const queueDescriptor = {
      id: "@dsh-task/task-system#taskPluginSettings/queue",
      service: "taskPluginSettings",
      namespace: "taskPluginSettings",
      method: "queue",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "@dsh-task/task-system#QueueSnapshot",
        create: () => ({
          parse(value) {
            if (
              !value ||
              typeof value.nodeId !== "string" ||
              typeof value.sampledAt !== "string" ||
              !Array.isArray(value.items) ||
              typeof value.truncated !== "boolean" ||
              value.items.some(
                (item) =>
                  !item ||
                  ["taskId", "runId", "title", "state"].some(
                    (key) => typeof item[key] !== "string",
                  ) ||
                  ["sessionId", "workspaceId"].some(
                    (key) =>
                      item[key] !== null && typeof item[key] !== "string",
                  ),
              )
            )
              throw new Error("Invalid local task queue snapshot");
            return value;
          },
        }),
      },
    };
    const executorIdentityDescriptor = {
      id: "@dsh-task/task-system#taskPluginSettings/executorIdentity",
      service: "taskPluginSettings",
      namespace: "taskPluginSettings",
      method: "executorIdentity",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "@dsh-task/task-system#ExecutorIdentity",
        create: () => ({
          parse(value) {
            if (
              !value ||
              ["schedulerId", "executorId", "nodeId"].some(
                (key) => typeof value[key] !== "string",
              )
            )
              throw new Error("Invalid executor identity");
            return value;
          },
        }),
      },
    };
    const hintStyle = {
      color: "var(--dsw-text-secondary)",
      fontSize: 13,
      lineHeight: 1.65,
      margin: "5px 0 12px",
    };
    const headingStyle = {
      fontSize: 16,
      fontWeight: 600,
      margin: "24px 0 12px",
    };
    function useReadSnapshot(read, automatic = true) {
      const [state, setState] = React.useState({ loading: automatic });
      const generation = React.useRef(0);
      const refresh = React.useCallback(() => {
        const current = ++generation.current;
        setState((old) => ({ ...old, loading: true, failed: false }));
        Promise.resolve()
          .then(read)
          .then(
            (value) => {
              if (generation.current === current)
                setState({ value, loading: false });
            },
            (error) => {
              if (generation.current === current)
                setState((old) => ({
                  ...old,
                  loading: false,
                  failed: true,
                  errorCode:
                    typeof error?.code === "string" &&
                    /^[a-z0-9_/-]{1,100}$/i.test(error.code)
                      ? error.code
                      : null,
                }));
            },
          );
      }, [read]);
      React.useEffect(() => {
        if (automatic) refresh();
        return () => {
          generation.current++;
        };
      }, [refresh, automatic]);
      return {
        state,
        refresh,
        replace(value) {
          generation.current++;
          setState({ value, loading: false });
        },
      };
    }
    function ReadOnly({ t, read, queryIdentity }) {
      const { state, refresh } = useReadSnapshot(read);
      const fields = (value, names) =>
        h(
          "dl",
          { style: { margin: 0 } },
          ...names.map((key) =>
            h(
              "div",
              {
                key,
                style: {
                  display: "grid",
                  gridTemplateColumns: "minmax(130px, 1fr) minmax(0, 2fr)",
                  gap: 16,
                  padding: "8px 0",
                  borderBottom: "1px solid var(--dsw-border)",
                },
              },
              h("dt", { style: hintStyle }, t(key)),
              h(
                "dd",
                {
                  style: {
                    margin: 0,
                    fontSize: 13,
                    overflowWrap: "anywhere",
                    whiteSpace: "pre-wrap",
                  },
                  "data-setting": key,
                },
                key === "role"
                  ? t(
                      {
                        planner: "rolePlanner",
                        executor: "roleExecutor",
                        both: "roleBoth",
                      }[value[key]],
                    )
                  : typeof value[key] === "boolean"
                    ? t(value[key] ? "yes" : "no")
                    : Array.isArray(value[key])
                      ? value[key].join(", ") || t("none")
                      : (value[key] ?? t("none")),
              ),
            ),
          ),
        );
      return h(
        "section",
        null,
        h("h3", { style: headingStyle }, t("deployment")),
        h("p", { style: hintStyle }, t("startupHint")),
        state.loading && !state.value
          ? h("p", { role: "status" }, t("loading"))
          : null,
        state.failed
          ? h(
              "p",
              { role: "alert" },
              t("loadFailed"),
              state.errorCode ? ` (${state.errorCode})` : "",
            )
          : null,
        state.value
          ? h(
              React.Fragment,
              null,
              state.value.commandLineConfigOverride
                ? h(
                    "p",
                    { role: "alert", style: hintStyle },
                    t("overlayWarning"),
                  )
                : null,
              state.value.homePatch
                ? h("p", { role: "note", style: hintStyle }, t("homeWarning"))
                : null,
              fields(state.value, [
                "commandLineConfigOverride",
                "homePatch",
                "nodeId",
                "role",
                "databasePath",
                "profilePatch",
                "keepAlive",
                "maintenanceIntervalMs",
                "leaseTtlMs",
                "executionTools",
              ]),
              Object.hasOwn(state.value, "schedulerId")
                ? fields(state.value, ["schedulerId"])
                : null,
              h("h3", { style: headingStyle }, t("identityTitle")),
              h("p", { style: hintStyle }, t("identityHint")),
              h(ExecutorIdentity, {
                key: `${state.value.remote?.endpoint ?? "none"}:${state.value.remote?.executorIdentity?.schedulerId ?? "unresolved"}`,
                t,
                fields,
                remote: state.value.remote,
                queryIdentity,
              }),
              h("h3", { style: headingStyle }, t("workspaceTitle")),
              Object.hasOwn(state.value, "defaultWorkspaceId") &&
                Object.hasOwn(state.value, "sessionDecisionEnabled")
                ? fields(state.value, [
                    "defaultWorkspaceId",
                    "sessionDecisionEnabled",
                  ])
                : h("p", { style: hintStyle }, t("settingsPending")),
              h("p", { style: hintStyle }, t("workspaceHint")),
              h("p", { style: hintStyle }, t("decisionHint")),
              h("h3", { style: headingStyle }, t("remoteTitle")),
              state.value.remote
                ? fields(state.value.remote, [
                    "nodeId",
                    "role",
                    "endpoint",
                    "polling",
                    "pollIntervalMs",
                    "concurrency",
                    "authMode",
                  ])
                : h("p", { style: hintStyle }, t("remoteNone")),
              state.value.remote &&
                Object.hasOwn(state.value.remote, "taskSessionsEnabled")
                ? fields(state.value.remote, ["taskSessionsEnabled"])
                : null,
              h("p", { style: hintStyle }, t("taskSessionHint")),
              h("p", { style: hintStyle }, t("remoteHint")),
            )
          : null,
        h(
          Button,
          { variant: "outline", onClick: refresh, disabled: state.loading },
          t("refresh"),
        ),
      );
    }
    function ExecutorIdentity({ t, fields, remote, queryIdentity }) {
      // Query only on the explicit button. It neither polls nor upgrades grants.
      const { state, refresh } = useReadSnapshot(queryIdentity, false);
      const value = state.value ?? remote?.executorIdentity;
      return h(
        React.Fragment,
        null,
        value
          ? fields(value, ["schedulerId", "executorId"])
          : h("p", { style: hintStyle }, t("identityNone")),
        state.failed
          ? h(
              "p",
              { role: "alert" },
              t("identityFailed"),
              state.errorCode ? ` (${state.errorCode})` : "",
            )
          : null,
        h(
          Button,
          {
            variant: "outline",
            disabled: !remote?.endpoint || state.loading,
            onClick: refresh,
          },
          t("queryIdentity"),
        ),
      );
    }
    function QueueContents({ t, value }) {
      const cellStyle = {
        textAlign: "left",
        padding: "8px 12px",
        borderBottom: "1px solid var(--dsw-border)",
        verticalAlign: "top",
        overflowWrap: "anywhere",
      };
      return h(
        React.Fragment,
        null,
        h(
          "p",
          { style: hintStyle },
          `${t("nodeId")}: ${value.nodeId} · ${t("queueSampledAt")}: ${value.sampledAt}`,
        ),
        value.items.length === 0
          ? h("p", { role: "status" }, t("queueEmpty"))
          : h(
              "div",
              { style: { overflowX: "auto" } },
              h(
                "table",
                {
                  style: {
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 13,
                  },
                },
                h(
                  "thead",
                  null,
                  h(
                    "tr",
                    null,
                    ...[
                      "queueTask",
                      "queueState",
                      "sessionId",
                      "workspaceId",
                    ].map((key) =>
                      h("th", { key, scope: "col", style: cellStyle }, t(key)),
                    ),
                  ),
                ),
                h(
                  "tbody",
                  null,
                  ...value.items.map((item) =>
                    h(
                      "tr",
                      { key: item.runId, "data-queue-run": item.runId },
                      h(
                        "td",
                        { style: cellStyle },
                        h("strong", null, item.title),
                        h(
                          "div",
                          { style: hintStyle },
                          `${item.taskId} / ${item.runId}`,
                        ),
                      ),
                      h(
                        "td",
                        { style: cellStyle },
                        {
                          queued: "stateQueued",
                          running: "stateRunning",
                          blocked: "stateBlocked",
                          uncertain: "stateUncertain",
                        }[item.state]
                          ? t(
                              {
                                queued: "stateQueued",
                                running: "stateRunning",
                                blocked: "stateBlocked",
                                uncertain: "stateUncertain",
                              }[item.state],
                            )
                          : item.state,
                      ),
                      h(
                        "td",
                        { style: cellStyle },
                        item.sessionId ?? t("none"),
                      ),
                      h(
                        "td",
                        { style: cellStyle },
                        item.workspaceId ?? t("none"),
                      ),
                    ),
                  ),
                ),
              ),
            ),
        value.truncated
          ? h("p", { role: "status", style: hintStyle }, t("queueTruncated"))
          : null,
      );
    }
    function LocalQueue({ t, readQueue }) {
      const { state, refresh } = useReadSnapshot(readQueue);
      return h(
        "section",
        { "data-task-local-queue": true },
        h("h3", { style: headingStyle }, t("queueTitle")),
        h("p", { style: hintStyle }, t("queueHint")),
        state.loading && !state.value
          ? h("p", { role: "status" }, t("queueLoading"))
          : null,
        state.failed
          ? h(
              "p",
              { role: "alert" },
              t("queueFailed"),
              state.errorCode ? ` (${state.errorCode})` : "",
            )
          : null,
        state.value ? h(QueueContents, { t, value: state.value }) : null,
        h(
          Button,
          { variant: "outline", onClick: refresh, disabled: state.loading },
          t("queueRefresh"),
        ),
      );
    }
    function startupDraft(target, values) {
      return target === "task"
        ? {
            role: values.role,
            defaultWorkspaceId: values.defaultWorkspaceId ?? "",
            sessionDecisionEnabled: values.sessionDecisionEnabled,
          }
        : {
            role: values.role,
            endpoint: values.endpoint ?? "",
            audience: values.audience ?? "",
            pollIntervalMs: String(values.pollIntervalMs),
            concurrency: String(values.concurrency),
            ...(values.trustedNetworkTarget
              ? {
                  targetAddress: values.trustedNetworkTarget.address,
                  targetPort: String(values.trustedNetworkTarget.port),
                  targetLocalAddress: values.trustedNetworkTarget.localAddress,
                }
              : {}),
          };
    }
    function startupChanges(target, values, draft, migrate = false) {
      const invalid = [],
        next = { role: draft.role };
      if (!["planner", "executor", "both"].includes(draft.role))
        invalid.push("role");
      if (target === "task") {
        next.defaultWorkspaceId =
          String(draft.defaultWorkspaceId).trim() || null;
        next.sessionDecisionEnabled = draft.sessionDecisionEnabled;
        if (typeof next.sessionDecisionEnabled !== "boolean")
          invalid.push("sessionDecisionEnabled");
      } else {
        next.endpoint = String(draft.endpoint).trim();
        next.audience = String(draft.audience).trim();
        if (!next.endpoint) invalid.push("endpoint");
        if (!next.audience) invalid.push("audience");
        for (const [key, min, max] of [
          ["pollIntervalMs", 100, 3600000],
          ["concurrency", 1, 16],
        ]) {
          next[key] = Number(draft[key]);
          if (
            String(draft[key]).trim() === "" ||
            !Number.isSafeInteger(next[key]) ||
            (key === "pollIntervalMs" && next[key] === 0
              ? false
              : next[key] < min || next[key] > max)
          )
            invalid.push(key);
        }
        if (values.trustedNetworkTarget) {
          const address = String(draft.targetAddress).trim(),
            localAddress = String(draft.targetLocalAddress).trim(),
            port = Number(draft.targetPort);
          if (!address) invalid.push("targetAddress");
          if (!localAddress) invalid.push("targetLocalAddress");
          if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
            invalid.push("targetPort");
          next.trustedNetworkTarget = {
            ...values.trustedNetworkTarget,
            address,
            port,
            localAddress,
          };
        }
        if (migrate) next.taskSessionsEnabled = true;
      }
      const changes = Object.fromEntries(
        Object.entries(next).filter(
          ([key, value]) =>
            JSON.stringify(value) !== JSON.stringify(values[key]),
        ),
      );
      return { changes, invalid, dirty: Object.keys(changes).length > 0 };
    }
    function StartupRow({ t, target, row, writable, saveStartup, onSaved }) {
      const [draft, setDraft] = React.useState(() =>
        startupDraft(target, row.values),
      );
      const [status, setStatus] = React.useState({ saving: false });
      const edit = (key, value) => {
        setDraft((old) => ({ ...old, [key]: value }));
        setStatus({ saving: false });
      };
      const parsed = startupChanges(target, row.values, draft);
      const disabled = !writable || status.saving;
      const save = async (migrate = false) => {
        const update = startupChanges(target, row.values, draft, migrate);
        if (disabled || !update.dirty || update.invalid.length) return;
        setStatus({ saving: true });
        try {
          await saveStartup({
            target,
            expected: row.values,
            changes: update.changes,
          });
          await onSaved();
          setStatus({ saving: false, saved: true });
        } catch (error) {
          setStatus({
            saving: false,
            failed: true,
            errorCode:
              typeof error?.code === "string" &&
              /^[a-z0-9_/-]{1,100}$/i.test(error.code)
                ? error.code
                : null,
          });
        }
      };
      const controlStyle = {
        width: "100%",
        boxSizing: "border-box",
        padding: "7px 10px",
        color: "var(--dsw-text-primary)",
        background: "var(--dsw-bg-secondary)",
        border: "1px solid var(--dsw-border)",
        borderRadius: 6,
      };
      const field = (key, label = key) =>
        h(
          "label",
          { key, style: { display: "block", margin: "12px 0" } },
          h("span", { style: { display: "block", marginBottom: 6 } }, t(label)),
          key === "role"
            ? h(
                "select",
                {
                  id: `task-startup-${target}-${key}`,
                  style: controlStyle,
                  value: draft[key],
                  disabled,
                  onChange: (event) => edit(key, event.target.value),
                },
                ...[
                  ["planner", "rolePlanner"],
                  ["executor", "roleExecutor"],
                  ["both", "roleBoth"],
                ].map(([value, text]) =>
                  h("option", { key: value, value }, t(text)),
                ),
              )
            : h("input", {
                id: `task-startup-${target}-${key}`,
                style: controlStyle,
                value: draft[key],
                disabled,
                "aria-invalid": parsed.invalid.includes(key),
                inputMode: [
                  "pollIntervalMs",
                  "concurrency",
                  "targetPort",
                ].includes(key)
                  ? "numeric"
                  : undefined,
                onChange: (event) => edit(key, event.target.value),
              }),
        );
      return h(
        "section",
        { "data-startup-target": target },
        h(
          "h4",
          { style: headingStyle },
          t(target === "task" ? "startupTask" : "startupRemote"),
        ),
        field("role"),
        target === "task"
          ? h(
              React.Fragment,
              null,
              field("defaultWorkspaceId"),
              h(
                "label",
                {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 20,
                    margin: "12px 0",
                  },
                },
                t("sessionDecisionEnabled"),
                h(Switch, {
                  label: t("sessionDecisionEnabled"),
                  checked: draft.sessionDecisionEnabled,
                  disabled,
                  onChange: (value) => edit("sessionDecisionEnabled", value),
                }),
              ),
              h("p", { style: hintStyle }, t("workspaceHint")),
              h("p", { style: hintStyle }, t("decisionHint")),
            )
          : h(
              React.Fragment,
              null,
              ...["endpoint", "audience", "pollIntervalMs", "concurrency"].map(
                (key) => field(key),
              ),
              row.values.trustedNetworkTarget
                ? h(
                    React.Fragment,
                    null,
                    ...[
                      "targetAddress",
                      "targetPort",
                      "targetLocalAddress",
                    ].map((key) => field(key)),
                  )
                : null,
              h("p", { style: hintStyle }, t("startupEndpointHint")),
              row.values.taskSessionsEnabled === false
                ? h(
                    React.Fragment,
                    null,
                    h("p", { style: hintStyle }, t("startupMigrationHint")),
                    h(
                      Button,
                      {
                        variant: "outline",
                        disabled: disabled || parsed.invalid.length > 0,
                        onClick: () => save(true),
                      },
                      t("startupMigration"),
                    ),
                  )
                : null,
            ),
        parsed.invalid.length
          ? h("p", { role: "alert" }, t("startupInvalid"))
          : null,
        status.failed
          ? h(
              "p",
              { role: "alert" },
              t("startupSaveFailed"),
              status.errorCode ? ` (${status.errorCode})` : "",
            )
          : null,
        status.saved ? h("p", { role: "status" }, t("startupSaved")) : null,
        h(
          "div",
          { style: { display: "flex", gap: 12, marginTop: 14 } },
          h(
            Button,
            {
              variant: "outline",
              disabled: disabled || !parsed.dirty || parsed.invalid.length > 0,
              onClick: () => save(),
            },
            t(status.saving ? "startupSaving" : "startupSave"),
          ),
          h(
            Button,
            {
              variant: "outline",
              disabled: disabled || !parsed.dirty,
              onClick: () => {
                setDraft(startupDraft(target, row.values));
                setStatus({ saving: false });
              },
            },
            t("discardDraft"),
          ),
        ),
      );
    }
    function StartupSettings({ t, startup, saveStartup, onSaved }) {
      const { state, refresh, replace } = useReadSnapshot(startup);
      const afterSave = async () => {
        // Clear the old connection summary before reading the new plugin state.
        onSaved();
        const value = await startup();
        replace(value);
      };
      return h(
        "section",
        { "data-task-startup-settings": true },
        h("h3", { style: headingStyle }, t("startupEditable")),
        h("p", { style: hintStyle }, t("startupRestartHint")),
        state.failed
          ? h(
              "p",
              { role: "alert" },
              t("startupReadFailed"),
              state.errorCode ? ` (${state.errorCode})` : "",
            )
          : null,
        state.loading && !state.value
          ? h("p", { role: "status" }, t("loading"))
          : null,
        state.value
          ? h(
              React.Fragment,
              null,
              !state.value.writable
                ? h("p", { role: "note" }, t("startupReadonly"))
                : null,
              state.value.task
                ? h(StartupRow, {
                    key:
                      state.value.task.entryId +
                      JSON.stringify(state.value.task.values),
                    t,
                    target: "task",
                    row: state.value.task,
                    writable: state.value.writable,
                    saveStartup,
                    onSaved: afterSave,
                  })
                : h("p", { style: hintStyle }, t("startupUnavailable")),
              state.value.remote?.values.endpoint
                ? h(StartupRow, {
                    key:
                      state.value.remote.entryId +
                      JSON.stringify(state.value.remote.values),
                    t,
                    target: "remote",
                    row: state.value.remote,
                    writable: state.value.writable,
                    saveStartup,
                    onSaved: afterSave,
                  })
                : h("p", { style: hintStyle }, t("startupUnconfigured")),
            )
          : null,
        h(
          Button,
          { variant: "outline", onClick: refresh, disabled: state.loading },
          t("startupRefresh"),
        ),
      );
    }
    function Page(props) {
      const { t } = props;
      const [refreshKey, setRefreshKey] = React.useState(0);
      const state = props.useTaskSettings((snapshot) => snapshot);
      if (props.view === "summary") return t("summary");
      return h(
        "div",
        { "data-task-plugin-settings": true },
        h(
          "style",
          null,
          '[data-task-plugin-settings] button:not([role="switch"]) { border: 1px solid var(--dsw-border); border-radius: 6px; }',
        ),
        h(
          "p",
          {
            role: "note",
            style: {
              ...hintStyle,
              padding: 12,
              border: "1px solid var(--dsw-border)",
              borderRadius: 8,
            },
          },
          t("safety"),
        ),
        h("h3", { style: headingStyle }, t("runtime")),
        h("p", { style: hintStyle }, t("savedHint")),
        h(
          SettingsForm,
          {
            state,
            labels: Object.fromEntries(
              ["unavailable", "readOnly", "save", "saving", "saveFailed"].map(
                (k) => [k, t(k)],
              ),
            ),
            onSave: props.save,
            onDiscard: props.discard,
          },
          ...keys.map((key) =>
            booleanKeys.has(key)
              ? h(
                  "div",
                  { key, style: { margin: "12px 0 20px" } },
                  h(
                    "div",
                    {
                      style: {
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 20,
                      },
                    },
                    h("span", null, t(key)),
                    h(Switch, {
                      label: t(key),
                      checked: state.fields[key].text === "true",
                      disabled: !state.writable || state.saving,
                      onChange: (value) => props.edit(key, String(value)),
                    }),
                  ),
                  h("p", { style: hintStyle }, t(`${key}Hint`)),
                  state.fields[key].overridden
                    ? h(
                        Button,
                        {
                          variant: "outline",
                          disabled: !state.writable || state.saving,
                          onClick: () => props.resetField(key),
                        },
                        t("reset"),
                      )
                    : null,
                )
              : h(SettingsValueField, {
                  key,
                  id: `task-setting-${key}`,
                  label: t(key),
                  hint: `${t(`${key}Hint`)} (${ranges[key][0]}–${ranges[key][1]})`,
                  overriddenLabel: t("overridden"),
                  resetLabel: t("reset"),
                  invalidLabel: t("invalidNumber"),
                  numeric: true,
                  disabled: !state.writable || state.saving,
                  ...state.fields[key],
                  onEdit: (text) => props.edit(key, text),
                  onReset: () => props.resetField(key),
                }),
          ),
        ),
        h(ReadOnly, {
          key: refreshKey,
          t,
          read: props.read,
          queryIdentity: props.queryIdentity,
        }),
        h(LocalQueue, { key: refreshKey, t, readQueue: props.readQueue }),
        props.startup
          ? h(StartupSettings, {
              t,
              startup: props.startup,
              saveStartup: props.saveStartup,
              onSaved: () => setRefreshKey((value) => value + 1),
            })
          : null,
      );
    }
    async function readRemote(ctx, method, codec) {
      // $mount owns a separate Cordis namespace. This dynamically mounted service
      // is read through the documented Context.get API, not an undeclared inject.
      const service = ctx.get("remote.taskPluginSettings");
      if (!service || typeof service[method] !== "function")
        throw Object.assign(new Error("Task settings service is unavailable"), {
          code: "client/service-unavailable",
        });
      const result = await service[method]();
      if (result?.ok === false) throw result.error;
      if (result?.ok !== true)
        throw Object.assign(new Error("Invalid task settings Remote result"), {
          code: "client/invalid-result",
        });
      return codec.parse(result.value);
    }
    async function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(
        () => ctx.locale.register(NS, { en, zh }),
        "task settings dictionaries",
      );
      const controller = new Controller(ctx.configForms.get("task-system"));
      ctx.effect(() => () => controller.dispose(), "task settings form");
      const unmount = await ctx.remote.$mount({
        package: "@dsh-task/task-system",
        descriptors: [descriptor, queueDescriptor, executorIdentityDescriptor],
      });
      ctx.effect(() => unmount, "task settings read-only remote");
      const read = () =>
        readRemote(ctx, "describe", descriptor.result.create());
      const readQueue = () =>
        readRemote(ctx, "queue", queueDescriptor.result.create());
      const queryIdentity = () =>
        readRemote(
          ctx,
          "executorIdentity",
          executorIdentityDescriptor.result.create(),
        );
      ctx.effect(
        () =>
          ctx.configForms.whileServed(["task-system"], () => {
            const inject = () => ({
              ...controller.inject(),
              read,
              readQueue,
              queryIdentity,
            });
            const section = ctx.slots.inject("settings.section", () =>
              ctx.slots.register(
                {
                  name: "settings.section",
                  id: "task-system",
                  order: 30,
                  label: () => t("title"),
                  locale: NS,
                  inject,
                },
                Page,
              ),
            );
            const row = ctx.slots.inject("plugins.row.config", () =>
              ctx.slots.register(
                {
                  name: "plugins.row.config",
                  key: "@dsh-task/task-system#task-system",
                  locale: NS,
                  inject,
                },
                Page,
              ),
            );
            return () => {
              row();
              section();
            };
          }),
        "task settings page",
      );
    }
    return {
      inject: ["slots", "locale", "configForms", "remote"],
      apply,
      Controller,
      fieldSpec,
      descriptor,
      readRemote,
      queueDescriptor,
      executorIdentityDescriptor,
      ExecutorIdentity,
      startupDraft,
      startupChanges,
      StartupRow,
      StartupSettings,
      QueueContents,
      LocalQueue,
      ReadOnly,
      Page,
      en,
      zh,
      keys,
    };
  },
});
