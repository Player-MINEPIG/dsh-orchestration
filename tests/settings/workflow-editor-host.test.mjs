import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
const source = readFileSync(
  new URL("../../packages/task-system/src/settings-client.js", import.meta.url),
  "utf8",
);

test("workflow navigation stays local to the authenticated iframe and restores project context", async () => {
  const start = source.indexOf("    function ProjectPanel("),
    end = source.indexOf("    /** Native commands", start);
  const methods = source.slice(
    source.indexOf("    const projectMethods = ["),
    source.indexOf("    const projectDescriptors ="),
  );
  const states = [],
    effects = [],
    listeners = new Map(),
    requests = [],
    posted = [];
  let index = 0,
    pending = [],
    rendered;
  const frameWindow = { postMessage: (value) => posted.push(value) };
  const React = {
    useRef: () => ({ current: { contentWindow: frameWindow } }),
    useState(initial) {
      const n = index++;
      if (!(n in states)) states[n] = initial;
      return [states[n], (value) => (states[n] = value)];
    },
    useEffect(fn, deps) {
      const n = index++;
      if (!effects[n] || deps.some((d, i) => d !== effects[n].deps[i])) {
        effects[n]?.cleanup?.();
        effects[n] = { deps };
        pending.push(() => (effects[n].cleanup = fn()));
      }
    },
  };
  const window = {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => {
      if (listeners.get(name) === fn) listeners.delete(name);
    },
  };
  const invoke = async (method) => {
    requests.push(method);
    return '<html lang="zh"><head></head><body><script>window.booted=true;</script></body></html>';
  };
  const context = vm.createContext({
    React,
    window,
    JSON,
    projectMethods: [],
    hostTheme: () => "light",
    watchTheme: () => () => {},
    sendTheme() {},
    h: (type, props, ...children) => ({ type, props, children }),
  });
  vm.runInContext(
    methods +
      source.slice(start, end) +
      ";globalThis.ProjectPanel=ProjectPanel;",
    context,
  );
  async function render() {
    for (let i = 0; i < 3; i++) {
      index = 0;
      rendered = context.ProjectPanel({ invoke, directoryApi: {} });
      const jobs = pending;
      pending = [];
      jobs.forEach((fn) => fn());
      await new Promise((resolve) => setImmediate(resolve));
    }
    rendered = rendered.type === "iframe" ? rendered : rendered.children.find((child) => child?.type === "iframe");
    return rendered;
  }
  await render();
  assert.equal(rendered.props.title, "项目与任务");
  await listeners.get("message")({
    source: {},
    data: {
      channel: "dsh-project-runtime",
      method: "openWorkflow",
      input: { projectId: "p" },
    },
  });
  await render();
  assert.deepEqual(requests, ["projectPage"]);
  const contextValue = {
    projectId: "p",
    taskId: "task",
    workflowId: "w",
    runId: "r",
    stageId: "stage",
    title: "</script><img src=x>",
  };
  await listeners.get("message")({
    source: frameWindow,
    data: {
      channel: "dsh-project-runtime",
      id: "open",
      method: "openWorkflow",
      input: contextValue,
    },
  });
  await render();
  assert.equal(rendered.props.title, "项目工作流");
  assert.match(rendered.props.srcDoc, /window\.__DSH_WORKFLOW_CONTEXT__=/);
  assert.match(rendered.props.srcDoc, /\\u003c\/script>/);
  assert.doesNotMatch(rendered.props.srcDoc, /<img src=x>/);
  assert.equal(posted[0].id, "open");
  await listeners.get("message")({
    source: frameWindow,
    data: {
      channel: "dsh-project-runtime",
      id: "close",
      method: "closeWorkflow",
      input: contextValue,
    },
  });
  await render();
  assert.equal(rendered.props.title, "项目与任务");
  assert.match(rendered.props.srcDoc, /window\.__DSH_PROJECT_CONTEXT__=/);
  assert.match(rendered.props.srcDoc, /"runId":"r"/);
  assert.doesNotMatch(source, /dsh-task-workflows|hash === "#workflows"/);
  assert.match(methods, /configureWorkflowTask/);
  assert.match(methods, /adoptWorkflow/);
  assert.match(methods, /createProjectTask/);
  assert.match(methods, /runProjectTask/);
});
