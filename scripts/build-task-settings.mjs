import { createRequire } from "node:module";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
copyFileSync(
  fileURLToPath(
    new URL("../packages/task-system/src/settings-client.js", import.meta.url),
  ),
  fileURLToPath(
    new URL("../packages/task-system/dist/settings-client.js", import.meta.url),
  ),
);

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
writeFileSync(
  new URL("../packages/task-system/dist/project-page.html", import.meta.url),
  page.replace("/*__TASK_MARKDOWN__*/", () => markdownBrowser),
);
