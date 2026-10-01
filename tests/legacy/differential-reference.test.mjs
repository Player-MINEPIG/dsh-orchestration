import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { buildAgentDaily, validateAgentDaily, validateGameDaily, buildNodeReport } from '../../examples/legacy-task-pack/index.mjs';
import { dailyInput, gameReport, collectorEvidence } from './synthetic-fixtures.mjs';

// Deliberately reference-only. No original code/fixtures are copied or required
// by the distributed task pack or its credential-free synthetic acceptance.
const reference = process.env.DSH_LEGACY_REFERENCE_ROOT;
const script = `
import importlib.util,json,pathlib,sys
root=pathlib.Path(sys.argv[1]); request=json.load(sys.stdin)
files={
 'agent':'plugins/hermes_monitor/hermes_monitor_plugin/agent_daily_report.py',
 'game':'plugins/hermes_monitor/hermes_monitor_plugin/game_daily_report.py',
 'node':'plugins/hermes_monitor/hermes_monitor_plugin/agent_daily_node_report.py',
}
spec=importlib.util.spec_from_file_location('reference_contract',root/files[request['kind']]);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
functions={'agent':'validate_agent_report','game':'validate_game_report','node':'validate_agent_daily_node_report'}
answer=getattr(module,functions[request['kind']])(request['payload'])
print(json.dumps({'valid':answer['valid'],'errors':answer.get('errors',[])}))
`;
function original(kind, payload) {
  const result = spawnSync(process.env.PYTHON ?? 'python3', ['-B', '-I', '-c', script, resolve(reference)], { input: JSON.stringify({ kind, payload }), encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
test('optional original validators agree on synthetic Agent Daily count/reference verdicts', { skip: !reference }, () => {
  const good = buildAgentDaily(dailyInput()); assert.equal(original('agent', good).valid, true); assert.doesNotThrow(() => validateAgentDaily(good));
  const bad = structuredClone(good); bad.summary.task_counts.total++; assert.equal(original('agent', bad).valid, false); assert.throws(() => validateAgentDaily(bad));
});
test('optional original Game validator agrees on synthetic no-run/evidence/causal verdicts', { skip: !reference }, () => {
  const good = gameReport(); good.report_meta.device_id = 'pc_au'; assert.equal(original('game', good).valid, true); assert.doesNotThrow(() => validateGameDaily(good));
  const bad = structuredClone(good); bad.automations[0].reported_top_level_status = null; assert.equal(original('game', bad).valid, false); assert.throws(() => validateGameDaily(bad));
  const unknownEvidence = structuredClone(good); unknownEvidence.automations[0].tasks[0].evidence_refs = ['unknown']; assert.equal(original('game', unknownEvidence).valid, false); assert.throws(() => validateGameDaily(unknownEvidence));
});
test('optional original node validator accepts independently built synthetic evidence report', { skip: !reference }, () => {
  const report = buildNodeReport({ nodeId: 'mbp', accountMeasurementNodeId: 'mbp', ...collectorEvidence() }); assert.equal(original('node', report).valid, true);
});
