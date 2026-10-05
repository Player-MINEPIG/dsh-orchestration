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
        "These are startup settings. Edit the existing profile patch and restart DSH. This page never writes identity, database paths, tool permissions, endpoints or credentials.",
      nodeId: "Node ID",
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
        "以下为启动配置。请编辑现有 profile 配置文件并重启 DSH。此页不会写入节点身份、数据库路径、工具授权、远端地址或凭据。",
      nodeId: "节点 ID",
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
    function ReadOnly({ t, read }) {
      const [state, setState] = React.useState({ loading: true });
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
            () => {
              if (generation.current === current)
                setState((old) => ({ ...old, loading: false, failed: true }));
            },
          );
      }, [read]);
      React.useEffect(() => {
        refresh();
        return () => {
          generation.current++;
        };
      }, [refresh]);
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
                typeof value[key] === "boolean"
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
        state.failed ? h("p", { role: "alert" }, t("loadFailed")) : null,
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
              h("p", { style: hintStyle }, t("remoteHint")),
            )
          : null,
        h(Button, { onClick: refresh, disabled: state.loading }, t("refresh")),
      );
    }
    function Page(props) {
      const { t } = props;
      const state = props.useTaskSettings((snapshot) => snapshot);
      if (props.view === "summary") return t("summary");
      return h(
        "div",
        { "data-task-plugin-settings": true },
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
                          variant: "ghost",
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
        h(ReadOnly, { t, read: props.read }),
      );
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
        descriptors: [descriptor],
      });
      ctx.effect(() => unmount, "task settings read-only remote");
      const read = () => ctx.remote.taskPluginSettings.describe();
      ctx.effect(
        () =>
          ctx.configForms.whileServed(["task-system"], () =>
            ctx.slots.inject("plugins.row.config", () =>
              ctx.slots.register(
                {
                  name: "plugins.row.config",
                  key: "@dsh-task/task-system#task-system",
                  locale: NS,
                  inject: () => ({ ...controller.inject(), read }),
                },
                Page,
              ),
            ),
          ),
        "task settings page",
      );
    }
    return {
      inject: ["slots", "locale", "configForms", "remote"],
      apply,
      Controller,
      fieldSpec,
      descriptor,
      Page,
      en,
      zh,
      keys,
    };
  },
});
