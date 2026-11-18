import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectChecks, selectBrowserGroups } from '../../scripts/ci/pr-checks.mjs';

test('documentation and CI controller edits require only lightweight safety contracts', () => {
  assert.deepEqual(selectChecks(['docs/DEVELOPMENT.md', 'AGENTS.md', '.github/workflows/ci.yml', 'scripts/ci/pr-checks.mjs']), { build: false, suites: [] });
});
test('UI edits do not run backend/native/distribution acceptance', () => {
  assert.deepEqual(selectChecks(['packages/task-system/src/settings-client.ts']), { build: true, suites: ['browser', 'ui'] });
});
test('backend edits cover core, native integration and official contracts', () => {
  assert.deepEqual(selectChecks(['packages/task-system/src/steward-router.ts']), { build: true, suites: ['core', 'native', 'official'] });
});
test('changed tests select their registered suite', () => {
  assert.deepEqual(selectChecks(['packages/task-system/test/settings.test.mjs']), { build: true, suites: ['ui'] });
});
test('independent consumers select only their own checks', () => {
  assert.deepEqual(selectChecks(['packages/jev/lib/index.js']), { build: true, suites: ['browser', 'jev'] });
  assert.deepEqual(selectChecks(['dashboard/src/index.js']), { build: true, suites: ['browser', 'dashboard'] });
  assert.deepEqual(selectChecks(['packages/feishu-channel/src/index.ts']), { build: true, suites: ['feishu'] });
});
test('shared dependencies and unmapped executable paths cannot skip checks', () => {
  for (const path of ['package-lock.json', 'packages/task-system/dsh.bundle.yml']) {
    const plan = selectChecks([path]);
    assert.equal(plan.build, true);
    for (const suite of ['core', 'native', 'ui', 'official', 'distribution']) assert.ok(plan.suites.includes(suite));
  }
});
test('shipped runtime instructions are executable behavior', () => {
  assert.deepEqual(selectChecks(['packages/task-system/src/project-collaboration/SKILL.md']), { build: true, suites: ['core', 'native', 'official'] });
});
test('unknown ownership has a runnable build smoke fallback and visible paths', () => {
  for (const path of ['new-module/index.mjs', '.gitignore', 'LICENSE']) assert.deepEqual(selectChecks([path]), { build: true, suites: [], unmapped: [path] });
  assert.deepEqual(selectBrowserGroups(['packages/task-system/src/steward-client.js', 'packages/task-system/src/steward-router.ts', '.github/workflows/ci.yml']), ['steward']);
});
test('deployed steward UI edits and distribution scripts select their actual coverage', () => {
  for (const path of ['steward-client.js', 'steward-native-client.js', 'steward-topic-overview.js']) {
    assert.deepEqual(selectChecks(['packages/task-system/src/' + path]), { build: true, suites: ['browser', 'ui'] });
    assert.deepEqual(selectBrowserGroups(['packages/task-system/src/' + path]), ['steward']);
  }
  assert.deepEqual(selectChecks(['tests/dsh/distribution-acceptance.mjs']), { build: true, suites: ['distribution'] });
});
test('workflow keeps PR, ordinary artifacts and formal release verification separate', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /paths-ignore: \['AGENTS\.md', 'README\.md', 'docs\/\*\*'/);
  assert.doesNotMatch(workflow, /'\*\*\/\*\.md'/);
  assert.match(workflow, /github\.event_name, inputs\.operation \|\| 'checks'/);
  for (const job of ['core', 'native', 'ui', 'distribution']) {
    const section = workflow.split(`\n  ${job}:\n`)[1].split(/\n  [a-z][a-z-]*:\n/)[0];
    assert.match(section, /github.event_name == 'workflow_dispatch' && inputs.operation == 'verify'/);
    assert.doesNotMatch(section, /pull_request/);
  }
  assert.match(workflow, /name: PR checks/);
  assert.match(workflow, /github.event_name == 'push' && github.ref == 'refs\/heads\/dev'/);
});
