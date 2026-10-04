"""Refresh unverified source-linked design drafts from reviewed symbol locations.

This records local file bytes. It neither asserts nor bypasses Archify Git evidence.
Run from any directory after re-reading semantic changes; symbol discovery is not review.
"""
import argparse, datetime, hashlib, json, re
from pathlib import Path
ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parents[1]
args = argparse.ArgumentParser()
args.add_argument('--freeze-note', default=None, help='Lead-confirmed source-freeze note; not Git provenance')
options = args.parse_args()
cache = {}
def data(path):
    if path not in cache:
        cache[path] = (PROJECT / path).read_bytes()
    return cache[path]
def ref(path, pattern, label):
    lines = data(path).decode().splitlines()
    hits = [i + 1 for i, line in enumerate(lines) if re.search(pattern, line)]
    if not hits:
        raise ValueError((path, pattern))
    return {'path': path, 'line': hits[0], 'label': label + '；本地源码，未通过 Git 来源门'}
L = 'packages/task-system/src/ledger.ts'
def ledger(symbol):
    return ref(L, r'^  (?:private )?' + re.escape(symbol) + r'(?:<[^>]+>)?\(', symbol)
def document(code):
    return ref('docs/architecture/sources.md', r'^- ' + code + r' ', '设计/源码边界 ' + code)
dsh = ref('packages/task-system/src/dsh-plugin.ts', r'^export (?:async )?function apply', 'native apply')
native_summary = ref('packages/task-system/src/dsh-plugin.ts', r'^  private missingResultSummary\(', 'safe owned-terminal error summary')
worker = ref('packages/remote-execution/src/worker.ts', r'^  private async executeOwned', '实例绑定先于 provider effects')
pack = ref('examples/legacy-task-pack/index.mjs', r'^export function registerLegacyTaskPack', 'trusted semantic validators')
prepare = ref('examples/legacy-task-pack/index.mjs', r'^export function prepareLegacyReport', 'prepare / finalized artifact')
collab = ref('packages/remote-execution/src/collaboration.ts', r'^export function bindCollaboration', 'lease-bound scoped collaboration')
target = {
    'supervisor': [document('T01')], 'host_runtime': [dsh, ref('packages/remote-execution/src/index.ts', r'^export async function apply', 'host-owned carrier lifecycle')],
    'channel_ingress': [ref('packages/feishu-channel/src/dsh-chat.ts', r'^export class FeishuChatService', 'native chat ownership'), document('N14')],
    'new_template': [ledger('fireSchedule'), ledger('pendingRuns')],
    'task_management': [dsh, ledger('respondApproval'), ledger('reconcileNodeHealth')],
    'execution': [worker, ledger('markRunning'), ref('packages/remote-execution/src/trusted-network.ts', r'^export class TrustedNetworkVerifier', 'explicit transport-auth alternative')],
    'new_decision': [ref('packages/typed-decisions/src/dsh-completion.ts', r'^export class DshCompletionService', 'native one-shot model bridge')],
    'task_ledger': [ledger('command'), ledger('submit')],
    'new_workspace': [ref('packages/task-system/src/workspaces.ts', r'^export class WorkspaceManager', 'physical workspace provision')],
    'task_view': [ref('dashboard/server.mjs', r'^export function createDashboardHandler', 'same-ledger read-only query'), ref('dashboard/access.mjs', r'^export function createAccessAuthorizer', 'optional fixed owner JWT gate'), ref('dashboard/live-server.mjs', r'^export function liveConfiguration', 'loopback live origin config')],
    'new_task_pack': [pack, ref('examples/legacy-task-pack/plugin.mjs', r'^export function apply', 'native task-pack integration'), ref('examples/legacy-task-pack/quota/plugin.mjs', r'^export function createQuotaPlugin', 'optional quota host lifecycle')],
    'new_terminal_journal': [ref('packages/task-system/src/native-result-journal.ts', r'^export class NativeResultJournal', 'independent terminal journal'), ledger('recoverSettlement'), document('N22')],
}
task = {
    'objective': [ledger('newTask')],
    'admit': [ledger('newRun'), ledger('claim'), ledger('setTaskConfirmation')],
    'active': [ledger('markRunning'), collab, native_summary],
    'settle': [ledger('submit'), ledger('allSettled'), ledger('executionScope')],
    'history': [ledger('history'), ledger('setTaskAdmission')],
    'wait': [ledger('recoverExpired')], 'cancel': [ledger('acknowledgeCancellation')],
    'approval': [ref('packages/task-system/src/approval-bridge.ts', r'^export function apply', 'native runtime approval bridge'), ledger('respondApproval')],
    'safe_retry': [ref('packages/task-system/src/native-retry.ts', r'^export class NativeRetryObservation', 'bounded retry evidence'), ledger('retryBeforeEffects')],
    'closed_retry': [ref('packages/task-system/src/native-retry.ts', r'^export class NativeRetryObservation', 'opt-in reviewed tool continuation'), ledger('retryBeforeEffects')],
    'ready': [ref('packages/task-system/src/native-result-journal.ts', r'^export class NativeResultJournal', 'independent terminal ready record'), ledger('recoverSettlement')],
}
report = {
    'author': [ledger('note'), prepare, native_summary], 'identity': [ledger('command')],
    'append': [ledger('appendReport'), ledger('newRun')], 'view': [ledger('snapshot')],
    'review': [ledger('history')], 'correction': [ledger('report')],
    'replay': [ledger('command')], 'conflict': [ledger('command')],
}
for name, mapping in [('target', target), ('task-lifecycle', task), ('report-lifecycle', report)]:
    candidate = json.loads((ROOT / name / 'candidate.json').read_text())
    for node in candidate.get('components', candidate.get('states', [])):
        node['sources'] = mapping[node['id']]
    (ROOT / name / 'repository-draft.json').write_text(json.dumps(candidate, ensure_ascii=False, indent=2) + '\n')
for path in [
    'packages/task-system/src/contracts.ts', 'packages/task-system/src/planning.ts',
    'packages/task-system/src/observer-dsh.ts', 'packages/task-system/package.json',
    'packages/feishu-channel/package.json', 'packages/remote-execution/package.json',
    'packages/typed-decisions/package.json',
    'packages/task-system/README.md', 'packages/remote-execution/README.md',
    'packages/feishu-channel/README.md', 'packages/typed-decisions/README.md',
    'packages/remote-execution/src/trusted-network.ts', 'packages/remote-execution/src/network-client.ts',
    'packages/remote-execution/src/observation.ts', 'packages/remote-execution/src/index.ts',
    'packages/remote-execution/src/store.ts', 'packages/remote-execution/src/gateway.ts',
    'packages/remote-execution/src/client.ts', 'packages/remote-execution/src/http.ts',
    'packages/remote-execution/src/protocol.ts', 'packages/feishu-channel/src/dsh-plugin.ts',
    'examples/legacy-task-pack/readers/common.mjs', 'examples/legacy-task-pack/readers/index.mjs',
    'examples/legacy-task-pack/reporting.mjs', 'scripts/build-task-pack.mjs',
    'packages/task-system/src/native-result-journal.ts', 'packages/task-system/src/native-retry.ts',
    'packages/task-system/src/approval-bridge.ts', 'packages/remote-execution/src/retry.ts',
    'packages/remote-execution/src/ports.ts', 'packages/feishu-channel/src/cards.ts',
    'examples/legacy-task-pack/configured-sources.mjs', 'examples/legacy-task-pack/ad-hoc.mjs',
    'examples/legacy-task-pack/diagnostics/index.mjs', 'examples/legacy-task-pack/compatibility/index.mjs',
    'examples/legacy-task-pack/readers/daily.mjs', 'examples/legacy-task-pack/readers/automas.mjs',
    'examples/legacy-task-pack/readers/game.mjs', 'examples/legacy-task-pack/readers/time.mjs',
    'examples/legacy-task-pack/quota/plugin.mjs', 'examples/legacy-task-pack/quota/providers.mjs',
    'examples/legacy-task-pack/quota/monitor.mjs', 'examples/legacy-task-pack/quota/store.mjs',
    'examples/legacy-task-pack/quota/reader.mjs',
    'dashboard/access.mjs', 'dashboard/live-server.mjs', 'dashboard/public/client.js',
    'dashboard/public/app.js', 'dashboard/public/model.js', 'dashboard/package.json', 'package-lock.json',
]:
    data(path)
snapshot = {
    'kind': 'unverified-working-tree-read-snapshot',
    'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'repositoryProvenance': False, 'sourceFreezeNote': options.freeze_note,
    'files': [{'path': p, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)} for p, raw in sorted(cache.items())],
}
(ROOT / 'source-snapshot.json').write_text(json.dumps(snapshot, indent=2) + '\n')
print(json.dumps({'files': len(cache), 'sourceFreezeNote': options.freeze_note, 'repositoryProvenance': False}))
