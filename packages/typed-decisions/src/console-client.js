/* Independent DSH settings page. No task-system browser or Host service dependency. */
window.__ModuleLoader__.load({
  id: "@dsh-task/typed-decisions",
  factory(require) {
    const React = require("react"),
      h = React.createElement;
    const methods = ["view", "command", "page"];
    const descriptors = methods.map((method) => ({
      id: `@dsh-task/typed-decisions#typedDecisionSettings/${method}`,
      service: "typedDecisionSettings",
      namespace: "typedDecisionSettings",
      method,
      invocation: { kind: "direct" },
      parameters:
        method === "command"
          ? [
              {
                name: "input",
                wire: "input",
                source: "json",
                codec: {
                  mode: "strict",
                  typeSymbol: "@dsh-task/typed-decisions#ConsoleCommand",
                  create: () => ({ parse: (value) => value }),
                },
              },
            ]
          : [],
      result: {
        mode: "strict",
        typeSymbol: `@dsh-task/typed-decisions#${method}Result`,
        create: () => ({
          parse(value) {
            if (
              method === "page"
                ? typeof value !== "string"
                : !value || typeof value !== "object"
            )
              throw Error("Invalid decision settings response");
            return value;
          },
        }),
      },
    }));
    function openSection(ctx, id) {
      const shell = ctx.slots
        .entries?.("sidebar.settings")
        .find((e) => e.store)
        ?.store.create();
      if (!shell?.actions?.openSection) return false;
      shell.actions.openSection(id);
      return true;
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
    function fitContentFrame(frame, height) {
      if (frame.current && Number.isFinite(height) && height >= 0)
        frame.current.style.height = `${Math.min(1000000, Math.max(500, Math.ceil(height)))}px`;
    }
    function Page({ invoke, models }) {
      const frame = React.useRef(null),
        [html, setHtml] = React.useState(null),
        [failed, setFailed] = React.useState(false);
      React.useEffect(() => {
        let active = true;
        invoke("page").then(
          (v) => {
            if (active) setHtml(v.replace("<html ", `<html data-theme="${hostTheme()}" `));
          },
          () => {
            if (active) setFailed(true);
          },
        );
        return () => {
          active = false;
        };
      }, [invoke]);
      React.useEffect(() => {
        const listener = async (event) => {
          if (
            event.source !== frame.current?.contentWindow ||
            event.data?.channel !== "dsh-decision-settings" ||
            !["view", "command", "models", "height"].includes(event.data.method)
          )
            return;
          const { id, method, input } = event.data;
          if (method === "height") {
            fitContentFrame(frame, input);
            return;
          }
          try {
            const value =
              method === "models"
                ? { opened: models() }
                : await invoke(method, input);
            event.source.postMessage(
              { channel: "dsh-decision-settings", id, value },
              "*",
            );
          } catch (error) {
            event.source.postMessage(
              {
                channel: "dsh-decision-settings",
                id,
                error:
                  error?.code === "decision/settings"
                    ? error.details?.reason
                    : "DECISION_SERVICE_UNAVAILABLE",
              },
              "*",
            );
          }
        };
        window.addEventListener("message", listener);
        return () => window.removeEventListener("message", listener);
      }, [invoke, models]);
      React.useEffect(() => html ? watchTheme(frame, "dsh-decision-settings") : undefined, [html]);
      if (failed)
        return h(
          "p",
          { role: "alert" },
          "决策设置加载失败，请重新连接后重试。",
        );
      if (!html) return h("p", null, "正在读取决策设置…");
      return h("iframe", {
        ref: frame,
        title: "决策设置",
        srcDoc: html,
        onLoad: () => sendTheme(frame, "dsh-decision-settings"),
        sandbox: "allow-scripts allow-forms allow-downloads",
        style: {
          display: "block",
          width: "100%",
          minWidth: 0,
          height: 650,
          border: 0,
          colorScheme: "inherit",
        },
      });
    }
    const responsiveStyles = `@media (max-width:640px) {
      [role="dialog"]:has(iframe[title="决策设置"], [data-task-plugin-settings]) { flex-direction:column; width:calc(100vw - 16px); max-width:none; }
      [role="dialog"]:has(iframe[title="决策设置"], [data-task-plugin-settings]) > nav { width:100%; flex:0 0 auto; padding:10px 12px 4px; }
      [role="dialog"]:has(iframe[title="决策设置"], [data-task-plugin-settings]) > nav > div:first-child { margin:0 0 6px; padding:0 4px; }
      [role="dialog"]:has(iframe[title="决策设置"], [data-task-plugin-settings]) > nav > div:last-child { display:flex; flex-direction:row; min-width:0; overflow-x:auto; gap:4px; }
      [role="dialog"]:has(iframe[title="决策设置"], [data-task-plugin-settings]) > nav button { flex:0 0 auto; width:auto; min-height:40px; padding:8px 10px; white-space:nowrap; }
      [role="dialog"]:has(iframe[title="决策设置"], [data-task-plugin-settings]) > div { width:100%; min-width:0; min-height:0; flex:1 1 auto; }
      [role="dialog"]:has(iframe[title="决策设置"], [data-task-plugin-settings]) > div > div:last-child { padding:0 14px 20px; }
    }`;
    async function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement("style");
        style.textContent = responsiveStyles;
        document.head.appendChild(style);
        return () => style.remove();
      });
      ctx.effect(() =>
        ctx.locale.register("typed-decisions", {
          zh: { title: "决策" },
          en: { title: "Decisions" },
        }),
      );
      const unmount = await ctx.remote.$mount({
        package: "@dsh-task/typed-decisions",
        descriptors,
      });
      ctx.effect(() => unmount);
      const invoke = async (method, input) => {
        const service = ctx.get("remote.typedDecisionSettings");
        if (!service?.[method]) throw Error("Decision settings unavailable");
        const result = await service[method](
          ...(method === "command" ? [input] : []),
        );
        if (result?.ok !== true) throw result?.error ?? Error("Invalid result");
        return descriptors
          .find((d) => d.method === method)
          .result.create()
          .parse(result.value);
      };
      const models = () => openSection(ctx, "models");
      const t = ctx.locale.bind("typed-decisions");
      ctx.effect(() =>
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            {
              name: "settings.section",
              id: "typed-decisions",
              order: 29,
              label: () => t("title"),
              locale: "typed-decisions",
              inject: () => ({ invoke, models }),
            },
            Page,
          ),
        ),
      );
    }
    return {
      inject: ["slots", "locale", "remote"],
      apply,
      descriptors,
      Page,
      openSection,
      responsiveStyles,
    };
  },
});
