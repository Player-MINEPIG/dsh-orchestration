#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AWS_HOST="${AWS_HOST:-aws-vps}"
AWS_PROFILE="${AWS_PROFILE:-/home/ubuntu/.dsh/profiles/web/package.json}"
MBP_PROFILE="${MBP_PROFILE:-/Users/pmp/.dsh/profiles/web/package.json}"
AWS_NODE="${AWS_NODE:-/usr/local/bin/node}"
MBP_NODE="${MBP_NODE:-/Users/pmp/.hermes/node/bin/node}"
AWS_RUNTIME_ENTRY="${AWS_RUNTIME_ENTRY:-/usr/local/bin/dsh}"
MBP_RUNTIME_ENTRY="${MBP_RUNTIME_ENTRY:-/Users/pmp/.local/bin/dsh}"
EXPECTED_VERSION="${EXPECTED_VERSION:-0.2.40}"
REAL_COORDINATOR="${REAL_COORDINATOR:-0}"
REAL_ARGS=""
if [ "$REAL_COORDINATOR" = 1 ]; then REAL_ARGS="--real-coordinator"; fi
RUN_ROOT="$(mktemp -d /private/tmp/dsh-physical-return.XXXXXX)"
TAG="$(basename "$RUN_ROOT")"
REMOTE_ROOT="/tmp/$TAG"
MARKER="DSH-PHYSICAL-RETURN-$TAG"
SOCKET="$RUN_ROOT/tunnel.sock"
TUNNEL_OPEN=0
cleanup() {
  rm -f "$RUN_ROOT/worker-private.pem"
  ssh -o BatchMode=yes "$AWS_HOST" "test ! -d '$REMOTE_ROOT/run' || { touch '$REMOTE_ROOT/run/stop'; rm -f '$REMOTE_ROOT/run/worker-private.pem'; }" >/dev/null 2>&1 || true
  if [ "$TUNNEL_OPEN" = 1 ]; then ssh -S "$SOCKET" -O exit "$AWS_HOST" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT INT TERM
ssh -o BatchMode=yes "$AWS_HOST" "umask 077; mkdir '$REMOTE_ROOT'"
scp -q -o BatchMode=yes "$SCRIPT_DIR/task-return-host-smoke.mjs" "$AWS_HOST:$REMOTE_ROOT/task-return-host-smoke.mjs"
ssh -o BatchMode=yes "$AWS_HOST" "umask 077; nohup '$AWS_NODE' --expose-internals '$REMOTE_ROOT/task-return-host-smoke.mjs' coordinator --profile '$AWS_PROFILE' --runtime-entry '$AWS_RUNTIME_ENTRY' --dir '$REMOTE_ROOT/run' --expected-version '$EXPECTED_VERSION' --marker '$MARKER' $REAL_ARGS > '$REMOTE_ROOT/coordinator.log' 2>&1 < /dev/null & echo \$! > '$REMOTE_ROOT/pid'"
READY=0
for _ in $(seq 1 30); do
  if ssh -o BatchMode=yes "$AWS_HOST" "test -f '$REMOTE_ROOT/run/ready.json'"; then READY=1; break; fi
  if ssh -o BatchMode=yes "$AWS_HOST" "test -f '$REMOTE_ROOT/run/result.json'"; then break; fi
  if ! ssh -o BatchMode=yes "$AWS_HOST" "test -s '$REMOTE_ROOT/pid' && kill -0 \$(cat '$REMOTE_ROOT/pid') 2>/dev/null"; then break; fi
  sleep 1
done
if [ "$READY" != 1 ]; then ssh -o BatchMode=yes "$AWS_HOST" "cat '$REMOTE_ROOT/run/result.json' '$REMOTE_ROOT/coordinator.log' 2>/dev/null"; exit 1; fi
scp -q -o BatchMode=yes "$AWS_HOST:$REMOTE_ROOT/run/ready.json" "$RUN_ROOT/aws-ready.json"
scp -q -o BatchMode=yes "$AWS_HOST:$REMOTE_ROOT/run/worker-private.pem" "$RUN_ROOT/worker-private.pem"
chmod 600 "$RUN_ROOT/worker-private.pem"
REMOTE_PORT="$("$MBP_NODE" -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).port" "$RUN_ROOT/aws-ready.json")"
LOCAL_PORT="$("$MBP_NODE" -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")"
ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -M -S "$SOCKET" -fnNT -L "127.0.0.1:$LOCAL_PORT:127.0.0.1:$REMOTE_PORT" "$AWS_HOST"
TUNNEL_OPEN=1
"$MBP_NODE" --expose-internals "$SCRIPT_DIR/task-return-host-smoke.mjs" executor --profile "$MBP_PROFILE" --runtime-entry "$MBP_RUNTIME_ENTRY" --dir "$RUN_ROOT/mbp" --expected-version "$EXPECTED_VERSION" --marker "$MARKER" --endpoint "http://127.0.0.1:$LOCAL_PORT/commands" --key-file "$RUN_ROOT/worker-private.pem" --delay-ms 4000
DONE=0
for _ in $(seq 1 20); do
  if ssh -o BatchMode=yes "$AWS_HOST" "test -f '$REMOTE_ROOT/run/result.json'"; then DONE=1; break; fi
  sleep 1
done
if [ "$DONE" != 1 ]; then ssh -o BatchMode=yes "$AWS_HOST" "cat '$REMOTE_ROOT/coordinator.log'"; exit 1; fi
scp -q -o BatchMode=yes "$AWS_HOST:$REMOTE_ROOT/run/result.json" "$RUN_ROOT/aws-result.json"
"$MBP_NODE" --input-type=module - "$RUN_ROOT/aws-result.json" "$RUN_ROOT/mbp/result.json" "$RUN_ROOT" "$REMOTE_ROOT" <<'JS'
import assert from 'node:assert/strict';import{readFileSync,writeFileSync}from'node:fs';import{join}from'node:path';
const [awsFile,mbpFile,root,remoteRoot]=process.argv.slice(2),aws=JSON.parse(readFileSync(awsFile)),mbp=JSON.parse(readFileSync(mbpFile));
assert.equal(aws.status,'passed');assert.equal(mbp.status,'passed');assert.notEqual(aws.host,mbp.host);assert.equal(aws.childRunId,mbp.execution.runId);assert.equal(aws.marker,mbp.marker);assert.equal(aws.parentState,'succeeded');assert.equal(aws.returnState,'completed');
const evidence={status:'passed',physicalHosts:true,modelBoundary:aws.modelBoundary,installedVersion:aws.installedVersion,awsHost:aws.host,mbpHost:mbp.host,awsEvidence:awsFile,mbpEvidence:mbpFile,remoteRoot,observations:aws.observations,parentState:aws.parentState,childState:aws.childState,returnState:aws.returnState,runCount:aws.runCount,attemptCount:aws.attemptCount,resultEvents:aws.resultEvents};
writeFileSync(join(root,'physical-evidence.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({...evidence,evidence:join(root,'physical-evidence.json')},null,2));
JS
