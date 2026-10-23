import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPullRequestRoute } from '../../scripts/ci/pr-flow.mjs';

const repository = 'Player-MINEPIG/dsh-orchestration';
const context = { eventName: 'pull_request', repository };
function event(head, base, headRepository = repository) {
  return { pull_request: { head: { ref: head, repo: { full_name: headRepository } }, base: { ref: base, repo: { full_name: repository } } } };
}

test('feature PR enters dev', () => assert.match(checkPullRequestRoute(event('codex/feature', 'dev'), context), /Accepted route/));
test('main sync is unnecessary and cannot enter dev', () => assert.throws(() => checkPullRequestRoute(event('main', 'dev'), context), /Open feature PRs to dev/));
test('dev cannot bypass the release workflow with a main PR', () => assert.throws(() => checkPullRequestRoute(event('dev', 'main'), context), /fast-forward promotion/));
test('direct feature PR to main is rejected', () => assert.throws(() => checkPullRequestRoute(event('codex/feature', 'main'), context), /Open feature PRs to dev/));
test('a fork dev branch cannot impersonate the candidate', () => assert.throws(() => checkPullRequestRoute(event('dev', 'main', 'someone/fork'), context), /this repository/));
test('a fork feature cannot enter dev', () => assert.throws(() => checkPullRequestRoute(event('feature', 'dev', 'someone/fork'), context), /this repository/));
test('missing PR data fails closed', () => assert.throws(() => checkPullRequestRoute({}, context), /requires a pull request/));
test('non-PR events cannot produce an accepted route', () => assert.throws(() => checkPullRequestRoute({}, { eventName: 'push', repository }), /only applies to pull_request/));
