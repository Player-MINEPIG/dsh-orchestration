import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const taskSuites = JSON.parse(readFileSync(new URL('../../tests/ci/suites.json', import.meta.url)));
const isDocumentation = path => /^(AGENTS\.md|README\.md|docs\/|\.codex\/|packages\/[^/]+\/(README\.md|docs\/))/.test(path);
const productSuites = ['core', 'native', 'official', 'ui', 'browser', 'jev', 'dashboard', 'task-pack', 'management'];
export function selectChecks(paths) {
  const selected = new Set();
  let build = false;
  const unmapped = [];
  for (const path of paths) {
    // Package documentation is shipped, but does not change executable behavior.
    if (isDocumentation(path)) continue;
    if (/^(scripts\/ci\/|tests\/ci\/|\.github\/)/.test(path) && !/browser|runtime-install|task-tests|suites\.json/.test(path)) continue;
    if (/^tests\/dsh\/(distribution-acceptance|capability-distribution|cli-.*probe)\.mjs$/.test(path)) { selected.add('distribution'); build = true; continue; }
    const testSuite = Object.keys(taskSuites).find(suite => taskSuites[suite].includes(path));
    if (testSuite) { selected.add(testSuite); build = true; continue; }
    if (path.startsWith('packages/feishu-channel/')) { selected.add('feishu'); build = true; continue; }
    if (path.startsWith('packages/jev/')) { selected.add('jev'); selected.add('browser'); build = true; continue; }
    if (path.startsWith('dashboard/')) { selected.add('dashboard'); selected.add('browser'); build = true; continue; }
    if (/^(task-pack\/|tests\/legacy\/|scripts\/build-task-pack)/.test(path)) { selected.add('task-pack'); build = true; continue; }
    if (path.startsWith('tests/management/')) { selected.add('management'); build = true; continue; }
    if (/^(tests\/settings\/|tests\/ci\/browser|scripts\/build-task-settings)/.test(path) || /^packages\/task-system\/src\/.*(settings-client|page|view|panel|presentation|progress-client|steward-client|steward-native-client|project-native-client|steward-topic-overview)/.test(path)) {
      selected.add('ui'); selected.add('browser'); build = true; continue;
    }
    if (/^(packages\/task-system\/src\/|packages\/task-system\/test\/|tests\/dsh\/)/.test(path)) {
      for (const suite of ['core', 'native', 'official']) selected.add(suite);
      build = true; continue;
    }
    // Shared dependency/build changes span modules. New ownership starts with a build smoke check.
    if (!/^(package(-lock)?\.json|packages\/task-system\/(package\.json|tsconfig\.json|dsh\.bundle\.yml|remote\.patch\.yml)|tests\/fixtures\/|scripts\/(build-|ci\/(runtime-install|task-tests))|tests\/ci\/suites\.json)/.test(path)) {
      unmapped.push(path); build = true; continue;
    }
    for (const suite of productSuites) selected.add(suite);
    selected.add('distribution');
    build = true;
  }
  return { build, suites: [...selected].sort(), ...(unmapped.length ? { unmapped } : {}) };
}

export function selectBrowserGroups(paths) {
  const groups = new Set();
  for (const path of paths) {
    if (!selectChecks([path]).suites.includes('browser')) continue;
    if (/packages\/jev\/|dashboard\//.test(path)) groups.add('remaining active frontend');
    else if (/steward/.test(path)) groups.add('steward');
    else if (/settings-client|browser-settings/.test(path)) groups.add('settings');
    else if (/project-page|project-native-client/.test(path)) for (const group of ['project', 'executor', 'check-ins', 'task center', 'remaining active']) groups.add(group);
    else return []; // Shared UI/build changes retain complete browser coverage.
  }
  return [...groups];
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event.pull_request;
  assert.ok(pr, 'PR checks require a pull request');
  for (const sha of [pr.base.sha, pr.head.sha]) assert.match(sha, /^[a-f0-9]{40}$/);
  // Include removed and renamed paths, and the complete merge-base diff (no API pagination limit).
  const paths = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${pr.base.sha}...${pr.head.sha}`], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const plan = selectChecks(paths);
  console.log(JSON.stringify({ paths, ...plan, browserGroups: selectBrowserGroups(paths) }, null, 2));
  if (plan.unmapped) console.warn(`Unmapped paths use build smoke checks; review applicable verification: ${plan.unmapped.join(', ')}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `PR checks: CI contracts always; build=${plan.build}; suites=${plan.suites.join(', ') || 'none (documentation/CI only)'}\n`);
  run(process.execPath, ['--test', ...execFileSync('git', ['ls-files', 'tests/ci/*.test.mjs'], { encoding: 'utf8' }).trim().split('\n')]);
  if (plan.build || plan.suites.length) run('npm', ['ci', '--ignore-scripts']);
  if (plan.build) { run('npm', ['run', 'build']); run('npm', ['run', 'build:fixtures']); }
  if (plan.suites.some(suite => ['native', 'official', 'browser', 'distribution'].includes(suite))) run('npm', ['run', 'setup:runtime']);
  process.env.DSH_BROWSER_GROUPS = JSON.stringify(selectBrowserGroups(paths));
  for (const suite of plan.suites) run('npm', ['run', `test:${suite}`]);
}
