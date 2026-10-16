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
  const context = window.__DSH_WORKFLOW_CONTEXT__ || {};
  const state = {
    snapshot: null,
    draft: null,
    dirty: false,
    workflowId: "",
    runId: "",
    nodeId: "",
    stageId: "",
    focusStage: false,
    viewport: { x: 35, y: 35, zoom: 1 },
    taskId: context.taskId || "",
    connectFrom: "",
    stepId: "",
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
  const definition = () => (run() ? normalized(run().definition) : state.draft);
  const selectedStep = () =>
    definition()?.steps.find((row) => row.stepId === state.stepId);
  const nodeStatus = (nodeId) =>
    state.snapshot?.nodes.find((row) => row.nodeId === nodeId) || {
      nodeId,
      state: "unknown",
    };
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
    const rows = (state.snapshot?.definitions || []).filter(
      (row) =>
        row.projectId === context.projectId ||
        row.workflowId === context.workflowId,
    );
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
          return `<button type="button" class="workflow-item ${row.workflowId === state.workflowId ? "active" : ""}" data-workflow="${esc(row.workflowId)}"><strong>${esc(row.title)}</strong><small>${count > 1 ? `${count} 台设备协作` : "单设备"} · ${row.steps.length} 个步骤${row.schedule?.enabled ? " · 定时运行" : ""}</small></button>`;
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
      !!run() ||
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
      `<div class="fields"><div><label for="workflow-title">工作流名称</label><input id="workflow-title" value="${esc(def.title)}"></div><div><label for="workflow-description">说明</label><input id="workflow-description" value="${esc(def.description)}"></div></div><p class="muted">流程属于当前项目。参数与触发方式在任务中配置。</p>`;
  }
  function normalized(value) {
    const def = clone(value);
    if (!def.stages) {
      def.stages = [...new Set(def.steps.map((step) => step.nodeId))].map(
        (nodeId, i) => ({
          stageId: `legacy-stage-${i}`,
          nodeId,
          title: nodeId,
          position: { x: i * 300, y: 0 },
        }),
      );
      for (const step of def.steps)
        step.stageId = def.stages.find(
          (stage) => stage.nodeId === step.nodeId,
        ).stageId;
    }
    if (!def.calls)
      def.calls = def.steps.flatMap((step) =>
        step.dependsOn.map((fromStepId) => ({
          fromStepId,
          toStepId: step.stepId,
        })),
      );
    def.stages.forEach((stage, i) => (stage.position ||= { x: i * 300, y: 0 }));
    def.steps.forEach(
      (step, i) =>
        (step.position ||= { x: (i % 3) * 280, y: Math.floor(i / 3) * 180 }),
    );
    return def;
  }
  function derive(def) {
    for (const step of def.steps) {
      const stage = def.stages.find((row) => row.stageId === step.stageId);
      if (!stage) throw Error("步骤所属阶段不存在");
      step.nodeId = stage.nodeId;
      step.dependsOn = def.calls
        .filter((call) => call.toStepId === step.stepId)
        .map((call) => call.fromStepId);
    }
    return def;
  }
  function checkCalls(def) {
    const byId = new Map(def.steps.map((step) => [step.stepId, step]));
    const visited = new Set(),
      active = new Set(),
      keys = new Set();
    for (const call of def.calls) {
      if (!byId.has(call.fromStepId) || !byId.has(call.toStepId))
        throw Error("连线端点不存在");
      if (call.fromStepId === call.toStepId) throw Error("步骤不能调用自身");
      const key = JSON.stringify([call.fromStepId, call.toStepId]);
      if (keys.has(key)) throw Error("此调用连线已存在");
      keys.add(key);
    }
    function visit(stepId) {
      if (active.has(stepId)) throw Error("调用存在循环，请调整连线");
      if (visited.has(stepId)) return;
      active.add(stepId);
      def.calls
        .filter((call) => call.fromStepId === stepId)
        .forEach((call) => visit(call.toStepId));
      active.delete(stepId);
      visited.add(stepId);
    }
    byId.forEach((_, stepId) => visit(stepId));
    for (const step of def.steps)
      for (const binding of Object.values(step.inputs)) {
        if (
          binding.kind === "step-output" &&
          !def.calls.some(
            (call) =>
              call.fromStepId === binding.stepId &&
              call.toStepId === step.stepId,
          )
        )
          throw Error(`${step.title} 仍使用上游输出，请先删除或重新绑定输入`);
      }
  }
  function changeCall(fromStepId, toStepId, remove = false) {
    if (run()) throw Error("历史执行只读");
    const next = clone(state.draft);
    next.calls = remove
      ? next.calls.filter(
          (call) =>
            call.fromStepId !== fromStepId || call.toStepId !== toStepId,
        )
      : [...next.calls, { fromStepId, toStepId }];
    checkCalls(next);
    state.draft = derive(next);
    setDirty();
    graph();
    stepList();
    renderStepEditor();
  }
  function visibleBoxes() {
    const def = definition();
    if (!def) return [];
    return (
      state.focusStage
        ? def.steps.filter((step) => step.stageId === state.stageId)
        : def.stages
    ).map((row) => ({
      ...row.position,
      w: state.focusStage ? 230 : 250,
      h: state.focusStage ? 115 : 140,
      id: state.focusStage ? row.stepId : row.stageId,
      row,
    }));
  }
  function applyViewport() {
    const v = state.viewport;
    $("device-graph").style.transform =
      `translate(${v.x}px,${v.y}px) scale(${v.zoom})`;
    $("zoom-label").textContent = `${Math.round(v.zoom * 100)}%`;
  }
  function fit() {
    const boxes = visibleBoxes(),
      rect = $("graph-container").getBoundingClientRect();
    if (!boxes.length) {
      state.viewport = { x: 35, y: 35, zoom: 1 };
      applyViewport();
      return;
    }
    const left = Math.min(...boxes.map((b) => b.x)),
      top = Math.min(...boxes.map((b) => b.y));
    const width = Math.max(...boxes.map((b) => b.x + b.w)) - left,
      height = Math.max(...boxes.map((b) => b.y + b.h)) - top;
    const zoom = Math.min(
      1.25,
      Math.max(
        0.15,
        Math.min((rect.width - 80) / width, (rect.height - 80) / height),
      ),
    );
    state.viewport = {
      zoom,
      x: (rect.width - width * zoom) / 2 - left * zoom,
      y: (rect.height - height * zoom) / 2 - top * zoom,
    };
    applyViewport();
  }
  function zoomAt(factor, x, y) {
    const v = state.viewport,
      zoom = Math.min(2.5, Math.max(0.15, v.zoom * factor)),
      ratio = zoom / v.zoom;
    state.viewport = {
      zoom,
      x: x - (x - v.x) * ratio,
      y: y - (y - v.y) * ratio,
    };
    applyViewport();
  }
  function graph() {
    const def = definition();
    if (!def) return;
    if (!def.stages.some((stage) => stage.stageId === state.stageId))
      state.stageId = def.stages[0]?.stageId || "";
    const stage = def.stages.find((row) => row.stageId === state.stageId);
    state.nodeId = stage?.nodeId || "";
    const boxes = visibleBoxes(),
      byId = new Map(boxes.map((box) => [box.id, box]));
    const lines = def.calls
      .map((call) => {
        const from = def.steps.find((step) => step.stepId === call.fromStepId),
          to = def.steps.find((step) => step.stepId === call.toStepId);
        if (!from || !to || (!state.focusStage && from.stageId === to.stageId))
          return "";
        const a = byId.get(state.focusStage ? from.stepId : from.stageId),
          b = byId.get(state.focusStage ? to.stepId : to.stageId);
        if (!a || !b) return "";
        const ax = a.x + a.w,
          ay = a.y + a.h / 2,
          bx = b.x,
          by = b.y + b.h / 2,
          bend = Math.max(65, Math.abs(bx - ax) / 2);
        return `<path d="M${ax} ${ay} C${ax + bend} ${ay},${bx - bend} ${by},${bx} ${by}" class="route" marker-end="url(#arrow)"><title>${esc(from.title)} → ${esc(to.title)}</title></path>`;
      })
      .join("");
    const cards = boxes
      .map((box) => {
        const row = box.row,
          isStep = state.focusStage,
          steps = isStep
            ? [row]
            : def.steps.filter((step) => step.stageId === row.stageId);
        const views =
          run()?.steps.filter((view) =>
            steps.some((step) => step.stepId === view.stepId),
          ) || [];
        const result = views.some((view) =>
          ["failed", "uncertain", "blocked"].includes(view.state),
        )
          ? "needs_attention"
          : views.length &&
              views.every((view) =>
                ["succeeded", "partial"].includes(view.state),
              )
            ? views.some((view) => view.state === "partial")
              ? "partial"
              : "succeeded"
            : views.some((view) => view.state === "running")
              ? "running"
              : "pending";
        return `<article class="graph-card ${box.id === (isStep ? state.stepId : state.stageId) ? "active" : ""}" data-card="${esc(box.id)}" style="left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px"><button type="button" class="card-main" ${isStep ? `data-step="${esc(row.stepId)}"` : `data-stage="${esc(row.stageId)}"`}><span class="card-kind">${isStep ? (row.execution.kind === "program" ? "程序" : "Agent") : "执行阶段"}</span><strong>${esc(row.title)}</strong>${isStep ? "" : `<span class="muted">设备 ${esc(row.nodeId)} · ${steps.length} 个内部步骤</span>`}${run() ? badge(result) : ""}</button>${!isStep ? `<span class="availability">当前设备 ${badge(nodeStatus(row.nodeId).state)}</span>` : ""}${!run() ? `<button type="button" class="port in" data-port="in" data-endpoint="${esc(box.id)}" aria-label="连接到 ${esc(row.title)}">●</button><button type="button" class="port out" data-port="out" data-endpoint="${esc(box.id)}" aria-label="从 ${esc(row.title)} 调用">●</button>` : ""}</article>`;
      })
      .join("");
    $("device-graph").innerHTML =
      `<svg class="graph-lines" aria-hidden="true"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8" fill="var(--accent)"/></marker></defs>${lines}</svg>${cards}`;
    $("canvas-empty").classList.toggle("hidden", !!boxes.length);
    $("canvas-breadcrumb").textContent = state.focusStage
      ? `${stage?.title || "阶段"} · 内部步骤`
      : "流程 · 执行阶段";
    $("leave-stage").classList.toggle("hidden", !state.focusStage);
    $("add-device-select").innerHTML =
      state.snapshot.nodes
        .map((row) =>
          option(
            row.nodeId,
            `${row.nodeId} · ${statusNames[row.state] || row.state}`,
            "",
          ),
        )
        .join("") || option("", "没有已登记设备", "");
    $("add-device").disabled = !$("add-device-select").value || state.pending;
    $("add-step").disabled = !stage || state.pending;
    $("stage-controls").innerHTML = stage
      ? `<label>阶段名称<input id="stage-title" value="${esc(stage.title)}"${run() ? " disabled" : ""}></label><label>执行设备<select id="stage-node"${run() ? " disabled" : ""}>${state.snapshot.nodes.map((row) => option(row.nodeId, row.nodeId, stage.nodeId)).join("")}${!state.snapshot.nodes.some((row) => row.nodeId === stage.nodeId) ? option(stage.nodeId, stage.nodeId, stage.nodeId) : ""}</select></label><button type="button" id="enter-stage">查看内部步骤</button>${!run() ? '<button type="button" id="remove-stage" class="danger">删除阶段</button>' : ""}`
      : '<p class="muted">添加阶段并指定执行设备。</p>';
    $("call-controls").classList.toggle("hidden", !!run());
    const endpointOptions = def.steps
      .map((step) =>
        option(
          step.stepId,
          `${def.stages.find((s) => s.stageId === step.stageId)?.title} / ${step.title}`,
          "",
        ),
      )
      .join("");
    $("call-from").innerHTML = endpointOptions;
    $("call-to").innerHTML = endpointOptions;
    $("call-list").innerHTML =
      def.calls
        .map(
          (call, index) =>
            `<div class="call-row"><span>${esc(def.steps.find((s) => s.stepId === call.fromStepId)?.title)} → ${esc(def.steps.find((s) => s.stepId === call.toStepId)?.title)}</span>${!run() ? `<button type="button" data-remove-call="${index}" aria-label="删除调用连线">删除</button>` : ""}</div>`,
        )
        .join("") ||
      '<p class="muted">暂无调用。没有前置调用的步骤会并行开始。</p>';
    applyViewport();
  }
  function stepList() {
    const def = definition();
    if (!def) return;
    const steps = def.steps.filter((step) => step.stageId === state.stageId);
    if (!steps.some((step) => step.stepId === state.stepId))
      state.stepId = steps[0]?.stepId || "";
    $("device-heading").textContent = state.nodeId
      ? `${def.stages.find((stage) => stage.stageId === state.stageId)?.title || state.nodeId} · 内部步骤`
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
          return `<button type="button" class="step ${step.stepId === state.stepId ? "active" : ""}" data-step="${esc(step.stepId)}"><span class="step-title"><strong>${esc(step.title || "未命名步骤")}</strong><span class="badge">${step.execution.kind === "program" ? "程序" : "Agent"}</span></span><span class="muted">${upstream ? `← ${esc(upstream)}` : "起始步骤"}</span>${view ? badge(view.state) : ""}</button>`;
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
          }<div><label>${binding.kind === "literal" ? "固定值（JSON）" : "字段路径"}<input data-binding="${binding.kind === "literal" ? "value" : "path"}" value="${esc(binding.kind === "literal" ? JSON.stringify(binding.value) : (binding.path || []).join("."))}" placeholder="${binding.kind === "literal" ? "{}" : "留空取全部"}"></label></div></div><button type="button" data-remove-binding="${esc(name)}" class="danger">删除输入</button></div>`,
      )
      .join(
        "",
      )}</div><button type="button" id="add-binding" style="margin-top:10px">添加输入映射</button>`;
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
      }</div>${renderBindings(step)}<div style="margin-top:24px"><button type="button" id="remove-step" class="danger">删除此步骤</button></div>`;
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
    const dispatches = (run().dispatches || []).filter(
      (row) => row.stepId === step.stepId,
    );
    const canRetry =
      run().state !== "cancelled" &&
      (["failed", "cancelled"].includes(view.state) ||
        (view.state === "blocked" && !!view.runId));
    $("step-detail").innerHTML =
      `<h3>${esc(step.title)}</h3><div class="row">${badge(view.state)}<span class="muted">尝试 ${view.attemptCount} 次</span></div>${view.reason ? `<p class="hint">${esc(view.reason)}</p>` : ""}<p style="margin-top:12px">${esc(view.summary || "尚无结果摘要")}</p><div class="row">${canRetry ? '<button type="button" id="retry-step">重试此步骤</button>' : ""}${view.taskId ? '<button type="button" id="show-task">查看任务记录</button>' : ""}</div>${htmlPreview(view.output)}<details${view.output?.presentation?.mediaType === "text/html" ? "" : " open"}><summary>输出数据</summary><pre>${esc(view.output === undefined ? "尚未产生输出" : JSON.stringify(view.output, null, 2))}</pre></details><details><summary>执行记录</summary><pre>${esc(JSON.stringify({ nodeId: view.nodeId, taskId: view.taskId, runId: view.runId, reportId: view.reportId, sessionId: view.sessionId }, null, 2))}</pre></details><details><summary>本次执行固定输入与映射</summary><pre>${esc(JSON.stringify({ parameters: run().input, bindings: step.inputs }, null, 2))}</pre></details><details><summary>历次执行回执（${dispatches.length}）</summary><pre>${esc(JSON.stringify(dispatches, null, 2))}</pre></details><div id="task-record"></div>`;
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
      draft: normalized(def),
      workflowId,
      runId: "",
      dirty: false,
      nodeId: "",
      stepId: "",
      stageId: "",
      focusStage: false,
    });
    fullRender();
    fit();
  }
  let refreshing = false;
  async function refresh() {
    if (refreshing || gesture) return;
    refreshing = true;
    try {
      const snapshot = await api("workflowSnapshot");
      state.snapshot = snapshot;
      $("connection").textContent = `已更新 ${new Date().toLocaleTimeString()}`;
      $("error").textContent = "";
      if (!state.draft && snapshot.definitions.length) {
        const chosen =
          snapshot.definitions.find(
            (row) => row.workflowId === context.workflowId,
          ) ||
          snapshot.definitions.find(
            (row) => row.projectId === context.projectId,
          );
        if (!chosen) {
          fullRender();
          return;
        }
        selectWorkflow(chosen.workflowId);
        const selectedRun = snapshot.runs.find(
          (row) =>
            row.workflowRunId === context.runId || row.runId === context.runId,
        );
        if (selectedRun) {
          state.runId = selectedRun.workflowRunId;
          fullRender();
          fit();
        }
        const binding = snapshot.taskBindings?.find(
          (row) => row.taskId === state.taskId,
        );
        if (binding)
          $("workflow-input").value = JSON.stringify(binding.input, null, 2);
        if (
          context.stageId &&
          definition().stages.some((stage) => stage.stageId === context.stageId)
        ) {
          state.stageId = context.stageId;
          state.focusStage = true;
          graph();
          stepList();
          renderStepEditor();
          fit();
        }
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
    derive(def);
    checkCalls(def);
    if (!def.projectId) throw Error("请从项目打开流程编辑器");
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
        if (!context.projectId) throw Error("请从项目打开流程编辑器");
        if (state.dirty && !confirm("放弃当前未保存修改并新建？")) return;
        Object.assign(state, {
          workflowId: id(),
          draft: {
            workflowId: "",
            revision: 0,
            title: "新工作流",
            description: "",
            projectId: context.projectId,
            stages: [],
            calls: [],
            steps: [],
          },
          dirty: true,
          runId: "",
          nodeId: "",
          stepId: "",
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
        state.draft = normalized(result);
        state.workflowId = result.workflowId;
        state.dirty = false;
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
        const binding = await mutate("configureWorkflowTask", {
          projectId: context.projectId,
          ...(state.taskId
            ? { taskId: state.taskId }
            : { title: state.draft.title }),
          workflowId: state.workflowId,
          input,
        });
        if (!binding) return;
        state.taskId = binding.taskId;
        const result = await mutate("startWorkflow", {
          taskId: state.taskId,
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
      } else if (action === "back-project") {
        if (state.dirty && !confirm("流程尚未保存，放弃修改并返回项目？"))
          return;
        await api("closeWorkflow", {
          ...context,
          taskId: state.taskId || context.taskId,
        });
      } else if (action === "fit-graph") {
        fit();
      } else if (action === "zoom-in" || action === "zoom-out") {
        const rect = $("graph-container").getBoundingClientRect();
        zoomAt(
          action === "zoom-in" ? 1.2 : 1 / 1.2,
          rect.width / 2,
          rect.height / 2,
        );
      } else if (action === "fullscreen-graph") {
        $("graph-panel").classList.toggle("canvas-fullscreen");
        const expanded =
          $("graph-panel").classList.contains("canvas-fullscreen");
        $("fullscreen-graph").textContent = expanded ? "退出全屏" : "全屏";
        $("fullscreen-graph").setAttribute("aria-pressed", String(expanded));
        parent.postMessage(
          {
            channel: "dsh-project-runtime",
            method: "detailFullscreen",
            input: expanded,
          },
          "*",
        );
        requestAnimationFrame(fit);
      } else if (action === "enter-stage" || action === "leave-stage") {
        state.focusStage = action === "enter-stage";
        graph();
        fit();
      } else if (action === "add-call") {
        changeCall($("call-from").value, $("call-to").value);
      } else if (action === "remove-stage") {
        if (state.draft.steps.some((step) => step.stageId === state.stageId))
          throw Error("请先删除阶段中的步骤");
        state.draft.stages = state.draft.stages.filter(
          (stage) => stage.stageId !== state.stageId,
        );
        state.stageId = "";
        setDirty();
        fullRender();
      } else if (action === "add-device") {
        const nodeId = $("add-device-select").value;
        if (!nodeId) return;
        state.stageId = id();
        state.draft.stages.push({
          stageId: state.stageId,
          title: `${nodeId} 阶段`,
          nodeId,
          position: { x: state.draft.stages.length * 300, y: 0 },
        });
        state.nodeId = nodeId;
        state.stepId = "";
        state.focusStage = false;
        setDirty();
        graph();
        stepList();
        renderStepEditor();
        fit();
      } else if (action === "add-step") {
        const nodeId = state.nodeId;
        if (!nodeId) return;
        const workspace = state.snapshot.workspaces.find(
          (row) => row.nodeId === nodeId && row.state === "ready",
        );
        const step = {
          stepId: id(),
          title: "新步骤",
          stageId: state.stageId,
          position: {
            x:
              state.draft.steps.filter((step) => step.stageId === state.stageId)
                .length * 280,
            y: 0,
          },
          nodeId,
          workspaceId: workspace?.workspaceId || "",
          dependsOn: [],
          inputs: {},
          execution: { kind: "program", programId: "", version: "" },
          maxRetries: 0,
        };
        state.draft.steps.push(step);
        state.stepId = step.stepId;
        state.focusStage = true;
        setDirty();
        graph();
        stepList();
        renderStepEditor();
        fit();
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
        state.draft.calls = state.draft.calls.filter(
          (call) => call.fromStepId !== target && call.toStepId !== target,
        );
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
    if (target.dataset.stage) {
      state.stageId = target.dataset.stage;
      state.stepId = "";
      graph();
      stepList();
      renderStepEditor();
      return;
    }
    if (target.dataset.removeCall !== undefined) {
      const call = state.draft.calls[Number(target.dataset.removeCall)];
      try {
        changeCall(call.fromStepId, call.toStepId, true);
      } catch (error) {
        notice(error.message);
      }
      return;
    }
    if (target.dataset.port) return;
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
      fit();
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
        try {
          changeCall(el.dataset.dependency, step.stepId, !el.checked);
        } catch (error) {
          el.checked = !el.checked;
          throw error;
        }
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
          if (
            el.value &&
            !state.draft.calls.some(
              (call) =>
                call.fromStepId === el.value && call.toStepId === step.stepId,
            )
          )
            throw Error("请先添加调用连线，再选择上游输出");
          binding.stepId = el.value;
          graph();
          stepList();
          renderStepEditor();
        }
        setDirty();
      } else if (el.id === "stage-title") {
        graph();
      } else if (el.id === "stage-node") {
        const stage = state.draft.stages.find(
          (row) => row.stageId === state.stageId,
        );
        stage.nodeId = el.value;
        for (const row of state.draft.steps.filter(
          (row) => row.stageId === stage.stageId,
        )) {
          row.nodeId = stage.nodeId;
          row.workspaceId = "";
        }
        setDirty();
        graph();
        renderStepEditor();
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
    } else if (el.id === "stage-title") {
      state.draft.stages.find(
        (stage) => stage.stageId === state.stageId,
      ).title = el.value;
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
  let gesture = null,
    suppressClick = false;
  function pointer(event) {
    const rect = $("graph-container").getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  $("graph-container").addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || state.pending) return;
    const port = event.target.closest("[data-port]");
    const card = event.target.closest("[data-card]");
    if (port && !run())
      gesture = {
        kind: "connect",
        id: port.dataset.endpoint,
        direction: port.dataset.port,
        start: pointer(event),
      };
    else if (card && !run())
      gesture = {
        kind: "drag",
        id: card.dataset.card,
        start: pointer(event),
        origin: {
          ...visibleBoxes().find((box) => box.id === card.dataset.card),
        },
      };
    else if (!card)
      gesture = {
        kind: "pan",
        start: pointer(event),
        origin: { ...state.viewport },
      };
    if (gesture) {
      $("graph-container").setPointerCapture(event.pointerId);
      event.preventDefault();
    }
  });
  $("graph-container").addEventListener("pointermove", (event) => {
    if (!gesture) return;
    const point = pointer(event),
      dx = point.x - gesture.start.x,
      dy = point.y - gesture.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) gesture.moved = true;
    if (gesture.kind === "pan") {
      state.viewport.x = gesture.origin.x + dx;
      state.viewport.y = gesture.origin.y + dy;
      applyViewport();
    }
    if (gesture.kind === "drag" && gesture.moved) {
      const rows = state.focusStage ? state.draft.steps : state.draft.stages;
      const row = rows.find(
        (row) => (state.focusStage ? row.stepId : row.stageId) === gesture.id,
      );
      row.position = {
        x: Math.round(gesture.origin.x + dx / state.viewport.zoom),
        y: Math.round(gesture.origin.y + dy / state.viewport.zoom),
      };
      graph();
    }
  });
  $("graph-container").addEventListener("pointerup", (event) => {
    if (!gesture) return;
    const current = gesture;
    gesture = null;
    if (current.kind === "drag" && current.moved) {
      setDirty();
      suppressClick = true;
    }
    if (current.kind === "connect") {
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest("[data-port]");
      if (target && target.dataset.port !== current.direction) {
        const from =
            current.direction === "out" ? current.id : target.dataset.endpoint,
          to =
            current.direction === "out" ? target.dataset.endpoint : current.id;
        if (state.focusStage) {
          try {
            changeCall(from, to);
          } catch (error) {
            notice(error.message);
          }
        } else {
          const def = definition(),
            source = def.steps.filter((step) => step.stageId === from),
            dest = def.steps.filter((step) => step.stageId === to);
          $("call-from").innerHTML = source
            .map((step) => option(step.stepId, step.title, ""))
            .join("");
          $("call-to").innerHTML = dest
            .map((step) => option(step.stepId, step.title, ""))
            .join("");
          $("connection-form").open = true;
          $("call-from").focus();
          notice(
            source.length && dest.length
              ? "选择具体的出口和入口步骤，然后添加调用"
              : "请先为两个阶段添加内部步骤",
          );
        }
      }
      suppressClick = true;
    }
    $("graph-container").releasePointerCapture(event.pointerId);
  });
  $("graph-container").addEventListener("pointercancel", () => {
    gesture = null;
  });
  $("graph-container").addEventListener(
    "click",
    (event) => {
      if (suppressClick) {
        event.stopPropagation();
        suppressClick = false;
      }
    },
    true,
  );
  $("graph-container").addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const p = pointer(event);
      zoomAt(event.deltaY < 0 ? 1.12 : 1 / 1.12, p.x, p.y);
    },
    { passive: false },
  );
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      $("graph-panel").classList.contains("canvas-fullscreen")
    )
      act("fullscreen-graph");
  });
  if (typeof ResizeObserver !== "undefined")
    new ResizeObserver(() => applyViewport()).observe($("graph-container"));
  refresh();
  setInterval(refresh, 10000);
})();
