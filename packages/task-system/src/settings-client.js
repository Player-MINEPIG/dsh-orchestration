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
      Modal,
    } = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = React.createElement;
    const keys = [
      "schedulerEnabled",
      "autoExecute",
      "maxConcurrent",
      "healthAlerts",
      "localHeartbeatIntervalMs",
    ];
    const ranges = {
      maxConcurrent: [1, 32],
      localHeartbeatIntervalMs: [100, 3600000],
    };
    const booleanKeys = new Set([
      "schedulerEnabled",
      "autoExecute",
      "healthAlerts",
    ]);
    const NS = "taskPluginSettings";
    const en = {
      decisionFormTitle: "Decision model settings",
      decisionShared:
        "Scheduler executor selection and executor workspace/session decisions use this same configuration.",
      decisionMode: "Decision adapter",
      decisionKind_rules:
        "Rules applies configured rules without a model call. With no matching rule it abstains.",
      decisionKind_structured:
        "DSH LLM uses your configured DSH provider/model. Recommended for varied tasks and natural-language requests.",
      decisionKind_jev:
        "Typesafe Jev uses the dedicated Typesafe decision API and needs its own credentials; it does not use your DSH model API.",
      decisionKind_compatible:
        "Uses an explicitly configured compatible decision API.",
      connectionCheck: "Check connection",
      connectionChecking: "Checking…",
      connectionCheckOk:
        "Scheduler protocol and this node's authorization verified.",
      connectionCheckPaused:
        "Executor is off; connection detection does not enable heartbeats or receive tasks.",
      connectionCheckFailed: "Connection check failed",
      connectionError_ECONNREFUSED: "The port refused the connection; check the task-protocol port and listener.",
      connectionError_EHOSTUNREACH: "The scheduler cannot be reached; check the private network.",
      connectionError_ENETUNREACH: "The private network is unavailable.",
      connectionError_EADDRNOTAVAIL: "The configured local source address is unavailable.",
      connectionError_OPERATION_DENIED: "The scheduler rejected this identity-query permission.",
      connectionError_NOT_FOUND: "The service is reachable, but this task-protocol path was not found.",
      connectionError_CONNECTION_FAILED: "The response could not be verified as the scheduler task protocol.",
      connectionPortHint:
        "Use the scheduler task-protocol address, not its WebUI address. This test uses the current draft without saving it.",
      connectionError_NETWORK_TARGET_DENIED:
        "Address/port does not match the exact transport binding.",
      connectionError_REMOTE_REJECTED:
        "The service replied but did not accept the task protocol; check its port and route.",
      connectionError_CONNECTION_TIMEOUT:
        "Connection timed out; check the address, port and network.",
      connectionError_CHECK_PAUSE_REQUIRED:
        "Pause remote execution before testing a changed destination.",
      startupError_STARTUP_TARGET_MISMATCH:
        "Address/port does not match the trusted-network destination. Check advanced settings.",
      startupError_STARTUP_BUSY:
        "Work or recovery is still active. Finish or reconcile it before saving.",
      startupError_STARTUP_CONFLICT:
        "Configuration changed. Refresh before saving; your draft is retained.",
      startupError_STARTUP_OVERRIDE:
        "A higher configuration layer owns these settings; update profile ownership before saving.",
      decisionProvider: "Configured DSH provider",
      decisionModel: "Configured model",
      decisionChoose: "Choose…",
      decisionModelSelector: "Model selector",
      decisionModelVersion: "Exact model version",
      decisionEndpoint: "Compatible API endpoint",
      decisionManageModels: "Open DSH model settings",
      decisionModelsUnavailable: "Model settings could not be opened. Select Models in the settings sidebar.",
      decisionCredentialMissing:
        "Credentials are not configured. Non-secret settings can be saved; model decisions are not ready.",
      decisionCatalogEmpty:
        "No configured DSH model is available. Add or repair it in Models, then refresh.",
      decisionBridgeMissing:
        "The native bridge entry is missing. Update this plugin installation to enable GUI routing.",
      decisionRestart:
        "Save restarts the decision plugins. Credentials, env references and other routes are retained.",
      decisionSave: "Save decision model",
      decisionCurrent: "Current configuration",
      decisionStatus_ready: "Configured",
      "decisionStatus_configured-unverified":
        "Configured; connection not verified",
      decisionStatus_unconfirmed: "Credential readiness could not be confirmed",
      "decisionStatus_credential-missing": "Credentials missing",
      "decisionStatus_bridge-missing": "Native model route missing",
      "decisionStatus_model-unavailable": "Configured model unavailable",
      decisionConflict:
        "Configuration changed. Your draft is retained. Refresh and discard to use current values before retrying.",
      decisionSaveFailed:
        "Save could not be confirmed. Your draft is retained; refresh to check current configuration.",
      decisionReadFailed: "Could not read model settings. Refresh to retry.",
      decisionUnavailable:
        "The Jev plugin is not installed or has no editable entry.",
      decisionClose: "Close model settings",
      simpleMode: "Simple",
      advancedMode: "Advanced",
      settingsMode: "Settings mode",
      simpleHint:
        "Choose your role, connection and default workspace. Advanced settings keep the same draft.",
      openAdvanced: "Open advanced settings",
      decisionDependencyRequired: "Install and enable the dsh-jev-plugin decision plugin to use this feature. Refresh startup configuration after enabling it.",
      startupError_STARTUP_DECISION_REQUIRED: "Install and enable dsh-jev-plugin before enabling decisions.",
      schedulerDecisionTitle: "Scheduler · executor selection",
      schedulerDecisionHint:
        "The scheduler uses the existing task_plan decision tool to propose an executor. Applying a proposal checks the authoritative executor catalog and permissions.",
      planningDecisionEnabled: "Enable scheduler executor-selection decisions",
      schedulerDecisionStatus:
        "Enable this switch and configure the existing model to choose an executor. When disabled or the decision plugin is not loaded, an explicit route is retained; work without an assigned executor remains pending assignment.",
      schedulerDecisionModelEntry: "Scheduler decision model settings",
      schedulerDecisionSetup:
        "Open Decision model settings. Both roles reuse the same configured model.",
      executorDecisionTitle: "Executor · workspace and session",
      executorDecisionHint:
        "After receiving a task, the executor selects its workspace and creates or reuses a Task session within the task's constraints.",
      executorDecisionInactive:
        "These execution settings are retained but inactive for the Scheduler role.",
      decisionModelEntry: "Executor decision model settings",
      decisionModelStatus:
        "Uses the existing decision-model configuration. If no valid decision is available, the default Task session/workspace policy applies.",
      decisionModelSetup:
        "Open Decision model settings to select the configured provider and model.",
      schedulerAddress: "Scheduler address",
      audienceHint:
        "Audience must match the scheduler's configured target validation label. Obtain it from the scheduler; it is not inferred from the address.",
      schedulerConnection: "Scheduler connection",
      executorConnections: "Executor connections",
      executorSetupStatus:
        "Executor registrations and permissions use the existing task-system plugin configuration. Review them in Plugins before remote dispatch.",
      connectionSetupStatus:
        "Connection not ready. Obtain connection information from the scheduler, including audience, authentication/permissions and the exact target binding, then complete it in advanced settings or Plugins.",
      connectionUnconfirmed:
        "Connection configured; scheduler identity and permissions have not been confirmed here.",
      remotePausedStatus:
        "Executor is off; heartbeats and task reception are stopped. Connection settings remain editable.",
      startupEditable: "Role, workspace and scheduler connection",
      nodeCapacityTitle: "Scheduler · executor node capacity",
      nodeCapacityHint: "Slots admitted by this scheduler for each registered executor (1–32). Effective parallelism also depends on executor concurrency and shared workspace serialization. Saving applies immediately; lowering capacity does not stop active runs.",
      nodeCapacityEmpty: "No executor nodes are registered in this profile.",
      nodeCapacity: "Node capacity",
      startupError_STARTUP_CAPACITY_DENIED: "Only existing scheduler-registered node capacities can be edited. Refresh the configuration.",
      startupTask: "Task-service startup settings",
      startupRemote: "Scheduler connection",
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
        "No scheduler connection is configured. This form can create a connection only with an existing trusted-network authentication mode and fixed internal node identity. Other authentication setup uses the official secure configuration flow; no keys or permissions are created here.",
      startupEndpointHint:
        "For an existing trusted-network connection, the endpoint must match the exact target address and port. Connection changes are blocked while work is active, claimed or uncertain.",
      startupMigration: "Save and restart: enable Task session protocol",
      startupMigrationHint:
        "Upgrade only after this existing peer has been explicitly granted executorIdentity, sessionContext and selectTaskSession. This action does not grant those permissions.",
      startupInvalid: "Enter valid values before saving.",
      executorEnabled: "Enable executor",
      remoteEnabled: "Enable scheduler connection service",
      executorEnabledHint: "This switch saves and restarts the remote plugin immediately. On: automatically send heartbeats and receive tasks. Off: stop receiving tasks and report unavailable; if the network is unreachable, the last heartbeat expires. Running or unresolved work blocks changes.",
      remoteEnabledHint: "This switch saves and restarts the remote service immediately. Planner-only nodes never receive execution work.",
      heartbeat_disabled: "Automatic heartbeat is off. Enable the executor to restore heartbeats and task reception.",
      heartbeat_waiting: "Executor enabled; waiting for the scheduler to acknowledge a heartbeat. Refresh to check again.",
      heartbeat_acknowledged: "Last heartbeat acknowledged by the scheduler; online status follows heartbeat expiry.",
      heartbeat_failed: "Heartbeat failed; executor is enabled but online status is not confirmed. Check the connection and refresh.",
      startupError_STARTUP_ROUTES_REQUIRED: "Configure authorized executor models and workspace routes before enabling the executor.",
      paused: "Pause remote operation",
      pausedHint:
        "Save and restart with this on to keep connection settings loaded while remote requests, workers and polling are paused. Turn it off and save to resume with the configured connection and permissions.",
      startupLoaded: "Connection settings loaded",
      startupLoaderDisabled: "Plugin disabled",
      startupRemoteDisabled:
        "This connection configuration is not loaded for editing. Load it paused through the approved setup before saving here.",
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
      workspaceTitle: "Executor · sessions and workspace",
      defaultWorkspaceId: "Workspace ID · read only",
      defaultWorkspace: "Default workspace",
      workspaceLayoutHint: "For new project tasks this is the authorized parent. Local project folders are created by scheduler and project ID; temporary tasks have their own folders. Existing sessions retain their directory.",
      workspaceNone: "No default workspace selected",
      workspaceLoading: "Reading this host's workspaces…",
      workspaceFailed:
        "Could not read this host's workspaces. Refresh to retry; your current selection and draft are retained.",
      workspaceEmpty:
        "No registered workspace is currently available for tasks on this host.",
      workspaceUnavailable:
        "Current selection is unavailable and retained. Choose another workspace or discard this change.",
      workspaceUnavailableOption: "Current selection · unavailable",
      workspaceUnavailableSuffix: "unavailable",
      workspaceRefresh: "Refresh workspaces",
      sessionDecisionEnabled: "Enable executor workspace/session decisions",
      workspaceHint:
        "The default workspace must already be registered locally. Saved changes apply to future tasks immediately. Without a valid decision, execution uses the default Task session and workspace policy.",
      decisionHint:
        "Decision adapters reuse dsh-jev-plugin: DSH LLM, Typesafe Jev, or a registered AnyJev adapter. Select the model in this form; manage credentials through Models.",
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
        "The executor switch controls heartbeats and task reception together. Enabling replaces legacy zero intervals with automatic defaults. Active or uncertain work can block changes.",
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
      decisionFormTitle: "决策模型配置",
      decisionShared:
        "调度端选择执行端、执行端选择工作区／会话，共用此决策模型配置。",
      decisionMode: "决策方式",
      decisionKind_rules:
        "Rules：按已配置的规则判断，不调用模型；没有匹配规则时不会自动选择。",
      decisionKind_structured:
        "DSH LLM：使用 DSH 中已有的供应商和模型。适合非固定任务及自然语言请求，建议你的场景选择此项。",
      decisionKind_jev:
        "Typesafe Jev：调用 Typesafe 的专用决策 API，需要单独配置凭据；不会使用你已配置的 DSH 模型 API。",
      decisionKind_compatible: "使用明确配置的兼容决策 API。",
      connectionCheck: "检验连接",
      connectionChecking: "正在检验…",
      connectionCheckOk: "已连通调度端任务协议，并确认此节点获准连接。",
      connectionCheckPaused: "执行端仍关闭；检验连接不会开启心跳或接单。",
      connectionCheckFailed: "连接检验失败",
      connectionError_ECONNREFUSED: "端口拒绝连接，请核对任务协议端口和监听服务。",
      connectionError_EHOSTUNREACH: "无法到达调度端，请检查私有网络连接。",
      connectionError_ENETUNREACH: "私有网络当前不可用。",
      connectionError_EADDRNOTAVAIL: "配置的本机来源地址当前不可用，请核对高级设置。",
      connectionError_OPERATION_DENIED: "调度端未允许此节点查询执行端身份。",
      connectionError_NOT_FOUND: "服务可达，但未找到任务协议接口路径。",
      connectionError_CONNECTION_FAILED: "未能把返回内容验证为调度端任务协议。",
      connectionPortHint:
        "请填调度端任务协议地址，而不是 WebUI 地址。检验使用当前草稿，无需先保存。",
      connectionError_NETWORK_TARGET_DENIED: "地址或端口与精确连接绑定不一致。",
      connectionError_REMOTE_REJECTED:
        "服务已响应，但未接受任务协议；请检查端口和接口路径。",
      connectionError_CONNECTION_TIMEOUT: "连接超时，请检查地址、端口和网络。",
      connectionError_CHECK_PAUSE_REQUIRED:
        "请先暂停远程执行，再检验修改后的目标地址。",
      startupError_STARTUP_TARGET_MISMATCH:
        "地址或端口与 trusted-network 目标绑定不一致，请核对高级设置。",
      startupError_STARTUP_BUSY: "角色或连接变更需要重启；仍有执行或未确认记录阻止重启。容量、默认工作区、决策开关和并发等即时设置可另行保存。",
      startupError_STARTUP_CONFLICT:
        "配置已变化，请刷新核对后保存；草稿已保留。",
      startupError_STARTUP_OVERRIDE:
        "此配置由更高层配置持有，需要先调整 profile 配置归属。",
      decisionProvider: "已有 DSH provider",
      decisionModel: "已有模型",
      decisionChoose: "请选择…",
      decisionModelSelector: "模型选择名",
      decisionModelVersion: "实际模型／版本",
      decisionEndpoint: "Compatible API 地址",
      decisionManageModels: "打开 DSH 模型设置",
      decisionModelsUnavailable: "模型设置入口暂不可用，请点击设置左侧的“模型”。",
      decisionCredentialMissing:
        "凭据尚未配置。可保存非秘密设置；模型决策尚未就绪。",
      decisionCatalogEmpty:
        "暂无可选的已配置 DSH 模型。请在“模型”中添加或修复后刷新。",
      decisionBridgeMissing:
        "当前安装缺少 native bridge 条目；更新插件安装后即可在此保存普通模型路由。",
      decisionRestart: "保存后重启相关决策插件；保留凭据、env 引用和其他路由。",
      decisionSave: "保存决策模型",
      decisionCurrent: "当前配置",
      decisionStatus_ready: "已配置",
      "decisionStatus_configured-unverified": "已配置；连接尚未验证",
      decisionStatus_unconfirmed: "凭据状态尚未确认",
      "decisionStatus_credential-missing": "缺少凭据",
      "decisionStatus_bridge-missing": "缺少普通模型路由",
      "decisionStatus_model-unavailable": "已配置模型不可用",
      decisionConflict:
        "配置已变化，草稿保留。刷新并取消草稿以载入当前值后重试。",
      decisionSaveFailed: "保存未能确认，草稿保留；请刷新检查当前配置。",
      decisionReadFailed: "无法读取决策模型配置，请刷新重试。",
      decisionUnavailable: "Jev 插件未安装或没有可编辑条目。",
      decisionClose: "关闭模型配置",
      simpleMode: "简单",
      advancedMode: "高级",
      settingsMode: "设置模式",
      simpleHint: "选择本机角色、连接与默认工作区。高级设置沿用同一份草稿。",
      openAdvanced: "打开高级设置",
      decisionDependencyRequired: "需要安装并启用 dsh-jev-plugin 决策插件后才能使用。启用后请刷新启动配置。",
      startupError_STARTUP_DECISION_REQUIRED: "请先安装并启用 dsh-jev-plugin 决策插件，再开启决策功能。",
      schedulerDecisionTitle: "调度端 · 选择执行者",
      schedulerDecisionHint:
        "调度端使用现有 task_plan 决策工具提出执行者建议；应用建议时校验权威执行端目录与权限。",
      planningDecisionEnabled: "启用调度端执行者决策",
      schedulerDecisionStatus:
        "打开此开关并选择决策预设后，使用该预设选择执行者。关闭或未加载决策插件时沿用明确路由；未确定执行者则保持待分配。",
      schedulerDecisionModelEntry: "选择调度端决策预设",
      schedulerDecisionSetup:
        "在本页分别选择调度端与执行端的决策预设；预设内容在独立“决策”设置中管理。",
      executorDecisionTitle: "执行端 · 工作区与会话",
      executorDecisionHint:
        "任务派过来后，由执行端在任务约束内选择工作区，并新建或复用 Task 会话。",
      executorDecisionInactive:
        "这些执行配置予以保留，但在“调度端”角色下不生效。",
      decisionModelEntry: "选择执行端决策预设",
      decisionModelStatus:
        "使用本机选择的决策预设；没有有效决策时，采用默认 Task 会话与工作区策略。",
      decisionModelSetup:
        "点击“选择执行端决策预设”；此开关控制会话与工作区决策。",
      schedulerAddress: "调度端地址",
      audienceHint:
        "audience 是调度端配置的目标验证标识，必须与调度端的值一致；请向调度端获取，不按地址猜测。",
      schedulerConnection: "调度端连接",
      executorConnections: "执行端连接信息",
      executorSetupStatus:
        "执行端注册与权限沿用已有 task-system 插件配置；远程派发前请在“插件”中确认。",
      connectionSetupStatus:
        "连接尚未就绪。请向调度端获取连接信息（audience、认证／权限及目标绑定），再在高级设置或“插件”中补齐。",
      connectionUnconfirmed: "连接已配置；此处尚未确认调度端身份与权限。",
      remotePausedStatus: "执行端已关闭，不发送心跳、不接收任务；连接配置仍可编辑。",
      startupEditable: "角色、工作区与调度端连接",
      nodeCapacityTitle: "调度端 · 执行节点容量",
      nodeCapacityHint: "此调度端允许各已登记执行节点同时占用的槽位数（1–32）。实际并行数还受执行端的远程执行并发及共享工作区串行约束限制。保存后即时生效；降低容量不会停止已有运行。",
      nodeCapacityEmpty: "当前配置尚未登记执行节点。",
      nodeCapacity: "节点容量",
      startupError_STARTUP_CAPACITY_DENIED: "只能修改调度端已有执行节点的容量，请刷新配置。",
      startupTask: "任务服务启动配置",
      startupRemote: "调度端连接",
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
        "全部草稿由下方常驻按钮统一保存。容量、工作区、决策开关和执行限制即时生效；角色、连接及协议变更需要重建受影响的插件。身份、凭据和授权仍由原配置管理。",
      startupUnconfigured:
        "尚未配置调度端连接。此表单仅可在已有 trusted-network 认证模式和固定内部节点身份的配置上建立连接；其他认证配置请使用官方安全配置流程。此页不创建密钥或授予权限。",
      startupEndpointHint:
        "已有 trusted-network 连接的调度端地址须与精确目标地址和端口一致。存在运行中、已领取或状态未确认的工作时不能改变连接。",
      startupMigration: "保存并重启：启用 Task 会话协议",
      startupMigrationHint:
        "仅在此已有 peer 已获 executorIdentity、sessionContext、selectTaskSession 明确授权后升级。此操作不会授予这些权限。",
      startupInvalid: "请先填写有效值再保存。",
      executorEnabled: "启用执行端",
      remoteEnabled: "启用调度连接服务",
      executorEnabledHint: "开关修改先进入草稿，点击下方常驻保存按钮后应用。开启后自动发送心跳并接收任务；关闭后停止接单。此变更需要重建远程服务，活动或未确认工作会阻止保存。",
      remoteEnabledHint: "开关会立即保存并重启远程服务。仅有调度端身份时不会接收执行任务。",
      heartbeat_disabled: "自动心跳未开启。启用执行端可恢复心跳和接单。",
      heartbeat_waiting: "执行端已启用，等待调度端确认心跳。可刷新查看最新状态。",
      heartbeat_acknowledged: "最近一次心跳已获调度端确认；在线状态以心跳有效期为准。",
      heartbeat_failed: "心跳发送失败；执行端已启用，但尚未确认在线。请检验连接后刷新。",
      startupError_STARTUP_ROUTES_REQUIRED: "请先配置已授权的执行模型和工作区路线，再启用执行端。",
      paused: "暂停远程运行",
      pausedHint:
        "开启并保存重启后，连接配置保持加载，远程请求、执行器和轮询暂停。关闭并保存后，按已配置的连接与权限恢复运行。",
      startupLoaded: "连接配置已加载",
      startupLoaderDisabled: "插件已停用",
      startupRemoteDisabled:
        "此连接配置尚未加载，当前不能编辑。请按已批准的配置流程以暂停状态加载，再在此保存。",
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
        "以下显示实际启动配置。角色、工作区和已有连接由下方常驻按钮统一保存；节点身份、数据库路径、工具授权和凭据仍为只读。",
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
      workspaceTitle: "执行端 · 会话与工作区",
      defaultWorkspaceId: "工作区 ID · 只读",
      defaultWorkspace: "默认工作区",
      workspaceLayoutHint: "新项目任务以此授权工作区为父目录，按调度端 ID／项目 ID 创建本地文件夹；临时任务使用独立目录。已有会话保留原目录。",
      workspaceNone: "未指定默认工作区",
      workspaceLoading: "正在读取本机工作区…",
      workspaceFailed:
        "未能读取本机工作区，请刷新重试；当前选择和草稿予以保留。",
      workspaceEmpty: "本机尚无已登记且可用于任务的工作区。",
      workspaceUnavailable:
        "当前选择已不可用，仍予以保留。请选择其他工作区，或丢弃本次更改。",
      workspaceUnavailableOption: "当前选择 · 不可用",
      workspaceUnavailableSuffix: "不可用",
      workspaceRefresh: "刷新工作区",
      sessionDecisionEnabled: "启用执行端工作区／会话决策",
      workspaceHint:
        "默认工作区须已在本机登记；保存后立即用于后续任务。没有有效决策时，执行采用默认的 Task 会话和工作区策略。",
      decisionHint:
        "在“决策”设置中管理 Rules、DSH LLM、Typesafe Jev 和已注册适配器的预设；本插件只选择使用哪一个。凭据在官方“模型”或原有环境引用中管理。",
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
        "执行端开关联动心跳和接单。启用时，旧的零间隔自动恢复为默认间隔；存在活动工作或状态未确认的执行时可能无法保存。",
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
        return { hooks: { taskSettings: this.store }, ...this.form.actions(), save: async () => { await this.form.save(); const state=this.form.shell(); return !state.failed && !state.dirty; } };
      }
      dispose() {
        this.form.dispose();
      }
    }
    // Task deployment settings belong to the authenticated Host. The shipped
    // shared preference provider deliberately uses browser memory off loopback;
    // use the public settings RPC for this namespace without changing that policy.
    class RemoteTaskSettingsScope {
      constructor(api) {
        this.api = api;
        this.listeners = new Set();
        this.snapshot = { status: "loading", writable: false, mode: "host" };
        this.tail = Promise.resolve();
        this.disposed = false;
      }
      getSnapshot = () => this.snapshot;
      subscribe = (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      };
      publish(snapshot) {
        if (this.disposed) return;
        this.snapshot = snapshot;
        for (const listener of this.listeners) listener();
      }
      accept(view, writable) {
        if (
          !view ||
          view.ns !== "task-system" ||
          !view.value ||
          !Number.isSafeInteger(view.revision)
        )
          throw new Error("Invalid task settings response");
        const pick = (value) =>
          Object.fromEntries(
            keys
              .filter((key) => value && Object.hasOwn(value, key))
              .map((key) => [key, value[key]]),
          );
        this.publish({
          status: "ready",
          mode: "host",
          writable: writable === true,
          value: pick(view.value),
          base: pick(view.base),
          user: pick(view.user),
          revision: view.revision,
        });
      }
      load() {
        if (this.disposed) return Promise.resolve();
        if (this.inFlight) {
          this.rerun = true;
          return this.inFlight;
        }
        this.inFlight = (async () => {
          do {
            this.rerun = false;
            try {
              const response = await this.api.describe();
              if (!response.ok) throw new Error("Task settings unavailable");
              const view = response.value.namespaces.find(
                (row) => row.ns === "task-system",
              );
              if (view) this.accept(view, response.value.writable);
              else
                this.publish({
                  status: "unavailable",
                  writable: false,
                  mode: "host",
                });
            } catch {
              this.publish({
                ...this.snapshot,
                writable: false,
                status: this.snapshot.value ? "ready" : "unavailable",
              });
            }
          } while (this.rerun && !this.disposed);
        })().finally(() => {
          this.inFlight = undefined;
        });
        return this.inFlight;
      }
      mutate(ops, revision) {
        if (
          !Array.isArray(ops) ||
          !ops.length ||
          ops.some(
            (op) =>
              !["set", "unset"].includes(op.op) ||
              !Array.isArray(op.path) ||
              op.path.length !== 1 ||
              !keys.includes(op.path[0]) ||
              (op.op === "set" &&
                typeof op.value !==
                  (booleanKeys.has(op.path[0]) ? "boolean" : "number")) ||
              (op.op === "set" &&
                !fieldSpec(op.path[0]).parse(String(op.value))),
          )
        )
          return Promise.resolve(false);
        const owned = structuredClone(ops);
        const task = this.tail.then(async () => {
          if (
            this.disposed ||
            !this.snapshot.writable ||
            !Number.isSafeInteger(revision)
          )
            return false;
          try {
            const response = await this.api.mutate(
              "task-system",
              owned,
              revision,
            );
            if (response.ok) {
              this.accept(response.value, true);
              return true;
            }
          } catch {
            /* Recover authoritative values; keep the form's draft. */
          }
          await this.load();
          return false;
        });
        this.tail = task.catch(() => {});
        return task;
      }
      whileServed(register) {
        let off;
        const sync = () => {
          if (this.snapshot.status === "ready" && !off) off = register();
          else if (this.snapshot.status !== "ready" && off) {
            off();
            off = undefined;
          }
        };
        const unsubscribe = this.subscribe(sync);
        sync();
        return () => {
          unsubscribe();
          off?.();
        };
      }
      async dispose() {
        this.disposed = true;
        this.listeners.clear();
        await Promise.allSettled([this.tail, this.inFlight]);
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
    const workspaceCatalogDescriptor = {
      id: "@dsh-task/task-system#taskPluginSettings/workspaces",
      service: "taskPluginSettings",
      namespace: "taskPluginSettings",
      method: "workspaces",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "@dsh-task/task-system#WorkspaceCatalog",
        create: () => ({
          parse(value) {
            if (
              !value ||
              !value.scope ||
              ["entryId", "nodeId", "schedulerId"].some(
                (key) => typeof value.scope[key] !== "string",
              ) ||
              !["official", "task"].includes(value.source) ||
              !Array.isArray(value.items) ||
              value.items.some(
                (item) =>
                  !item ||
                  ["workspaceId", "title", "path"].some(
                    (key) => typeof item[key] !== "string",
                  ) ||
                  typeof item.available !== "boolean",
              ) ||
              new Set(value.items.map((item) => item.workspaceId)).size !==
                value.items.length
            )
              throw new Error("Invalid local workspace catalog");
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
    const startupKeys = {
      task: [
        "role",
        "defaultWorkspaceId",
        "nodeCapacities",
        "planningDecisionEnabled",
        "sessionDecisionEnabled",
      ],
      remote: [
        "role",
        "paused",
        "endpoint",
        "audience",
        "pollIntervalMs",
        "concurrency",
        "taskSessionsEnabled",
        "trustedNetworkTarget",
      ],
    };
    function parseStartupValues(value, target, partial = false) {
      const keys = startupKeys[target];
      if (
        !keys ||
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !keys.includes(key)) ||
        (!partial && keys.some((key) => key !== "nodeCapacities" && !Object.hasOwn(value, key)))
      )
        throw new Error("Invalid startup values");
      for (const [key, entry] of Object.entries(value)) {
        if (key === "nodeCapacities" && (!Array.isArray(entry) || entry.some(node =>
          !node || Object.keys(node).some(field => !["nodeId", "maxConcurrent"].includes(field)) ||
          typeof node.nodeId !== "string" || !node.nodeId || !Number.isSafeInteger(node.maxConcurrent) || node.maxConcurrent < 1 || node.maxConcurrent > 32)))
          throw new Error("Invalid node capacity");
        if (
          (key === "role" &&
            !["planner", "executor", "both"].includes(entry)) ||
          ([
            "planningDecisionEnabled",
            "sessionDecisionEnabled",
            "taskSessionsEnabled",
            "paused",
          ].includes(key) &&
            typeof entry !== "boolean") ||
          (["defaultWorkspaceId", "endpoint", "audience"].includes(key) &&
            entry !== null &&
            typeof entry !== "string") ||
          (key === "pollIntervalMs" &&
            (!Number.isSafeInteger(entry) || entry < 0 || entry > 3600000)) ||
          (key === "concurrency" &&
            (!Number.isSafeInteger(entry) || entry < 1 || entry > 16))
        )
          throw new Error("Invalid startup value");
        if (
          key === "trustedNetworkTarget" &&
          entry !== null &&
          (!entry ||
            typeof entry !== "object" ||
            Object.keys(entry).some(
              (field) =>
                !["address", "port", "localAddress", "allowHttp"].includes(
                  field,
                ),
            ) ||
            typeof entry.address !== "string" ||
            !entry.address ||
            typeof entry.localAddress !== "string" ||
            !entry.localAddress ||
            !Number.isSafeInteger(entry.port) ||
            entry.port < 1 ||
            entry.port > 65535 ||
            entry.allowHttp !== true)
        )
          throw new Error("Invalid startup connection target");
      }
      return value;
    }
    const startupDescriptor = {
      id: "@dsh-task/task-system#taskPluginSettings/startup",
      service: "taskPluginSettings",
      namespace: "taskPluginSettings",
      method: "startup",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "@dsh-task/task-system#StartupSettings",
        create: () => ({
          parse(value) {
            if (
              !value ||
              typeof value.writable !== "boolean" ||
              value.applies !== "plugin-restart"
            )
              throw new Error("Invalid startup settings snapshot");
            for (const target of ["task", "remote"]) {
              const row = value[target];
              if (row === null) continue;
              if (!row || typeof row.entryId !== "string")
                throw new Error("Invalid startup settings row");
              if (
                target === "remote" &&
                (typeof row.loaded !== "boolean" ||
                  typeof row.loaderDisabled !== "boolean")
              )
                throw new Error("Invalid startup remote loading state");
              if (
                target === "task" &&
                row.workspaceScope &&
                ["nodeId", "schedulerId"].some(
                  (key) => typeof row.workspaceScope[key] !== "string",
                )
              )
                throw new Error("Invalid startup workspace scope");
              parseStartupValues(row.values, target);
            }
            return value;
          },
        }),
      },
    };
    const saveStartupDescriptor = {
      id: "@dsh-task/task-system#taskPluginSettings/saveStartup",
      service: "taskPluginSettings",
      namespace: "taskPluginSettings",
      method: "saveStartup",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "input",
          wire: "input",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "@dsh-task/task-system#SaveStartupInput",
            create: () => ({
              parse(value) {
                if (
                  !value ||
                  !["task", "remote"].includes(value.target) ||
                  Object.keys(value).some(
                    (key) => !["target", "expected", "changes"].includes(key),
                  )
                )
                  throw new Error("Invalid startup edit");
                parseStartupValues(value.expected, value.target);
                parseStartupValues(value.changes, value.target, true);
                return value;
              },
            }),
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "@dsh-task/task-system#SaveStartupResult",
        create: () => ({
          parse(value) {
            if (value?.saved !== true || !["live", "plugin-restart"].includes(value.applies))
              throw new Error("Invalid startup save result");
            return value;
          },
        }),
      },
    };
    const startupNeedsRestart = (target, changes) => Object.keys(changes).some(key => !(target === "task" ? ["nodeCapacities", "defaultWorkspaceId", "planningDecisionEnabled", "sessionDecisionEnabled"] : ["concurrency", "pollIntervalMs"]).includes(key));
    class SettingsSaveCoordinator {
      constructor() { this.items = new Map(); this.listeners = new Set(); this.saving = false; this.message = ""; }
      subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
      emit() { for (const fn of this.listeners) fn(); }
      register(id, item) { this.items.set(id,item); this.emit(); return () => {this.items.delete(id);this.emit();}; }
      update(id, meta) { const row=this.items.get(id); if (!row || JSON.stringify(row.meta)===JSON.stringify(meta)) return; if (meta.dirty && !row.meta?.dirty && !this.saving) this.message=""; row.meta=meta; this.emit(); }
      snapshot() { const dirty=[...this.items.values()].filter(row=>row.meta?.dirty); return {count:dirty.length,invalid:dirty.some(row=>row.meta.invalid),busy:this.saving || [...this.items.values()].some(row=>row.meta?.busy),restart:dirty.some(row=>row.meta.restart),message:this.message}; }
      async saveAll() {
        const before=this.snapshot(); if (!before.count || before.invalid || before.busy) return false;
        this.saving=true;this.message="";this.emit();let saved=0;
        const items=[...this.items.values()].filter(row=>row.meta?.dirty).sort((a,b)=>Number(a.meta.restart)-Number(b.meta.restart));
        try { for (const row of items) { if (await row.save() !== true) {this.message=saved ? "部分设置已保存；未完成的草稿已保留。请查看错误提示。" : "未能保存，草稿已保留。请查看错误提示。";return false;} saved++; } this.message="设置已保存。";return true; }
        catch {this.message=saved ? "部分设置已保存；其余草稿已保留。" : "未能保存，草稿已保留。";return false;}
        finally {this.saving=false;this.emit();}
      }
      discardAll() { if (this.snapshot().busy) return; for (const row of this.items.values()) row.discard(); this.message="";this.emit(); }
    }
    function useSaveParticipant(coordinator, id, participant) {
      if (!coordinator) return;
      const ref=React.useRef(participant);ref.current=participant;
      React.useEffect(()=>coordinator.register(id,{meta:participant.meta,save:()=>ref.current.save(),discard:()=>ref.current.discard()}),[coordinator,id]);
      React.useEffect(()=>coordinator.update(id,participant.meta),[coordinator,id,participant.meta.dirty,participant.meta.invalid,participant.meta.busy,participant.meta.restart]);
    }
    const hintStyle = {
      color: "var(--dsw-alias-label-secondary, currentColor)",
      fontSize: 13,
      lineHeight: 1.65,
      margin: "5px 0 12px",
    };
    const controlStyle = {
      width: "100%",
      boxSizing: "border-box",
      padding: "7px 10px",
      color: "var(--dsw-alias-label-primary, currentColor)",
      background: "var(--dsw-alias-bg-layer-1, transparent)",
      border: "1px solid var(--dsw-alias-border-l3, #8a8a8a)",
      borderRadius: 6,
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
                "data-task-detail-row": true,
                style: {
                  display: "grid",
                  gridTemplateColumns: "minmax(130px, 1fr) minmax(0, 2fr)",
                  gap: 16,
                  padding: "8px 0",
                  borderBottom: "1px solid var(--dsw-alias-border-l3, #8a8a8a)",
                },
              },
              h("dt", { style: { ...hintStyle, margin: 0 } }, t(key)),
              h(
                "dd",
                {
                  style: {
                    margin: 0,
                    fontSize: 13,
                    lineHeight: 1.65,
                    overflowWrap: "anywhere",
                    whiteSpace: "pre-wrap",
                  },
                  "data-setting": key,
                },
                key === "executionTools" && value.executionToolsMode === "preset" ? "DSH Agent preset（默认工具与权限）" : key === "role"
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
                key: `${state.value.remote?.endpoint ?? "none"}:${state.value.remote?.paused ?? false}:${state.value.remote?.executorIdentity?.schedulerId ?? "unresolved"}`,
                t,
                fields,
                remote: state.value.remote,
                queryIdentity,
              }),
              state.value.role !== "executor"
                ? h(
                    "div",
                    null,
                    h(
                      "h3",
                      { style: headingStyle },
                      t("schedulerDecisionTitle"),
                    ),
                    Object.hasOwn(state.value, "planningDecisionEnabled")
                      ? fields(state.value, ["planningDecisionEnabled"])
                      : h("p", { style: hintStyle }, t("settingsPending")),
                    h("p", { style: hintStyle }, t("schedulerDecisionStatus")),
                  )
                : null,
              h("h3", { style: headingStyle }, t("workspaceTitle")),
              state.value.role === "planner"
                ? h("p", { style: hintStyle }, t("executorDecisionInactive"))
                : null,
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
                    "paused",
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
      const value = remote?.paused
        ? null
        : (state.value ?? remote?.executorIdentity);
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
            disabled: !remote?.endpoint || remote.paused || state.loading,
            onClick: remote?.paused ? undefined : refresh,
          },
          t("queryIdentity"),
        ),
      );
    }
    function QueueContents({ t, value, advanced = true }) {
      const cellStyle = {
        textAlign: "left",
        padding: "8px 12px",
        borderBottom: "1px solid var(--dsw-alias-border-l3, #8a8a8a)",
        verticalAlign: "top",
        overflowWrap: "anywhere",
      };
      return h(
        React.Fragment,
        null,
        h(
          "p",
          { style: hintStyle, hidden: !advanced },
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
                      ...(advanced ? ["sessionId", "workspaceId"] : []),
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
                        item.projectTitle ? h("div", { style: hintStyle }, item.projectTitle) : null,
                        advanced && item.executionDirectory ? h("div", { style: { ...hintStyle, overflowWrap: "anywhere" } }, item.executionDirectory) : null,
                        h(
                          "div",
                          { style: hintStyle, hidden: !advanced },
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
                        { style: cellStyle, hidden: !advanced },
                        item.sessionId ?? t("none"),
                      ),
                      h(
                        "td",
                        { style: cellStyle, hidden: !advanced },
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
    function LocalQueue({ t, readQueue, advanced = true }) {
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
        state.value
          ? h(QueueContents, { t, value: state.value, advanced })
          : null,
        h(
          Button,
          { variant: "outline", onClick: refresh, disabled: state.loading },
          t("queueRefresh"),
        ),
      );
    }
    const checkConnectionDescriptor = {
      id: "@dsh-task/task-system#taskPluginSettings/checkConnection",
      service: NS,
      namespace: NS,
      method: "checkConnection",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "input",
          wire: "input",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "@dsh-task/task-system#CheckConnectionInput",
            create: () => ({
              parse(value) {
                if (
                  !value ||
                  Object.keys(value).sort().join() !==
                    "endpoint,expected,trustedNetworkTarget" ||
                  typeof value.endpoint !== "string" ||
                  !value.endpoint ||
                  value.endpoint.length > 2048
                )
                  throw Error("Invalid connection check input");
                parseStartupValues(value.expected, "remote");
                parseStartupValues(
                  { trustedNetworkTarget: value.trustedNetworkTarget },
                  "remote",
                  true,
                );
                return value;
              },
            }),
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "@dsh-task/task-system#CheckConnectionResult",
        create: () => ({
          parse(value) {
            if (
              !value ||
              Object.keys(value).sort().join() !==
                "checkedAt,code,connected,endpoint,identity,paused" ||
              typeof value.connected !== "boolean" ||
              typeof value.paused !== "boolean" ||
              typeof value.checkedAt !== "string" ||
              (value.endpoint !== null && typeof value.endpoint !== "string") ||
              (value.code !== null && typeof value.code !== "string")
            )
              throw Error("Invalid connection check result");
            if (value.identity !== null)
              executorIdentityDescriptor.result.create().parse(value.identity);
            if (
              value.connected !== (value.identity !== null) ||
              (value.connected && value.code !== null)
            )
              throw Error("Invalid connection check status");
            return value;
          },
        }),
      },
    };
    function connectionUrl(value) {
      try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) ? url : null;
      } catch {
        return null;
      }
    }
    function simpleEndpointDisplay(value) {
      const url = connectionUrl(value);
      return url && !url.username && !url.password && !url.search && !url.hash
        ? url.origin
        : value;
    }
    function simpleEndpointInput(value, previous) {
      const text = String(value).trim(),
        url = connectionUrl(text);
      if (text.endsWith(":")) return text;
      if (
        !url ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      )
        return text;
      const path = connectionUrl(previous)?.pathname ?? "/dsh-task/v1/commands";
      return url.origin + path;
    }
    function startupDraft(target, values) {
      return target === "task"
        ? {
            role: values.role,
            defaultWorkspaceId: values.defaultWorkspaceId ?? "",
            ...(values.nodeCapacities ? {nodeCapacities: values.nodeCapacities.map(node => ({nodeId: node.nodeId, maxConcurrent: String(node.maxConcurrent)}))} : {}),
            planningDecisionEnabled: values.planningDecisionEnabled,
            sessionDecisionEnabled: values.sessionDecisionEnabled,
          }
        : {
            role: values.role,
            paused: values.paused,
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
              : values.endpoint === null
                ? { targetAddress: "", targetPort: "", targetLocalAddress: "" }
                : {}),
          };
    }
    function startupChanges(target, values, draft, migrate = false) {
      const invalid = [],
        next = { role: draft.role };
      if (!["planner", "executor", "both"].includes(draft.role))
        invalid.push("role");
      if (target === "task") {
        if (values.nodeCapacities) {
          next.nodeCapacities = (draft.nodeCapacities ?? []).map(node => ({nodeId: node.nodeId, maxConcurrent: Number(node.maxConcurrent)}));
          if (next.nodeCapacities.length !== values.nodeCapacities.length ||
              next.nodeCapacities.some((node, i) => node.nodeId !== values.nodeCapacities[i]?.nodeId ||
                !String(draft.nodeCapacities[i].maxConcurrent).trim() || !Number.isSafeInteger(node.maxConcurrent) || node.maxConcurrent < 1 || node.maxConcurrent > 32))
            invalid.push("nodeCapacities");
        }
        next.defaultWorkspaceId =
          String(draft.defaultWorkspaceId).trim() || null;
        for (const key of [
          "planningDecisionEnabled",
          "sessionDecisionEnabled",
        ]) {
          next[key] = draft[key];
          if (typeof next[key] !== "boolean") invalid.push(key);
        }
      } else {
        next.paused = draft.paused;
        if (typeof next.paused !== "boolean") invalid.push("paused");
        next.endpoint = String(draft.endpoint).trim() || null;
        next.audience = String(draft.audience).trim() || null;
        if (values.trustedNetworkTarget || values.endpoint === null) {
          const address = String(draft.targetAddress).trim(),
            localAddress = String(draft.targetLocalAddress).trim(),
            portText = String(draft.targetPort).trim();
          next.trustedNetworkTarget =
            !address && !localAddress && !portText
              ? null
              : {
                  ...values.trustedNetworkTarget,
                  address,
                  port: Number(portText),
                  localAddress,
                  allowHttp: true,
                };
        }
        const connectionChanged = [
          "endpoint",
          "audience",
          "trustedNetworkTarget",
        ].some(
          (key) =>
            Object.hasOwn(next, key) &&
            JSON.stringify(next[key]) !== JSON.stringify(values[key]),
        );
        if (!next.paused || connectionChanged) {
          if (
            !next.endpoint ||
            !connectionUrl(next.endpoint) ||
            next.endpoint.endsWith(":")
          )
            invalid.push("endpoint");
          if (!next.audience) invalid.push("audience");
          if (values.trustedNetworkTarget || values.endpoint === null) {
            const binding = next.trustedNetworkTarget;
            if (!binding?.address) invalid.push("targetAddress");
            if (!binding?.localAddress) invalid.push("targetLocalAddress");
            if (
              !Number.isSafeInteger(binding?.port) ||
              binding.port < 1 ||
              binding.port > 65535
            )
              invalid.push("targetPort");
          }
        }
        for (const [key, min, max] of [
          ["pollIntervalMs", 100, 3600000],
          ["concurrency", 1, 16],
        ]) {
          next[key] =
            key === "pollIntervalMs" &&
            values.endpoint === null &&
            connectionChanged
              ? 0
              : Number(draft[key]);
          if (
            String(draft[key]).trim() === "" ||
            !Number.isSafeInteger(next[key]) ||
            (key === "pollIntervalMs" && next[key] === 0
              ? false
              : next[key] < min || next[key] > max)
          )
            invalid.push(key);
        }
        if (migrate || draft.taskSessionsEnabled === true) next.taskSessionsEnabled = true;
      }
      const changes = Object.fromEntries(
        Object.entries(next).filter(
          ([key, value]) =>
            JSON.stringify(value) !== JSON.stringify(values[key]),
        ),
      );
      return { changes, invalid, dirty: Object.keys(changes).length > 0 };
    }
    function workspaceDirectoryState(row, state, selected) {
      const value = state?.value;
      const matches =
        !!value &&
        value.scope.entryId === row.entryId &&
        (!row.workspaceScope ||
          ["nodeId", "schedulerId"].every(
            (key) => value.scope[key] === row.workspaceScope[key],
          ));
      const items = matches ? value.items : [];
      const current = items.find((item) => item.workspaceId === selected);
      return {
        items,
        ready: matches && !state.loading && !state.failed,
        current,
        unavailable: !!selected && (!current || !current.available),
      };
    }
    function WorkspaceSelect({
      t,
      row,
      directory,
      refresh,
      selected,
      edit,
      disabled,
      advanced,
      controlStyle,
    }) {
      const view = workspaceDirectoryState(row, directory, selected);
      return h(
        "div",
        { "data-task-workspace-selector": true },
        h(
          "label",
          { style: { display: "block", margin: "12px 0" } },
          h(
            "span",
            { style: { display: "block", marginBottom: 6 } },
            t("defaultWorkspace"),
          ),
          h(
            "select",
            {
              id: "task-startup-task-defaultWorkspaceId",
              style: controlStyle,
              value: selected,
              disabled: disabled || !view.ready,
              onChange: (event) =>
                edit("defaultWorkspaceId", event.target.value),
            },
            h("option", { value: "" }, t("workspaceNone")),
            selected && !view.current
              ? h(
                  "option",
                  { value: selected, disabled: true },
                  t("workspaceUnavailableOption"),
                )
              : null,
            ...view.items.map((item) =>
              h(
                "option",
                {
                  key: item.workspaceId,
                  value: item.workspaceId,
                  disabled: !item.available,
                },
                `${item.title} · ${item.path}${item.available ? "" : ` · ${t("workspaceUnavailableSuffix")}`}`,
              ),
            ),
          ),
        ),
        h("p", { style: hintStyle }, t("workspaceLayoutHint")),
        directory?.loading
          ? h("p", { role: "status", style: hintStyle }, t("workspaceLoading"))
          : null,
        directory?.failed ||
          (directory?.value && !view.ready && !directory.loading)
          ? h("p", { role: "alert", style: hintStyle }, t("workspaceFailed"))
          : null,
        view.ready && view.unavailable
          ? h(
              "p",
              { role: "alert", style: hintStyle },
              t("workspaceUnavailable"),
            )
          : null,
        view.ready && !view.items.some((item) => item.available)
          ? h("p", { style: hintStyle }, t("workspaceEmpty"))
          : null,
        h(
          Button,
          {
            variant: "outline",
            onClick: refresh,
            disabled: !refresh || directory?.loading,
          },
          t("workspaceRefresh"),
        ),
        h(
          "label",
          { hidden: !advanced, style: { display: "block", margin: "12px 0" } },
          h(
            "span",
            { style: { display: "block", marginBottom: 6 } },
            t("defaultWorkspaceId"),
          ),
          h("input", {
            id: "task-startup-task-workspaceId-readonly",
            style: controlStyle,
            readOnly: true,
            value: selected,
          }),
        ),
      );
    }
    function StartupRow({
      t,
      target,
      row,
      writable,
      saveStartup,
      onSaved,
      advanced = true,
      visible = true,
      onRoleChange,
      workspaceDirectory = { loading: true },
      refreshWorkspaces,
      openAdvanced,
      openPlugins,
      openDecisionModels,
      renderDecisionModels,
      decisionAvailable = false,
      checkConnection,
      saveCoordinator,
    }) {
      const [draft, setDraft] = React.useState(() =>
        startupDraft(target, row.values),
      );
      const [status, setStatus] = React.useState({ saving: false });
      const [endpointText, setEndpointText] = React.useState(() =>
        simpleEndpointDisplay(row.values.endpoint ?? ""),
      );
      const [connection, setConnection] = React.useState({ checking: false });
      const edit = (key, value) => {
        if (key === "endpoint") setEndpointText(simpleEndpointDisplay(value));
        setConnection({ checking: false });
        if (key === "role") onRoleChange?.(value);
        setDraft((old) => ({
          ...old,
          [key]: value,
          ...(target === "remote" &&
          row.values.endpoint === null &&
          [
            "endpoint",
            "audience",
            "targetAddress",
            "targetPort",
            "targetLocalAddress",
          ].includes(key)
            ? { pollIntervalMs: "0" }
            : {}),
        }));
        setStatus({ saving: false });
      };
      const parsed = startupChanges(target, row.values, draft);
      const workspaceChanged =
        target === "task" &&
        Object.hasOwn(parsed.changes, "defaultWorkspaceId");
      const directory =
        target === "task"
          ? workspaceDirectoryState(
              row,
              workspaceDirectory,
              draft.defaultWorkspaceId,
            )
          : null;
      const workspaceInvalid =
        workspaceChanged &&
        (!directory.ready ||
          (draft.defaultWorkspaceId && directory.unavailable));
      const disabled =
        !writable ||
        status.saving ||
        connection.checking ||
        (target === "remote" && (!row.loaded || row.loaderDisabled));
      const executor = draft.role === "executor" || draft.role === "both";
      const planner = draft.role === "planner" || draft.role === "both";
      const save = async (migrate = false, selectedDraft = draft) => {
        const update = startupChanges(target, row.values, selectedDraft, migrate);
        if (
          disabled ||
          workspaceInvalid ||
          !update.dirty ||
          update.invalid.length
        )
          return;
        setStatus({ saving: true });
        try {
          await saveStartup({
            target,
            expected: row.values,
            changes: update.changes,
          });
          await onSaved();
          setStatus({ saving: false, saved: true });
          return true;
        } catch (error) {
          setStatus({
            saving: false,
            failed: true,
            errorCode:
              typeof (error?.details?.reason ?? error?.code) === "string" &&
              /^[a-z0-9_/-]{1,100}$/i.test(error?.details?.reason ?? error.code)
                ? (error?.details?.reason ?? error.code)
                : null,
          });
        }
      };

      const discardStartup = () => {setDraft(startupDraft(target,row.values));setEndpointText(simpleEndpointDisplay(row.values.endpoint ?? ""));setConnection({checking:false});onRoleChange?.(row.values.role);setStatus({saving:false});};
      useSaveParticipant(saveCoordinator, `startup-${target}`, {meta:{dirty:parsed.dirty,invalid:workspaceInvalid || parsed.invalid.length>0 || !writable,busy:status.saving || connection.checking,restart:startupNeedsRestart(target,parsed.changes)},save:()=>save(),discard:discardStartup});
      const field = (key, label = key) =>
        h(
          "label",
          {
            key,
            hidden: target === "remote" && !advanced && key !== "endpoint",
            style: { display: "block", margin: "12px 0" },
          },
          h(
            "span",
            { style: { display: "block", marginBottom: 6 } },
            t(key === "endpoint" && !advanced ? "schedulerAddress" : label),
          ),
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
                value:
                  key === "endpoint" && !advanced ? endpointText : draft[key],
                disabled:
                  disabled ||
                  (target === "task" &&
                    key === "defaultWorkspaceId" &&
                    !executor) ||
                  (target === "remote" &&
                    row.values.endpoint === null &&
                    key === "pollIntervalMs"),
                "aria-invalid": parsed.invalid.includes(key),
                inputMode: [
                  "pollIntervalMs",
                  "concurrency",
                  "targetPort",
                ].includes(key)
                  ? "numeric"
                  : undefined,
                onChange: (event) => {
                  const text = event.target.value;
                  if (key === "endpoint" && !advanced) {
                    edit(key, simpleEndpointInput(text, row.values.endpoint));
                    setEndpointText(text);
                    const url = connectionUrl(text);
                    if (
                      url &&
                      !text.trim().endsWith(":") &&
                      row.values.trustedNetworkTarget
                    )
                      setDraft((old) => ({
                        ...old,
                        targetAddress: url.hostname.replace(/^\[|\]$/g, ""),
                        targetPort: String(
                          Number(
                            url.port || (url.protocol === "http:" ? 80 : 443),
                          ),
                        ),
                      }));
                  } else edit(key, text);
                },
              }),
          key === "audience" && advanced
            ? h("p", { style: hintStyle }, t("audienceHint"))
            : null,
        );
      return h(
        "section",
        { "data-startup-target": target, hidden: !visible },
        h(
          "h4",
          { style: headingStyle, hidden: target === "task" && !advanced },
          t(
            target === "task"
              ? "startupTask"
              : advanced
                ? "startupRemote"
                : "schedulerConnection",
          ),
        ),
        target === "remote"
          ? h(
              React.Fragment,
              null,
              h(
                "p",
                { style: hintStyle, hidden: !advanced },
                `${t("startupLoaded")}: ${t(row.loaded ? "yes" : "no")} · ${t("startupLoaderDisabled")}: ${t(row.loaderDisabled ? "yes" : "no")}`,
              ),
              !row.loaded || row.loaderDisabled
                ? h(
                    "p",
                    { role: "note", style: hintStyle },
                    t("startupRemoteDisabled"),
                  )
                : null,
            )
          : null,
        field("role"),
        target === "task" && planner ? h("div", {"data-task-node-capacities": true},
          h("h4", {style: headingStyle}, t("nodeCapacityTitle")),
          h("p", {style: hintStyle}, t("nodeCapacityHint")),
          ...(draft.nodeCapacities ?? []).map((node, index) => h("div", {key:node.nodeId, style:{margin:"12px 0"}},
            h("label", {htmlFor:`task-node-capacity-${index}`, style:{display:"block", marginBottom:6}}, `${node.nodeId} · ${t("nodeCapacity")}`),
            h("input", {id:`task-node-capacity-${index}`, type:"number", min:1, max:32, step:1, style:controlStyle, value:node.maxConcurrent, disabled,
              "aria-invalid": parsed.invalid.includes("nodeCapacities") || undefined,
              onChange:event => edit("nodeCapacities", draft.nodeCapacities.map((value,i) => i === index ? {...value,maxConcurrent:event.target.value} : value))}))),
          !draft.nodeCapacities?.length ? h("p", {style:hintStyle}, t("nodeCapacityEmpty")) : null) : null,
        target === "task"
          ? h(
              React.Fragment,
              null,
              h(
                "div",
                { "data-task-scheduler-decision": true, hidden: !planner },
                h("h4", { style: headingStyle }, t("schedulerDecisionTitle")),
                h("p", { style: hintStyle }, t("schedulerDecisionHint")),
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
                  t("planningDecisionEnabled"),
                  h(Switch, {
                    label: t("planningDecisionEnabled"),
                    checked: decisionAvailable && draft.planningDecisionEnabled,
                    disabled: disabled || !planner || !decisionAvailable,
                    onChange: (value) => edit("planningDecisionEnabled", value),
                  }),
                ),
                !decisionAvailable ? h("p", {role:"note",style:hintStyle}, t("decisionDependencyRequired")) : null,
                h("p", { style: hintStyle }, t("schedulerDecisionStatus")),
                decisionAvailable && draft.planningDecisionEnabled
                  ? h(
                      "div",
                      { "data-task-scheduler-decision-entry": true },
                      h(
                        Button,
                        {
                          variant: "outline",
                          onClick: () => {
                            openDecisionModels?.("planner");
                          },
                        },
                        t("schedulerDecisionModelEntry"),
                      ),
                      renderDecisionModels?.("planner"),
                      h(
                        "div",
                        {
                          id: "task-scheduler-decision-model",
                          hidden: !advanced,
                          tabIndex: -1,
                        },
                        h(
                          "p",
                          { style: hintStyle },
                          t("schedulerDecisionSetup"),
                        ),
                        h("p", { style: hintStyle }, t("decisionHint")),
                      ),
                    )
                  : null,
              ),
              h(
                "div",
                {
                  "data-task-executor-decision": true,
                  hidden: !executor && !advanced,
                },
                h("h4", { style: headingStyle }, t("executorDecisionTitle")),
                h("p", { style: hintStyle }, t("executorDecisionHint")),
                !executor
                  ? h("p", { style: hintStyle }, t("executorDecisionInactive"))
                  : null,
                WorkspaceSelect({
                  t,
                  row,
                  directory: workspaceDirectory,
                  refresh: refreshWorkspaces,
                  selected: draft.defaultWorkspaceId,
                  edit,
                  disabled: disabled || !executor,
                  advanced,
                  controlStyle,
                }),
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
                    checked: decisionAvailable && draft.sessionDecisionEnabled,
                    disabled: disabled || !executor || !decisionAvailable,
                    onChange: (value) => edit("sessionDecisionEnabled", value),
                  }),
                ),
                !decisionAvailable ? h("p", {role:"note",style:hintStyle}, t("decisionDependencyRequired")) : null,
                h("p", { style: hintStyle }, t("workspaceHint")),
                decisionAvailable && executor && draft.sessionDecisionEnabled
                  ? h(
                      "div",
                      { "data-task-decision-entry": true },
                      h("p", { style: hintStyle }, t("decisionModelStatus")),
                      h(
                        Button,
                        {
                          variant: "outline",
                          onClick: () => {
                            openDecisionModels?.("executor");
                          },
                        },
                        t("decisionModelEntry"),
                      ),
                      renderDecisionModels?.("executor"),
                      h(
                        "div",
                        {
                          id: "task-decision-model",
                          hidden: !advanced,
                          tabIndex: -1,
                        },
                        h("p", { style: hintStyle }, t("decisionModelSetup")),
                        h("p", { style: hintStyle }, t("decisionHint")),
                      ),
                    )
                  : null,
              ),
            )
          : h(
              React.Fragment,
              null,
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
                  "data-task-availability-switch": true,
                },
                t(executor ? "executorEnabled" : "remoteEnabled"),
                h(Switch, {
                  label: t(executor ? "executorEnabled" : "remoteEnabled"),
                  checked: !draft.paused,
                  disabled: disabled || parsed.invalid.length > 0,
                  onChange: async (enabled) => {
                    const next = { ...draft, paused: !enabled };
                    setDraft(next);
                    setConnection({ checking: false });
                    if (!saveCoordinator && !await save(false, next)) setDraft(draft);
                  },
                }),
              ),
              draft.paused
                ? h(
                    "p",
                    { role: "status", style: hintStyle },
                    t("remotePausedStatus"),
                  )
                : null,
              h("p", { style: hintStyle }, t(executor ? "executorEnabledHint" : "remoteEnabledHint")),
              executor && !row.values.paused
                ? h("p", { role: "status", style: hintStyle, "data-task-heartbeat-status": true },
                    t(`heartbeat_${row.heartbeat?.state ?? "waiting"}`),
                    row.heartbeat?.acknowledgedAt ? ` · ${new Date(row.heartbeat.acknowledgedAt).toLocaleString()}` : "")
                : null,
              ...["endpoint", "audience", "pollIntervalMs", "concurrency"].map(
                (key) => field(key),
              ),
              row.values.trustedNetworkTarget || row.values.endpoint === null
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
              row.values.endpoint === null
                ? h(
                    "p",
                    { style: hintStyle, hidden: !advanced },
                    t("startupUnconfigured"),
                  )
                : null,
              h(
                "p",
                { style: hintStyle, hidden: !advanced },
                t("startupEndpointHint"),
              ),
              !advanced
                ? h(
                    "div",
                    { "data-task-connection-status": true },
                    h(
                      "p",
                      {
                        role: "status",
                        style: hintStyle,
                        hidden: !!connection.value,
                      },
                      t(
                        row.values.endpoint === null ||
                          !row.loaded ||
                          row.loaderDisabled
                          ? "connectionSetupStatus"
                          : "connectionUnconfirmed",
                      ),
                    ),
                    h(
                      Button,
                      {
                        variant: "outline",
                        onClick: () =>
                          openAdvanced?.("task-startup-remote-endpoint"),
                      },
                      t("openAdvanced"),
                    ),
                  )
                : null,
              row.values.taskSessionsEnabled === false &&
                row.values.endpoint !== null
                ? h(
                    React.Fragment,
                    null,
                    h(
                      "p",
                      { style: hintStyle, hidden: !advanced },
                      t("startupMigrationHint"),
                    ),
                    h(
                      Button,
                      {
                        variant: "outline",
                        hidden: !advanced,
                        disabled: disabled || parsed.invalid.length > 0,
                        onClick: () => saveCoordinator ? edit("taskSessionsEnabled",true) : save(true),
                      },
                      t("startupMigration"),
                    ),
                  )
                : null,
            ),
        target === "remote"
          ? h(
              "div",
              { "data-task-connection-check": true },
              h("p", { style: hintStyle }, t("connectionPortHint")),
              h(
                Button,
                {
                  variant: "outline",
                  disabled:
                    disabled ||
                    !checkConnection ||
                    parsed.invalid.length > 0 ||
                    !draft.endpoint,
                  onClick: async () => {
                    setConnection({ checking: true });
                    try {
                      const selected = { ...row.values, ...parsed.changes };
                      const value = await checkConnection({
                        expected: row.values,
                        endpoint: selected.endpoint,
                        trustedNetworkTarget: selected.trustedNetworkTarget,
                      });
                      setConnection({ checking: false, value });
                    } catch (error) {
                      setConnection({
                        checking: false,
                        value: {
                          connected: false,
                          code:
                            error?.details?.reason ??
                            error?.code ??
                            "CONNECTION_FAILED",
                        },
                      });
                    }
                  },
                },
                t(
                  connection.checking
                    ? "connectionChecking"
                    : "connectionCheck",
                ),
              ),
              connection.value
                ? h(
                    "p",
                    {
                      role: connection.value.connected ? "status" : "alert",
                      style: {
                        ...hintStyle,
                        color: connection.value.connected
                          ? "#93C9A3"
                          : "#E58F8F",
                      },
                    },
                    connection.value.connected
                      ? t("connectionCheckOk")
                      : `${t("connectionCheckFailed")}：${t(`connectionError_${connection.value.code}`) === `connectionError_${connection.value.code}` ? connection.value.code : t(`connectionError_${connection.value.code}`)}`,
                    connection.value.identity
                      ? ` · ${connection.value.identity.nodeId} · ${connection.value.identity.executorId}`
                      : "",
                    connection.value.paused
                      ? ` ${t("connectionCheckPaused")}`
                      : "",
                  )
                : null,
            )
          : null,
        parsed.invalid.length
          ? h(
              "p",
              { role: "alert", hidden: !advanced && target === "remote" },
              t("startupInvalid"),
            )
          : null,
        status.failed
          ? h(
              "p",
              { role: "alert" },
              t(`startupError_${status.errorCode}`) ===
                `startupError_${status.errorCode}`
                ? t("startupSaveFailed")
                : t(`startupError_${status.errorCode}`),
              status.errorCode ? ` (${status.errorCode})` : "",
            )
          : null,
        status.saved ? h("p", { role: "status" }, t("startupSaved")) : null,
        !saveCoordinator ? h(
          "div",
          {
            style: {
              display: "flex",
              flexWrap: "wrap",
              gap: 12,
              marginTop: 14,
            },
          },
          h(
            Button,
            {
              variant: "outline",
              disabled:
                disabled ||
                workspaceInvalid ||
                !parsed.dirty ||
                parsed.invalid.length > 0,
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
                setEndpointText(
                  simpleEndpointDisplay(row.values.endpoint ?? ""),
                );
                setConnection({ checking: false });
                onRoleChange?.(row.values.role);
                setStatus({ saving: false });
              },
            },
            t("discardDraft"),
          ),
        ) : null,
      );
    }
    function StartupSettings({
      t,
      startup,
      saveStartup,
      readWorkspaces,
      onSaved,
      advanced = true,
      openAdvanced,
      openPlugins,
      openDecisionModels,
      renderDecisionModels,
      checkConnection,
      saveCoordinator,
    }) {
      const { state, refresh, replace } = useReadSnapshot(startup);
      const workspaceScopeKey = JSON.stringify([
        state.value?.task?.entryId,
        state.value?.task?.workspaceScope,
      ]);
      const workspaceRead = React.useCallback(
        () => readWorkspaces(),
        [readWorkspaces, workspaceScopeKey],
      );
      const workspaceCatalog = useReadSnapshot(
        workspaceRead,
        !!readWorkspaces && !!state.value?.task,
      );
      const [taskRole, setTaskRole] = React.useState(null);
      const savedRoleKey =
        state.value?.task?.entryId +
        JSON.stringify(state.value?.task?.values) +
        workspaceScopeKey;
      React.useEffect(() => {
        setTaskRole(state.value?.task?.values.role ?? null);
      }, [savedRoleKey]);
      const role = taskRole ?? state.value?.task?.values.role;
      const executor = role === "executor" || role === "both";
      const planner = role === "planner" || role === "both";
      const afterSave = async () => {
        // Clear the old connection summary before reading the new plugin state.
        onSaved();
        const value = await startup();
        replace(value);
        if (readWorkspaces) workspaceCatalog.refresh();
      };
      return h(
        "section",
        { "data-task-startup-settings": true },
        h("h3", { style: headingStyle }, t("startupEditable")),
        h(
          "p",
          { style: hintStyle, hidden: !advanced },
          t("startupRestartHint"),
        ),
        state.value?.restartBlockers?.length ? h("details", {"data-task-restart-blockers":true},
          h("summary",null,`有 ${state.value.restartBlockers.length} 项执行／恢复记录会阻止重启类变更；即时设置可正常保存`),
          ...state.value.restartBlockers.map(run=>h("p",{key:run.runId,style:hintStyle},`${run.title} · ${run.state} · ${run.runId}`))) : null,
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
                      JSON.stringify(state.value.task.values) +
                      workspaceScopeKey,
                    t,
                    target: "task",
                    advanced,
                    openAdvanced,
                    openPlugins,
                    openDecisionModels,
                    renderDecisionModels,
                    onRoleChange: setTaskRole,
                    workspaceDirectory: workspaceCatalog.state,
                    refreshWorkspaces: workspaceCatalog.refresh,
                    row: state.value.task,
                    decisionAvailable: state.value.task.decisionAvailable === true,
                    writable: state.value.writable,
                    saveStartup,
                    saveCoordinator,
                    onSaved: afterSave,
                  })
                : h("p", { style: hintStyle }, t("startupUnavailable")),
              !advanced && planner
                ? h(
                    "section",
                    { "data-task-executor-connections": true },
                    h("h4", { style: headingStyle }, t("executorConnections")),
                    h(
                      "p",
                      { role: "status", style: hintStyle },
                      t("executorSetupStatus"),
                    ),
                    h(
                      Button,
                      {
                        variant: "outline",
                        onClick: () => openAdvanced?.("task-startup-task-role"),
                      },
                      t("openAdvanced"),
                    ),
                  )
                : null,
              state.value.remote
                ? h(StartupRow, {
                    key:
                      state.value.remote.entryId +
                      JSON.stringify(state.value.remote.values),
                    t,
                    target: "remote",
                    checkConnection,
                    advanced,
                    visible: advanced || executor,
                    openAdvanced,
                    row: state.value.remote,
                    writable: state.value.writable,
                    saveStartup,
                    saveCoordinator,
                    onSaved: afterSave,
                  })
                : executor || advanced
                  ? h(
                      "div",
                      null,
                      h(
                        "p",
                        { role: "status", style: hintStyle },
                        t("connectionSetupStatus"),
                      ),
                      h(
                        Button,
                        {
                          variant: "outline",
                          onClick: () =>
                            openAdvanced?.("task-startup-task-role"),
                        },
                        t("openAdvanced"),
                      ),
                    )
                  : null,
            )
          : null,
        h(
          Button,
          { variant: "outline", onClick: refresh, disabled: state.loading },
          t("startupRefresh"),
        ),
      );
    }
    const decisionSettingsDescriptor = {
      id: "@dsh-task/task-system#taskPluginSettings/decisionSettings",
      service: NS,
      namespace: NS,
      method: "decisionSettings",
      invocation: { kind: "direct" },
      parameters: [],
      result: {
        mode: "strict",
        typeSymbol: "@dsh-task/task-system#DecisionSettings",
        create: () => ({
          parse(value) {
            if (
              !value ||
              typeof value.available !== "boolean" ||
              typeof value.writable !== "boolean" ||
              !Array.isArray(value.catalog) ||
              !Array.isArray(value.readiness) ||
              (value.snapshot !== null &&
                (!value.snapshot ||
                  typeof value.snapshot.entryId !== "string" ||
                  !Array.isArray(value.snapshot.providers)))
            )
              throw Error("Invalid decision settings");
            return value;
          },
        }),
      },
    };
    function parseDecisionInput(value) {
      const keys = {
        rules: ["kind", "providerId"],
        structured: ["kind", "providerId", "nativeProvider", "modelVersion"],
        jev: ["kind", "providerId", "model", "modelVersion"],
        compatible: ["kind", "providerId", "model", "modelVersion", "endpoint"],
      };
      const selection = value?.selection,
        fields = keys[selection?.kind];
      if (
        !value ||
        Object.keys(value).sort().join() !== "expected,selection" ||
        !value.expected?.entryId ||
        !fields ||
        Object.keys(selection).sort().join() !== [...fields].sort().join() ||
        fields.some(
          (k) => typeof selection[k] !== "string" || !selection[k].trim(),
        )
      )
        throw Error("Invalid decision selection");
      return value;
    }
    const saveDecisionSettingsDescriptor = {
      id: "@dsh-task/task-system#taskPluginSettings/saveDecisionSettings",
      service: NS,
      namespace: NS,
      method: "saveDecisionSettings",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "input",
          wire: "input",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "@dsh-task/task-system#SaveDecisionInput",
            create: () => ({ parse: parseDecisionInput }),
          },
        },
      ],
      result: {
        mode: "strict",
        typeSymbol: "@dsh-task/task-system#SaveDecisionResult",
        create: () => ({
          parse(value) {
            if (value?.saved !== true || value.applies !== "plugin-restart")
              throw Error("Unconfirmed decision save");
            return value;
          },
        }),
      },
    };
    const decisionPresetDescriptors = ["decisionConsole", "setDecisionPreset"].map(method => ({
      id: `@dsh-task/task-system#taskPluginSettings/${method}`, service:"taskPluginSettings", namespace:"taskPluginSettings", method,
      invocation:{kind:"direct"}, parameters: method === "setDecisionPreset" ? [{name:"input",wire:"input",source:"json",codec:{mode:"strict",typeSymbol:"@dsh-task/task-system#SetDecisionPresetInput",create:()=>({parse:value=>value})}}] : [],
      result:{mode:"strict",typeSymbol:`@dsh-task/task-system#${method}Result`,create:()=>({parse(value){if(!value || typeof value!=="object")throw Error("Invalid decision preset response");return value;}})},
    }));
    function decisionChoices(snapshot) {
      const choices = snapshot.providers.map((p) => ({
        id: p.id,
        kind: p.kind,
        label: `${p.kind === "structured" ? "DSH LLM" : p.kind === "jev" ? "Typesafe Jev" : p.kind === "compatible" ? "AnyJev compatible" : "Rules"} · ${p.id}`,
      }));
      for (const [kind, base, label] of [
        ["structured", "ordinary", "DSH LLM"],
        ["jev", "typesafe", "Typesafe Jev"],
      ]) {
        if (choices.some((p) => p.kind === kind)) continue;
        let id = base;
        for (let n = 2; choices.some((p) => p.id === id); n++)
          id = `${base}-${n}`;
        choices.push({ id, kind, label });
      }
      return choices;
    }
    function decisionDraft(snapshot, providerId = snapshot.defaultProvider) {
      const kind =
        decisionChoices(snapshot).find((p) => p.id === providerId)?.kind ??
        "rules";
      const p = snapshot.providers.find((p) => p.id === providerId),
        model = p?.models?.[0];
      const route = snapshot.completion?.routes.find(
        (r) => r.model === model?.model && r.modelVersion === model.version,
      );
      return kind === "structured"
        ? {
            kind,
            providerId,
            nativeProvider: route?.provider ?? "",
            modelVersion: route?.modelVersion ?? "",
          }
        : kind === "rules"
          ? { kind, providerId }
          : {
              kind,
              providerId,
              model: p?.model ?? "jev-1.13.0",
              modelVersion: p?.modelVersion ?? "jev-1.13.0",
              ...(kind === "compatible" ? { endpoint: p?.endpoint ?? "" } : {}),
            };
    }
    function DecisionModelRow({
      t,
      value,
      saveDecisionSettings,
      onSaved,
      openModels,
    }) {
      const snapshot = value.snapshot;
      const [draft, setDraft] = React.useState(() => decisionDraft(snapshot));
      const [expected, setExpected] = React.useState(snapshot);
      const [status, setStatus] = React.useState({ saving: false });
      const choices = decisionChoices(snapshot),
        selectedNative = value.catalog.find(
          (p) => p.provider === draft.nativeProvider,
        );
      const edit = (key, text) => {
        setDraft((old) => ({ ...old, [key]: text }));
        setStatus({ saving: false });
      };
      const valid =
        Object.entries(draft).every(
          ([, v]) => typeof v === "string" && v.trim(),
        ) &&
        (draft.kind !== "structured" ||
          (snapshot.completion &&
            selectedNative?.available &&
            selectedNative.models.some((m) => m.id === draft.modelVersion)));
      const dirty =
        JSON.stringify(draft) !== JSON.stringify(decisionDraft(expected));
      const disabled = !value.writable || status.saving;
      const select = (key, label, items) =>
        h(
          "label",
          { style: { display: "block", margin: "12px 0" } },
          h("span", { style: { display: "block", marginBottom: 6 } }, label),
          h(
            "select",
            {
              id: `task-decision-${key}`,
              style: controlStyle,
              value: draft[key],
              disabled,
              onChange: (e) => {
                if (key === "providerId")
                  setDraft(decisionDraft(snapshot, e.target.value));
                else if (key === "nativeProvider")
                  setDraft((old) => ({
                    ...old,
                    nativeProvider: e.target.value,
                    modelVersion: "",
                  }));
                else edit(key, e.target.value);
                setStatus({ saving: false });
              },
            },
            h("option", { value: "" }, t("decisionChoose")),
            draft[key] && !items.some((i) => i.id === draft[key])
              ? h(
                  "option",
                  { value: draft[key], disabled: true },
                  `${draft[key]} · ${t("workspaceUnavailableSuffix")}`,
                )
              : null,
            ...items.map((i) =>
              h(
                "option",
                { key: i.id, value: i.id, disabled: i.available === false },
                i.label ?? i.name,
              ),
            ),
          ),
        );
      const text = (key, label) =>
        h(
          "label",
          { style: { display: "block", margin: "12px 0" } },
          h("span", { style: { display: "block", marginBottom: 6 } }, label),
          h("input", {
            id: `task-decision-${key}`,
            style: controlStyle,
            value: draft[key],
            disabled,
            onChange: (e) => edit(key, e.target.value),
          }),
        );
      const readiness = value.readiness.find(
        (p) => p.providerId === snapshot.defaultProvider,
      )?.status;
      const credentialMissing =
        draft.kind === "structured"
          ? selectedNative?.credential === "missing"
          : ["jev", "compatible"].includes(draft.kind) &&
            (!snapshot.providers.some((p) => p.id === draft.providerId) ||
              value.readiness.find((p) => p.providerId === draft.providerId)
                ?.status === "credential-missing");
      return h(
        "div",
        { "data-decision-model-form": true },
        h("p", { style: hintStyle }, t("decisionShared")),
        readiness
          ? h(
              "p",
              { role: "status", style: hintStyle },
              `${t("decisionCurrent")}: ${t(`decisionStatus_${readiness}`)}`,
            )
          : null,
        select("providerId", t("decisionMode"), choices),
        h(
          "p",
          { style: hintStyle, "data-decision-kind-help": draft.kind },
          t(`decisionKind_${draft.kind}`),
        ),
        draft.kind === "structured"
          ? h(
              React.Fragment,
              null,
              select(
                "nativeProvider",
                t("decisionProvider"),
                value.catalog.map((p) => ({
                  id: p.provider,
                  name: p.name,
                  available: p.available,
                })),
              ),
              select(
                "modelVersion",
                t("decisionModel"),
                selectedNative?.models ?? [],
              ),
              !snapshot.completion
                ? h("p", { role: "alert" }, t("decisionBridgeMissing"))
                : null,
              !value.catalog.length
                ? h("p", { role: "status" }, t("decisionCatalogEmpty"))
                : null,
            )
          : ["jev", "compatible"].includes(draft.kind)
            ? h(
                React.Fragment,
                null,
                text("model", t("decisionModelSelector")),
                text("modelVersion", t("decisionModelVersion")),
                draft.kind === "compatible"
                  ? text("endpoint", t("decisionEndpoint"))
                  : null,
              )
            : null,
        credentialMissing
          ? h("p", { role: "status" }, t("decisionCredentialMissing"))
          : null,
        h(
          Button,
          {
            variant: "outline",
            onClick: () => {
              if (!openModels?.())
                setStatus({ saving: false, code: "MODELS_GUI_UNAVAILABLE" });
            },
          },
          t("decisionManageModels"),
        ),
        h("p", { style: hintStyle }, t("decisionRestart")),
        status.code
          ? h(
              "p",
              { role: "alert" },
              t(
                status.code === "MODELS_GUI_UNAVAILABLE"
                  ? "decisionModelsUnavailable"
                  : status.code === "DECISION_CONFLICT"
                    ? "decisionConflict"
                    : "decisionSaveFailed",
              ),
              ` (${status.code})`,
            )
          : null,
        status.saved ? h("p", { role: "status" }, t("startupSaved")) : null,
        h(
          "div",
          {
            style: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 },
          },
          h(
            Button,
            {
              variant: "outline",
              disabled: disabled || !dirty || !valid,
              onClick: async () => {
                setStatus({ saving: true });
                try {
                  await saveDecisionSettings(
                    parseDecisionInput({ expected, selection: draft }),
                  );
                  const saved = await onSaved();
                  setExpected(saved.snapshot);
                  setDraft(decisionDraft(saved.snapshot));
                  setStatus({ saving: false, saved: true });
                } catch (error) {
                  setStatus({
                    saving: false,
                    code:
                      error?.message?.match(/DECISION_[A-Z_]+/)?.[0] ??
                      error?.code ??
                      "DECISION_SAVE_REJECTED",
                  });
                }
              },
            },
            t(status.saving ? "startupSaving" : "decisionSave"),
          ),
          h(
            Button,
            {
              variant: "outline",
              disabled:
                status.saving ||
                (!dirty &&
                  JSON.stringify(expected) === JSON.stringify(snapshot)),
              onClick: () => {
                setDraft(decisionDraft(snapshot));
                setExpected(snapshot);
                setStatus({ saving: false });
              },
            },
            t("discardDraft"),
          ),
        ),
      );
    }
    function DecisionPresetSettings({role, readDecisionConsole, setDecisionPreset, openDecisions, close, saveCoordinator}) {
      const {state, refresh} = useReadSnapshot(readDecisionConsole);
      const [selected, select] = React.useState(null), [saving, setSaving] = React.useState(false), [message, setMessage] = React.useState(null);
      const consumer = role === "planner" ? "task-planning" : "task-session";
      const current = state.value?.bindings?.[consumer] ?? "";
      const choice = selected ?? current;
      const savePreset=async()=>{setSaving(true);setMessage(null);try {await setDecisionPreset({expected:state.value.revision,consumer,id:choice});select(null);await refresh();setMessage("预设选择已保存。");return true;} catch(error){setMessage(error?.details?.reason==="DECISION_CONFLICT" ? "配置已变化，请刷新后核对草稿。" : "保存未能确认，请查看决策插件状态。");return false;} finally {setSaving(false);}};
      useSaveParticipant(saveCoordinator,`preset-${consumer}`,{meta:{dirty:choice!==current,invalid:!state.value?.writable,busy:saving,restart:false},save:savePreset,discard:()=>{select(null);setMessage(null);}});
      return h("section", {"data-decision-model-settings": true, id:"task-decision-model-form", tabIndex:-1},
        h("h4", {style:headingStyle}, "决策预设"),
        h("p", {style:hintStyle}, "在本插件选择预设。服务商、模型与思考强度在“JEV”中管理。此处只选择任务调用的模型配置。"),
        state.failed ? h("p", {role:"alert"}, "无法读取决策预设，请检查 Jev 是否启用。") : null,
        state.value ? h(React.Fragment, null,
          h("label", {htmlFor:"task-preset-select",style:{display:"block",margin:"12px 0 6px"}}, role === "planner" ? "选择执行者使用的预设" : "选择工作区与会话使用的预设"),
          h("select", {id:"task-preset-select", value:choice, disabled:saving || !state.value.writable, style:controlStyle, onChange:e=>{select(e.target.value);setMessage(null);}},
            h("option", {value:""}, "跟随 Jev 默认服务商与模型"),
            ...(state.value.presets ?? []).map(p => h("option", {key:p.id,value:p.id}, p.name))),
          message ? h("p", {role:"status",style:hintStyle}, message) : null,
          !saveCoordinator ? h(Button, {variant:"outline",disabled:saving || !state.value.writable || choice===current,onClick:savePreset}, saving ? "保存中…" : "保存预设选择") : null) : h("p", {style:hintStyle}, "正在读取预设…"),
        h("div", {style:{display:"flex",flexWrap:"wrap",gap:8,marginTop:12}},
          h(Button, {variant:"outline",onClick:()=>{if(!openDecisions())setMessage("请打开设置 → JEV。");}}, "打开 JEV 设置"),
          h(Button, {variant:"outline",disabled:state.loading,onClick:refresh}, "刷新预设"),
          h(Button, {variant:"outline",onClick:close}, "关闭预设选择")));
    }
    function DecisionModelSettings({
      t,
      readDecisionSettings,
      saveDecisionSettings,
      openModels,
      close,
    }) {
      const { state, refresh, replace } = useReadSnapshot(readDecisionSettings);
      return h(
        "section",
        {
          "data-decision-model-settings": true,
          id: "task-decision-model-form",
          tabIndex: -1,
        },
        h("h3", { style: headingStyle }, t("decisionFormTitle")),
        state.loading && !state.value
          ? h("p", { role: "status" }, t("loading"))
          : null,
        state.failed
          ? h("p", { role: "alert" }, t("decisionReadFailed"))
          : null,
        state.value?.snapshot
          ? h(DecisionModelRow, {
              key: state.value.snapshot.entryId,
              t,
              value: state.value,
              saveDecisionSettings,
              onSaved: async () => {
                const current = await readDecisionSettings();
                replace(current);
                return current;
              },
              openModels,
            })
          : state.value
            ? h("p", { role: "status" }, t("decisionUnavailable"))
            : null,
        h(
          "div",
          {
            style: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 },
          },
          h(
            Button,
            { variant: "outline", onClick: refresh, disabled: state.loading },
            t("refresh"),
          ),
          h(Button, { variant: "outline", onClick: close }, t("decisionClose")),
        ),
      );
    }

    function ProjectWorkspaceSettings({ readProjectSettings, saveProjectSettings, saveCoordinator }) {
      const {state, replace, refresh} = useReadSnapshot(readProjectSettings);
      const [root, setRoot] = React.useState(null), [saving, setSaving] = React.useState(false), [notice, setNotice] = React.useState("");
      const saveRoot=async()=>{setSaving(true);setNotice("");try {const value=await saveProjectSettings({root:(root ?? state.value.root).trim(),expectedRevision:state.value.revision});replace({enabled:true,...value});setRoot(null);setNotice("项目父目录已保存");return true;} catch {setNotice("保存失败，请核对路径或刷新后重试；草稿已保留。");return false;} finally {setSaving(false);}};
      useSaveParticipant(saveCoordinator,"project-root",{meta:{dirty:root!==null && root!==state.value?.root,invalid:!state.value?.enabled || !(root ?? state.value?.root ?? "").trim(),busy:saving,restart:false},save:saveRoot,discard:()=>{setRoot(null);setNotice("");}});
      if (state.value && !state.value.enabled) return null;
      return h("section", {"data-project-workspace-settings": true},
        h("h3", {style: headingStyle}, "调度端 · 项目工作区"),
        h("p", {style: hintStyle}, "项目和临时任务的规划工作区父目录。只影响新建工作区；执行端使用自己已授权的目录。"),
        state.failed ? h("p", {role:"alert"}, "读取项目父目录失败，请刷新重试。") : null,
        h("label", {htmlFor:"task-project-root"}, "项目父目录"),
        h("input", {id:"task-project-root", value:root ?? state.value?.root ?? "", placeholder:"/absolute/path/projects", style:{display:"block",width:"100%",boxSizing:"border-box",margin:"8px 0 12px"}, disabled:!state.value?.enabled || saving, onChange:event=>{setRoot(event.target.value);setNotice("");}}),
        !saveCoordinator ? h(Button,{variant:"outline",disabled:!state.value?.enabled || saving,onClick:saveRoot},saving ? "正在保存…" : "保存项目父目录") : null,
        h(Button, {variant:"outline",style:{marginLeft:8},disabled:saving,onClick:()=>{setRoot(null);setNotice("");refresh();}}, "刷新"),
        notice ? h("p", {role:"status",style:hintStyle}, notice) : null);
    }
    function Page(props) {
      const { t } = props;
      const registryRef=React.useRef(null);if (!registryRef.current) registryRef.current=new SettingsSaveCoordinator();
      const saveCoordinator=registryRef.current;
      const [,redrawSave]=React.useState(0);
      React.useEffect(()=>saveCoordinator.subscribe(()=>redrawSave(value=>value+1)),[saveCoordinator]);
      const [refreshKey, setRefreshKey] = React.useState(0);
      const [advanced, setAdvanced] = React.useState(false);
      const [modelOpen, setModelOpen] = React.useState(false);
      const openDecisionModels = (role) => {
        setModelOpen(role);
        requestAnimationFrame(() =>
          document.getElementById("task-decision-model-form")?.focus(),
        );
      };
      const openAdvanced = (id) => {
        setAdvanced(true);
        requestAnimationFrame(() => document.getElementById(id)?.focus());
      };
      const state = props.useTaskSettings((snapshot) => snapshot);
      useSaveParticipant(saveCoordinator,"runtime",{meta:{dirty:state.dirty,invalid:state.invalid || !state.writable,busy:state.saving,restart:false},save:props.save,discard:props.discard});
      const saveState=saveCoordinator.snapshot();
      if (props.view === "summary") return t("summary");
      return h(
        "div",
        { "data-task-plugin-settings": true, style:{minHeight:"100%",display:"flex",flexDirection:"column"} },
        h(
          "style",
          null,
          `[data-task-plugin-settings] { min-width: 0; overflow-wrap: anywhere; }
          [data-task-plugin-settings] [hidden] { display: none !important; }
          [data-task-plugin-settings] input, [data-task-plugin-settings] select { min-width: 0; max-width: 100%; }
          [data-task-plugin-settings] [role="switch"] { flex-shrink: 0; }
          [data-task-plugin-settings] button:not([role="switch"]) { border: 1px solid var(--dsw-alias-border-l3, #8a8a8a) !important; }
          [data-task-plugin-settings] button:not([role="switch"]) { border-radius: 6px; background: var(--dsw-alias-bg-layer-2, #e9e9e9); padding: 7px 12px; color: var(--dsw-alias-label-primary, #252525); }
          [data-task-plugin-settings] button:not([role="switch"]):disabled { color: var(--dsw-alias-label-secondary, #666); opacity: 1; cursor: not-allowed; }
          [data-task-plugin-settings] [data-task-detail-row] { align-items: start; }
          [data-task-plugin-settings] table th, [data-task-plugin-settings] table td { vertical-align: top; text-align: left; }
          [data-task-plugin-settings] button:focus-visible, [data-task-plugin-settings] input:focus-visible, [data-task-plugin-settings] select:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
          [data-task-plugin-settings] section, [data-task-plugin-settings] [data-task-runtime] { border-top: 1px solid var(--dsw-alias-border-l3, #8a8a8a); padding-top: 18px; margin-top: 22px; }
          [data-task-plugin-settings] [data-task-startup-settings] > [data-startup-target="task"] { border-top: 0; padding-top: 0; margin-top: 0; }
          [data-task-plugin-settings] section > h3:first-child, [data-task-plugin-settings] section > h4:first-child { margin-top: 0 !important; }
          [data-task-plugin-settings] [data-task-runtime-form] > div > div:last-child > button { display:none; }
          [data-task-plugin-settings] [data-task-save-bar] { position:sticky; bottom:0; z-index:5; margin-top:20px; padding:12px; background:var(--dsw-alias-bg-layer-1,#fff); border-top:1px solid var(--dsw-alias-border-l3,#8a8a8a); box-shadow:0 -4px 12px rgba(0,0,0,.12); }
          [data-task-plugin-settings] [data-task-mode] { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
          [data-task-plugin-settings] [data-task-mode] [aria-pressed="true"] { font-weight: 600; box-shadow: inset 0 -2px currentColor; }
          @media (max-width: 640px) {
            /* Scope the Host shell adaptation to the active task page. */
            [role="dialog"]:has([data-task-plugin-settings]) { flex-direction: column; position: relative; width: calc(100vw - 24px); max-height: calc(100dvh - 24px); }
            [role="dialog"]:has([data-task-plugin-settings]) > nav { width: 100%; height: auto; box-sizing: border-box; padding: 12px 16px; flex: 0 0 auto; }
            [role="dialog"]:has([data-task-plugin-settings]) > nav > div:last-child { display: flex; flex-direction: row; flex-wrap: wrap; gap: 4px; padding-top: 8px; }
            [role="dialog"]:has([data-task-plugin-settings]) > nav > div:last-child > button { flex: 0 0 auto; width: auto; min-height: 44px; padding: 6px 10px; }
            [role="dialog"]:has([data-task-plugin-settings]) > nav + div { width: 100%; min-width: 0; min-height: 0; flex: 1 1 auto; }
            [role="dialog"]:has([data-task-plugin-settings]) > nav + div > div:first-child { position: static; height: 0; padding: 0; flex: 0 0 auto; }
            [role="dialog"]:has([data-task-plugin-settings]) > nav + div > div:first-child button { position: absolute; top: 12px; right: 12px; }
            [role="dialog"]:has([data-task-plugin-settings]) > nav + div > div:last-child { padding: 16px; }
            [data-task-plugin-settings] [data-task-detail-row] { display: block !important; }
            [data-task-plugin-settings] button:not([role="switch"]), [data-task-plugin-settings] input, [data-task-plugin-settings] select { min-height: 44px; }
          }`,
        ),
        h(
          "div",
          {
            "data-task-mode": true,
            role: "group",
            "aria-label": t("settingsMode"),
          },
          h(
            Button,
            {
              variant: "outline",
              "aria-pressed": !advanced,
              onClick: () => setAdvanced(false),
            },
            t("simpleMode"),
          ),
          h(
            Button,
            {
              variant: "outline",
              "aria-pressed": advanced,
              onClick: () => setAdvanced(true),
            },
            t("advancedMode"),
          ),
        ),
        h("p", { style: hintStyle }, t("simpleHint")),
        props.startup
          ? h(StartupSettings, {
              t,
              startup: props.startup,
              readWorkspaces: props.readWorkspaces,
              saveStartup: props.saveStartup,
              onSaved: () => setRefreshKey((value) => value + 1),
              advanced,
              openAdvanced,
              openPlugins: props.openPlugins,
              openDecisionModels,
              checkConnection: props.checkConnection,
              saveCoordinator,
              renderDecisionModels: (role) =>
                modelOpen === role
                  ? h(DecisionPresetSettings, {
                      role,
                      readDecisionConsole: props.readDecisionConsole,
                      setDecisionPreset: props.setDecisionPreset,
                      openDecisions: props.openDecisions,
                      close: () => setModelOpen(false),
                      saveCoordinator,
                    })
                  : null,
            })
          : null,
        h(ProjectWorkspaceSettings, {readProjectSettings:props.readProjectSettings,saveProjectSettings:props.saveProjectSettings,saveCoordinator}),
        h(LocalQueue, {
          key: refreshKey,
          t,
          readQueue: props.readQueue,
          advanced,
        }),
        h(
          "div",
          { hidden: !advanced, "data-task-advanced": true },
          h(
            "p",
            {
              role: "note",
              style: {
                ...hintStyle,
                padding: 12,
                border: "1px solid var(--dsw-alias-border-l3, #8a8a8a)",
                borderRadius: 8,
              },
            },
            t("safety"),
          ),
          h(
            "section",
            { "data-task-runtime": true },
            h("h3", { style: headingStyle }, t("runtime")),
            h("p", { style: hintStyle }, t("savedHint")),
            h("div", {"data-task-runtime-form":true}, h(
              SettingsForm,
              {
                state,
                labels: Object.fromEntries(
                  [
                    "unavailable",
                    "readOnly",
                    "save",
                    "saving",
                    "saveFailed",
                  ].map((k) => [k, t(k)]),
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
            )),
          ),
          h(ReadOnly, {
            key: refreshKey,
            t,
            read: props.read,
            queryIdentity: props.queryIdentity,
          }),
        ),
        h("div", {"data-task-save-bar":true},
          h("p",{role:"status",style:{...hintStyle,margin:"0 0 8px"}},saveState.message || (saveState.count ? `有 ${saveState.count} 处未保存修改。${saveState.restart ? "包含需重启插件的变更。" : "保存后即时生效，已有运行保持原配置。"}` : "设置已保存；修改后在此统一保存。")),
          h("div",{style:{display:"flex",flexWrap:"wrap",gap:8}},
            h(Button,{variant:"outline",disabled:!saveState.count || saveState.invalid || saveState.busy,onClick:()=>saveCoordinator.saveAll()},saveState.busy ? "保存中…" : saveState.restart ? "保存并重启插件" : "保存设置"),
            h(Button,{variant:"outline",disabled:!saveState.count || saveState.busy,onClick:()=>saveCoordinator.discardAll()},"丢弃全部草稿")))
      );
    }
    async function readRemote(ctx, method, codec, ...args) {
      // $mount owns a separate Cordis namespace. This dynamically mounted service
      // is read through the documented Context.get API, not an undeclared inject.
      const service = ctx.get("remote.taskPluginSettings");
      if (!service || typeof service[method] !== "function")
        throw Object.assign(new Error("Task settings service is unavailable"), {
          code: "client/service-unavailable",
        });
      const result = await service[method](...args);
      if (result?.ok === false) throw result.error;
      if (result?.ok !== true)
        throw Object.assign(new Error("Invalid task settings Remote result"), {
          code: "client/invalid-result",
        });
      return codec.parse(result.value);
    }
    function openSettingsSection(ctx, id) {
      const shell = ctx.slots
        .entries?.("sidebar.settings")
        .find((entry) => entry.store)
        ?.store.create();
      if (!shell?.actions?.openSection) return false;
      shell.actions.openSection(id);
      return true;
    }
    const openPlugins = (ctx) => openSettingsSection(ctx, "plugins");
    const openModels = (ctx) => openSettingsSection(ctx, "models");
    const projectMethods = [
      "projectSettings",
      "createTemporaryTask",
      "scheduleOptions",
      "createScheduledPlan",
      "controlScheduledPlan",
      "projectSnapshot",
      "projectPage",
      "saveProjectSettings",
      "createProject",
      "conversationModels",
      "selectConversationModel",
      "taskConversation",
      "sendTaskMessage",
      "sendExecutorMessage",
      "projectConversation",
      "sendProjectMessage",
      "handoffProject",
      "reviewProjectTask",
      "actOnProjectTask",
    ];
    const projectDescriptors = projectMethods.map((method) => ({
      id: `@dsh-task/task-system#taskPluginSettings/${method}`,
      service: "taskPluginSettings",
      namespace: "taskPluginSettings",
      method,
      invocation: { kind: "direct" },
      parameters: ["projectSettings", "projectSnapshot", "projectPage", "conversationModels", "scheduleOptions"].includes(method)
        ? []
        : [
            {
              name: "input",
              wire: "input",
              source: "json",
              codec: {
                mode: "strict",
                typeSymbol: `@dsh-task/task-system#${method}Input`,
                create: () => ({
                  parse(value) {
                    if (!value || typeof value !== "object")
                      throw Error("Invalid project input");
                    return value;
                  },
                }),
              },
            },
          ],
      result: {
        mode: "strict",
        typeSymbol: `@dsh-task/task-system#${method}Result`,
        create: () => ({
          parse(value) {
            if (
              method === "projectPage"
                ? typeof value !== "string"
                : !value || typeof value !== "object"
            )
              throw Error("Invalid project response");
            return value;
          },
        }),
      },
    }));
    function ProjectIcon() {
      return h(
        "svg",
        {
          width: 24,
          height: 24,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.6,
          "aria-hidden": true,
        },
        h("path", {
          d: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
        }),
      );
    }
    function hostTheme() {
      const scheme = getComputedStyle(document.documentElement).colorScheme;
      return scheme === "dark" || (scheme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
    }
    function sendTheme(frame, channel) {
      frame.current?.contentWindow?.postMessage({ channel, method: "theme", input: hostTheme() }, "*");
    }
    function watchTheme(frame, channel) {
      const update = () => sendTheme(frame, channel);
      const observer = new MutationObserver(update);
      observer.observe(document.documentElement, { attributes: true });
      observer.observe(document.body, { attributes: true });
      const system = matchMedia("(prefers-color-scheme: dark)");
      system.addEventListener("change", update);
      update();
      return () => { observer.disconnect(); system.removeEventListener("change", update); };
    }
    function ProjectPanel({ invoke }) {
      const frame = React.useRef(null),
        [html, setHtml] = React.useState(null),
        [error, setError] = React.useState(null),
        [detailFullscreen, setDetailFullscreen] = React.useState(false);
      React.useEffect(() => {
        let active = true;
        invoke("projectPage").then(
          (value) => {
            if (active) setHtml(value.replace("<html ", `<html data-theme="${hostTheme()}" `));
          },
          () => {
            if (active) setError("项目页面加载失败，请重新连接");
          },
        );
        return () => {
          active = false;
        };
      }, [invoke]);
      React.useEffect(() => {
        const listener = async (event) => {
          if (event.source === frame.current?.contentWindow && event.data?.channel === "dsh-project-runtime" && event.data.method === "detailFullscreen") {
            setDetailFullscreen(event.data.input === true);
            return;
          }
          if (
            event.source !== frame.current?.contentWindow ||
            event.data?.channel !== "dsh-project-runtime" ||
            !projectMethods.includes(event.data.method) ||
            event.data.method === "projectPage"
          )
            return;
          const source = event.source,
            { id, method, input } = event.data;
          try {
            const value = await invoke(method, input);
            source.postMessage(
              { channel: "dsh-project-runtime", id, value },
              "*",
            );
          } catch (error) {
            const code = error?.code === "task/project" ? error.details?.reason : error?.code;
            const messages = {
              COORDINATOR_UNAVAILABLE: "中央进度暂时无法连接，请检查执行端与调度端的 Tailscale 连接。",
              PLANNER_REQUIRED: "当前节点为执行端，项目任务中心需要调度端身份。",
              PROJECT_UNAVAILABLE: "本机项目服务尚未就绪，请检查任务插件是否启用。",
              "gateway/internal": "项目服务内部错误，请检查调度端日志后重试。",
              "client/invalid-result": "项目服务返回的数据格式不正确，请核对插件版本。",
              CONFLICT: "记录已变化或请求 ID 重复，请刷新后核对",
              BUSY: "统筹会话正在响应，请稍后再试",
              INVALID: "请输入有效的名称、目标和绝对目录",
              CONFIGURATION: "请先设置项目目录或配置统筹模型",
              FORBIDDEN: "此节点或会话没有操作权限",
              NOT_FOUND: "找不到对应记录",
              WORKSPACE_POLICY: "目录不符合工作区规则",
            };
            source.postMessage(
              {
                channel: "dsh-project-runtime",
                id,
                error: messages[code] || "无法读取或操作项目服务，请检查连接后重试。",
                errorCode: code,
              },
              "*",
            );
          }
        };
        window.addEventListener("message", listener);
        return () => window.removeEventListener("message", listener);
      }, [invoke]);
      React.useEffect(() => html ? watchTheme(frame, "dsh-project-runtime") : undefined, [html]);
      if (error)
        return h("div", { role: "alert", style: { padding: 24 } }, error);
      if (!html)
        return h("div", { style: { padding: 24 } }, "正在加载项目与任务…");
      return h("iframe", {
        ref: frame,
        title: "项目与任务",
        srcDoc: html,
        onLoad: () => sendTheme(frame, "dsh-project-runtime"),
        sandbox: "allow-scripts allow-same-origin allow-forms allow-popups",
        style: {
          ...(detailFullscreen ? {position: "fixed", inset: 0, zIndex: 1000, width: "100vw", height: "100dvh"} : {}),
          display: "block",
          border: 0,
          width: detailFullscreen ? "100vw" : "100%",
          height: detailFullscreen ? "100dvh" : "100%",
          minHeight: 0,
          background: "transparent",
          colorScheme: "inherit",
        },
      });
    }

    /** Native commands are log-only; rc.2 intentionally hides command-only blank chats.
     * Show our own human command result using the public client event and official modal.
     * This never schedules a model, alters the session log, or handles another command.
     */
    class ProjectCommandFeedback {
      constructor() { this.items = []; this.listeners = new Set(); this.serial = 0; }
      getSnapshot = () => this.items[0] ?? null;
      subscribe = (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
      notify() { for (const listener of this.listeners) listener(); }
      accept(sessionId, name, result) {
        if (name !== "project" || !result || !["success", "error"].includes(result.kind)) return;
        this.items.push({ id: ++this.serial, sessionId, kind: result.kind,
          text: typeof result.text === "string" ? result.text : "项目命令已完成。" });
        this.notify();
      }
      dismiss = () => { this.items.shift(); this.notify(); };
      clear() { this.items = []; this.notify(); }
    }
    function ProjectCommandResult({ feedback }) {
      const result = React.useSyncExternalStore(feedback.subscribe, feedback.getSnapshot, feedback.getSnapshot);
      if (!result) return null;
      const text = result.text;
      const collaborationPending = /^COLLABORATION_PENDING:/.test(text);
      const pending = !collaborationPending && text.includes("中央尚未确认");
      const title = collaborationPending ? "会话协作待确认" : result.kind === "error" ? "项目操作未完成" : pending ? "项目快照待同步" : "项目命令结果";
      return h(Modal, { open: true, onClose: feedback.dismiss, title, closeLabel: "关闭项目命令结果",
        description: collaborationPending ? "协作请求待中央确认，恢复连接后重试原 /project 命令。" :
          pending ? "快照已保存在本机；恢复连接后使用 /project sync 重试。" :
          "这是当前命令的结果；项目进度仍在「项目与任务」面板查看。",
        footer: h(Button, { onClick: feedback.dismiss, "data-modal-autofocus": true }, "知道了"),
      }, h("pre", { role: result.kind === "error" ? "alert" : "status",
        "aria-label": "项目命令详情", style: {
          whiteSpace: "pre-wrap", overflowWrap: "anywhere", overflow: "auto", maxHeight: "55vh",
          margin: 0, padding: 12, borderRadius: "var(--dsw-radius-lg, 12px)",
          background: "var(--dsw-alias-markdown-code-block)", color: "var(--dsw-alias-label-primary)",
          fontSize: "var(--dsh-content-font-size-secondary, 13px)", lineHeight: 1.6,
        } }, text));
    }
    function mountProjectCommandFeedback(ctx) {
      const feedback = new ProjectCommandFeedback();
      ctx.effect(() => {
        const offEvent = ctx.on("command/executed", (sessionId, name, result) => feedback.accept(sessionId, name, result));
        const offOverlay = ctx.slots.inject("shell.overlay", () => ctx.slots.register({
          name: "shell.overlay", id: "task-project-command-result", order: 30,
          inject: () => ({ feedback }),
        }, ProjectCommandResult));
        return () => { offEvent(); offOverlay(); feedback.clear(); };
      }, "project human command result");
      return feedback;
    }

    async function apply(ctx) {
      mountProjectCommandFeedback(ctx);
      const t = ctx.locale.bind(NS);
      ctx.effect(
        () => ctx.locale.register(NS, { en, zh }),
        "task settings dictionaries",
      );
      const remoteScope = ctx.remote.$host.isLoopback
        ? undefined
        : new RemoteTaskSettingsScope(ctx.remote.settings);
      const controller = new Controller(
        remoteScope ?? ctx.configForms.get("task-system"),
      );
      ctx.effect(() => () => controller.dispose(), "task settings form");
      if (remoteScope)
        ctx.effect(() => {
          const refresh = () => {
            void remoteScope.load();
          };
          const disposers = [
            ctx.remote.$on("settings/document-updated", refresh),
            ctx.on("connection/reset", refresh),
          ];
          refresh();
          return async () => {
            for (const off of disposers) off();
            await remoteScope.dispose();
          };
        }, "remote task deployment settings");
      const unmount = await ctx.remote.$mount({
        package: "@dsh-task/task-system",
        descriptors: [
          ...projectDescriptors,
          descriptor,
          queueDescriptor,
          workspaceCatalogDescriptor,
          executorIdentityDescriptor,
          startupDescriptor,
          saveStartupDescriptor,
          checkConnectionDescriptor,
          ...decisionPresetDescriptors,
          decisionSettingsDescriptor,
          saveDecisionSettingsDescriptor,
        ],
      });
      ctx.effect(() => unmount, "task settings read-only remote");
      const invoke = (method, input) => {
        const descriptor = projectDescriptors.find((d) => d.method === method);
        return readRemote(
          ctx,
          method,
          descriptor.result.create(),
          ...(input === undefined ? [] : [input]),
        );
      };
      ctx.effect(() => {
        const offMain = ctx.slots.inject("main", () =>
          ctx.slots.register(
            {
              name: "main",
              key: "dsh-task-projects",
              inject: () => ({ invoke }),
            },
            ProjectPanel,
          ),
        );
        const offNav = ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register(
            {
              name: "sidebar.panellist",
              id: "dsh-task-projects",
              order: 20,
              label: () => "项目与任务",
            },
            ProjectIcon,
          ),
        );
        return () => {
          offNav();
          offMain();
        };
      }, "project task center");
      if (
        new URL(window.location?.href ?? "https://localhost/").hash === "#tasks"
      ) {
        const layout = ctx.get("layout");
        layout?.selectPanel("dsh-task-projects");
      }

      const read = () =>
        readRemote(ctx, "describe", descriptor.result.create());
      const readQueue = () =>
        readRemote(ctx, "queue", queueDescriptor.result.create());
      const readDecisionSettings = () =>
        readRemote(
          ctx,
          "decisionSettings",
          decisionSettingsDescriptor.result.create(),
        );
      const saveDecisionSettings = (input) =>
        readRemote(
          ctx,
          "saveDecisionSettings",
          saveDecisionSettingsDescriptor.result.create(),
          parseDecisionInput(input),
        );
      const readDecisionConsole = () => readRemote(ctx,"decisionConsole",decisionPresetDescriptors[0].result.create());
      const setDecisionPreset = input => readRemote(ctx,"setDecisionPreset",decisionPresetDescriptors[1].result.create(),input);
      const readWorkspaces = () =>
        readRemote(
          ctx,
          "workspaces",
          workspaceCatalogDescriptor.result.create(),
        );
      const queryIdentity = () =>
        readRemote(
          ctx,
          "executorIdentity",
          executorIdentityDescriptor.result.create(),
        );
      const startup = () =>
        readRemote(ctx, "startup", startupDescriptor.result.create());
      const checkConnection = (input) =>
        readRemote(
          ctx,
          "checkConnection",
          checkConnectionDescriptor.result.create(),
          checkConnectionDescriptor.parameters[0].codec.create().parse(input),
        );
      const saveStartup = (input) =>
        readRemote(
          ctx,
          "saveStartup",
          saveStartupDescriptor.result.create(),
          saveStartupDescriptor.parameters[0].codec.create().parse(input),
        );
      ctx.effect(
        () =>
          (remoteScope
            ? (register) => remoteScope.whileServed(register)
            : (register) =>
                ctx.configForms.whileServed(["task-system"], register))(() => {
            const inject = () => ({
              ...controller.inject(),
              read,
              readQueue,
              readProjectSettings: () => invoke("projectSettings"),
              saveProjectSettings: input => invoke("saveProjectSettings",input),
              readWorkspaces,
              readDecisionSettings,
              saveDecisionSettings,
              readDecisionConsole,
              setDecisionPreset,
              openDecisions: () => openSettingsSection(ctx,"jev"),
              openModels: () => openModels(ctx),
              queryIdentity,
              startup,
              saveStartup,
              checkConnection,
              openPlugins: () => openPlugins(ctx),
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
      inject: ["slots", "locale", "configForms", "remote", "remote.settings"],
      apply,
      Controller,
      SettingsSaveCoordinator,
      ProjectCommandFeedback,
      ProjectCommandResult,
      mountProjectCommandFeedback,
      startupNeedsRestart,
      RemoteTaskSettingsScope,
      openPlugins,
      openModels,
      decisionSettingsDescriptor,
      saveDecisionSettingsDescriptor,
      DecisionModelRow,
      DecisionModelSettings,
      DecisionPresetSettings,
      decisionPresetDescriptors,
      decisionDraft,
      decisionChoices,
      parseDecisionInput,
      fieldSpec,
      descriptor,
      readRemote,
      queueDescriptor,
      workspaceCatalogDescriptor,
      executorIdentityDescriptor,
      startupDescriptor,
      saveStartupDescriptor,
      checkConnectionDescriptor,
      ExecutorIdentity,
      startupDraft,
      startupChanges,
      simpleEndpointDisplay,
      simpleEndpointInput,
      StartupRow,
      WorkspaceSelect,
      workspaceDirectoryState,
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
