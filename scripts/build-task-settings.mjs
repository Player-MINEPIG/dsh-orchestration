import { Script } from "node:vm";
import { createRequire } from "node:module";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const operateTheme = readFileSync(new URL("../packages/task-system/src/operate-theme.css", import.meta.url), "utf8");
const withTheme = source => {
  if (!source.includes("/*__TASK_OPERATE_THEME__*/")) throw new Error("Task visual theme placeholder is missing");
  return source.replace("/*__TASK_OPERATE_THEME__*/", () => operateTheme);
};
const settingsClient = readFileSync(new URL("../packages/task-system/src/settings-client.js", import.meta.url), "utf8");
const nativeClient = readFileSync(new URL("../packages/task-system/src/project-native-client.js", import.meta.url), "utf8");
if (!settingsClient.includes("/*__PROJECT_NATIVE_CLIENT__*/")) throw new Error("Project native client placeholder is missing");
const topicOverview = readFileSync(new URL("../packages/task-system/src/steward-topic-overview.js", import.meta.url), "utf8");
const stewardClient = topicOverview + "\n" + readFileSync(new URL("../packages/task-system/src/steward-client.js", import.meta.url), "utf8");
if (!settingsClient.includes("/*__STEWARD_CLIENT__*/")) throw new Error("Steward client placeholder is missing");
const stewardNativeClient = readFileSync(new URL("../packages/task-system/src/steward-native-client.js", import.meta.url), "utf8");
const settingsBundle = withTheme(settingsClient).replace("/*__PROJECT_NATIVE_CLIENT__*/", () => nativeClient).replace("/*__STEWARD_CLIENT__*/", () => stewardClient).replace("/*__STEWARD_NATIVE_CLIENT__*/", () => stewardNativeClient);
new Script(settingsBundle, { filename: "settings-client.js" });
writeFileSync(new URL("../packages/task-system/dist/settings-client.js", import.meta.url), settingsBundle);

const require = createRequire(
  new URL("../packages/task-system/package.json", import.meta.url),
);
const markdownBrowser = readFileSync(
  require.resolve("markdown-it/browser"),
  "utf8",
).replace(/<\/script/gi, "<\\/script");
const page = readFileSync(
  new URL("../packages/task-system/src/project-page.html", import.meta.url),
  "utf8",
);
const projectHtml = withTheme(page).replace("/*__TASK_MARKDOWN__*/", () => markdownBrowser);
function validateInlineScripts(html, label) {
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g))
    new Script(match[1], { filename: label });
}
validateInlineScripts(projectHtml, "project-page.html");
writeFileSync(new URL("../packages/task-system/dist/project-page.html", import.meta.url), projectHtml);

// Ship the session-scoped skill with the plugin; no global harness files are written.
copyFileSync(
  new URL("../packages/task-system/src/project-collaboration/SKILL.md", import.meta.url),
  new URL("../packages/task-system/dist/project-collaboration/SKILL.md", import.meta.url),
);

const workflowPage = readFileSync(new URL("../packages/task-system/src/workflow-page.html", import.meta.url), "utf8");
const workflowClient = readFileSync(new URL("../packages/task-system/src/workflow-ui.js", import.meta.url), "utf8").replace(/<\/script/gi, "<\\/script");
if (!workflowPage.includes("/*__WORKFLOW_UI__*/")) throw new Error("Workflow editor script placeholder is missing");
const workflowHtml = withTheme(workflowPage).replace("/*__WORKFLOW_UI__*/", () => workflowClient);
validateInlineScripts(workflowHtml, "workflow-page.html");
writeFileSync(new URL("../packages/task-system/dist/workflow-page.html", import.meta.url), workflowHtml);
