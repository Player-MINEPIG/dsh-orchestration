#!/bin/sh
# Explicitly authorized isolated deployment. No default DSH / Hermes paths.
set -eu
REMOTE=aliyun-vps
DEST=/root/dsh-orchestration-tests/project-registration-20261011
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
test -f .runtime/registration/pv/pv-registration.json
COPYFILE_DISABLE=1 tar --no-xattrs -czf .runtime/registration/vps-package.tgz packages/task-system/dist packages/task-system/test/fixtures scripts/registration dashboard packages/task-system/test/project-registration.test.mjs
ssh "$REMOTE" "mkdir -p '$DEST/pv' '$DEST/npm-cache'"
scp .runtime/registration/vps-package.tgz "$REMOTE:$DEST/package.tgz"
scp .runtime/registration/pv/pv-registration.json "$REMOTE:$DEST/pv/pv-registration.json"
ssh "$REMOTE" "cd '$DEST' && tar -xzf package.tgz && npm install --prefix '$DEST' --cache '$DEST/npm-cache' --ignore-scripts --no-audit --no-fund ajv@8.17.1 cron-parser@5.4.0 zod@4.6.5 > runtime-install.log 2>&1 && node scripts/registration/vps-smoke.mjs '$DEST'" > .runtime/registration/vps-http-evidence.json
cat .runtime/registration/vps-http-evidence.json
