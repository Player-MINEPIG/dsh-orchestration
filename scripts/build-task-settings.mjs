import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
copyFileSync(
  fileURLToPath(
    new URL("../packages/task-system/src/settings-client.js", import.meta.url),
  ),
  fileURLToPath(
    new URL("../packages/task-system/dist/settings-client.js", import.meta.url),
  ),
);
