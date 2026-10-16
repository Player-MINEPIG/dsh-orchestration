(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const statusNames = {
    pending: "等待依赖",
    waiting_device: "等待设备",
    queued: "等待执行",
    running: "执行中",
    succeeded: "已完成",
    partial: "部分交付",
    failed: "失败",
    uncertain: "结果待核实",
    cancelled: "已取消",
    blocked: "依赖受阻",
    needs_attention: "需处理",
    online: "在线",
    stale: "离线",
    unknown: "状态未知",
    unavailable: "执行端未就绪",
    disabled: "已停用",
  };
  const badge = (status) =>
    `<span class="badge ${esc(status)}">${esc(statusNames[status] || status)}</span>`;
  const state = {
    snapshot: null,
    draft: null,
    dirty: false,
    workflowId: "",
    runId: "",
    nodeId: "",
    stepId: "",
    deviceIds: [],
    filter: "all",
    pending: false,
  };
  const requests = new Map(),
    commandIds = new Map();
  function id() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) =>
      x.toString(16).padStart(2, "0"),
    ).join("");
  }
  function api(method, input) {
    return new Promise((resolve, reject) => {
      const requestId = id();
      const timer = setTimeout(() => {
        requests.delete(requestId);
        reject(Error("连接超时。可重试原操作，系统将核对同一请求。"));
      }, 45000);
      requests.set(requestId, { resolve, reject, timer });
      parent.postMessage(
        { channel: "dsh-project-runtime", id: requestId, method, input },
        "*",
      );
    });
  }
  window.addEventListener("message", (event) => {
    if (
      event.source !== parent ||
      event.data?.channel !== "dsh-project-runtime"
    )
      return;
    if (event.data.method === "theme") {
      document.documentElement.dataset.theme =
        event.data.input === "dark" ? "dark" : "light";
      return;
    }
    const request = requests.get(event.data.id);
    if (!request) return;
    clearTimeout(request.timer);
    requests.delete(event.data.id);
    if (event.data.error) request.reject(Error(event.data.error));
    else request.resolve(event.data.value);
  });
  function notice(text) {
    $("notice").textContent = text;
    clearTimeout(notice.timer);
    notice.timer = setTimeout(() => ($("notice").textContent = ""), 7000);
  }
  const run = () =>
    state.snapshot?.runs.find((row) => row.workflowRunId === state.runId);
  const definition = () => run()?.definition || state.draft;
  const selectedStep = () =>
    definition()?.steps.find((row) => row.stepId === state.stepId);
  const nodeStatus = (nodeId) =>
    state.snapshot?.nodes.find((row) => row.nodeId === nodeId) || {
      nodeId,
      state: "unknown",
    };
  const online = (nodeId) => nodeStatus(nodeId).state === "online";
  const option = (value, label, selected) =>
    `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(label)}</option>`;
  const setDirty = () => {
    state.dirty = true;
    renderHeading();
  };
  function workspaceOptions(nodeId, selected) {
    const rows = state.snapshot.workspaces.filter(
      (row) => row.nodeId === nodeId && row.state === "ready",
    );
    return (
      option("", "请选择该设备已登记的工作区", selected) +
      rows
        .map((row) =>
          option(
            row.workspaceId,
            `${row.label || row.path} · ${row.path}`,
            selected,
          ),
        )
        .join("") +
      (selected && !rows.some((row) => row.workspaceId === selected)
        ? option(selected, `${selected} · 当前不可用`, selected)
        : "")
    );
  }
  function programsFor(nodeId) {
    return (state.snapshot.programs || []).filter(
      (row) => row.nodeId === nodeId,
    );
  }
  const programKey = (row) => JSON.stringify([row.programId, row.version]);
  function programOptions(step) {
    const selected = programKey(step.execution),
      rows = programsFor(step.nodeId);
    return (
      option(
        "",
        rows.length ? "选择程序与版本" : "此设备未公布可用程序",
        selected,
      ) +
      rows
        .map((row) =>
          option(
            programKey(row),
            `${row.title || row.programId} · ${row.version}`,
            selected,
          ),
        )
        .join("") +
      (step.execution.programId &&
      !rows.some((row) => programKey(row) === selected)
        ? option(
            selected,
            `${step.execution.programId} · ${step.execution.version} · 不可用`,
            selected,
          )
        : "")
    );
  }
  function list() {
    const rows = state.snapshot?.definitions || [];
    const visible = rows.filter(
      (row) =>
        state.filter === "all" ||
        (new Set(row.steps.map((s) => s.nodeId)).size > 1
          ? "multi"
          : "single") === state.filter,
    );
    $("workflow-list").innerHTML =
      visible
        .map((row) => {
          const count = new Set(row.steps.map((s) => s.nodeId)).size;
          return `<button class="workflow-item ${row.workflowId === state.workflowId ? "active" : ""}" data-workflow="${esc(row.workflowId)}"><strong>${esc(row.title)}</strong><small>${count > 1 ? `${count} 台设备协作` : "单设备"} · ${row.steps.length} 个步骤${row.schedule?.enabled ? " · 定时运行" : ""}</small></button>`;
        })
        .join("") || '<p class="empty">暂无工作流。点击“新建工作流”开始。</p>';
  }
  function renderHeading() {
    const def = definition();
    if (!def) return;
    $("workflow-heading").textContent = def.title || "新工作流";
    $("revision").textContent = run()
      ? `本次执行固定使用版本 ${run().definitionRevision}`
      : `版本 ${def.revision || "未保存"}${state.dirty ? " · 有未保存修改" : ""}`;
    $("save-workflow").disabled = state.pending || !!run() || !state.dirty;
    $("start-workflow").disabled =
      state.pending ||
      state.dirty ||
      !state.snapshot.definitions.some(
        (row) => row.workflowId === state.workflowId,
      );
    $("edit-definition").classList.toggle("hidden", !run());
    $("cancel-workflow").classList.toggle(
      "hidden",
      !run() ||
        ["succeeded", "partial", "failed", "cancelled"].includes(run().state),
    );
    $("cancel-workflow").disabled = state.pending;
    $("add-step").classList.toggle("hidden", !!run());
    $("device-controls").classList.toggle("hidden", !!run());
    $("start-input").classList.toggle("hidden", !!run());
    $("run-state").innerHTML = run() ? badge(run().state) : "";
  }
  function history() {
    $("history").innerHTML =
      option("", "当前定义", state.runId) +
      state.snapshot.runs
        .filter((row) => row.workflowId === state.workflowId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((row) =>
          option(
            row.workflowRunId,
            `${new Date(row.createdAt).toLocaleString()} · ${statusNames[row.state] || row.state}`,
            state.runId,
          ),
        )
        .join("");
  }
  function renderDefinitionEditor() {
    const def = state.draft;
    if (run()) {
      $("definition-editor").innerHTML = "";
      return;
    }
    $("definition-editor").innerHTML =
      `<div class="fields"><div><label for="workflow-title">工作流名称</label><input id="workflow-title" value="${esc(def.title)}"></div><div><label for="workflow-description">说明</label><input id="workflow-description" value="${esc(def.description)}"></div></div><details><summary>定时触发${def.schedule?.enabled ? " · 已启用" : " · 未启用"}</summary><label><input id="schedule-enabled" type="checkbox"${def.schedule?.enabled ? " checked" : ""}>启用定时运行</label><div class="fields"><div><label for="schedule-cron">Cron 表达式</label><input id="schedule-cron" placeholder="0 7 * * *" value="${esc(def.schedule?.cron || "0 7 * * *")}"></div><div><label for="schedule-zone">时区</label><input id="schedule-zone" value="${esc(def.schedule?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")}"></div><div><label for="schedule-day">日期窗口</label><select id="schedule-day">${option("-1", "前一个自然日", String(def.schedule?.dayOffset ?? -1))}${option("0", "当前自然日", String(def.schedule?.dayOffset ?? -1))}</select></div></div><p class="muted">例如 0 7 * * * 表示每天 07:00。每次执行保留当时的工作流版本。</p></details>`;
  }
  function graph() {
    const def = definition();
    if (!def) return;
    const nodes = [
      ...new Set([
        ...def.steps.map((s) => s.nodeId),
        ...(!run() ? state.deviceIds : []),
      ]),
    ];
    if (!nodes.includes(state.nodeId)) state.nodeId = nodes[0] || "";
    const positions = new Map(
      nodes.map((node, i) => [
        node,
        { x: 35 + (i % 2) * 320, y: 30 + Math.floor(i / 2) * 190 },
      ]),
    );
    const height = Math.max(210, Math.ceil(nodes.length / 2) * 190 + 25);
    const routes = new Map();
    for (const step of def.steps)
      for (const dependency of step.dependsOn) {
        const from = def.steps.find((s) => s.stepId === dependency)?.nodeId;
        if (from && from !== step.nodeId) {
          const key = JSON.stringify([from, step.nodeId]);
          const route = routes.get(key) || { from, to: step.nodeId, count: 0 };
          route.count++;
          routes.set(key, route);
        }
      }
    const lines = [...routes.values()]
      .map((route, index) => {
        const a = positions.get(route.from),
          b = positions.get(route.to),
          waiting = !online(route.from) || !online(route.to);
        const ax = a.x + 115,
          ay = a.y + 110,
          bx = b.x + 115,
          by = b.y;
        const d =
          a.y === b.y
            ? `M ${a.x + (a.x < b.x ? 230 : 0)} ${a.y + 48 + (index % 3) * 12} C ${(a.x + b.x) / 2 + 115} ${a.y - 15 - (index % 3) * 12}, ${(a.x + b.x) / 2 + 115} ${b.y - 15 - (index % 3) * 12}, ${b.x + (a.x < b.x ? 0 : 230)} ${b.y + 48 + (index % 3) * 12}`
            : `M ${ax} ${ay} C ${ax} ${(ay + by) / 2}, ${bx} ${(ay + by) / 2}, ${bx} ${by}`;
        return `<path d="${d}" class="route${waiting ? " waiting" : ""}" marker-end="url(#${waiting ? "arrow-wait" : "arrow"})"><title>${esc(route.from)} → ${esc(route.to)} · ${route.count} 条依赖${waiting ? " · 等待设备恢复" : ""}</title></path>`;
      })
      .join("");
    const cards = nodes
      .map((node) => {
        const p = positions.get(node),
          rows = def.steps.filter((s) => s.nodeId === node),
          results = run()?.steps.filter((s) => s.nodeId === node) || [];
        return `<button class="device ${node === state.nodeId ? "active" : ""} ${online(node) ? "" : "offline"}" data-node="${esc(node)}" style="left:${p.x}px;top:${p.y}px" aria-pressed="${node === state.nodeId}"><strong>${esc(node)}</strong>${badge(nodeStatus(node).state)}<small>${rows.length} 个步骤${run() ? ` · ${results.filter((s) => s.state === "succeeded").length} 已完成` : ""}</small></button>`;
      })
      .join("");
    $("device-graph").style.height = `${height}px`;
    $("device-graph").innerHTML = nodes.length
      ? `<svg viewBox="0 0 620 ${height}" preserveAspectRatio="none" aria-label="设备间依赖连接"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8" fill="var(--accent)"/></marker><marker id="arrow-wait" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8" fill="var(--muted)"/></marker></defs>${lines}</svg>${cards}`
      : '<p class="empty">添加设备，再为设备添加程序或 Agent 步骤。</p>';
    $("add-device-select").innerHTML =
      state.snapshot.nodes
        .filter((row) => !nodes.includes(row.nodeId))
        .map((row) =>
          option(
            row.nodeId,
            `${row.nodeId} · ${statusNames[row.state] || row.state}`,
            "",
          ),
        )
        .join("") || '<option value="">没有更多已登记设备</option>';
    $("add-device").disabled = !$("add-device-select").value || state.pending;
    $("add-step").disabled = !state.nodeId || state.pending;
  }
  function stepList() {
    const def = definition();
    if (!def) return;
    const steps = def.steps.filter((step) => step.nodeId === state.nodeId);
    if (!steps.some((step) => step.stepId === state.stepId))
      state.stepId = steps[0]?.stepId || "";
    $("device-heading").textContent = state.nodeId
      ? `${state.nodeId} · 设备内工作流`
      : "设备内工作流";
    $("step-list").innerHTML =
      steps
        .map((step) => {
          const view = run()?.steps.find((row) => row.stepId === step.stepId);
          const upstream = step.dependsOn
            .map((dep) => {
              const row = def.steps.find((s) => s.stepId === dep);
              return row ? `${row.nodeId} / ${row.title}` : dep;
            })
            .join("、");
          return `<button class="step ${step.stepId === state.stepId ? "active" : ""}" data-step="${esc(step.stepId)}"><span class="step-title"><strong>${esc(step.title || "未命名步骤")}</strong><span class="badge">${step.execution.kind === "program" ? "程序" : "Agent"}</span></span><span class="muted">${upstream ? `← ${esc(upstream)}` : "起始步骤"}</span>${view ? badge(view.state) : ""}</button>`;
        })
        .join("") || '<p class="empty">此设备还没有步骤。</p>';
  }
  function renderBindings(step) {
    const rows = Object.entries(step.inputs);
    return `<h3 style="margin-top:20px">输入映射</h3><p class="muted">把上游输出、工作流输入或固定值传给此步骤。字段路径用点分隔，留空表示整个对象。</p><div id="bindings">${rows
      .map(
        ([name, binding], index) =>
          `<div class="binding" data-binding-index="${index}" data-binding-name="${esc(name)}"><div class="binding-grid"><div><label>输入字段名<input data-binding="name" value="${esc(name)}"></label></div><div><label>来源<select data-binding="kind">${option("literal", "固定 JSON 值", binding.kind)}${option("workflow-input", "工作流输入", binding.kind)}${option("step-output", "上游步骤输出", binding.kind)}</select></label></div>${
            binding.kind === "step-output"
              ? `<div><label>来源步骤<select data-binding="stepId">${option("", "选择上游步骤", binding.stepId)}${definition()
                  .steps.filter((row) => row.stepId !== step.stepId)
                  .map((row) =>
                    option(
                      row.stepId,
                      `${row.nodeId} / ${row.title}`,
                      binding.stepId,
                    ),
                  )
                  .join("")}</select></label></div>`
              : ""
          }<div><label>${binding.kind === "literal" ? "固定值（JSON）" : "字段路径"}<input data-binding="${binding.kind === "literal" ? "value" : "path"}" value="${esc(binding.kind === "literal" ? JSON.stringify(binding.value) : (binding.path || []).join("."))}" placeholder="${binding.kind === "literal" ? "{}" : "留空取全部"}"></label></div></div><button data-remove-binding="${esc(name)}" class="danger">删除输入</button></div>`,
      )
      .join(
        "",
      )}</div><button id="add-binding" style="margin-top:10px">添加输入映射</button>`;
  }
  function renderStepEditor() {
    const step = selectedStep();
    if (!step) {
      $("step-detail").innerHTML =
        '<p class="empty">选择一个步骤查看详情。</p>';
      return;
    }
    if (run()) {
      renderStepResult();
      return;
    }
    const e = step.execution;
    const capabilities = state.snapshot.models.find(
      (row) => row.nodeId === step.nodeId,
    );
    const models = capabilities?.models || [];
    const selectedModel = JSON.stringify([e.provider, e.model]);
    $("step-detail").innerHTML =
      `<div class="fields"><div><label for="step-title">步骤名称</label><input id="step-title" value="${esc(step.title)}"></div><div><label for="step-kind">执行类型</label><select id="step-kind">${option("program", "程序", e.kind)}${option("agent", "Agent", e.kind)}</select></div><div class="span-all"><label for="step-workspace">执行工作区</label><select id="step-workspace">${workspaceOptions(step.nodeId, step.workspaceId)}</select></div></div>${e.kind === "program" ? `<label for="step-program">已登记的程序与版本</label><select id="step-program">${programOptions(step)}</select><p class="hint">${programsFor(step.nodeId).length ? "程序入口由该设备的插件登记。工作流只引用入口与版本。" : "此设备没有公布可用程序。请先在设备上安装并登记业务程序，恢复连接后刷新。"}</p>` : `<label for="step-model">模型</label><select id="step-model">${option("", models.length ? "选择模型" : "此设备未公布模型", selectedModel)}${models.map((row) => option(JSON.stringify([row.provider, row.model]), `${row.provider} / ${row.model}`, selectedModel)).join("")}${e.model && !models.some((row) => row.provider === e.provider && row.model === e.model) ? option(selectedModel, `${e.provider} / ${e.model} · 当前不可用`, selectedModel) : ""}</select><label for="step-effort">推理档位</label><select id="step-effort">${option("", "模型默认", e.reasoningEffort || "")}${(models.find((row) => row.provider === e.provider && row.model === e.model)?.reasoningEfforts || []).map((value) => option(value, value, e.reasoningEffort)).join("")}</select><label for="step-input-exposure">输入提供方式</label><select id="step-input-exposure">${option("inline", "直接提供给 Agent", e.inputExposure || "inline")}${option("tools", "通过工具按需读取", e.inputExposure || "inline")}</select><p class="muted">大量来源数据可由工具分页读取。选择此方式前，需要为 Agent 配置可读取本次工作流输入的工具。</p><label for="step-instructions">Agent 执行要求</label><textarea id="step-instructions">${esc(e.instructions)}</textarea><label for="step-tools">允许使用的工具（每行一个）</label><textarea id="step-tools">${esc(e.allowedTools.join("\n"))}</textarea>`}<label for="step-retries">${e.kind === "agent" ? "Agent 自动重试次数" : "程序步骤仅支持手动重试"}</label><input id="step-retries" type="number" min="0" max="5" value="${step.maxRetries}"${e.kind === "program" ? " disabled" : ""}><h3 style="margin-top:20px">等待哪些步骤完成</h3><div id="dependencies">${
        definition()
          .steps.filter((row) => row.stepId !== step.stepId)
          .map(
            (row) =>
              `<label class="dependency"><input type="checkbox" data-dependency="${esc(row.stepId)}"${step.dependsOn.includes(row.stepId) ? " checked" : ""}>${esc(row.nodeId)} / ${esc(row.title)}</label>`,
          )
          .join("") || '<p class="muted">添加其他步骤后可以连线。</p>'
      }</div>${renderBindings(step)}<div style="margin-top:24px"><button id="remove-step" class="danger">删除此步骤</button></div>`;
  }
  function htmlPreview(output) {
    const presentation = output?.presentation;
    if (
      presentation?.mediaType !== "text/html" ||
      typeof presentation.body !== "string" ||
      presentation.body.length > 2_000_000
    )
      return "";
    const policy =
      "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'\">";
    return `<details open><summary>报告预览</summary><iframe class="html-preview" title="报告 HTML 预览" sandbox="" referrerpolicy="no-referrer" srcdoc="${esc(policy + presentation.body)}"></iframe></details>`;
  }
  function renderStepResult() {
    const step = selectedStep(),
      view = run()?.steps.find((row) => row.stepId === step?.stepId);
    if (!step || !view) return;
    const canRetry =
      run().state !== "cancelled" &&
      (["failed", "cancelled"].includes(view.state) ||
        (view.state === "blocked" && !!view.runId));
    $("step-detail").innerHTML =
      `<h3>${esc(step.title)}</h3><div class="row">${badge(view.state)}<span class="muted">尝试 ${view.attemptCount} 次</span></div>${view.reason ? `<p class="hint">${esc(view.reason)}</p>` : ""}<p style="margin-top:12px">${esc(view.summary || "尚无结果摘要")}</p><div class="row">${canRetry ? '<button id="retry-step">重试此步骤</button>' : ""}${view.taskId ? '<button id="show-task">查看任务记录</button>' : ""}</div>${htmlPreview(view.output)}<details${view.output?.presentation?.mediaType === "text/html" ? "" : " open"}><summary>输出数据</summary><pre>${esc(view.output === undefined ? "尚未产生输出" : JSON.stringify(view.output, null, 2))}</pre></details><details><summary>执行记录</summary><pre>${esc(JSON.stringify({ nodeId: view.nodeId, taskId: view.taskId, runId: view.runId, reportId: view.reportId, sessionId: view.sessionId }, null, 2))}</pre></details><div id="task-record"></div>`;
  }
  function fullRender() {
    const visible = !!definition();
    $("welcome").classList.toggle("hidden", visible);
    $("content").classList.toggle("hidden", !visible);
    list();
    if (!visible) {
      $("welcome").textContent = "新建一个工作流，定义设备与执行步骤。";
      return;
    }
    renderHeading();
    history();
    renderDefinitionEditor();
    graph();
    stepList();
    renderStepEditor();
  }
  function selectWorkflow(workflowId) {
    if (state.dirty && !confirm("当前定义尚未保存，放弃修改并切换？")) return;
    const def = state.snapshot.definitions.find(
      (row) => row.workflowId === workflowId,
    );
    if (!def) return;
    Object.assign(state, {
      draft: clone(def),
      workflowId,
      runId: "",
      dirty: false,
      nodeId: "",
      stepId: "",
      deviceIds: [],
    });
    fullRender();
  }
  let refreshing = false;
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const snapshot = await api("workflowSnapshot");
      state.snapshot = snapshot;
      $("connection").textContent = `已更新 ${new Date().toLocaleTimeString()}`;
      $("error").textContent = "";
      if (!state.draft && snapshot.definitions.length) {
        selectWorkflow(snapshot.definitions[0].workflowId);
        return;
      }
      if (!state.draft) {
        fullRender();
        return;
      }
      list();
      history();
      graph();
      stepList();
      renderHeading();
      if (run()) {
        const resultKey = JSON.stringify(
          run().steps.find((row) => row.stepId === state.stepId),
        );
        if (refresh.resultKey !== resultKey) {
          const top = window.scrollY;
          renderStepResult();
          window.scrollTo(0, top);
          refresh.resultKey = resultKey;
        }
      }
    } catch (error) {
      $("connection").textContent = "连接中断";
      $("error").textContent = error.message;
    } finally {
      refreshing = false;
    }
  }
  function validate(def) {
    if (!def.title.trim()) throw Error("请填写工作流名称");
    if (!def.steps.length) throw Error("至少添加一个步骤");
    const ids = new Set(def.steps.map((step) => step.stepId));
    for (const step of def.steps) {
      if (!step.title.trim() || !step.workspaceId)
        throw Error(`${step.title || "步骤"} 需要名称和工作区`);
      if (
        step.execution.kind === "program" &&
        (!step.execution.programId || !step.execution.version)
      )
        throw Error(`${step.title} 尚未选择程序`);
      if (
        step.execution.kind === "agent" &&
        (!step.execution.provider ||
          !step.execution.model ||
          !step.execution.instructions.trim())
      )
        throw Error(`${step.title} 需要模型和执行要求`);
      if (
        !Number.isInteger(step.maxRetries) ||
        step.maxRetries < 0 ||
        step.maxRetries > 5
      )
        throw Error("重试次数须为 0 到 5");
      if (step.dependsOn.some((dep) => !ids.has(dep)))
        throw Error("依赖的步骤已不存在");
      for (const [name, binding] of Object.entries(step.inputs)) {
        if (!name.trim()) throw Error("输入字段名不能为空");
        if (
          binding.kind === "step-output" &&
          !step.dependsOn.includes(binding.stepId)
        )
          throw Error(`${step.title} 的输入来源须同时设为前置依赖`);
      }
    }
    const complete = new Set(),
      visiting = new Set();
    function visit(step) {
      if (complete.has(step.stepId)) return;
      if (visiting.has(step.stepId))
        throw Error("步骤依赖存在循环，请调整连线");
      visiting.add(step.stepId);
      for (const dep of step.dependsOn)
        visit(def.steps.find((row) => row.stepId === dep));
      visiting.delete(step.stepId);
      complete.add(step.stepId);
    }
    def.steps.forEach(visit);
  }
  async function mutate(method, input) {
    if (state.pending) return;
    const key = JSON.stringify([method, input]),
      commandId = commandIds.get(key) || id();
    commandIds.set(key, commandId);
    state.pending = true;
    const controls = [
      ...document.querySelectorAll("button,input,select,textarea"),
    ].map((element) => [element, element.disabled]);
    for (const [element] of controls) element.disabled = true;
    renderHeading();
    try {
      const result = await api(method, { commandId, ...input });
      commandIds.delete(key);
      return result;
    } finally {
      state.pending = false;
      for (const [element, disabled] of controls) element.disabled = disabled;
      renderHeading();
    }
  }
  async function act(action) {
    try {
      if (!state.snapshot) throw Error("尚未连接到调度端，请先刷新连接");
      if (action === "new-workflow") {
        if (state.dirty && !confirm("放弃当前未保存修改并新建？")) return;
        Object.assign(state, {
          workflowId: id(),
          draft: {
            workflowId: "",
            revision: 0,
            title: "新工作流",
            description: "",
            steps: [],
          },
          dirty: true,
          runId: "",
          nodeId: "",
          stepId: "",
          deviceIds: [],
        });
        state.draft.workflowId = state.workflowId;
        fullRender();
      } else if (action === "save-workflow") {
        const invalid = document.querySelector(":invalid");
        if (invalid) {
          invalid.reportValidity();
          throw Error("请修正表单中的无效内容");
        }
        validate(state.draft);
        const result = await mutate("saveWorkflow", {
          expectedRevision: state.draft.revision,
          definition: clone(state.draft),
        });
        if (!result) return;
        state.draft = clone(result);
        state.workflowId = result.workflowId;
        state.dirty = false;
        state.deviceIds = [];
        await refresh();
        fullRender();
        notice("工作流已保存");
      } else if (action === "start-workflow") {
        if (state.dirty) throw Error("请先保存定义");
        let input;
        try {
          input = JSON.parse($("workflow-input").value);
        } catch {
          throw Error("本次运行输入须为有效 JSON");
        }
        const result = await mutate("startWorkflow", {
          workflowId: state.workflowId,
          input,
        });
        if (!result) return;
        await refresh();
        state.runId = result.workflowRunId;
        fullRender();
        notice("工作流已开始");
      } else if (action === "cancel-workflow") {
        await mutate("cancelWorkflow", { workflowRunId: state.runId });
        await refresh();
        notice("取消请求已记录");
      } else if (action === "retry-step") {
        await mutate("retryWorkflowStep", {
          workflowRunId: state.runId,
          stepId: state.stepId,
        });
        await refresh();
        notice("步骤已请求重试");
      } else if (action === "edit-definition") {
        state.runId = "";
        fullRender();
      } else if (action === "add-device") {
        const nodeId = $("add-device-select").value;
        if (!nodeId) return;
        state.deviceIds.push(nodeId);
        state.nodeId = nodeId;
        state.stepId = "";
        graph();
        stepList();
        renderStepEditor();
      } else if (action === "add-step") {
        const nodeId = state.nodeId;
        if (!nodeId) return;
        const workspace = state.snapshot.workspaces.find(
          (row) => row.nodeId === nodeId && row.state === "ready",
        );
        const step = {
          stepId: id(),
          title: "新步骤",
          nodeId,
          workspaceId: workspace?.workspaceId || "",
          dependsOn: [],
          inputs: {},
          execution: { kind: "program", programId: "", version: "" },
          maxRetries: 0,
        };
        state.draft.steps.push(step);
        state.stepId = step.stepId;
        setDirty();
        graph();
        stepList();
        renderStepEditor();
      } else if (action === "remove-step") {
        const target = state.stepId;
        if (
          state.draft.steps.some(
            (step) =>
              step.dependsOn.includes(target) ||
              Object.values(step.inputs).some(
                (binding) =>
                  binding.kind === "step-output" && binding.stepId === target,
              ),
          )
        )
          throw Error("其他步骤仍依赖此步骤，请先移除相关依赖和输入映射");
        state.draft.steps = state.draft.steps.filter(
          (step) => step.stepId !== target,
        );
        setDirty();
        graph();
        stepList();
        renderStepEditor();
      } else if (action === "add-binding") {
        const step = selectedStep();
        let index = 1;
        while (Object.hasOwn(step.inputs, `input${index}`)) index++;
        step.inputs[`input${index}`] = { kind: "workflow-input", path: [] };
        setDirty();
        renderStepEditor();
      } else if (action === "show-task") {
        const view = run().steps.find((row) => row.stepId === state.stepId);
        const snapshot = await api("projectSnapshot");
        const task = snapshot.tasks.find((row) => row.id === view.taskId);
        $("task-record").innerHTML =
          `<details open><summary>任务记录</summary><pre>${esc(task ? JSON.stringify(task, null, 2) : "该任务暂未出现在项目快照中，可在任务中心按任务 ID 查找。")}</pre></details>`;
      }
    } catch (error) {
      notice(error.message);
      $("error").textContent = error.message;
    }
  }
  document.addEventListener("click", (event) => {
    if (state.pending) return;
    const target = event.target.closest("button");
    if (!target) return;
    if (target.dataset.workflow) {
      selectWorkflow(target.dataset.workflow);
      return;
    }
    if (target.dataset.node) {
      state.nodeId = target.dataset.node;
      state.stepId = "";
      graph();
      stepList();
      renderStepEditor();
      return;
    }
    if (target.dataset.step) {
      state.stepId = target.dataset.step;
      stepList();
      renderStepEditor();
      return;
    }
    if (target.dataset.removeBinding) {
      delete selectedStep().inputs[target.dataset.removeBinding];
      setDirty();
      renderStepEditor();
      return;
    }
    if (target.id === "refresh") {
      refresh();
      return;
    }
    if (target.id) act(target.id);
  });
  document.addEventListener("change", (event) => {
    const el = event.target;
    if (el.id === "scope") {
      state.filter = el.value;
      list();
      return;
    }
    if (el.id === "history") {
      if (
        state.dirty &&
        el.value &&
        !confirm("未保存修改会保留在当前定义中。查看历史执行？")
      ) {
        el.value = state.runId;
        return;
      }
      state.runId = el.value;
      state.stepId = "";
      fullRender();
      return;
    }
    if (run() || !state.draft) return;
    const step = selectedStep();
    try {
      if (el.id === "step-kind") {
        step.maxRetries = el.value === "program" ? 0 : 2;
        step.execution =
          el.value === "program"
            ? { kind: "program", programId: "", version: "" }
            : {
                kind: "agent",
                provider: "",
                model: "",
                instructions: "",
                allowedTools: [],
              };
        setDirty();
        stepList();
        renderStepEditor();
      } else if (el.id === "step-program") {
        const [programId, version] = el.value ? JSON.parse(el.value) : ["", ""];
        Object.assign(step.execution, { programId, version });
        setDirty();
      } else if (el.id === "step-model") {
        const [provider, model] = el.value ? JSON.parse(el.value) : ["", ""];
        Object.assign(step.execution, { provider, model });
        delete step.execution.reasoningEffort;
        setDirty();
        renderStepEditor();
      } else if (el.id === "step-effort") {
        if (el.value) step.execution.reasoningEffort = el.value;
        else delete step.execution.reasoningEffort;
        setDirty();
      } else if (el.id === "step-input-exposure") {
        step.execution.inputExposure = el.value;
        setDirty();
      } else if (el.id === "step-workspace") {
        step.workspaceId = el.value;
        setDirty();
      } else if (el.dataset.dependency) {
        step.dependsOn = el.checked
          ? [...new Set([...step.dependsOn, el.dataset.dependency])]
          : step.dependsOn.filter((dep) => dep !== el.dataset.dependency);
        setDirty();
        graph();
        stepList();
      } else if (el.dataset.binding) {
        el.setCustomValidity("");
        const container = el.closest("[data-binding-name]"),
          name = container.dataset.bindingName,
          binding = step.inputs[name];
        if (el.dataset.binding === "name") {
          const next = el.value.trim();
          if (!next) throw Error("输入字段名不能为空");
          if (["__proto__", "constructor", "prototype"].includes(next))
            throw Error("请使用其他输入字段名");
          if (next === name) return;
          if (Object.hasOwn(step.inputs, next)) throw Error("输入字段名重复");
          step.inputs[next] = binding;
          delete step.inputs[name];
          container.dataset.bindingName = next;
          container.querySelector(
            "[data-remove-binding]",
          ).dataset.removeBinding = next;
        } else if (el.dataset.binding === "kind") {
          step.inputs[name] =
            el.value === "literal"
              ? { kind: "literal", value: {} }
              : el.value === "workflow-input"
                ? { kind: "workflow-input", path: [] }
                : { kind: "step-output", stepId: "", path: [] };
          renderStepEditor();
        } else if (el.dataset.binding === "value") {
          binding.value = JSON.parse(el.value);
        } else if (el.dataset.binding === "path") {
          binding.path = el.value ? el.value.split(".") : [];
        } else if (el.dataset.binding === "stepId") {
          binding.stepId = el.value;
          if (el.value)
            step.dependsOn = [...new Set([...step.dependsOn, el.value])];
          graph();
          stepList();
          renderStepEditor();
        }
        setDirty();
      } else if (el.id.startsWith("schedule-")) {
        state.draft.schedule = {
          enabled: $("schedule-enabled").checked,
          cron: $("schedule-cron").value,
          timeZone: $("schedule-zone").value,
          dayOffset: Number($("schedule-day").value),
        };
        setDirty();
      }
    } catch (error) {
      if (el.dataset.binding) el.setCustomValidity(error.message);
      notice(error.message);
    }
  });
  document.addEventListener("input", (event) => {
    if (run() || !state.draft) return;
    const el = event.target,
      step = selectedStep();
    if (el.id === "workflow-title") {
      state.draft.title = el.value;
      setDirty();
    } else if (el.id === "workflow-description") {
      state.draft.description = el.value;
      setDirty();
    } else if (el.id === "step-title") {
      step.title = el.value;
      setDirty();
      stepList();
    } else if (el.id === "step-retries") {
      step.maxRetries = Number(el.value);
      setDirty();
    } else if (el.id === "step-instructions") {
      step.execution.instructions = el.value;
      setDirty();
    } else if (el.id === "step-tools") {
      step.execution.allowedTools = el.value
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean);
      setDirty();
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (state.dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  refresh();
  setInterval(refresh, 10000);
})();
