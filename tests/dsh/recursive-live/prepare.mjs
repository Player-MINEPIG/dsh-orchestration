/** Prepare a fresh isolated test runtime. Does not copy credentials or contact the VPS. */
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  cpSync,
  copyFileSync,
} from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { liveConfiguration } from "./config.mjs";
const config = liveConfiguration(),
  { root, workspace } = config;
const codexHome = resolve(
  process.env.DSH_RECURSIVE_CODEX_HOME || join(root, "codex-home"),
);
const auth = resolve(
  process.env.DSH_RECURSIVE_AUTH_REFERENCE ||
    join(homedir(), ".codex/auth.json"),
);
for (const file of [
  join(root, "coordinator.sqlite"),
  join(root, "worker.sqlite"),
  join(root, "mbp-private.pem"),
  join(codexHome, "config.toml"),
  join(codexHome, "auth.json"),
])
  if (existsSync(file))
    throw new Error(
      "Preparation requires a fresh runtime/profile; existing file: " + file,
    );
if (!existsSync(auth))
  throw new Error("Read-only Codex authentication reference is missing");
mkdirSync(workspace, { recursive: true });
mkdirSync(codexHome, { recursive: true });
symlinkSync(auth, join(codexHome, "auth.json"));
writeFileSync(
  join(codexHome, "config.toml"),
  'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\nsandbox_mode = "read-only"\napproval_policy = "never"\ncli_auth_credentials_store = "file"\n',
);
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
writeFileSync(
  join(root, "mbp-private.pem"),
  privateKey.export({ format: "pem", type: "pkcs8" }),
  { mode: 0o600 },
);
writeFileSync(
  join(root, "mbp-public.pem"),
  publicKey.export({ format: "pem", type: "spki" }),
);
writeFileSync(join(root, "mbp-workspace.txt"), workspace + "\n");
const protectedFiles = [
  auth,
  join(codexHome, "auth.json"),
  join(homedir(), ".codex/config.toml"),
].map((p) => "(literal " + JSON.stringify(p) + ")");
const protectedRoots = [
  join(homedir(), ".dsh"),
  "/Users/pmp/AI/deepseek-harness/workspace/dsh-tavern-v3-pv",
].map((p) => "(subpath " + JSON.stringify(p) + ")");
writeFileSync(
  join(root, "readonly-test.sb"),
  "(version 1)\n(allow default)\n(deny file-write* " +
    [...protectedFiles, ...protectedRoots].join(" ") +
    ")\n",
);
const bundle = join(root, "coordinator-bundle");
mkdirSync(join(bundle, "tests/dsh/recursive-live"), { recursive: true });
cpSync(
  resolve("packages/task-system/dist"),
  join(bundle, "packages/task-system/dist"),
  { recursive: true },
);
copyFileSync(
  resolve("tests/dsh/recursive-live/coordinator.mjs"),
  join(bundle, "tests/dsh/recursive-live/coordinator.mjs"),
);
for (const name of ["mbp-public.pem", "mbp-workspace.txt"])
  copyFileSync(join(root, name), join(bundle, name));
writeFileSync(
  join(bundle, "package.json"),
  JSON.stringify(
    {
      private: true,
      type: "module",
      dependencies: { ajv: "8.17.1", "cron-parser": "5.4.0", zod: "4.6.5" },
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    runtimeRoot: root,
    workspace,
    codexHome,
    commandsEndpoint: config.endpoint.href,
    snapshotEndpoint: config.snapshotEndpoint.href,
    bundle,
    authentication: "read-only symlink; no credential copy",
  }),
);
