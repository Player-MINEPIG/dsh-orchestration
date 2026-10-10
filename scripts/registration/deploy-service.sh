#!/bin/sh
# Update only this task's isolated service; preserve run databases and receipts.
set -eu
DEST=/root/dsh-orchestration-tests/project-registration-20261011
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
COPYFILE_DISABLE=1 tar --no-xattrs -czf .runtime/registration/service-package.tgz packages/task-system/dist scripts/registration dashboard
scp .runtime/registration/service-package.tgz "aliyun-vps:$DEST/service-package.tgz"
ssh aliyun-vps "cd '$DEST' && tar -xzf service-package.tgz && node scripts/registration/restart-service.mjs"
