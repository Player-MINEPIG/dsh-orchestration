#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
mkdir -p .runtime/registration
npm run check > .runtime/registration/check.log 2>&1
node --check dashboard/public/registration-ui.js
node --check dashboard/public/app.js
git diff --check
