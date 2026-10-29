/* Official DSH browser-half protocol; dependencies come from its shared platform. */
window.__ModuleLoader__.load({
  id: "@dsh-task/task-system",
  factory(require) {
    const React = require("react");
    const { createPortal } = require("react-dom");
    const {
      SettingsForm,
      SettingsFormModel,
      SettingsValueField,
      Switch,
      Button,
      Modal,
    } = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = React.createElement;
    const { Context: ClientContext } = require("@deepseek-ai/cordis");
    /*__PROJECT_NATIVE_CLIENT__*/
    /*__STEWARD_CLIENT__*/
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
        "The address, port and path must identify the scheduler task service. This test uses the current draft without saving it.",
      connectionError_NETWORK_TARGET_DENIED:
        "Address/port does not match the exact transport binding.",
      connectionError_REMOTE_REJECTED:
        "The service replied but did not accept the task protocol; check its port and route.",
      connectionError_CONNECTION_TIMEOUT:
        "Connection timed out; check the address, port and network.",
      connectionError_CHECK_PAUSE_REQUIRED:
        "Pause remote execution before testing a changed destination.",
      startupError_STARTUP_TARGET_MISMATCH:
        "Address/port does not match the trusted-network destination. Check collaboration connections.",
      startupError_STARTUP_ROLE_CONFLICT: "The role conflicts with existing executor registrations or connection settings. Pause the connection and check its listener, polling and heartbeat first.",
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
      decisionDependencyRequired: "Install and enable the dsh-jev-plugin decision plugin to use this feature. Refresh startup configuration after enabling it.",
      startupError_STARTUP_DECISION_REQUIRED: "Install and enable dsh-jev-plugin before enabling decisions.",
      schedulerDecisionTitle: "Automatic observation admission",
      schedulerDecisionHint:
        "Only automatic observation admission uses JEV to classify or attach observed material. Dispatch uses authorized executor defaults without JEV.",
      planningDecisionEnabled: "Enable automatic observation decisions",
      schedulerDecisionStatus:
        "Used only when automatic observation admission is configured. Executor allocation is independent of this switch.",
      schedulerDecisionModelEntry: "Scheduler decision model settings",
      schedulerDecisionSetup:
        "Open Decision model settings. Both roles reuse the same configured model.",
      executorDecisionTitle: "Executor · session selection",
      executorDecisionHint:
        "The project or temporary-task rule fixes the directory. The decision selects a legal new or existing Task session.",
      executorDecisionInactive:
        "Local task execution is disabled. Session selection settings are retained.",
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
        "Connection not ready. Obtain connection information from the scheduler, including audience, authentication/permissions and the exact target binding, then complete it in collaboration connections or Plugins.",
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
        "Saving generates the connection address from the fields above.",
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
      paused: "Pause executor connection",
      pausedHint:
        "Pause executor connections, polling and heartbeat. The scheduler listener is controlled separately.",
      startupLoaded: "Connection settings loaded",
      startupLoaderDisabled: "Plugin disabled",
      startupRemoteDisabled:
        "This connection configuration is not loaded for editing. Load it paused through the approved setup before saving here.",
      audience: "Scheduler audience",
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
      executorId: "Scheduler registration ID",
      identityTitle: "Scheduler-bound executor identity · read only",
      identityHint:
        "The scheduler assigns a stable executor ID to an already authorized peer. A connection to another scheduler has its own identity; this page does not edit IDs or grant access.",
      identityNone: "No scheduler-confirmed executor identity is available.",
      rolePlanner: "Scheduler",
      roleExecutor: "Executor",
      roleBoth: "Scheduler and executor",
      workspaceTitle: "Executor · sessions and workspace",
      workspaceLayoutHint: "For new project tasks this is the authorized parent. Local project folders are created by scheduler and project ID; temporary tasks have their own folders. Existing sessions retain their directory.",
      workspaceFailed:
        "Could not read this host's workspaces. Refresh to retry; your current selection and draft are retained.",
      workspaceEmpty:
        "No registered workspace is currently available for tasks on this host.",
      workspaceUnavailable:
        "Current selection is unavailable and retained. Choose another workspace or discard this change.",
      workspaceUnavailableSuffix: "unavailable",
      sessionDecisionEnabled: "Enable executor workspace/session decisions",
      workspaceHint:
        "The default workspace must already be registered locally. Saved changes apply to future tasks immediately. Execution follows the authorized project directory or registered default and reuses the current Task session.",
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
      executionAgentPreset: "Execution-session Agent preset",
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
        "Edits stay in the draft until Save. Switching pages preserves the draft. Saved runtime settings persist in this profile without restarting the task service.",
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
      connectionError_EADDRNOTAVAIL: "配置的本机来源地址当前不可用，请核对协作连接。",
      connectionError_OPERATION_DENIED: "调度端未允许此节点查询执行端身份。",
      connectionError_NOT_FOUND: "服务可达，但未找到任务协议接口路径。",
      connectionError_CONNECTION_FAILED: "未能把返回内容验证为调度端任务协议。",
      connectionPortHint:
        "地址、端口和路径应对应调度端任务服务；检验使用当前草稿，无需先保存。",
      connectionError_NETWORK_TARGET_DENIED: "地址或端口与精确连接绑定不一致。",
      connectionError_REMOTE_REJECTED:
        "服务已响应，但未接受任务协议；请检查端口和接口路径。",
      connectionError_CONNECTION_TIMEOUT: "连接超时，请检查地址、端口和网络。",
      connectionError_CHECK_PAUSE_REQUIRED:
        "请先暂停远程执行，再检验修改后的目标地址。",
      startupError_STARTUP_TARGET_MISMATCH:
        "地址或端口与 trusted-network 目标绑定不一致，请核对协作连接。",
      startupError_STARTUP_ROLE_CONFLICT: "角色与现有执行登记或连接配置不兼容。请先停用连接，并核对监听、轮询和心跳设置。",
      startupError_STARTUP_BUSY: "角色或连接变更需要重启；仍有执行或未确认记录阻止重启。容量、决策开关和并发等即时设置可另行保存。",
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
      decisionDependencyRequired: "需要安装并启用 dsh-jev-plugin 决策插件后才能使用。启用后请刷新启动配置。",
      startupError_STARTUP_DECISION_REQUIRED: "请先安装并启用 dsh-jev-plugin 决策插件，再开启决策功能。",
      schedulerDecisionTitle: "自动观察归并",
      schedulerDecisionHint:
        "仅自动观察归并使用 JEV 判断已有材料是否需记录或关联。任务派发和会话选择按授权与确定规则执行，不调用 JEV。",
      planningDecisionEnabled: "启用自动观察归并决策",
      schedulerDecisionStatus:
        "仅在已配置自动观察准入时使用此预设判断材料归并；不参与执行者、工作区或会话选择。",
      schedulerDecisionModelEntry: "选择调度端决策预设",
      schedulerDecisionSetup:
        "在本页分别选择调度端与执行端的决策预设；预设内容在独立“决策”设置中管理。",
      executorDecisionTitle: "本机执行 · 会话选择",
      executorDecisionHint:
        "工作目录按项目或临时任务规则确定；决策只选择合法的 Task 会话，新建或复用。",
      executorDecisionInactive:
        "本机未启用任务执行，会话选择配置保留。",
      decisionModelEntry: "选择执行端决策预设",
      decisionModelStatus:
        "使用本机选择的决策预设；没有有效决策时，按项目/临时目录规则确定工作区，并创建或复用合法会话。",
      decisionModelSetup:
        "点击“选择执行端决策预设”；此开关控制会话与工作区决策。",
      schedulerAddress: "调度端地址",
      audienceHint:
        "audience 是调度端配置的目标验证标识，必须与调度端的值一致；请向调度端获取，不按地址猜测。",
      schedulerConnection: "调度端连接",
      executorConnections: "执行端连接信息",
      executorSetupStatus:
        "执行端注册与权限沿用已有 task-system 插件配置；安排远程执行前请在“插件”中确认。",
      connectionSetupStatus:
        "连接尚未就绪。请向调度端获取连接信息（audience、认证／权限及目标绑定），再在下方协作连接中补齐。",
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
        "保存时会根据以上字段生成连接地址。",
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
      paused: "暂停执行端连接",
      pausedHint:
        "暂停执行端连接、远程接单和心跳；调度端监听独立控制。",
      startupLoaded: "连接配置已加载",
      startupLoaderDisabled: "插件已停用",
      startupRemoteDisabled:
        "此连接配置尚未加载，当前不能编辑。请按已批准的配置流程以暂停状态加载，再在此保存。",
      audience: "调度端受众标识（audience）",
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
      executorId: "调度端登记号",
      identityTitle: "调度端绑定的执行端身份 · 只读",
      identityHint:
        "调度端为已授权的执行端分配固定 ID。连接到不同调度端使用各自的身份；此页不编辑 ID，也不授予访问权限。",
      identityNone: "尚无调度端确认的执行端身份。",
      rolePlanner: "调度端",
      roleExecutor: "执行端",
      roleBoth: "调度端和执行端",
      workspaceEmpty: "本机目前没有可用于任务的已登记工作区。",
      workspaceTitle: "执行端 · 会话与工作区",
      workspaceLayoutHint: "新项目任务以此授权工作区为父目录，按调度端 ID／项目 ID 创建本地文件夹；临时任务使用独立目录。已有会话保留原目录。",
      workspaceFailed:
        "未能读取本机工作区，请刷新重试；当前选择和草稿予以保留。",
      workspaceUnavailable:
        "当前选择已不可用，仍予以保留。请选择其他工作区，或丢弃本次更改。",
      workspaceUnavailableSuffix: "不可用",
      sessionDecisionEnabled: "启用执行端会话决策",
      workspaceHint:
        "父目录保存后用于新建项目工作区；已有项目和任务会话保留原位置。按授权目录和已有 Task 绑定创建或复用任务会话。",
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
      executionAgentPreset: "执行会话 Agent preset",
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
        "运行设置保存后即时生效，写入当前 profile；切换页面保留未保存草稿。",
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
        "centralMode",
        "executionEnabled",
        "databasePath",
        "nodeId",
        "nodeCapacities",
        "executionAgentPreset",
        "executionTools",
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
      const keys = startupKeys[target].filter(key=>!(partial && ((target==="remote" && key==="role") || key==="nodeId" || key==="sessionDecisionEnabled")));
      if (
        !keys ||
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !keys.includes(key)) ||
        (!partial && keys.some((key) => !["centralMode","executionEnabled","nodeCapacities","databasePath","nodeId","executionAgentPreset","executionTools"].includes(key) && !Object.hasOwn(value, key)))
      )
        throw new Error("Invalid startup values");
      for (const [key, entry] of Object.entries(value)) {
        if (key === "executionTools" && entry !== null && (!Array.isArray(entry) || entry.some(name=>typeof name!=="string"))) throw new Error("Invalid execution tool mask");
        if (key === "executionAgentPreset" && (typeof entry!=="string" || !entry.trim())) throw new Error("Invalid execution agent preset");
        if (key === "nodeCapacities" && (!Array.isArray(entry) || entry.some(node =>
          !node || Object.keys(node).some(field => !["nodeId", "maxConcurrent"].includes(field)) ||
          typeof node.nodeId !== "string" || !node.nodeId || !Number.isSafeInteger(node.maxConcurrent) || node.maxConcurrent < 1 || node.maxConcurrent > 32)))
          throw new Error("Invalid node capacity");
        if (
          (key === "role" &&
            !["planner", "executor", "both"].includes(entry)) ||
          (key === "centralMode" && !["host", "remote"].includes(entry)) ||
          ([
            "planningDecisionEnabled",
            "sessionDecisionEnabled",
            "executionEnabled",
            "taskSessionsEnabled",
            "paused",
          ].includes(key) &&
            typeof entry !== "boolean") ||
          (["endpoint", "audience","databasePath","nodeId"].includes(key) &&
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
    const startupNeedsRestart = (target, changes) => Object.keys(changes).some(key => !(target === "task" ? ["nodeCapacities", "planningDecisionEnabled", "sessionDecisionEnabled"] : ["concurrency", "pollIntervalMs"]).includes(key));
    class SettingsSaveCoordinator {
      constructor() { this.items = new Map(); this.listeners = new Set(); this.saving = false; this.message = ""; }
      subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
      emit() { for (const fn of this.listeners) fn(); }
      register(id, item) { this.items.set(id,{...item,id}); this.emit(); return () => {this.items.delete(id);this.emit();}; }
      update(id, meta) { const row=this.items.get(id); if (!row || JSON.stringify(row.meta)===JSON.stringify(meta)) return; if (meta.dirty && !row.meta?.dirty && !this.saving) this.message=""; row.meta=meta; this.emit(); }
      snapshot() { const dirty=[...this.items.values()].filter(row=>row.meta?.dirty); return {count:dirty.length,retained:[...this.items.values()].filter(row=>row.meta?.retainedDirty).length,invalid:dirty.some(row=>row.meta.invalid),busy:this.saving || [...this.items.values()].some(row=>row.meta?.busy),restart:dirty.some(row=>row.meta.restart),message:this.message}; }
      async saveAll() {
        const before=this.snapshot(); if (!before.count || before.invalid || before.busy) return false;
        this.saving=true;this.message="";this.emit();let saved=0;
        const items=[...this.items.values()].filter(row=>row.meta?.dirty).sort((a,b)=>Number(a.meta.restart)-Number(b.meta.restart) || Number(b.id==="startup-task")-Number(a.id==="startup-task"));
        try { for (const row of items) { if (await row.save() !== true) {this.message=saved ? "部分设置已保存；未完成的草稿已保留。请查看错误提示。" : "未能保存，草稿已保留。请查看错误提示。";return false;} saved++; } this.message=this.snapshot().retained?"所选设置已保存，未提交的草稿保留。":"设置已保存。";return true; }
        catch {this.message=saved ? "部分设置已保存；其余草稿已保留。" : "未能保存，草稿已保留。";return false;}
        finally {this.saving=false;this.emit();}
      }
      discardAll() { if (this.snapshot().busy) return; for (const row of this.items.values()) row.discard(); this.message="";this.emit(); }
    }
    function useSaveParticipant(coordinator, id, participant) {
      if (!coordinator) return;
      const ref=React.useRef(participant);ref.current=participant;
      React.useEffect(()=>coordinator.register(id,{meta:participant.meta,save:()=>ref.current.save(),discard:()=>ref.current.discard()}),[coordinator,id]);
      React.useEffect(()=>coordinator.update(id,participant.meta),[coordinator,id,participant.meta.dirty,participant.meta.retainedDirty,participant.meta.invalid,participant.meta.busy,participant.meta.restart]);
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
        return Promise.resolve()
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
              h("p", { style: hintStyle }, t("workspaceHint")),
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
    function QueueContents({ t, value }) {
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
                        item.projectTitle ? h("div", { style: hintStyle }, item.projectTitle) : null,
                        item.executionDirectory ? h("div", { style: { ...hintStyle, overflowWrap: "anywhere" } }, item.executionDirectory) : null,
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
        state.value
          ? h(QueueContents, { t, value: state.value })
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
    function outboundFields(endpoint, audience, target) {
      const url = connectionUrl(endpoint);
      return {
        connectionProtocol: url?.protocol.slice(0, -1) ?? "http",
        connectionAddress: url?.hostname.replace(/^\[|\]$/g, "") ?? "",
        connectionPort: url ? (url.port || (url.protocol === "https:" ? "443" : "80")) : "",
        connectionPath: url?.pathname ?? "/dsh-task/v1/commands",
        audience: audience ?? "",
        targetLocalAddress: target?.localAddress ?? "",
      };
    }
    function connectionHost(value, literal = false) {
      const text = String(value).trim().replace(/^\[|\]$/g, "");
      if (!text || /[\\\s/@?#%]/.test(text)) return null;
      if (/^\d+\.\d+\.\d+\.\d+$/.test(text)) {
        return !["0.0.0.0","255.255.255.255"].includes(text) && text.split(".").every(part => String(Number(part)) === part && Number(part) <= 255) ? text : null;
      }
      if (!text.includes(":")) {
        if (literal) return null;
        try { const url = new URL(`https://${text}/`); return url.port ? null : url.hostname; } catch { return null; }
      }
      try {
        const host = new URL(`http://[${text}]/`).hostname.slice(1,-1);
        if (host.startsWith("::ffff:")) {
          const parts = host.slice(7).split(":");
          if (parts.length === 2) { const high = parseInt(parts[0],16), low = parseInt(parts[1],16); return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`; }
        }
        return host === "::" ? null : host;
      } catch { return null; }
    }
    function buildOutbound(fields, trusted) {
      const address = connectionHost(fields.connectionAddress, trusted),
        port = Number(fields.connectionPort), path = String(fields.connectionPath).trim(),
        protocol = fields.connectionProtocol, audience = String(fields.audience).trim(),
        localAddress = trusted ? connectionHost(fields.targetLocalAddress, true) : null;
      const invalid = [];
      if (!address) invalid.push("connectionAddress");
      if (!/^\d+$/.test(String(fields.connectionPort)) || !Number.isSafeInteger(port) || port < 1 || port > 65535) invalid.push("connectionPort");
      if (!path.startsWith("/") || /[?#\s]/.test(path)) invalid.push("connectionPath");
      if (!["http","https"].includes(protocol) || (trusted && protocol !== "http")) invalid.push("connectionProtocol");
      if (!audience) invalid.push("audience");
      if (trusted && !localAddress) invalid.push("targetLocalAddress");
      // Keep the explicit port, including :80; trusted transport checks raw authority.
      const endpoint = `${protocol}://${address?.includes(":") ? `[${address}]` : address ?? ""}:${port}${path}`;
      const url = connectionUrl(endpoint);
      if (!url || url.pathname !== path || url.username || url.password || url.search || url.hash) invalid.push("connectionPath");
      return {endpoint, audience, target:trusted ? {address,port,localAddress,allowHttp:true} : null, invalid};
    }
    function outboundMismatch(endpoint, target) {
      const url = connectionUrl(endpoint);
      return !!target && (!url || connectionHost(url.hostname) !== connectionHost(target.address) || Number(url.port || (url.protocol === "https:" ? 443 : 80)) !== target.port);
    }
    function OutboundConnectionFields({fields, edit, disabled, trusted, idPrefix, mismatch, originalTarget, onSynchronize}) {
      const input = (key, label, numeric = false) => h("label",{className:"task-connection-field"},h("span",null,label),h("input",{id:`${idPrefix}-${key}`,style:controlStyle,value:fields[key] ?? "",inputMode:numeric?"numeric":undefined,disabled,onChange:event=>edit(key,event.target.value)}));
      return h(React.Fragment,null,
        h("div",{className:"task-connection-grid","data-outbound-address-fields":true},
          input("connectionAddress","调度端地址 / IP"),input("connectionPort","调度端任务协议端口",true),
          input("connectionPath","任务协议路径"),input("audience","调度端受众标识（audience）"),
          !trusted || fields.connectionProtocol !== "http" ? h("label",{className:"task-connection-field"},h("span",null,"连接协议"),h("select",{id:`${idPrefix}-connectionProtocol`,style:controlStyle,value:fields.connectionProtocol,disabled,onChange:event=>edit("connectionProtocol",event.target.value)},h("option",{value:"https"},"HTTPS"),h("option",{value:"http"},trusted?"HTTP（可信网络）":"HTTP（仅已允许的回环连接）"))) : null),
        trusted ? h("div",{"data-outbound-local-address":true},input("targetLocalAddress","本机外连来源地址")) : null,
        mismatch ? h("div",{role:"note","data-outbound-mismatch":true},h("p",{style:hintStyle},`现有协议地址与目标绑定不一致。以上字段来自协议地址；原目标为 ${originalTarget?.address}:${originalTarget?.port}。原配置保持不变，编辑这组连接或点击同步后，保存会按以上地址统一绑定。`),h(Button,{variant:"outline",disabled,onClick:onSynchronize},"按当前地址同步")) : null);
    }
    function deployment(values) {
      return {centralMode:values.centralMode ?? (values.role === "executor" ? "remote" : "host"),executionEnabled:values.executionEnabled ?? ["executor","both"].includes(values.role)};
    }
    function startupDraft(target, values) {
      return target === "task"
        ? {
            role: values.role,
            ...deployment(values),
            executionAgentPreset:values.executionAgentPreset ?? "ptc",
            followExecutionPreset:values.executionTools === null,
            databasePath: values.databasePath ?? "",
            ...(values.nodeCapacities ? {nodeCapacities: values.nodeCapacities.map(node => ({nodeId: node.nodeId, maxConcurrent: String(node.maxConcurrent)}))} : {}),
            planningDecisionEnabled: values.planningDecisionEnabled,
          }
        : {
            paused: values.paused,
            endpoint: values.endpoint ?? "",
            audience: values.audience ?? "",
            pollIntervalMs: String(values.pollIntervalMs),
            concurrency: String(values.concurrency),
            ...outboundFields(values.endpoint, values.audience, values.trustedNetworkTarget),
            connectionTouched: false,
          };
    }
    function startupChanges(target, values, draft, migrate = false, role = values.role, authMode) {
      let retainedDirty = false;
      const invalid = [],
        next = target==="task" ? {centralMode:draft.centralMode,executionEnabled:draft.executionEnabled} : {};
      if (target === "task" && values.centralMode === undefined && values.executionEnabled === undefined && JSON.stringify(deployment(values)) === JSON.stringify(deployment(draft))) {delete next.centralMode;delete next.executionEnabled;}
      if (target === "task" && (!["host","remote"].includes(draft.centralMode) || typeof draft.executionEnabled !== "boolean")) invalid.push("centralMode");
      if (target === "task") {
        if(draft.executionEnabled && draft.followExecutionPreset) {
          next.executionAgentPreset=String(draft.executionAgentPreset ?? "").trim();
          next.executionTools=null;
          if(!next.executionAgentPreset) invalid.push("executionAgentPreset");
        }
        if(draft.centralMode === "host" && values.databasePath!==undefined){next.databasePath=String(draft.databasePath).trim();if(!next.databasePath.startsWith("/") || next.databasePath.includes("\0"))invalid.push("databasePath");}
        if (values.nodeCapacities) {
          next.nodeCapacities = (draft.nodeCapacities ?? []).map(node => ({nodeId: node.nodeId, maxConcurrent: Number(node.maxConcurrent)}));
          if (next.nodeCapacities.length !== values.nodeCapacities.length ||
              next.nodeCapacities.some((node, i) => node.nodeId !== values.nodeCapacities[i]?.nodeId ||
                !String(draft.nodeCapacities[i].maxConcurrent).trim() || !Number.isSafeInteger(node.maxConcurrent) || node.maxConcurrent < 1 || node.maxConcurrent > 32))
            invalid.push("nodeCapacities");
        }
        for (const key of [
          "planningDecisionEnabled",
        ]) {
          next[key] = draft[key];
          if (typeof next[key] !== "boolean") invalid.push(key);
        }
      } else {
        {
        next.paused = draft.paused;
        if (typeof next.paused !== "boolean") invalid.push("paused");
        const trusted = authMode ? authMode === "trusted-network" : !!values.trustedNetworkTarget || values.endpoint === null;
        next.endpoint = values.endpoint;
        next.audience = values.audience;
        if (draft.connectionTouched) {
          const connection = buildOutbound(draft, trusted);
          if (draft.paused && connection.invalid.length) retainedDirty = true;
          else {
            invalid.push(...connection.invalid);
            next.endpoint = connection.endpoint;
            next.audience = connection.audience;
            if (trusted) next.trustedNetworkTarget = connection.target;
          }
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
          if (trusted) {
            const binding = next.trustedNetworkTarget ?? values.trustedNetworkTarget;
            if (!binding?.address) invalid.push("connectionAddress");
            if (!binding?.localAddress) invalid.push("targetLocalAddress");
            if (
              !Number.isSafeInteger(binding?.port) ||
              binding.port < 1 ||
              binding.port > 65535
            )
              invalid.push("connectionPort");
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
            { if(draft.paused){delete next[key];retainedDirty=true;}else invalid.push(key); }
        }
        if (migrate || draft.taskSessionsEnabled === true) next.taskSessionsEnabled = true;
        }
      }
      const changes = Object.fromEntries(
        Object.entries(next).filter(
          ([key, value]) =>
            JSON.stringify(value) !== JSON.stringify(values[key]),
        ),
      );
      if (target === "task" && Object.hasOwn(changes,"executionTools")) changes.executionAgentPreset=next.executionAgentPreset;
      return { changes, invalid, retainedDirty, dirty: Object.keys(changes).length > 0 };
    }
    function SettingsArea({ id, title, description, children }) {
      return h("section", { id, "data-settings-area": true },
        h("header", null, h("h2", null, title), description ? h("p", {style:hintStyle}, description) : null),
        h("div", {"data-settings-area-body":true}, children));
    }
    function StartupRow({
      t,
      target,
      row,
      writable,
      saveStartup,
      onSaved,
      visible = true,
      onRoleChange,
      renderExecutionDirectory,
      readExecutionPresets,
      renderProjectDirectory,
      renderConnection,
      connectionRole,
      connectionAuthMode,
      initialDraft,
      openPlugins,
      openDecisionModels,
      renderDecisionModels,
      decisionAvailable = false,
      checkConnection,
      saveCoordinator,
    }) {
      const [expected, setExpected] = React.useState(row.values);
      const [draft, setDraft] = React.useState(() =>
        ({...startupDraft(target, row.values),...initialDraft}),
      );
      const presetCatalog = useReadSnapshot(readExecutionPresets, target === "task" && draft.executionEnabled && !!readExecutionPresets);
      const [status, setStatus] = React.useState({ saving: false });
      const [connection, setConnection] = React.useState({ checking: false });
      const edit = (key, value) => {
        setConnection({ checking: false });
        if (["centralMode","executionEnabled"].includes(key)) onRoleChange?.({...deployment(draft),[key]:value});
        setDraft((old) => ({
          ...old,
          [key]: value,
          ...(target === "remote" && ["connectionAddress","connectionPort","connectionPath","connectionProtocol","audience","targetLocalAddress","connectionTouched"].includes(key) ? {connectionTouched:true} : {}),
          ...(target === "remote" &&
          row.values.endpoint === null &&
          [
            "connectionAddress",
            "connectionPort",
            "connectionPath",
            "connectionProtocol",
            "audience",
            "targetLocalAddress",
          ].includes(key)
            ? { pollIntervalMs: "0" }
            : {}),
        }));
        setStatus({ saving: false });
      };
      const policy=target === "task" ? deployment(draft) : typeof connectionRole === "object" && connectionRole ? connectionRole : deployment(row.values);
      const currentRole=policy.centralMode === "remote" ? "executor" : policy.executionEnabled ? "both" : "planner";
      const allParsed=startupChanges(target,expected,draft,false,"both",connectionAuthMode);
      const parsed = startupChanges(target, expected, draft,false,currentRole,connectionAuthMode);
      const hiddenDraft=parsed.retainedDirty;
      React.useEffect(()=>{if(!allParsed.dirty && !allParsed.retainedDirty){setExpected(row.values);setDraft(startupDraft(target,row.values));}},[row.values]);
      const workspaceInvalid=false;
      const disabled =
        !writable ||
        status.saving ||
        connection.checking ||
        (target === "remote" && (!row.loaded || row.loaderDisabled));
      const executor = target === "remote" || policy.executionEnabled;
      const planner = policy.centralMode === "host";
      const save = async (migrate = false, selectedDraft = draft) => {
        const update = startupChanges(target, expected, selectedDraft, migrate,currentRole,connectionAuthMode);
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
            expected,
            changes: update.changes,
          });
          const current = await onSaved();
          const savedValues=current?.[target]?.values ?? {...expected,...update.changes};
          setExpected(savedValues);
          if(target==="remote" && selectedDraft.connectionTouched && !update.retainedDirty) setDraft(old=>({...old,...outboundFields(savedValues.endpoint,savedValues.audience,savedValues.trustedNetworkTarget),endpoint:savedValues.endpoint,connectionTouched:false}));
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

      const discardStartup = () => {setExpected(row.values);setDraft(startupDraft(target,row.values));setConnection({checking:false});onRoleChange?.(deployment(row.values));setStatus({saving:false});};
      useSaveParticipant(saveCoordinator, `startup-${target}`, {meta:{dirty:parsed.dirty,retainedDirty:hiddenDraft,invalid:workspaceInvalid || parsed.invalid.length>0 || !writable,busy:status.saving || connection.checking,restart:startupNeedsRestart(target,parsed.changes)},save:()=>save(),discard:discardStartup});
      const field = (key, label = key) =>
        h(
          "label",
          {
            key,
            style: { display: "block", margin: "12px 0" },
          },
          h(
            "span",
            { style: { display: "block", marginBottom: 6 } },
            t(label),
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
                value: draft[key],
                disabled:
                  disabled ||
                  (target === "remote" &&
                    row.values.endpoint === null &&
                    key === "pollIntervalMs"),
                "aria-invalid": parsed.invalid.includes(key),
                inputMode: [
                  "pollIntervalMs",
                  "concurrency",
                ].includes(key)
                  ? "numeric"
                  : undefined,
                onChange: (event) => edit(key, event.target.value),
              }),
        );
      const decisionToggle = (key, active) => h("label", {className:"task-switch-row"}, t(key), h(Switch, {label:t(key), checked:decisionAvailable && draft[key], disabled:disabled || !active || !decisionAvailable, onChange:value=>edit(key,value)}));
      if (target !== "task") {
      return h("section", {"data-startup-target":"remote",hidden:!visible},
        !row.loaded || row.loaderDisabled ? h("p",{role:"note",style:hintStyle},t("startupRemoteDisabled")) : null,
        h("div", {"data-connection-role":"executor",hidden:!executor,style:{order:2}},
          h("h3",{style:headingStyle},"连接中央服务"),
h(
              "div",
              {"data-collaboration-controls":true,style:{order:0}},
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
                "启用执行端连接",
                h(Switch, {
                  label: "启用执行端连接",
                  checked: !draft.paused,
                  disabled,
                  onChange: async (enabled) => {
                    const next = { ...draft, paused: !enabled };
                    setDraft(next);
                    setConnection({ checking: false });
                    if (!saveCoordinator && !await save(false, next)) setDraft(draft);
                  },
                }),
              ),
              row.values.paused
                ? h(
                    "p",
                    { role: "status", style: hintStyle },
                    "执行端连接已暂停：不连接调度端、不领取远程任务，也不发送心跳。调度端监听与本机任务不受影响。",
                  )
                : null,
              h("p", { style: hintStyle }, "控制连接调度端、接收任务和发送心跳。修改先进入草稿，保存后应用；活动或未确认工作会阻止变更。"),
            ),
              executor && !row.values.paused
                ? h("p", { role: "status", style: hintStyle, "data-task-heartbeat-status": true },
                    t(`heartbeat_${row.heartbeat?.state ?? "waiting"}`),
                    row.heartbeat?.acknowledgedAt ? ` · ${new Date(row.heartbeat.acknowledgedAt).toLocaleString()}` : "")
                : null,
              h(OutboundConnectionFields,{fields:draft,edit,disabled,trusted:connectionAuthMode ? connectionAuthMode==="trusted-network" : !!row.values.trustedNetworkTarget || row.values.endpoint===null,idPrefix:"task-startup-remote",mismatch:!draft.connectionTouched && outboundMismatch(row.values.endpoint,row.values.trustedNetworkTarget),originalTarget:row.values.trustedNetworkTarget,onSynchronize:()=>edit("connectionTouched",true)}),
              h("div",{className:"task-connection-grid"},...["pollIntervalMs","concurrency"].map(key=>field(key))),
              row.values.endpoint === null
                ? h(
                    "p",
                    { style: hintStyle },
                    t("startupUnconfigured"),
                  )
                : null,
              h(
                "p",
                { style: hintStyle },
                t("startupEndpointHint"),
              ),
              row.values.taskSessionsEnabled === false &&
                row.values.endpoint !== null
                ? h(
                    React.Fragment,
                    null,
                    h(
                      "p",
                      { style: hintStyle },
                      t("startupMigrationHint"),
                    ),
                    h(
                      Button,
                      {
                        variant: "outline",
                        disabled: disabled || parsed.invalid.length > 0,
                        onClick: () => saveCoordinator ? edit("taskSessionsEnabled",true) : save(true),
                      },
                      t("startupMigration"),
                    ),
                  )
                : null,
            ),
        hiddenDraft ? h("p",{role:"note",style:{...hintStyle,order:3}},"未启用或未选中的执行端连接草稿已保留，本次保存不提交不完整内容。") : null,
        target === "remote"
          ? h(
              "div",
              { "data-task-connection-check": true,hidden:!executor,style:{order:2} },
              h("p", { style: hintStyle }, t("connectionPortHint")),
              h(
                Button,
                {
                  variant: "outline",
                  disabled:
                    disabled ||
                    !checkConnection ||
                    parsed.invalid.length > 0 ||
                    !((parsed.changes.endpoint ?? row.values.endpoint)),
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
              { role: "alert" },
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
        status.saved && !saveCoordinator ? h("p", { role: "status" }, t("startupSaved")) : null,
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
                setConnection({ checking: false });
                onRoleChange?.(deployment(row.values));
                setStatus({ saving: false });
              },
            },
            t("discardDraft"),
          ),
        ) : null,
      );
      }
      return h("div", {"data-startup-target":"task"},
        h(SettingsArea, {id:"task-local",title:"本机与工作区",description:"以下设置属于当前连接的 DSH 服务设备。任务中心显示的中央任务进度不改变设置的所属设备。"},
          h("label",{className:"task-connection-field"},h("span",null,"中央账本"),h("select",{id:"task-startup-task-centralMode",value:draft.centralMode,disabled,onChange:event=>edit("centralMode",event.target.value)},h("option",{value:"host"},"在本机托管中央服务"),h("option",{value:"remote"},"连接远端中央服务"))),
          h("label",{className:"task-switch-row"},"允许本机接受任务执行",h(Switch,{label:"允许本机接受任务执行",checked:draft.executionEnabled,disabled,onChange:value=>edit("executionEnabled",value)})),
          h("p",{style:hintStyle},"普通会话可连接中央项目并调度任务。本机执行权限、工具和工作区授权单独管理。远端不可达时保留待确认状态，不创建本机中央账本。"),
          row.values.nodeId ? h("div",{"data-local-node-identity":true},h("h3",null,executor?"执行端 ID（本机实例）":"本机节点 ID"),h("code",{style:{overflowWrap:"anywhere"}},row.values.nodeId),h("p",{style:hintStyle},"此稳定身份不随连接地址或调度端改变；节点昵称单独设置。")) : null,
          h("div",{hidden:!planner,"data-task-database-settings":true},h("h3",null,"中央任务数据库"),h("label",{className:"task-connection-field"},h("span",null,"SQLite 数据库文件路径"),h("input",{id:"task-startup-task-databasePath",style:controlStyle,value:draft.databasePath,disabled,onChange:event=>edit("databasePath",event.target.value)})),h("p",{style:hintStyle},"填写此设备上的绝对文件路径。保存后重建任务服务并加载目标库，不搬移旧数据，也不覆盖目标库；不存在的文件将创建新账本及新的调度端身份。原数据库保留。")),
          executor ? h("section",{"data-execution-agent-preset":true,className:"task-directory-card"},
            h("h3",null,"本机执行 · DSH Agent preset"),
            h("p",{style:hintStyle},"为新的任务执行会话选择本机已注册的插件组合。工具、提示词和权限由该 preset 提供；任务权限仍可收窄。执行模型继续采用任务路由，已有会话保留其记录的 preset。"),
            h("label",{htmlFor:"task-execution-agent-preset"},"新执行会话的 Agent preset"),
            h("select",{id:"task-execution-agent-preset",style:controlStyle,value:draft.executionAgentPreset,disabled:disabled || !presetCatalog.state.value,onChange:event=>setDraft(value=>({...value,executionAgentPreset:event.target.value,followExecutionPreset:true}))},
              !presetCatalog.state.value?.items.some(item=>item.id===draft.executionAgentPreset) ? h("option",{value:draft.executionAgentPreset,disabled:true},`${draft.executionAgentPreset}（当前目录不可用）`) : null,
              ...(presetCatalog.state.value?.items ?? []).map(item=>h("option",{key:item.id,value:item.id,disabled:!item.available},`${item.label} (${item.id})${item.available ? "" : " · 不可用"}`))),
            presetCatalog.state.loading ? h("p",{role:"status"},"正在读取本机 preset…") : null,
            presetCatalog.state.failed ? h("p",{role:"alert"},"无法读取 DSH agent preset，请刷新后重试。") : null,
            presetCatalog.state.value?.items.find(item=>item.id===draft.executionAgentPreset)?.description ? h("p",{style:hintStyle},presetCatalog.state.value.items.find(item=>item.id===draft.executionAgentPreset).description) : null,
            presetCatalog.state.value?.items.find(item=>item.id===draft.executionAgentPreset)?.diagnostic ? h("p",{role:"alert"},presetCatalog.state.value.items.find(item=>item.id===draft.executionAgentPreset).diagnostic) : null,
            row.values.executionTools != null ? h("div",{role:"note"},h("p",{style:hintStyle},draft.followExecutionPreset ? "保存时将移除旧执行工具白名单，改为跟随所选 preset；已有会话不会换代。" : `旧执行工具白名单仍在生效（${row.values.executionTools.length} 项），会覆盖 preset 的常规工具。`),h(Button,{variant:"outline",disabled:disabled || !presetCatalog.state.value?.items.some(item=>item.id===draft.executionAgentPreset && item.available),onClick:()=>edit("followExecutionPreset",true)},"使用此 preset，移除旧白名单")) : h("p",{style:hintStyle},"当前跟随所选 preset，未附加旧工具白名单。"),
            h(Button,{variant:"outline",disabled:status.saving,onClick:presetCatalog.refresh},"刷新 preset 目录")) : null,
          h("div", {className:"task-directory-grid"},
            h("div",null,renderProjectDirectory?.()),
            h("div",null,renderExecutionDirectory?.())),
          ),
        h(SettingsArea, {id:"task-connections",title:"协作连接",description:"中央服务监听与本机连接分别配置。远程领取与本机自动执行独立生效。"},
          renderConnection?.(),
          h("div",null,
        planner ? h("div", {"data-task-node-capacities": true},
          h("h4", {style: headingStyle}, t("nodeCapacityTitle")),
          h("p", {style: hintStyle}, t("nodeCapacityHint")),
          ...(draft.nodeCapacities ?? []).map((node, index) => h("div", {key:node.nodeId, style:{margin:"12px 0"}},
            h("label", {htmlFor:`task-node-capacity-${index}`, style:{display:"block", marginBottom:6}}, `${node.nodeId} · ${t("nodeCapacity")}`),
            h("input", {id:`task-node-capacity-${index}`, type:"number", min:1, max:32, step:1, style:controlStyle, value:node.maxConcurrent, disabled,
              "aria-invalid": parsed.invalid.includes("nodeCapacities") || undefined,
              onChange:event => edit("nodeCapacities", draft.nodeCapacities.map((value,i) => i === index ? {...value,maxConcurrent:event.target.value} : value))}))),
          !draft.nodeCapacities?.length ? h("p", {style:hintStyle}, t("nodeCapacityEmpty")) : null) : null,

          )),
        planner ? h(SettingsArea,{id:"task-decisions",title:"观察归并",description:"仅供没有对话模型参与的自动观察筛选。派发和执行会话不调用 JEV。"},
          h("div",{"data-task-scheduler-decision":true},
            h("h3",null,t("schedulerDecisionTitle")),h("p",{style:hintStyle},t("schedulerDecisionHint")),
            decisionToggle("planningDecisionEnabled",planner),renderDecisionModels?.("planner")),
          !decisionAvailable ? h("p",{role:"note",style:hintStyle},t("decisionDependencyRequired")) : null) : null,
        parsed.invalid.length
          ? h(
              "p",
              { role: "alert" },
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
        status.saved && !saveCoordinator ? h("p", { role: "status" }, t("startupSaved")) : null,
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
                setConnection({ checking: false });
                onRoleChange?.(deployment(row.values));
                setStatus({ saving: false });
              },
            },
            t("discardDraft"),
          ),
        ) : null,
      );
    }
    const nodeModelKey = choice => JSON.stringify([choice.provider,choice.model,choice.backend ?? null]);
    const nodeModelChoiceKey = choice => choice ? JSON.stringify([choice.provider,choice.model,choice.reasoningEffort ?? null,choice.backend ?? null]) : "";
    function nodeModelCatalog(value) {
      const positive=value?.catalog.positiveSnapshot;
      const recent=!!positive?.revision && positive.expiresAt>Date.now();
      const snapshot=recent?positive:value?.catalog.snapshot;
      return {snapshot,available:recent || (value?.catalog.state==="fresh" && snapshot?.complete===true && snapshot.expiresAt>Date.now() && !!snapshot.revision)};
    }
    function NodeModelSettings({nodeId,read,refresh,save,saveCoordinator,writable,active=true}) {
      const [state,setState]=React.useState({loading:true}),[draft,setDraft]=React.useState(null),[saving,setSaving]=React.useState(false),[message,setMessage]=React.useState("");
      const generation=React.useRef(0);
      const [,setCatalogClock]=React.useState(0);
      const expiry=state.value?.catalog.positiveSnapshot?.expiresAt ?? state.value?.catalog.snapshot?.expiresAt;
      React.useEffect(()=>{
        if(!expiry || expiry<=Date.now())return;
        const timer=setTimeout(()=>setCatalogClock(value=>value+1),Math.min(2147483647,expiry-Date.now()+1));
        return()=>clearTimeout(timer);
      },[expiry]);
      const accept = value => {
        if(value?.nodeId!==nodeId || !value.policy || !value.catalog)throw new Error("节点模型设置返回的身份不匹配");
        return value;
      };
      const load=React.useCallback(async force=>{
        const request=++generation.current;
        setState(old=>({...old,loading:true,error:""}));
        try {
          let value=accept(await (force?refresh:read)({nodeId}));
          if(generation.current!==request)return;
          setState({value,loading:false});
          if(!force && !nodeModelCatalog(value).available){
            setState({value,loading:true});
            value=accept(await refresh({nodeId}));
            if(generation.current===request)setState({value,loading:false});
          }
        }catch(error){if(generation.current===request)setState(old=>({...old,loading:false,error:error?.message || "模型目录读取失败"}));}
      },[nodeId,read,refresh]);
      React.useEffect(()=>{void load(false);return()=>{generation.current++;};},[load]);
      const value=state.value,{snapshot,available}=nodeModelCatalog(value);
      const fresh=available && !state.error;
      const models=snapshot?.models ?? [],groups=new Map();
      for(const model of models){const key=nodeModelKey(model);if(!groups.has(key))groups.set(key,{...model,efforts:[]});const group=groups.get(key);if(!group.efforts.includes(model.reasoningEffort))group.efforts.push(model.reasoningEffort);}
      const choice=draft?.choice ?? value?.policy.choice,modelKey=choice?nodeModelKey(choice):"",group=groups.get(modelKey);
      const dirty=!!draft && nodeModelChoiceKey(draft.choice)!==nodeModelChoiceKey(value?.policy.choice);
      const valid=!!draft?.choice;
      const disabled=!writable || !active || saving || state.loading || !fresh;
      const choose=next=>{setDraft({choice:next,catalogRevision:snapshot.revision,expectedRevision:draft?.expectedRevision ?? value.policy.revision});setMessage("");};
      const saveDefault=async()=>{
        if(!dirty || !valid || !writable || !active || saving || state.loading)return false;
        setSaving(true);setMessage("");
        try {
          const result=accept(await save({nodeId,expectedRevision:draft.expectedRevision,expectedCatalogRevision:draft.catalogRevision,choice:draft.choice}));
          generation.current++;setState({value:result,loading:false});setDraft(null);setMessage("节点默认执行模型已保存。");return true;
        }catch(error){const code=error?.details?.reason ?? error?.code;
          const reason={EXECUTION_CATALOG_STALE:"暂未取得新鲜目录，执行端可能离线或响应超时，请稍后重试。",EXECUTION_CATALOG_UNCONFIRMED:"本次目录仅部分成功，尚不能确认所选模型与档位，请稍后重试。",EXECUTION_MODEL_UNAVAILABLE:"最新完整目录中已没有所选模型与档位，请核对后选择。",EXECUTION_MODEL_POLICY_CONFLICT:"此节点默认值已被其他操作修改。请刷新核对，丢弃这份旧草稿后重新选择并保存。",EXECUTION_MODEL_AUTHORITY_CHANGED:"调度端身份已变化，请刷新核对后再保存。",EXECUTOR_REQUIRED:"此执行端已停用或身份绑定已变化，请重新核对节点。",FORBIDDEN:"当前身份不能保存调度端设置。"}[code];
          setMessage(`保存失败，草稿已保留：${reason ?? error?.message ?? code ?? "请稍后重试"}`);return false;}
        finally{setSaving(false);}
      };
      useSaveParticipant(saveCoordinator,`node-model-${nodeId}`,{meta:{dirty:dirty && active,retainedDirty:dirty && !active,invalid:!writable || !valid,busy:saving || state.loading,restart:false},save:saveDefault,discard:()=>{setDraft(null);setMessage("");}});
      return h("section",{"data-node-model-settings":nodeId},
        h("h4",null,"默认执行模型"),
        h("p",{style:hintStyle},"仅影响未明确指定执行模型的任务。此设置属于这个节点，不修改全局模型或决策模型。"),
        !value?.policy.choice?h("p",{style:hintStyle},"尚未设置节点默认值；系统备用为 deepseek-official / deepseek-flash · high，实际执行前会验证可用性。"):null,
        h("p",{role:"status",style:hintStyle},state.loading?"正在读取此节点的模型目录…":state.error || (fresh && !snapshot.complete?"已读取部分模型目录，可选择已确认的模型。未列出的模型与已有默认值保持不变。":({fresh:fresh?"已读取完整模型目录。":"模型目录已过期，保存时将重新确认所选模型。",stale:"模型目录已过期，保留已有默认值。",pending:"正在等待节点返回模型目录，保留已有默认值。",unavailable:"模型目录暂不可用，保留已有默认值。"}[value?.catalog.state] ?? "尚未读取模型目录。"))),
        choice?h("p",{style:hintStyle},`当前${draft?"草稿":"默认"}：${choice.provider} / ${choice.model}${choice.backend?` · ${choice.backend}`:""} · ${choice.reasoningEffort ?? "模型默认档位"}`):null,
        h("div",{className:"task-connection-grid"},
          h("label",{className:"task-connection-field"},h("span",null,"执行模型"),h("select",{"aria-label":"默认执行模型",style:controlStyle,value:modelKey,disabled,onChange:event=>{
            const selected=groups.get(event.target.value);if(!selected)return;
            const effort=selected.efforts.includes(choice?.reasoningEffort)?choice?.reasoningEffort:selected.efforts.includes("high")?"high":selected.efforts[0];
            choose({provider:selected.provider,model:selected.model,...(selected.backend?{backend:selected.backend}:{}),...(effort!==undefined?{reasoningEffort:effort}:{})});
          }},h("option",{value:"",disabled:true},"选择此节点的执行模型"),
          choice && !groups.has(modelKey)?h("option",{value:modelKey,disabled:true},`${choice.provider} / ${choice.model} · 当前目录未确认`):null,
          ...[...groups].map(([key,model])=>h("option",{key,value:key},`${model.provider} / ${model.model}${model.backend?` · ${model.backend}`:""}`)))),
          h("label",{className:"task-connection-field"},h("span",null,"推理档位"),h("select",{"aria-label":"默认推理档位",style:controlStyle,value:choice?.reasoningEffort ?? "",disabled:disabled || !group,onChange:event=>{
            if(!choice)return;const {reasoningEffort,...base}=choice;choose({...base,...(event.target.value?{reasoningEffort:event.target.value}:{})});
          }},!group || !group.efforts.includes(choice?.reasoningEffort)?h("option",{value:choice?.reasoningEffort ?? "",disabled:true},choice?.reasoningEffort ?? "请先选择模型"):null,
          ...(group?.efforts ?? []).map(effort=>h("option",{key:effort ?? "",value:effort ?? ""},effort ?? "模型默认档位"))))),
        dirty && !fresh?h("p",{role:"note",style:hintStyle},"草稿已保留；保存时会按需刷新目录并确认所选模型与档位，不会替换你的选择。"):null,
        message?h("p",{role:"status",style:hintStyle},message):null,
        h(Button,{variant:"outline",disabled:saving || state.loading,onClick:()=>load(true)},"刷新模型目录"),
        !saveCoordinator?h(Button,{variant:"outline",disabled:!writable || !active || saving || state.loading || !dirty || !valid,onClick:saveDefault},saving?"保存中…":"保存节点默认模型"):null);
    }
    function ConnectionSettings({read,save,onSaved,saveCoordinator,role,onCreatedDraft,savedPaused,onAuthMode,nodeModelApi}) {
      const {state,replace,refresh}=useReadSnapshot(read);
      const [draft,setDraft]=React.useState(null),[expected,setExpected]=React.useState(null),[status,setStatus]=React.useState({saving:false}),[checks,setChecks]=React.useState({});
      const current=state.value,value=draft ?? current?.values;
      const paused=savedPaused ?? current?.paused;
      React.useEffect(()=>{if(current)onAuthMode?.(current.values.authMode);},[current?.values.authMode]);
      const edit=(key,next)=>{setExpected(old=>old ?? current.revision);setDraft(old=>({...old ?? current.values,[key]:next}));setStatus({saving:false});};
      const policy=typeof role === "object" && role ? role : deployment({role});
      const planner=policy.centralMode === "host",executor=true;
      const schedulerKeys=["listenerEnabled","listenAddress","listenPort","routePath","serviceAudience","peers"];
      const outboundEditor=value?.outbound?._fields;
      const outboundParsed=outboundEditor?buildOutbound(outboundEditor,value.authMode==="trusted-network"):null;
      const selectedOutbound=outboundParsed?{endpoint:outboundParsed.endpoint,audience:outboundParsed.audience,target:outboundParsed.target}:value?.outbound;
      const schedulerReady=!!value && connectionHost(value.listenAddress,true) && Number.isInteger(value.listenPort) && value.listenPort>=1 && value.listenPort<=65535 && /^\/[A-Za-z0-9/_-]+$/.test(value.routePath) && !!value.serviceAudience?.trim() && !value.peers.some(peer=>!peer.nickname?.trim() || !connectionHost(peer.address,true));
      const schedulerRetained=planner && !value?.listenerEnabled && !schedulerReady && ["listenAddress","listenPort","peers"].some(key=>JSON.stringify(value?.[key])!==JSON.stringify(current?.values[key]));
      const outboundRetained=executor && !!outboundParsed?.invalid.length && (paused || !current?.exists);
      const projected=value?{...current.values,...Object.fromEntries(schedulerKeys.filter(()=>planner && !schedulerRetained).map(key=>[key,value[key]])),...(planner?{listenerEnabled:value.listenerEnabled}:{}),...(executor && !outboundRetained?{outbound:selectedOutbound}:{})}:null;
      const dirty=!!draft && JSON.stringify(projected)!==JSON.stringify(current?.values);
      const hiddenDraft=!!draft && (schedulerRetained || outboundRetained || (!planner && schedulerKeys.some(key=>JSON.stringify(value[key])!==JSON.stringify(current.values[key]))) || (!executor && JSON.stringify(value.outbound)!==JSON.stringify(current.values.outbound)));
      const saveConfig=async()=>{if(!current?.writable || !value || status.saving || (executor && !paused && current?.exists && outboundParsed?.invalid.length))return false;setStatus({saving:true});try{const result=await save({expected:expected ?? current.revision,value:projected});
        const retained={...result.values,...Object.fromEntries(schedulerKeys.filter(()=>!planner || schedulerRetained).map(key=>[key,value[key]])),...(!executor || outboundRetained?{outbound:value.outbound}:{})};
        if(!current.exists && !executor && value.outbound && JSON.stringify(value.outbound)!==JSON.stringify(current.values.outbound)){
          onCreatedDraft?.({...outboundFields(value.outbound.endpoint,value.outbound.audience,value.outbound.target),...value.outbound._fields,connectionTouched:true});retained.outbound=result.values.outbound;
        }
        replace(result);setDraft(JSON.stringify(retained)===JSON.stringify(result.values)?null:retained);setExpected(result.revision);setStatus({saving:false,saved:true});await onSaved();return true;}catch(error){setStatus({saving:false,error:error?.details?.reason ?? error?.code ?? "CONNECTION_SAVE_FAILED"});return false;}};
      useSaveParticipant(saveCoordinator,"connection-settings",{meta:{dirty,retainedDirty:hiddenDraft,invalid:!current?.writable || (planner && value?.listenerEnabled && !schedulerReady) || (executor && !paused && current?.exists && !!outboundParsed?.invalid.length),busy:status.saving,restart:true},save:saveConfig,discard:()=>{setDraft(null);setExpected(null);setStatus({saving:false});}});
      if(!value)return h("p",{role:state.failed?"alert":"status"},state.failed?"连接设置读取失败，请刷新重试。":"正在读取连接设置…");
      const field=(key,label,numeric=false)=>h("label",{className:"task-connection-field"},h("span",null,label),h("input",{id:`task-connection-${key}`,style:controlStyle,value:value[key] ?? "",inputMode:numeric?"numeric":undefined,disabled:status.saving || !current.writable || (value.authMode!=="trusted-network" && ["listenAddress","listenPort"].includes(key)),onChange:event=>edit(key,numeric?(event.target.value?Number(event.target.value):null):event.target.value)}));
      const editPeer=(index,key,next)=>{setChecks(old=>{const copy={...old};delete copy[value.peers[index].address];return copy;});edit("peers",value.peers.map((row,i)=>i===index?{...row,[key]:next}:row));};
      const outbound=value.outbound ?? {endpoint:"",audience:"",target:{address:"",port:null,localAddress:"",allowHttp:true}};
      const outgoingFields=outbound._fields ?? outboundFields(outbound.endpoint,outbound.audience,outbound.target);
      const editOutbound=(key,next)=>edit("outbound",{...outbound,_fields:{...outgoingFields,[key]:next}});
      return h("section",{"data-connection-settings":true},
        h("div",{"data-connection-role":"planner",hidden:!planner,style:{order:1}},
        h("h3",null,"调度端 · 本机任务服务"),
        h("p",{style:hintStyle},"接收执行端轮询和心跳；来源地址列表限定哪些执行端可以连接。"),
        h("label",{className:"task-switch-row"},"启用任务服务监听",h(Switch,{label:"启用任务服务监听",checked:value.listenerEnabled,disabled:!current.exists || !current.writable || status.saving,onChange:enabled=>edit("listenerEnabled",enabled)})),
        h("p",{role:"status",style:hintStyle},current.values.listenerEnabled?"已保存配置允许入站监听；服务状态和网络可达性需单独确认。":"已保存配置未启用入站任务接口。执行端连接可独立运行。"),
        h("div",{className:"task-connection-grid"},field("listenAddress","本机监听地址"),field("listenPort","本机监听端口",true),field("routePath","任务协议路径"),field("serviceAudience","本机任务服务受众标识（audience）")),
        h("h4",null,"执行端节点"),
        h("p",{style:hintStyle},"保存节点昵称和允许的来源地址后，首次合法握手会绑定真实执行端 ID。昵称不改变身份；只接受双方已明确配置的连接。"),
        ...value.peers.map((row,index)=>{
          const saved=current.values.peers.find(peer=>peer.address===row.address),evidence=current.peersStatus?.find(peer=>peer.address===row.address),check=checks[row.address];
          return h("div",{key:index,className:"task-connection-peer"},
            h("div",{className:"task-connection-grid"},...[ ["nickname","节点昵称"],["address","执行端来源地址"] ].map(([key,label])=>h("label",{key,className:"task-connection-field"},h("span",null,label),h("input",{style:controlStyle,value:row[key] ?? "",disabled:status.saving || !current.writable,onChange:event=>editPeer(index,key,event.target.value)})))),
            h("p",{style:hintStyle},row.nodeId?`执行端 ID：${row.nodeId}`:"执行端 ID：等待此来源首次握手后绑定"),
            row.nodeId && nodeModelApi?h(NodeModelSettings,{key:row.nodeId,nodeId:row.nodeId,...nodeModelApi,saveCoordinator,writable:current.writable,active:planner}):h("p",{style:hintStyle},"先连接并绑定执行端身份，随后可设置此节点的默认执行模型。"),
            h("p",{style:hintStyle},"允许此节点连接并执行分配给它的任务。新会话使用 PTC 和默认工具。"),
            check ? h("p",{role:"status"},check) : evidence?.state==="unpaired" ? h("p",{style:hintStyle},"尚未连接") : null,
            h("div",{style:{display:"flex",justifyContent:"space-between",gap:12,flexWrap:"wrap"}},
              h("label",{className:"task-switch-row"},"允许此设备领取执行任务",h(Switch,{label:"允许此设备领取执行任务",checked:row.executionEnabled ?? ["executor","both"].includes(row.role),disabled:status.saving || !current.writable,onChange:enabled=>edit("peers",value.peers.map((peer,i)=>i===index?{...peer,executionEnabled:enabled}:peer))})),
              h(Button,{variant:"outline",disabled:status.saving || !current.writable,onClick:()=>{setChecks(old=>{const copy={...old};delete copy[row.address];return copy;});edit("peers",value.peers.filter((_,i)=>i!==index));}},"移除设备连接"),
              h(Button,{variant:"outline",disabled:status.saving,onClick:async()=>{
                if(!saved || row.nickname!==saved.nickname || row.address!==saved.address){setChecks(old=>({...old,[row.address]:"此节点草稿尚未保存，未检测。"}));return;}
                try{const snapshot=await read(),item=snapshot.peersStatus?.find(peer=>peer.address===row.address);replace(snapshot);
                  const message=!item?.nodeId?"尚未连接：等待执行端发来首次合法握手。":`执行端 ID：${item.nodeId}；${item.sampledAt?`最近心跳 ${new Date(item.sampledAt).toLocaleString()}`:"尚无心跳"}；${{online:"在线",stale:"心跳已过期",unavailable:"已连接但执行环境未就绪",disabled:"节点已停用",unknown:"尚无已确认心跳",waiting:"尚无已确认心跳",unregistered:"尚未完成登记"}[item.state] ?? item.state}。依据最近心跳判断连接状态；模型目录在节点卡片中按需读取。`;
                  setChecks(old=>({...old,[row.address]:message}));
                }catch{setChecks(old=>({...old,[row.address]:"检测状态读取失败，未确认连接。"}));}
              }},"检测")));
        }),
        h(Button,{variant:"outline",disabled:!current.writable || status.saving || value.authMode!=="trusted-network",onClick:()=>edit("peers",[...value.peers,{address:"",nodeId:"",nickname:"",executionEnabled:false}])},"添加设备连接"),
        ),
        !current.exists ? h("div",{"data-connection-role":"executor",hidden:!executor,style:{order:2}},
          h("h3",null,"连接中央服务"),h("p",{style:hintStyle},"本机通过中央服务的任务协议地址建立连接。会话协作与任务执行分别授权。"),
          h(OutboundConnectionFields,{fields:outgoingFields,edit:editOutbound,disabled:status.saving || !current.writable,trusted:value.authMode==="trusted-network",idPrefix:"task-connection-outbound",mismatch:!outbound._fields && outboundMismatch(outbound.endpoint,outbound.target),originalTarget:outbound.target,onSynchronize:()=>edit("outbound",{...outbound,_fields:outgoingFields})}),
          executor && outboundParsed?.invalid.length ? h("p",{role:"note",style:hintStyle},"当前执行端未启用，不完整草稿已保留；启用前需补全调度端地址、端口、路径、受众标识和本机来源地址。") : null,
          ) : null,
        !current.exists ? h("div",{style:{order:3}},h(Button,{variant:"outline",disabled:!current.writable || status.saving || (executor && !paused && current?.exists && !!outboundParsed?.invalid.length),onClick:saveConfig},status.saving?"保存中…":"保存连接配置"),h("p",{style:hintStyle},"首次保存后保持暂停，可在完成配置后启用。")) : null,
        hiddenDraft ? h("p",{role:"note",style:{...hintStyle,order:3}},"未启用或未选中的连接草稿已保留，本次保存不提交不完整内容。") : null,
        status.error ? h("p",{role:"alert",style:{order:3}},`未能保存连接配置：${status.error}。草稿已保留。`) : null,
        status.saved ? h("p",{role:"status",style:{order:3}},"连接配置已保存；尚未据此验证网络或执行能力。") : null,
        h("details",{style:{order:3}},h("summary",null,"连接信息与刷新"),h("p",{style:hintStyle},`节点 ${value.nodeId} · ${value.authMode==="trusted-network"?"可信网络协议":"既有签名协议"}`),h(Button,{variant:"outline",disabled:status.saving,onClick:refresh},"刷新连接配置")));
    }
    function StartupSettings({
      t,
      readConnectionSettings,saveConnectionSettings,
      nodeModelApi,
      startup,
      saveStartup,
      readWorkspaces,
      renderExecutionDirectory,
      readExecutionPresets,
      renderProjectDirectory,
      renderConnection,
      onSaved,
      openPlugins,
      openDecisionModels,
      renderDecisionModels,
      checkConnection,
      saveCoordinator,
    }) {
      const { state, refresh, replace } = useReadSnapshot(startup);
      const [taskRole, setTaskRole] = React.useState(null);
      const [createdRemoteDraft,setCreatedRemoteDraft]=React.useState(null);
      const [connectionAuthMode,setConnectionAuthMode]=React.useState(null);
      const savedRoleKey =
        state.value?.task?.entryId +
        JSON.stringify(state.value?.task?.values);
      React.useEffect(() => {
        setTaskRole(state.value?.task ? deployment(state.value.task.values) : null);
      }, [savedRoleKey]);
      const role = taskRole ?? deployment(state.value?.task?.values ?? {});
      const afterSave = async () => {
        // Clear the old connection summary before reading the new plugin state.
        onSaved();
        const value = await startup();
        replace(value);
        return value;
      };
      return h(
        "section",
        { "data-task-startup-settings": true },
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
                      state.value.task.entryId,
                    t,
                    target: "task",
                    openPlugins,
                    renderDecisionModels,
                    onRoleChange: setTaskRole,
                    renderExecutionDirectory,
                    readExecutionPresets,
                    renderProjectDirectory,
                    renderConnection: () => h("div",{className:"task-collaboration-settings"},
                      state.value.remote ? h(StartupRow,{key:state.value.remote.entryId,t,target:"remote",connectionRole:role,connectionAuthMode,initialDraft:createdRemoteDraft,checkConnection,visible:true,row:state.value.remote,writable:state.value.writable,saveStartup,saveCoordinator,onSaved:afterSave}) : null,
                      h(ConnectionSettings,{key:"network-settings",role,savedPaused:state.value.remote?.values.paused,read:readConnectionSettings,save:saveConnectionSettings,onSaved:afterSave,saveCoordinator,onCreatedDraft:setCreatedRemoteDraft,onAuthMode:setConnectionAuthMode,nodeModelApi})),
                    row: state.value.task,
                    decisionAvailable: state.value.task.decisionAvailable === true,
                    writable: state.value.writable,
                    saveStartup,
                    saveCoordinator,
                    onSaved: afterSave,
                  })
                : h(React.Fragment,null,h("p", { style: hintStyle }, t("startupUnavailable")),h(SettingsArea,{id:"task-connections",title:"协作连接"},state.value.remote
                ? h(StartupRow, {
                    key:
                      state.value.remote.entryId,
                    t,
                    target: "remote",
                    checkConnection,
                    visible: true,
                                  row: state.value.remote,
                    writable: state.value.writable,
                    saveStartup,
                    saveCoordinator,
                    onSaved: afterSave,
                  })
                : h("p",{role:"note",style:hintStyle},t("connectionSetupStatus")))),

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
        status.saved && !saveCoordinator ? h("p", { role: "status" }, t("startupSaved")) : null,
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
      const consumer = "task-planning";
      const current = state.value?.bindings?.[consumer] ?? "";
      const choice = selected ?? current;
      const savePreset=async()=>{setSaving(true);setMessage(null);try {const latest=await readDecisionConsole();if((latest.bindings?.[consumer] ?? "")!==current)throw {details:{reason:"DECISION_CONFLICT"}};await setDecisionPreset({expected:latest.revision,consumer,id:choice});select(null);await refresh();setMessage("预设选择已保存。");return true;} catch(error){setMessage(error?.details?.reason==="DECISION_CONFLICT" ? "配置已变化，请刷新后核对草稿。" : "保存未能确认，请查看决策插件状态。");return false;} finally {setSaving(false);}};
      useSaveParticipant(saveCoordinator,`preset-${consumer}`,{meta:{dirty:choice!==current,invalid:!state.value?.writable,busy:saving,restart:false},save:savePreset,discard:()=>{select(null);setMessage(null);}});
      return h("section", {"data-decision-model-settings": true, id:`task-decision-model-${role}`, tabIndex:-1},
        h("h4", {style:headingStyle}, "决策预设"),
        h("p", {style:hintStyle}, "在本插件选择预设。服务商、模型与思考强度在“JEV”中管理。此处只选择任务调用的模型配置。"),
        state.failed ? h("p", {role:"alert"}, "无法读取决策预设，请检查 Jev 是否启用。") : null,
        state.value ? h(React.Fragment, null,
          h("label", {htmlFor:`task-preset-select-${role}`,style:{display:"block",margin:"12px 0 6px"}}, "自动观察归并使用的预设"),
          h("select", {id:`task-preset-select-${role}`, value:choice, disabled:saving || !state.value.writable, style:controlStyle, onChange:e=>{select(e.target.value);setMessage(null);}},
            h("option", {value:""}, "跟随 Jev 默认服务商与模型"),
            ...(state.value.presets ?? []).map(p => h("option", {key:p.id,value:p.id}, p.name))),
          message ? h("p", {role:"status",style:hintStyle}, message) : null,
          !saveCoordinator ? h(Button, {variant:"outline",disabled:saving || !state.value.writable || choice===current,onClick:savePreset}, saving ? "保存中…" : "保存预设选择") : null) : h("p", {style:hintStyle}, "正在读取预设…"),
        h("div", {style:{display:"flex",flexWrap:"wrap",gap:8,marginTop:12}},
          h(Button, {variant:"outline",onClick:()=>{if(!openDecisions())setMessage("请打开设置 → JEV。");}}, "打开 JEV 设置"),
          h(Button, {variant:"outline",disabled:state.loading,onClick:refresh}, "刷新预设"),
          close ? h(Button, {variant:"outline",onClick:close}, "关闭预设选择") : null));
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

    function DirectoryField({ value, onChange, disabled, directoryApi, extraActions, label = "项目父目录" }) {
      const [open, setOpen] = React.useState(false);
      const [listing, setListing] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const [error, setError] = React.useState("");
      const [hidden, setHidden] = React.useState(false);
      const [folder, setFolder] = React.useState(null);
      const request = React.useRef(0);
      React.useEffect(() => () => { request.current++; }, []);
      const browse = async path => {
        const id = ++request.current;
        setLoading(true); setError("");
        try { const next = await directoryApi.list(path || undefined); if (id === request.current) setListing(next); }
        catch (reason) {
          if (id !== request.current) return;
          if (reason.rpcError?.code === "directory-picker/unavailable" && reason.rpcError?.details?.capability === "native" && directoryApi.pick) {
            setError("请在当前 DSH 服务设备弹出的系统窗口中选择目录。");
            try { const chosen=await directoryApi.pick(); if(id === request.current){if(chosen) onChange(chosen);setOpen(false);setError("");} }
            catch (failure) { if(id === request.current) setError(failure.message || "目录选择失败"); }
          } else setError(reason.message || "目录读取失败");
        }
        finally { if (id === request.current) setLoading(false); }
      };
      const close = () => { request.current++; setOpen(false); setLoading(false); setFolder(null); };
      return h("div", {"data-task-directory-picker":true},
        h("p", {style:hintStyle}, label),
        h("div", {className:"task-directory-value"}, value || "尚未选择目录"),
        h("div", {className:"task-directory-actions"},
          h(Button, {variant:"outline",disabled:disabled || !directoryApi,onClick:()=>{setListing(null);setFolder(null);setOpen(true);void browse(value);}}, "选择目录"),
          extraActions),
        open ? h(Modal, {open:true,onClose:close,closeLabel:"取消目录选择",title:"选择当前服务所在设备的目录"},
          h("div", {style:{maxHeight:"65vh",overflowY:"auto",padding:12,minWidth:0}},
            h("p", {style:hintStyle}, "浏览的是当前连接的 DSH 服务设备；选择后会在这里自动创建项目文件夹。"),
            h("nav", {"aria-label":"目录位置",style:{display:"flex",gap:6,flexWrap:"wrap"}},
              h(Button,{variant:"outline",disabled:loading,onClick:()=>browse()},"主目录"),
              ...(listing?.crumbs ?? []).map(crumb=>h(Button,{key:crumb.path,variant:"outline",disabled:loading,onClick:()=>browse(crumb.path)},crumb.name))),
            h("p",{style:{overflowWrap:"anywhere"}},listing?.path || ""),
            h("label",null,h("input",{type:"checkbox",checked:hidden,onChange:event=>setHidden(event.target.checked)})," 显示隐藏目录"),
            loading ? h("p",{role:"status"},"正在读取目录…") : null,
            error ? h("p",{role:"alert"},error) : null,
            h("div",{style:{display:"grid",gap:4,margin:"12px 0"}},...(listing?.entries ?? []).filter(entry=>hidden || !entry.hidden).map(entry=>
              h(Button,{key:entry.path,variant:"outline",disabled:loading,onClick:()=>{setFolder(null);void browse(entry.path);},style:{textAlign:"left"}},`📁 ${entry.name}`))),
            listing?.truncated ? h("p",{role:"status"},"目录较多，当前列表仅显示一部分。") : null,
            folder !== null ? h("div",null,
              h("input",{"aria-label":"新文件夹名称",value:folder,onChange:event=>setFolder(event.target.value),disabled:loading}),
              h(Button,{disabled:loading || !folder.trim(),onClick:async()=>{setLoading(true);setError("");try{const path=await directoryApi.create(listing.path,folder.trim());setFolder(null);await browse(path);}catch(reason){setError(reason.message);setLoading(false);}}},"创建")) :
              h(Button,{variant:"outline",disabled:loading || !listing || !!error,onClick:()=>setFolder("")},"新建文件夹"),
            h("div",{style:{display:"flex",justifyContent:"flex-end",gap:8,marginTop:16}},
              h(Button,{variant:"outline",onClick:close},"取消"),
              h(Button,{variant:"primary",disabled:loading || !listing || !!error,onClick:()=>{onChange(listing.path);close();}},"选择此目录")))) : null);
    }
    function ProjectWorkspaceSettings({ readProjectSettings, saveProjectSettings, saveCoordinator, directoryApi, executor = false }) {
      const {state, replace, refresh} = useReadSnapshot(readProjectSettings);
      const [root, setRoot] = React.useState(null), [saving, setSaving] = React.useState(false), [notice, setNotice] = React.useState("");
      const saveRoot=async()=>{setSaving(true);setNotice("");try {const value=await saveProjectSettings({root:(root ?? state.value.root ?? state.value.fallback ?? "").trim(),expectedRevision:state.value.revision});replace({enabled:true,...value});setRoot(null);setNotice("项目父目录已保存");return true;} catch {setNotice("保存失败，请核对路径或刷新后重试；草稿已保留。");return false;} finally {setSaving(false);}};
      useSaveParticipant(saveCoordinator,executor ? "execution-root" : "project-root",{meta:{dirty:root!==null && root!==state.value?.root,invalid:!state.value?.enabled || !(root ?? state.value?.root ?? state.value?.fallback ?? "").trim(),busy:saving,restart:false},save:saveRoot,discard:()=>{setRoot(null);setNotice("");}});
      if (state.value && !state.value.enabled) return null;
      return h("section", {"data-project-workspace-settings": true, className:"task-directory-card"},
        h("h3", {style: headingStyle}, executor ? "执行端 · 工作区" : "调度端 · 项目工作区"),
        h("p", {style: hintStyle}, executor ? "选择这台执行设备上的父目录。项目任务按项目创建文件夹；普通临时任务共用 temporary-tasks。递归子任务单独隔离，已有会话保留原位置。" : "项目和临时任务的规划工作区父目录。只影响新建工作区；执行端在各自设备上选择父目录。"),
        h(DirectoryField, {value:root ?? state.value?.root ?? state.value?.fallback ?? "", directoryApi, disabled:!state.value?.enabled || saving,
          onChange:value=>{setRoot(value);setNotice("");},
          extraActions:h(React.Fragment,null,
            !saveCoordinator ? h(Button,{variant:"outline",disabled:!state.value?.enabled || saving,onClick:saveRoot},saving ? "正在保存…" : "保存项目父目录") : null,
            h(Button,{variant:"outline",disabled:saving,onClick:()=>{setNotice("");refresh();}},"刷新"))}),
        h("div",{className:"task-directory-notice"},
          state.failed ? h("p",{role:"alert"},"读取项目父目录失败，请刷新重试。") : null,
          notice ? h("p",{role:"status",style:hintStyle},notice) : null));
    }

    function ExecutorWorkspaceGrantSettings({readGrants,setGrant}) {
      const {state,replace,refresh}=useReadSnapshot(readGrants);
      const [saving,setSaving]=React.useState(false),[notice,setNotice]=React.useState("");
      if(state.value?.enabled===false)return null;
      const change=async item=>{setSaving(true);setNotice("");try {const value=await setGrant({registryId:item.registryId,enabled:!item.enabled,expectedRevision:state.value.revision});replace(value);setNotice(item.enabled?"本机工作区已停用；已运行任务保留原上下文。":"本机工作区已启用；调度端收到公告且通过连接授权后可选择。");}catch(reason){const failure=reason?.rpcError??reason;setNotice(["CONFLICT","WORKSPACE_GRANT_CONFLICT"].includes(failure?.details?.reason)?"授权已被其他操作更改，请刷新后重试。":failure?.details?.reason==="CONFIGURATION_BUSY"?"本机仍有活动执行或待回传结果，暂不能更改授权。":"目录授权保存失败，请检查目录是否存在并刷新；没有自动授权其他目录。");}finally {setSaving(false);}};
      return h("section",{"data-executor-workspace-grants":true,className:"task-workspace-grants"},
        h("h3",{style:headingStyle},"本机执行 · 工作区"),
        h("p",{style:hintStyle},"受信网络调度可选择此设备已登记且有效的 DSH 工作区；可在此停用特定目录。静态连接仍遵循其目录授权。这里只管理本机目录，不接受调度端传入任意路径。"),
        state.loading&&!state.value?h("p",{role:"status"},"正在读取本机工作区…"):null,
        state.failed?h("p",{role:"alert"},"本机工作区读取失败，请刷新重试。"):null,
        ...(state.value?.items??[]).map(item=>h("div",{key:item.workspaceId,style:{borderTop:"1px solid var(--dsw-alias-border-l3,#8884)",padding:"12px 0",display:"flex",gap:12,alignItems:"center"}},
          h("div",{style:{flex:1,minWidth:0}},h("strong",null,item.label),h("p",{style:{...hintStyle,overflowWrap:"anywhere",margin:"4px 0"}},item.path),h("small",null,item.source==="configuration"?"插件配置授权":item.enabled?(item.state==="ready"?(item.source==="registry"?"本机已登记 · 受信调度可选":"已启用"):"目录不可用"):item.state==="revoked"?"已停用":"未授权")),
          h(Button,{variant:"outline",disabled:saving||!item.registryId||item.source==="configuration"||!item.enabled&&!(item.available ?? item.state==="ready"),onClick:()=>change(item)},item.source==="configuration"?"由插件配置管理":item.enabled?"停用此工作区":"启用此工作区"))),
        state.value&&!state.value.items.length?h("p",{role:"status"},"没有本机工作区登记。请先在此执行端的 DSH 工作区中添加已有目录，再刷新；调度端不能替本机填写任意路径。"):null,
        notice?h("p",{role:"status",style:hintStyle},notice):null,
        h(Button,{variant:"outline",disabled:saving,onClick:()=>{setNotice("");refresh();}},"刷新本机工作区"));
    }
    function Page(props) {
      const { t } = props;
      const registryRef=React.useRef(null);if (!registryRef.current) registryRef.current=new SettingsSaveCoordinator();
      const saveCoordinator=registryRef.current;
      const [,redrawSave]=React.useState(0);
      React.useEffect(()=>saveCoordinator.subscribe(()=>redrawSave(value=>value+1)),[saveCoordinator]);
      const [refreshKey, setRefreshKey] = React.useState(0);
      const state = props.useTaskSettings((snapshot) => snapshot);
      useSaveParticipant(saveCoordinator,"runtime",{meta:{dirty:state.dirty,invalid:state.invalid || !state.writable,busy:state.saving,restart:false},save:props.save,discard:props.discard});
      const saveState=saveCoordinator.snapshot();
      const hostIdentity=useReadSnapshot(props.read);
      React.useEffect(()=>{const warn=event=>{if(saveCoordinator.snapshot().count || saveCoordinator.snapshot().retained){event.preventDefault();event.returnValue="";}};window.addEventListener("beforeunload",warn);return()=>window.removeEventListener("beforeunload",warn);},[saveCoordinator]);
      if (props.view === "summary") return t("summary");
      return h(
        "div",
        { "data-task-plugin-settings": true, style:{minHeight:"100%",display:"flex",flexDirection:"column"} },
        h(
          "style",
          null,
          `[data-task-plugin-settings] { min-width:0; width:100%; max-width:none; margin:0; padding:0 40px; box-sizing:border-box; overflow-wrap:anywhere; }
          [data-task-plugin-settings] * { box-sizing:border-box; }
          [data-task-plugin-settings] > :not(style):not(header) {width:100%;max-width:1200px;margin-left:auto;margin-right:auto;}
          [data-task-plugin-settings] h1 {font-size:17px;margin:0 0 8px;line-height:1.3;}
          [data-task-plugin-settings] h3 {font-size:17px;margin:22px 0 10px;}
          [data-task-plugin-settings] .task-settings-header {display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin:0 -40px 22px;padding:16px 26px;border-bottom:1px solid var(--dsw-alias-border-l3,#ddd);min-height:76px;}
          [data-task-plugin-settings] .task-settings-header p{font-size:11px;margin:4px 0 0;}
          [data-task-plugin-settings] .task-primary-nav {display:flex;flex-wrap:wrap;gap:3px;border-radius:18px;padding:5px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#eef1ef) 88%,#839b8c 12%);}
          [data-task-plugin-settings] .task-primary-nav button:not([role="switch"]) {border:0!important;background:transparent!important;border-radius:14px!important;padding:8px 16px!important;font-size:13px;white-space:nowrap;}
          [data-task-plugin-settings] .task-primary-nav button[aria-current=page]:not([role="switch"]){background:var(--dsw-alias-bg-layer-1,#fff)!important;box-shadow:0 1px 4px #00000012;color:var(--dsw-alias-label-primary,#222);font-weight:600;}

          [data-task-plugin-settings] .task-settings-nav {display:flex;flex-wrap:wrap;gap:8px 22px;padding:16px 0 24px;}
          [data-task-plugin-settings] .task-settings-nav a {color:var(--dsw-alias-link,#4d94e6);text-decoration:none;font-size:14px;}
          [data-task-plugin-settings] [data-settings-area] {margin:24px 0 40px;scroll-margin-top:20px;}
          [data-task-plugin-settings] [data-settings-area] > header {border-left:4px solid #4d94e6;background:color-mix(in srgb,#4d94e6 7%,transparent);padding:16px 22px;margin-bottom:22px;}
          [data-task-plugin-settings] [data-settings-area] > header h2 {color:var(--dsw-alias-link,#4d94e6);font-size:24px;line-height:1.3;margin:0 0 8px;font-weight:650;}
          [data-task-plugin-settings] [data-settings-area] > header p {margin-bottom:0;}
          [data-task-plugin-settings] [data-settings-area-body] {padding:0 6px;}
          [data-task-plugin-settings] .task-collaboration-settings{display:flex;flex-direction:column;gap:10px;}
          [data-task-plugin-settings] .task-collaboration-settings > [data-startup-target=remote], [data-task-plugin-settings] .task-collaboration-settings > [data-connection-settings]{display:contents!important;}
          [data-task-plugin-settings] .task-directory-grid > div:empty{display:none;}
          [data-task-plugin-settings] .task-directory-grid > div:not(:empty){display:contents;}
          [data-task-plugin-settings] .task-directory-card{display:grid;grid-template-rows:subgrid;grid-row:span 6;row-gap:10px;min-width:0;}
          [data-task-plugin-settings] .task-workspace-grants{display:grid;grid-column:1/-1;gap:10px;min-width:0;}
          [data-task-plugin-settings] :is(.task-directory-card,.task-workspace-grants) > :is(h3,p){margin:0;}
          [data-task-plugin-settings] .task-directory-card [data-task-directory-picker]{display:contents;}
          [data-task-plugin-settings] .task-directory-card [data-task-directory-picker] > p{margin:0;}
          [data-task-plugin-settings] .task-directory-value{overflow-wrap:anywhere;min-width:0;align-self:start;}
          [data-task-plugin-settings] .task-directory-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;align-self:start;}

          [data-task-plugin-settings] .task-directory-grid:has(> div:empty){grid-template-columns:minmax(0,1fr);}
          [data-task-plugin-settings] .task-directory-grid,[data-task-plugin-settings] .task-decision-grid {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:32px;}
          [data-task-plugin-settings] .task-connection-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 28px;}
          [data-task-plugin-settings] .task-connection-field{display:flex;flex-direction:column;gap:6px;margin:8px 0;min-width:0;}
          [data-task-plugin-settings] .task-connection-peer{border:1px solid var(--dsw-alias-border-l3,#888);border-radius:10px;padding:16px;margin:16px 0;}
          [data-task-plugin-settings] .task-operation-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;font-size:12px;}
          @media(max-width:760px){[data-task-plugin-settings] .task-connection-grid{grid-template-columns:minmax(0,1fr);}}
          [data-task-plugin-settings] .task-switch-row {display:flex;align-items:center;justify-content:space-between;gap:20px;margin:16px 0;}
          [data-task-plugin-settings] [data-startup-target=remote] {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 28px;}
          [data-task-plugin-settings] [data-startup-target=remote] > :not(label) {grid-column:1/-1;}
          [data-task-plugin-settings] [data-task-runtime-form] {max-width:780px;}
          [data-task-plugin-settings] details {padding:14px 0;}
          [data-task-plugin-settings] summary {cursor:pointer;font-weight:600;}
          @media(max-width:760px){[data-task-plugin-settings]{padding:0 18px;}[data-task-plugin-settings] .task-settings-header{margin:0 -18px 18px;padding:14px 16px;align-items:flex-start;}[data-task-plugin-settings] .task-primary-nav{max-width:100%;}[data-task-plugin-settings] .task-primary-nav button{padding:7px 11px!important;}[data-task-plugin-settings] .task-directory-grid,[data-task-plugin-settings] .task-decision-grid,[data-task-plugin-settings] [data-startup-target=remote]{grid-template-columns:minmax(0,1fr);gap:16px;}[data-task-plugin-settings] [data-settings-area] > header{padding:14px 16px;}[data-task-plugin-settings] [data-settings-area] > header h2{font-size:21px;}}

          [data-task-plugin-settings] [hidden] { display: none !important; }
          [data-task-plugin-settings] input, [data-task-plugin-settings] select { min-width: 0; max-width: 100%; }
          [data-task-plugin-settings] select { appearance:none; -webkit-appearance:none; padding-right:36px!important; background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Cpath d='m4 6 4 4 4-4' fill='none' stroke='%23788894' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")!important; background-repeat:no-repeat!important; background-position:right 12px center!important; background-size:16px 16px!important; }
          [data-task-plugin-settings] [role="switch"] { flex-shrink: 0; }
          [data-task-plugin-settings] button:not([role="switch"]) { border: 1px solid var(--dsw-alias-border-l3, #8a8a8a) !important; }
          [data-task-plugin-settings] button:not([role="switch"]) { border-radius: 6px; background: var(--dsw-alias-bg-layer-2, #e9e9e9); padding: 7px 12px; color: var(--dsw-alias-label-primary, #252525); }
          [data-task-plugin-settings] button:not([role="switch"]):disabled { color: var(--dsw-alias-label-secondary, #666); opacity: 1; cursor: not-allowed; }
          [data-task-plugin-settings] [data-task-detail-row] { align-items: start; }
          [data-task-plugin-settings] table th, [data-task-plugin-settings] table td { vertical-align: top; text-align: left; }
          [data-task-plugin-settings] button:focus-visible, [data-task-plugin-settings] input:focus-visible, [data-task-plugin-settings] select:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
          [data-task-plugin-settings] section { border:0; padding-top:0; }
          [data-task-plugin-settings] [data-task-startup-settings] > [data-startup-target="task"] { border-top: 0; padding-top: 0; margin-top: 0; }
          [data-task-plugin-settings] section > h3:first-child, [data-task-plugin-settings] section > h4:first-child { margin-top: 0 !important; }
          [data-task-plugin-settings] [data-task-runtime-form] > div > div:last-child > button { display:none; }
          [data-task-plugin-settings] [data-task-save-bar] { position:sticky; bottom:0; z-index:5; margin-top:20px; padding:12px; background:var(--dsw-alias-bg-layer-1,#fff); border-top:1px solid var(--dsw-alias-border-l3,#8a8a8a); box-shadow:0 -4px 12px rgba(0,0,0,.12); }
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
        h("header", {className:"task-settings-header"},
          h("div",null,h("h1",null,"设置"),h("p",{style:hintStyle},`当前服务设备 · ${hostIdentity.state.value?.nodeId ?? (hostIdentity.state.failed ? "身份读取失败" : "正在读取身份…")} · 本机配置`)),
          h("nav",{className:"task-primary-nav","aria-label":"任务系统导航"},...[ ["tasks","任务"],["projects","项目"],["fullpanel","完整面板"],["settings","设置"] ].map(([target,label])=>h("button",{type:"button",key:target,"aria-current":target==="settings"?"page":undefined,onClick:()=>props.onNavigate?.(target)},label)))),
        h("p",{style:hintStyle},"修改先保留为草稿；底部统一保存。即时设置与需重启插件的设置会分别标明，部分保存失败会保留未完成草稿。"),
        h("nav",{className:"task-settings-nav","aria-label":"设置分区"},...[ ["task-local","本机与工作区"],["task-connections","协作连接"],["task-decisions","观察归并"],["task-runtime","运行控制"],["task-diagnostics","状态与诊断"] ].map(([id,title])=>h("a",{key:id,href:`#${id}`,onClick:event=>{event.preventDefault();document.getElementById(id)?.scrollIntoView({block:"start",behavior:"smooth"});}},title))),
        props.startup
          ? h(StartupSettings, {
              t,
              readConnectionSettings:props.readConnectionSettings,
              saveConnectionSettings:props.saveConnectionSettings,
              nodeModelApi:props.nodeModelApi,
              readExecutionPresets:props.readExecutionPresets,
              startup: props.startup,
              readWorkspaces: props.readWorkspaces,
              renderProjectDirectory:()=>h(ProjectWorkspaceSettings,{readProjectSettings:props.readProjectSettings,saveProjectSettings:props.saveProjectSettings,saveCoordinator,directoryApi:props.directoryApi}),
              renderExecutionDirectory:()=>h(React.Fragment,null,h(ProjectWorkspaceSettings,{executor:true,readProjectSettings:props.readExecutionDirectorySettings,saveProjectSettings:props.saveExecutionDirectorySettings,saveCoordinator,directoryApi:props.directoryApi}),h(ExecutorWorkspaceGrantSettings,{readGrants:props.readExecutorWorkspaceGrants,setGrant:props.setExecutorWorkspaceGrant})),
              saveStartup: props.saveStartup,
              onSaved: () => setRefreshKey((value) => value + 1),
              openPlugins: props.openPlugins,
              checkConnection: props.checkConnection,
              saveCoordinator,
              renderDecisionModels: (role) => h(DecisionPresetSettings, {
                role, readDecisionConsole:props.readDecisionConsole, setDecisionPreset:props.setDecisionPreset,
                openDecisions:props.openDecisions, saveCoordinator,
              }),
            })
          : null,
        h(
          "div",
          { "data-task-runtime-and-diagnostics": true },
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
            { "data-task-runtime": true, id:"task-runtime", "data-settings-area":true },
            h("header",null,h("h2",null,"运行控制"),h("p",{style:hintStyle},"控制本机维护与自动执行；远程领取在协作连接中单独设置。")),
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
          h(SettingsArea,{id:"task-diagnostics",title:"状态与诊断",description:"这里显示实际运行状态。路径、内部 ID 和部署细节保持只读。"},
        h(LocalQueue, {
          key: refreshKey,
          t,
          readQueue: props.readQueue,
        }),
          h("details",null,h("summary",null,"部署与技术详情"),h(ReadOnly,{key:refreshKey,t,read:props.read,queryIdentity:props.queryIdentity}))),
        ),
        h("div", {"data-task-save-bar":true},
          h("p",{role:"status",style:{...hintStyle,margin:"0 0 8px"}},saveState.message || (saveState.count ? `有 ${saveState.count} 处未保存修改。${saveState.restart ? "包含需重启插件的变更。" : "保存后即时生效，已有运行保持原配置。"}` : saveState.retained ? "有未选配置的草稿保留，当前不提交；切回对应配置可继续编辑。" : "设置已保存；修改后在此统一保存。")),
          h("div",{style:{display:"flex",flexWrap:"wrap",gap:8}},
            h(Button,{variant:"outline",disabled:!saveState.count || saveState.invalid || saveState.busy,onClick:()=>saveCoordinator.saveAll()},saveState.busy ? "保存中…" : saveState.restart ? "保存并重启插件" : "保存设置"),
            h(Button,{variant:"outline",disabled:(!saveState.count && !saveState.retained) || saveState.busy,onClick:()=>saveCoordinator.discardAll()},"丢弃全部草稿")))
      );
    }
    class TaskSettingsSurface {
      constructor() { this.container=document.createElement("div");this.container.style.cssText="height:100%;min-height:0;width:100%;overflow:auto";this.listeners=new Set();this.opened=false; }
      subscribe = listener => {this.listeners.add(listener);return()=>this.listeners.delete(listener);};
      snapshot = () => this.opened;
      attach(node) {node.appendChild(this.container);if(!this.opened){this.opened=true;for(const listener of this.listeners)listener();}}
      detach(node) {if(this.container.parentNode===node)this.container.remove();}
    }
    function TaskSettingsPanel({surface}) {
      const ref=React.useRef(null);
      React.useEffect(()=>{const node=ref.current;surface.attach(node);return()=>surface.detach(node);},[surface]);
      return h("div",{ref,style:{height:"100%",minHeight:0,width:"100%"},"data-task-settings-panel":true});
    }
    function TaskSettingsPortal({surface, ...props}) {
      const opened=React.useSyncExternalStore(surface.subscribe,surface.snapshot,surface.snapshot);
      return opened ? createPortal(h(Page,props),surface.container) : null;
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
      "stewardSnapshot", "stewardSend", "stewardReconcile", "stewardResolve",
      "executionPresets",
      "connectionSettings","saveConnectionSettings",
      "nodeModelSettings","refreshNodeModels","saveNodeModelDefault",
      "workflowView", "setTaskPresentation", "readProjectReport", "getProjectReportPresentation",
      "workflowPage", "workflowSnapshot", "saveWorkflow", "startWorkflow", "retryWorkflowStep", "cancelWorkflow", "configureWorkflowTask", "adoptWorkflow", "createProjectTask", "runProjectTask",
      "sessionTasks",
      "projectExecutionSettings",
      "saveProjectExecutionSettings",
      "setExecutorAlertDisposition",
      "executorWorkspaceGrants",
      "setExecutorWorkspaceGrant",
      "projectSettings",
      "executionDirectorySettings",
      "saveExecutionDirectorySettings",
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
      "projectNativeConversation",
      "sendProjectMessage",
      "handoffProject",
      "reviewProjectTask",
      "actOnProjectTask",
      "setReportRetryLimit",
    ];
    const projectDescriptors = projectMethods.map((method) => ({
      id: `@dsh-task/task-system#taskPluginSettings/${method}`,
      service: "taskPluginSettings",
      namespace: "taskPluginSettings",
      method,
      invocation: { kind: "direct" },
      parameters: ["executionPresets", "workflowPage", "workflowSnapshot", "connectionSettings", "executionDirectorySettings", "executorWorkspaceGrants", "projectSettings", "projectPage", "conversationModels", "scheduleOptions"].includes(method)
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
              ["projectPage", "workflowPage"].includes(method)
                ? typeof value !== "string"
                : !value || typeof value !== "object"
            )
              throw Error("Invalid project response");
            return value;
          },
        }),
      },
    }));
    function ProjectIcon({ size }) {
      return h(
        "svg",
        {
          width: size,
          height: size,
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
    class ProjectNavigation {
      constructor(){this.target=null;this.listeners=new Set();}
      go(target){if(!["tasks","projects","fullpanel"].includes(target))return;this.target=target;for(const listener of this.listeners)listener(target);}
      subscribe(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
    }
    function ProjectNativeOverlay({ frame, nativeClient, invoke, descriptor, covered }) {
      const root = React.useRef(null), content = React.useRef(null);
      const [status, setStatus] = React.useState({ state: "connecting", message: "正在连接项目所属设备…" });
      const [retry, setRetry] = React.useState(0), [toast, setToast] = React.useState(null);
      const openRecipient = () => frame.current?.contentDocument?.querySelector('[data-action="recipient"]')?.click();
      React.useLayoutEffect(() => {
        const document = frame.current?.contentDocument;
        if (!document) return;
        const css = document.createElement("style");
        css.textContent = "[data-project-conversation-host][data-native-primary] > *{visibility:hidden!important;pointer-events:none!important}";
        document.head.append(css);
        let seat, animation;
        const resize = new ResizeObserver(() => schedule());
        const update = () => {
          animation = undefined;
          const next = document.querySelector("[data-project-conversation-host]");
          if (next !== seat) { if (seat) { seat.removeAttribute("data-native-primary"); resize.unobserve(seat); } seat = next; if (seat) resize.observe(seat); }
          if (!root.current) return;
          if (!seat || !seat.getClientRects().length) { root.current.style.display = "none"; return; }
          if (!seat.hasAttribute("data-native-primary")) seat.setAttribute("data-native-primary", "");
          const box = seat.getBoundingClientRect(), outer = frame.current.getBoundingClientRect();
          const notification = document.getElementById("toast");
          const shown = notification && !notification.hidden && notification.textContent.trim();
          const toastBox = shown ? notification.getBoundingClientRect() : null;
          const nextToast = shown ? { text: shown, status: notification.dataset.status, left: outer.left + toastBox.left, top: outer.top + toastBox.top, width: toastBox.width } : null;
          setToast((value) => JSON.stringify(value) === JSON.stringify(nextToast) ? value : nextToast);
          Object.assign(root.current.style, { display: "flex", left: `${outer.left + box.left}px`, top: `${outer.top + box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
        };
        const schedule = () => { if (animation === undefined) animation = requestAnimationFrame(update); };
        const mutation = new MutationObserver(schedule);
        mutation.observe(document.body, { childList: true, subtree: true, attributes: true });
        resize.observe(frame.current);
        document.addEventListener("scroll", schedule, true);
        window.addEventListener("resize", schedule);
        update();
        return () => { mutation.disconnect(); resize.disconnect(); css.remove(); seat?.removeAttribute("data-native-primary"); if (animation !== undefined) cancelAnimationFrame(animation); document.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); };
      }, [frame]);
      React.useEffect(() => {
        const abort = new AbortController();
        let mounted;
        setStatus({ state: "connecting", message: "正在连接项目所属设备…" });
        const recipient = openRecipient;
        nativeClient.mount(content.current, descriptor, invoke, { signal: abort.signal, onRecipient: recipient,
          onState: (value) => { if (!abort.signal.aborted) setStatus(value); } }).then((value) => {
          if (abort.signal.aborted) void value.dispose(); else mounted = value;
        }, (error) => { if (!abort.signal.aborted) setStatus({ state: "error", message: error?.message || "项目会话无法连接。" }); });
        return () => { abort.abort(); if (mounted) void mounted.dispose(); };
      }, [nativeClient, invoke, retry]);
      const blocked = status.state !== "ready";
      return h("section", { ref: root, "data-project-native-host": "", "aria-label": "项目统筹原生会话", inert: covered ? "" : undefined,
        style: { position: "fixed", zIndex: 1001, display: "none", flexDirection: "column", minHeight: 0,
          visibility: covered ? "hidden" : "visible", background: "var(--dsw-alias-bg-base,#fff)", color: "var(--dsw-alias-label-primary)" } },
        h("div", { ref: content, style: { height: "100%", minHeight: 0, opacity: blocked ? 0.5 : 1, pointerEvents: blocked ? "none" : "auto" } }),
        blocked && h("div", { role: status.state === "error" ? "alert" : "status", style: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12, padding: 24, background: "var(--dsw-alias-bg-base,#fff)" } },
          h("p", null, status.message), h("button", { type: "button", onClick: openRecipient }, "选择对话对象"), status.state === "error" && h("button", { type: "button", onClick: () => setRetry((value) => value + 1) }, "重新连接")),
        toast && h("div", { role: "status", "data-project-native-toast": "", style: { position: "fixed", zIndex: 1002, left: toast.left, top: toast.top, width: toast.width,
          boxSizing: "border-box", padding: "12px 18px", borderRadius: 10, pointerEvents: "none", fontSize: 12,
          background: toast.status === "done" ? "#dcfce7" : toast.status === "error" ? "#fee2e2" : "var(--dsw-alias-bg-base,#fff)",
          color: toast.status === "done" ? "#166534" : toast.status === "error" ? "#991b1b" : "inherit" } }, toast.text));
    }
    async function openTaskSession(input, invoke, openSession) {
      const snapshot=await invoke("projectSnapshot",{view:input?.view==="executor"?"executor":"planner"});
      const task=snapshot.tasks.find(task=>task.id===input?.taskId);
      if(!task || task.observationOnly || snapshot.viewContext?.nodeId!==input.nodeId)throw Error("请在会话所属设备的 DSH 中打开，不能在当前设备打开其他节点的同名会话。");
      const origin=task.checkin?.owner;
      const source=origin?.kind==="session" && origin.nodeId===input.nodeId && origin.sessionId===input.sessionId;
      const nativeRuns=snapshot.runs?.filter(r=>r.taskId===task.id && r.executionDriver==="dsh")??[];
      const execution=snapshot.attempts?.some(a=>a.taskId===task.id && a.nodeId===input.nodeId && a.sessionId===input.sessionId && nativeRuns.some(r=>(r.id??r.runId)===a.runId)) ||
        nativeRuns.some(r=>r.node===input.nodeId && r.sessionIds?.includes(input.sessionId));
      if(!source && !execution)throw Error("此会话不在当前任务的来源或执行记录中，请刷新后重试。");
      await openSession(input.sessionId);
      return {opened:true};
    }
    function ProjectPanel({ invoke, directoryApi, navigation, nativeClient }) {
      const frame = React.useRef(null),
        [html, setHtml] = React.useState(null),
        [page, setPage] = React.useState({method: "projectPage", context: null}),
        [error, setError] = React.useState(null),
        [detailFullscreen, setDetailFullscreen] = React.useState(false),
        [nativeConversation, setNativeConversation] = React.useState(null);
      const frameReady=React.useRef(false);
      const sendNavigation = () => {
        if(!navigation?.target)return;
        if(page.method!=="projectPage"){frameReady.current=false;setPage({method:"projectPage",context:null});return;}
        if(frameReady.current && frame.current?.contentWindow)frame.current.contentWindow.postMessage({channel:"dsh-project-runtime",method:"navigate",input:navigation.target},"*");
      };
      React.useEffect(()=>navigation?.subscribe(sendNavigation),[navigation,page.method]);
      React.useEffect(() => {
        let active = true;
        frameReady.current=false;
        setNativeConversation(null);
        invoke(page.method).then(
          (value) => {
            if (active) {
              const name = page.method === "workflowPage" ? "__DSH_WORKFLOW_CONTEXT__" : "__DSH_PROJECT_CONTEXT__";
              const encoded = JSON.stringify(page.context).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
              setHtml(value.replace("<html ", `<html data-theme="${hostTheme()}" `).replace("<head>", () => `<head><script>window.${name}=${encoded};</script>`));
              setError(null);
            }
          },
          () => {
            if (active) setError("项目页面加载失败，请重新连接");
          },
        );
        return () => {
          active = false;
        };
      }, [invoke, page]);
      React.useEffect(() => {
        const listener = async (event) => {
          if (event.source === frame.current?.contentWindow && event.data?.channel === "dsh-project-runtime" && event.data.method === "nativeConversation") {
            const input = event.data.input;
            const descriptor = input?.descriptor;
            if (input?.primary && descriptor?.kind === "native" && typeof descriptor.projectId === "string" &&
                descriptor.projectId === input.projectId && Number.isSafeInteger(descriptor.generation) &&
                typeof descriptor.nodeId === "string" && typeof descriptor.sessionId === "string") {
              setNativeConversation({ descriptor, covered: input.covered === true });
            } else setNativeConversation(null);
            return;
          }
          if(event.source===frame.current?.contentWindow && event.data?.channel==="dsh-project-runtime" && event.data.method==="navigateAcknowledged"){
            if(navigation?.target===event.data.input)navigation.target=null;
            return;
          }

          if (event.source === frame.current?.contentWindow && event.data?.channel === "dsh-project-runtime" && event.data.method === "detailFullscreen") {
            setDetailFullscreen(event.data.input === true);
            return;
          }
          if (event.source === frame.current?.contentWindow && event.data?.channel === "dsh-project-runtime" && ["openWorkflow", "closeWorkflow"].includes(event.data.method)) {
            const {id, method, input} = event.data;
            if (!input || typeof input.projectId !== "string") {
              event.source.postMessage({channel:"dsh-project-runtime",id,error:"缺少项目上下文"},"*");
              return;
            }
            event.source.postMessage({channel:"dsh-project-runtime",id,value:{opened:true}},"*");
            setDetailFullscreen(false);
            setPage({method:method === "openWorkflow" ? "workflowPage" : "projectPage",context:input});
            return;
          }
          if (
            event.source !== frame.current?.contentWindow ||
            event.data?.channel !== "dsh-project-runtime" ||
            !projectMethods.includes(event.data.method) && !["projectDirectoryList", "projectDirectoryPick", "projectOpenSettings", "projectOpenModels", "projectOpenTaskSession"].includes(event.data.method) ||
            ["projectPage", "workflowPage"].includes(event.data.method)
          )
            return;
          const source = event.source,
            { id, method, input } = event.data;
          try {
            const value = method === "projectDirectoryList" ? await directoryApi.list(input?.path)
              : method === "projectDirectoryPick" ? await directoryApi.pick()
              : method === "projectOpenSettings" ? directoryApi.openSettings()
              : method === "projectOpenModels" ? directoryApi.openModels()
              : method === "projectOpenTaskSession" ? await openTaskSession(input,invoke,directoryApi.openSession)
              : await invoke(method, input);
            source.postMessage(
              { channel: "dsh-project-runtime", id, value },
              "*",
            );
          } catch (error) {
            const failure = error?.rpcError ?? error;
            const code = failure?.code === "task/project" ? failure.details?.reason : failure?.code;
            const messages = {
              COORDINATOR_UNAVAILABLE: "中央进度暂时无法连接，请检查执行端与调度端的 Tailscale 连接。",
              PLANNER_REQUIRED: "当前节点为执行端，项目任务中心需要调度端身份。",
              PROJECT_UNAVAILABLE: "本机项目服务尚未就绪，请检查任务插件是否启用。",
              "gateway/internal": "项目服务内部错误，请检查调度端日志后重试。",
              "client/invalid-result": "项目服务返回的数据格式不正确，请核对插件版本。",
              CONFLICT: "记录已变化或请求 ID 重复，请刷新后核对",
              BUSY: "统筹会话正在响应，请稍后再试",
              INVALID: "请输入有效的名称、目标和绝对目录",
              CONFIGURATION: "项目会话服务尚未配置完整，请打开任务系统设置检查。",
              PROJECT_ROOT_REQUIRED: "请先选择项目父目录，再创建项目。",
              PROJECT_MODEL_REQUIRED: "请先选择本项目的统筹模型。",
              PROJECT_MODEL_UNAVAILABLE: "所选统筹模型或思考强度已不可用，请刷新模型目录后重新选择。",
              FORBIDDEN: "此节点或会话没有操作权限",
              NOT_FOUND: "找不到对应记录",
              WORKSPACE_POLICY: "工作区已失效或不再授权，请刷新后重新选择。",
              EXECUTOR_REQUIRED: "请在执行端 DSH 的任务设置中登记本机工作区。",
              CONFIGURATION_BUSY: "执行端仍有活动任务，请等执行与回传结束后更改目录授权。",
              PROJECT_SETTINGS_CHANGED: "项目设置已变化，请刷新并处理尚未领取的旧请求。",
            };
            source.postMessage(
              {
                channel: "dsh-project-runtime",
                id,
                error: code === "WORKFLOW_UNBOUND" ? "执行前请选择执行方式（Agent 或程序）并绑定工作区："+(failure.details?.detail||"存在未绑定步骤") : code === "WORKFLOW_SCOPE" ? "任务权限未覆盖工作流所需范围，请由项目所有者核对授权："+(failure.details?.detail||"缺少设备、工作区或工具授权") : messages[code] || (method === "projectOpenTaskSession" && error?.message) || (/^projectDirectory/.test(method) && error?.message) || (/workflow/i.test(method) && error?.message) || "无法读取或操作项目服务，请检查连接后重试。",
                errorCode: code,
                errorDetails: /^projectDirectory/.test(method) ? failure?.details : undefined,
              },
              "*",
            );
          }
        };
        window.addEventListener("message", listener);
        return () => window.removeEventListener("message", listener);
      }, [invoke, directoryApi, navigation]);
      React.useEffect(() => html ? watchTheme(frame, "dsh-project-runtime") : undefined, [html]);
      if (error)
        return h("div", { role: "alert", style: { padding: 24 } }, error);
      if (!html)
        return h("div", { style: { padding: 24 } }, "正在加载项目与任务…");
      return h("div", { style: { position: "relative", isolation: "isolate", zIndex: detailFullscreen ? 1000 : 0, width: "100%", height: "100%", minHeight: 0 } }, h("iframe", {
        ref: frame,
        title: page.method === "workflowPage" ? "项目工作流" : "项目与任务",
        srcDoc: html,
        onLoad: () => {frameReady.current=true;sendTheme(frame, "dsh-project-runtime");sendNavigation();},
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
      }), nativeConversation && h(ProjectNativeOverlay, {
        key: [nativeConversation.descriptor.projectId, nativeConversation.descriptor.generation, nativeConversation.descriptor.nodeId, nativeConversation.descriptor.sessionId].join(":"),
        frame, nativeClient, invoke, descriptor: nativeConversation.descriptor, covered: nativeConversation.covered,
      }));
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

    const sessionTaskLabels = { all: "全部", running: "执行中", queued: "等待开始", review: "待确认", error: "需处理", done: "已完成", accepted: "已验收", handled: "已处理", cancelled: "已取消", cancelling: "取消中", archived: "已归档", unknown: "状态待核实" };
    class SessionTaskMonitor {
      constructor(invoke, sessionId) {
        this.invoke = invoke; this.sessionId = sessionId; this.listeners = new Set();
        this.state = { value: null, loading: false, error: null }; this.disposed = false;
      }
      subscribe = (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
      snapshot = () => this.state;
      update(patch) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
      async load() {
        if (this.disposed || this.state.loading) return;
        this.update({ loading: true });
        try {
          const value = await this.invoke("sessionTasks", { sessionId: this.sessionId });
          if (!value || value.sessionId !== this.sessionId || !Array.isArray(value.tasks) || !Array.isArray(value.runs) || !value.counts) throw Error("Invalid session snapshot");
          if (!this.disposed) this.update({ value, loading: false, error: null });
        } catch {
          if (!this.disposed) this.update({ loading: false, error: this.state.value?.viewContext?.scope === "local" ? "暂时无法读取本机任务记录，请稍后重试。" : "暂时无法读取当前会话的任务状态，请稍后重试。" });
        }
      }
      dispose() { this.disposed = true; this.listeners.clear(); }
    }
    function SessionTaskPanel({ invoke, sessionId }) {
      const monitor = React.useMemo(() => new SessionTaskMonitor(invoke, sessionId), [invoke, sessionId]);
      const { value, loading, error } = React.useSyncExternalStore(monitor.subscribe, monitor.snapshot);
      const [filter, setFilter] = React.useState("all"), [search, setSearch] = React.useState("");
      React.useEffect(() => {
        monitor.disposed = false;
        void monitor.load();
        const timer = setInterval(() => { if (document.visibilityState !== "hidden") void monitor.load(); }, 5000);
        return () => { clearInterval(timer); monitor.dispose(); };
      }, [monitor]);
      React.useEffect(() => { setFilter("all"); setSearch(""); }, [sessionId]);
      const [theme, setTheme] = React.useState(hostTheme);
      React.useEffect(() => {
        const update = () => setTheme(hostTheme()), observer = new MutationObserver(update);
        observer.observe(document.documentElement, { attributes: true });
        observer.observe(document.body, { attributes: true });
        const system = matchMedia("(prefers-color-scheme: dark)");
        system.addEventListener("change", update);
        update();
        return () => { observer.disconnect(); system.removeEventListener("change", update); };
      }, []);
      const tasks = value?.tasks ?? [], counts = value?.counts ?? {}, context = value?.viewContext;
      const local = context?.scope === "local";
      const formatTime = time => time && Number.isFinite(new Date(time).getTime()) ? new Date(time).toLocaleString() : "尚未观测";
      const visible = tasks.filter(task => (filter === "all" || task.status === filter) && [task.title, task.node, task.id, task.parentTaskId, task.runId, task.sessionId, ...(task.sessionIds ?? []), task.stateLabel].filter(Boolean).join(" ").toLowerCase().includes(search.toLowerCase()));
      const taskLabel = status => local && status === "done" ? "已回传" : sessionTaskLabels[status] || status;
      const statusColor = status => `var(--status-${({ accepted: "done", handled: "queued", cancelled: "queued", cancelling: "review", archived: "queued", unknown: "queued" })[status] || status}, var(--status-queued))`;
      const runLabel = run => run.stateLabel || (run.reviewStatus === "pending_user" ? "待确认" : run.reviewStatus === "accepted" ? "已验收" : run.reviewStatus === "rejected" ? "审核未通过" : ({ queued: "等待开始", running: "执行中", succeeded: "执行成功", partial: "部分完成", failed: "执行失败", blocked: "执行受阻", uncertain: "结果待核实", cancelled: "已取消" }[run.state] ?? run.state));
      const evidence = rows => h("dl", { className: "stm-evidence" }, rows.filter(([, detail]) => detail).map(([label, detail]) => h(React.Fragment, { key: label }, h("dt", null, label), h("dd", null, detail))));
      return h("section", { className: "session-task-monitor", "data-theme": theme, "aria-label": "当前会话的执行任务" },
        h("style", null, `
          .session-task-monitor{--status-running:#315fa8;--status-review:#86601d;--status-queued:#62626b;--status-done:#347457;--status-error:#b43e48;--stm-panel:var(--dsw-alias-bg-layer-1,#fafafa);--stm-soft:var(--dsw-alias-bg-layer-2,#f5f5f7);--stm-line:var(--dsw-alias-border-l3,#d4d4d8);--stm-muted:var(--dsw-alias-label-secondary,#62626b);--stm-selected:var(--dsw-alias-bg-hover,#e4e4e7);height:100%;min-height:0;overflow:auto;box-sizing:border-box;padding:32px;line-height:1.6;color:var(--dsw-alias-label-primary,inherit);font-size:14px}
          .session-task-monitor[data-theme=dark]{--status-running:#7ca4ef;--status-review:#d3b686;--status-queued:#a1a1a1;--status-done:#91b9a4;--status-error:#e58f8f;--stm-panel:var(--dsw-alias-bg-layer-1,#1d1d1d);--stm-soft:var(--dsw-alias-bg-layer-2,#222);--stm-line:var(--dsw-alias-border-l3,#343434);--stm-muted:var(--dsw-alias-label-secondary,#a1a1a1);--stm-selected:var(--dsw-alias-bg-hover,#414141)}
          .session-task-monitor *{box-sizing:border-box}.session-task-monitor header{display:flex;gap:16px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap}.session-task-monitor h2{font-size:26px;font-weight:600;letter-spacing:-.6px;margin:0 0 8px}.session-task-monitor p{margin:5px 0 14px}.session-task-monitor .stm-muted{color:var(--stm-muted);font-size:12px}.session-task-monitor .stm-scope{font-size:12px;color:var(--stm-muted);margin-bottom:8px}.session-task-monitor button,.session-task-monitor input{font:inherit;color:inherit;background:transparent;border:1px solid var(--stm-line);border-radius:9px;padding:10px 14px}.session-task-monitor button{cursor:pointer;min-height:40px}.session-task-monitor button:hover{background:var(--stm-selected)}.session-task-monitor button:disabled{opacity:.4;cursor:default}.session-task-monitor button:focus-visible,.session-task-monitor input:focus-visible,.session-task-monitor summary:focus-visible{outline:2px solid var(--status-running);outline-offset:3px}.session-task-monitor .stm-filters{display:flex;flex-wrap:wrap;gap:10px;margin:24px 0 16px}.session-task-monitor .stm-filters button{padding:8px 12px;font-size:12px;background:var(--stm-soft)}.session-task-monitor .stm-filters button[aria-pressed=true]{background:var(--stm-selected);border-color:var(--stm-muted)}.session-task-monitor .stm-filters b{margin-left:10px;font-weight:500}.session-task-monitor input{width:100%;margin-bottom:20px;background:var(--stm-soft)}.session-task-monitor input::placeholder{color:var(--stm-muted)}.session-task-monitor .stm-list{display:flex;flex-direction:column;border:1px solid var(--stm-line);border-radius:13px;overflow:hidden}.session-task-monitor .stm-list:empty{display:none}.session-task-monitor details{background:var(--stm-panel);border-bottom:1px solid var(--stm-line);min-width:0}.session-task-monitor details:last-child{border:0}.session-task-monitor summary{padding:18px;cursor:pointer;list-style:none}.session-task-monitor summary:hover{background:var(--stm-soft)}.session-task-monitor summary::-webkit-details-marker{display:none}.session-task-monitor .stm-row{display:flex;justify-content:space-between;gap:14px;align-items:flex-start}.session-task-monitor .stm-title{font-size:14px;font-weight:600;overflow-wrap:anywhere;min-width:0}.session-task-monitor .stm-status{display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border-radius:6px;background:var(--stm-soft);font-size:12px;flex-shrink:0;white-space:nowrap}.session-task-monitor .stm-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0}.session-task-monitor .stm-meta{margin-top:6px;overflow-wrap:anywhere}.session-task-monitor .stm-body{padding:0 18px 18px;border-top:1px solid var(--stm-line)}.session-task-monitor .stm-body h3{font-size:13px;margin:16px 0 8px}.session-task-monitor .stm-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}.session-task-monitor .stm-empty{text-align:center;padding:35px 16px;color:var(--stm-muted)}.session-task-monitor .stm-notice{border:1px solid var(--stm-line);border-radius:10px;padding:12px;background:var(--stm-soft);font-size:13px}.session-task-monitor .stm-evidence{display:grid;grid-template-columns:90px minmax(0,1fr);gap:6px 12px;font-size:12px;margin:14px 0}.session-task-monitor dt{color:var(--stm-muted)}.session-task-monitor dd{margin:0;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,monospace}.session-task-monitor .stm-runs{list-style:none;padding:0;margin:0;display:grid;gap:8px}.session-task-monitor .stm-run{border:1px solid var(--stm-line);border-radius:10px;padding:12px;background:var(--stm-soft)}.session-task-monitor .stm-run .stm-evidence{margin-bottom:0}
          @media(max-width:600px){.session-task-monitor{padding:20px 16px}.session-task-monitor h2{font-size:22px}.session-task-monitor .stm-filters{gap:6px}.session-task-monitor .stm-filters button{padding:7px 9px;min-height:36px}.session-task-monitor summary{padding:14px}.session-task-monitor .stm-row{gap:8px;flex-wrap:wrap}.session-task-monitor .stm-status{white-space:normal}.session-task-monitor .stm-body{padding:0 14px 14px}.session-task-monitor .stm-evidence{grid-template-columns:70px minmax(0,1fr)}}
        `),
        h("header", null, h("div", null, h("div", { className: "stm-scope" }, local ? `本机执行${context.nodeId ? " · " + context.nodeId : ""}` : "当前会话"), h("h2", null, "会话任务"), h("p", { className: "stm-muted" }, value ? `共 ${counts.all ?? tasks.length} 项 · 会话任务 ${value.directCount ?? 0} 项 · 子任务 ${Math.max(0, (counts.all ?? tasks.length) - (value.directCount ?? 0))} 项` : "查看当前会话的执行任务与后续子任务")),
          h("button", { type: "button", disabled: loading, onClick: () => monitor.load() }, loading ? "正在刷新…" : "刷新")),
        local && h("p", { className: "stm-muted" }, "仅显示当前会话关联的本机执行记录。"),
        error && h("p", { role: "alert", className: "stm-notice" }, error, value ? " 下方保留上次成功读取的数据。" : ""),
        value?.pendingDispatches > 0 && h("p", { className: "stm-notice" }, `${value.pendingDispatches} 项执行请求等待确认，尚未计入任务总数。`),
        value?.unavailableTasks > 0 && h("p", { className: "stm-notice" }, local ? `${value.unavailableTasks} 项任务未在本机记录中找到，不能据此判定远端无任务。` : `${value.unavailableTasks} 项已提交的执行任务暂未出现在任务快照中，尚未计入下方分类。`),
        value?.externalDispatchCount > 0 && h("p", { className: "stm-notice" }, `含 ${value.externalDispatchCount} 次通过 shell 启动的 Codex CLI 调用，按启动次数计数（含续跑）。这些调用没有进入任务账本；进程结束归入“已处理”，不代表任务已验收。`),
        value?.localCodexCount > 0 && h("p", { className: "stm-muted" }, `${value.localCodexCount} 项本地 Codex 任务；结果回传后待确认，父会话验收后标记已完成。`),
        h("div", { className: "stm-filters", role: "group", "aria-label": "按任务状态筛选" }, Object.entries(sessionTaskLabels).filter(([key]) => ["all", "running", "queued", "review", "error", "done"].includes(key) || counts[key] || filter === key).map(([key]) => h("button", { key, type: "button", "aria-pressed": filter === key, style: { color: key === "all" ? undefined : statusColor(key) }, onClick: () => setFilter(key) }, taskLabel(key), h("b", null, counts[key] ?? 0)))),
        h("input", { type: "search", "aria-label": "搜索会话任务", placeholder: "搜索任务、执行端或任务 ID", value: search, onChange: event => setSearch(event.target.value) }),
        h("div", { className: "stm-list", "aria-busy": loading }, visible.map(task => {
          const runs = (value?.runs ?? []).filter(run => run.taskId === task.id).reverse();
          return h("details", { key: task.id, "data-task-status": task.status }, h("summary", null, h("div", { className: "stm-row" }, h("span", { className: "stm-title" }, task.title), h("span", { className: "stm-status", style: { color: statusColor(task.status) } }, h("i", { className: "stm-dot", "aria-hidden": true }), task.stateLabel || taskLabel(task.status))), h("div", { className: "stm-muted stm-meta" }, `${task.direct ? "会话任务" : "子任务"} · ${task.node || "等待分配执行端"}${task.model ? " · " + task.model : ""} · 展开详情`)),
            h("div", { className: "stm-body" }, evidence([["任务 ID", task.id], ["父任务 ID", task.parentTaskId], ["当前 Run", task.runId], ["执行会话", task.sessionIds?.length ? task.sessionIds.join(" · ") : task.sessionId]]), h("h3", null, task.source === "codex-cli" ? "调用来源" : "任务要求"), h("div", { className: "stm-text" }, task.description || "未提供任务要求"), h("h3", null, task.source === "codex-cli" ? "进程状态" : "最新结果"), h("div", { className: "stm-text" }, task.report || "尚无结果报告"),
              task.acceptance && h(React.Fragment, null, h("h3", null, "父会话验收"), h("div", { className: "stm-text" }, task.acceptance.evidence), h("p", { className: "stm-muted" }, `验收于 ${formatTime(task.acceptance.acceptedAt)}`)),
              task.source === "local-codex" ? h("p", { className: "stm-muted" }, `${task.permissionLabel}${task.reasoningEffort ? " · 思考强度 " + task.reasoningEffort : ""} · ${task.cwd} · 启动于 ${formatTime(task.time)}`) : task.source === "codex-cli" ? h("p", { className: "stm-muted" }, `启动于 ${formatTime(task.time)} · 完整调用与输出可在本会话轨迹中查看。`) : h(React.Fragment, null, h("h3", null, `执行记录 · ${runs.length} 次`), h("ul", { className: "stm-runs" }, runs.slice(0, 5).map(run => h("li", { key: run.id, className: "stm-run" }, h("div", { className: "stm-row" }, h("strong", { className: "stm-text" }, runLabel(run)), h("span", { className: "stm-muted" }, formatTime(run.createdAt))), h("div", { className: "stm-muted" }, `${run.node || "待分配"}${run.model ? " · " + run.model : ""}`), evidence([["Run ID", run.id], ["父 Run ID", run.parentRunId], ["父任务 ID", run.parentTaskId], ["会话 ID", run.sessionIds?.length ? run.sessionIds.join(" · ") : run.sessionId]]))))),
              runs.length > 5 && h("p", { className: "stm-muted" }, "此处显示最近 5 次执行；完整历史可在总任务面板查看。")));
        })),
        !visible.length && h("div", { className: "stm-empty" }, !value ? (loading ? "正在读取任务…" : "读取失败，请重试") : tasks.length ? "当前筛选没有任务" : local ? "当前会话尚无本机执行记录" : "当前会话尚无执行任务"),
        evidence([["来源会话", sessionId]]),
        local && context.pollState && h("p", { className: "stm-muted" }, `本机队列轮询：${({ never: "尚未观测", ready: "最近一次观测成功", failed: "最近一次观测失败，保留已有执行记录", paused: "已暂停，保留上次观测记录" })[context.pollState] || "状态待核实"}。队列观测与结果回传状态分别记录。`),
        (context?.observedAt || value?.sampledAt) && h("p", { className: "stm-muted" }, `更新于 ${formatTime(context?.observedAt || value?.sampledAt)}${context?.queueObservedAt ? " · 队列观测于 " + formatTime(context.queueObservedAt) : ""} · 每 5 秒自动刷新`));
    }
    function mountSessionTaskPanel(ctx, invoke) {
      return ctx.slots.inject("conversation.view", () => ctx.slots.register({
        name: "conversation.view", id: "dsh-session-tasks", order: 20,
        label: () => "任务", inject: sessionId => ({ sessionId, invoke }),
      }, SessionTaskPanel));
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
      const projectNavigation = new ProjectNavigation();
      const projectNativeClient = createProjectNativeClient({ React, Context: ClientContext, modules: ctx.modules });
      const { StewardPanel } = createStewardClient(React);
      const projectDirectoryApi = {
        openSession: sessionId => {const service=ctx.get("uiWorkspace");if(!service)throw Error("DSH 会话导航服务尚未加载");return service.openSession(sessionId);},
        list: path => {const service=ctx.get("uiWorkspace");if(!service)throw Error("DSH 目录浏览服务尚未加载，请稍后重试");return service.listDirectory(path);},
        pick: () => {const service=ctx.get("uiWorkspace");if(!service)throw Error("DSH 目录选择服务尚未加载");return service.pickDirectory();},
        openSettings: () => {ctx.get("layout")?.selectPanel("dsh-task-settings");return true;},
        openModels: () => openModels(ctx),
      };
      ctx.effect(() => {
        const offMain = ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: "dsh-steward", inject: () => ({ invoke, openSession: projectDirectoryApi.openSession }) }, StewardPanel));
        const offNav = ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: "dsh-steward", order: 19, label: () => "管家" }, ProjectIcon));
        return () => { offNav(); offMain(); };
      }, "steward conversation");
      ctx.effect(() => mountSessionTaskPanel(ctx, invoke), "session task monitor");
      ctx.effect(() => {
        const offMain = ctx.slots.inject("main", () =>
          ctx.slots.register(
            {
              name: "main",
              key: "dsh-task-projects",
              inject: () => ({ invoke, directoryApi: projectDirectoryApi, navigation:projectNavigation, nativeClient: projectNativeClient }),
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
      const selectLinkedPanel = () => {
        const hash = new URL(window.location?.href ?? "https://localhost/").hash;
        if (hash === "#tasks")
          ctx.get("layout")?.selectPanel("dsh-task-projects");
      };
      selectLinkedPanel();
      ctx.effect(() => {
        window.addEventListener("hashchange", selectLinkedPanel);
        return () => window.removeEventListener("hashchange", selectLinkedPanel);
      }, "task panel deep links");

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
              readConnectionSettings:()=>invoke("connectionSettings"),
              saveConnectionSettings:input=>invoke("saveConnectionSettings",input),
              nodeModelApi:{read:input=>invoke("nodeModelSettings",input),refresh:input=>invoke("refreshNodeModels",input),save:input=>invoke("saveNodeModelDefault",input)},
              readProjectSettings: () => invoke("projectSettings"),
              readExecutionPresets: () => invoke("executionPresets"),
              readExecutionDirectorySettings: () => invoke("executionDirectorySettings"),
              readExecutorWorkspaceGrants:()=>invoke("executorWorkspaceGrants"),
              setExecutorWorkspaceGrant:input=>invoke("setExecutorWorkspaceGrant",input),
              saveExecutionDirectorySettings: input => invoke("saveExecutionDirectorySettings",input),
              directoryApi: {
                pick: () => {const service=ctx.get("uiWorkspace"); if(!service) throw new Error("DSH 目录选择服务尚未加载"); return service.pickDirectory();},
                list: path => {const service=ctx.get("uiWorkspace"); if(!service) throw new Error("DSH 目录浏览服务尚未加载，请稍后重试"); return service.listDirectory(path);},
                create: (path,name) => {const service=ctx.get("uiWorkspace"); if(!service) throw new Error("DSH 目录浏览服务尚未加载"); return service.createDirectory(path,name);},
              },
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
            const surface = new TaskSettingsSurface();
            const main = ctx.slots.inject("main", () => ctx.slots.register({name:"main",key:"dsh-task-settings",inject:()=>({surface})}, TaskSettingsPanel));
            const portal = ctx.slots.inject("shell.overlay", () => ctx.slots.register({name:"shell.overlay",id:"task-settings-surface",locale:NS,inject:()=>({...inject(),surface,onNavigate:target=>{if(target!=="settings"){projectNavigation.go(target);ctx.get("layout")?.selectPanel("dsh-task-projects");}}})},TaskSettingsPortal));
            return () => {
              main();
              portal();
            };
          }),
        "task settings page",
      );
    }
    return {
      inject: ["modules", "slots", "locale", "configForms", "remote", "remote.settings"],
      apply,
      Controller,
      SessionTaskMonitor,
      SessionTaskPanel,
      mountSessionTaskPanel,
      SettingsSaveCoordinator,
      NodeModelSettings,
      ConnectionSettings,
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
      projectDescriptors,
      workspaceCatalogDescriptor,
      executorIdentityDescriptor,
      startupDescriptor,
      saveStartupDescriptor,
      checkConnectionDescriptor,
      ExecutorIdentity,
      startupDraft,
      startupChanges,
      StartupRow,
      DirectoryField,
      ProjectWorkspaceSettings,
      ExecutorWorkspaceGrantSettings,
      StartupSettings,
      QueueContents,
      LocalQueue,
      ReadOnly,
      Page,
      TaskSettingsSurface,
      TaskSettingsPanel,
      TaskSettingsPortal,
      en,
      zh,
      keys,
      openTaskSession,
    };
  },
});
