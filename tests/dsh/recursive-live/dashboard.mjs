import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDashboardServer } from "../../../dashboard/server.mjs";
const snapshotPath = resolve(
  process.env.DSH_RECURSIVE_SNAPSHOT ||
    ".runtime/recursive-live/evidence/vps-snapshot.json",
);
const port = Number(process.env.DSH_RECURSIVE_DASHBOARD_PORT || 43173);
const server = createDashboardServer({
  snapshot: () => JSON.parse(readFileSync(snapshotPath, "utf8")),
  config: { refreshIntervalMs: 15000 },
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Recursive ledger dashboard http://127.0.0.1:${port}/#delegation · snapshot ${snapshotPath}`,
  ),
);
