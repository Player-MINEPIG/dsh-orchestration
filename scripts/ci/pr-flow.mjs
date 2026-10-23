import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function checkPullRequestRoute(event, { eventName, repository }) {
  if (eventName !== 'pull_request') throw new Error('PR routing only applies to pull_request events.');
  const pr = event.pull_request;
  if (!pr || !repository) throw new Error('PR routing requires a pull request and repository identity.');
  if (pr.head?.repo?.full_name !== repository || pr.base?.repo?.full_name !== repository) {
    throw new Error('Long-lived branch PRs must use branches from this repository.');
  }
  const head = pr.head.ref;
  const base = pr.base.ref;
  if (base === 'dev' && head && head !== 'dev' && head !== 'main') return `Accepted route: ${head} → dev.`;
  throw new Error('Open feature PRs to dev. Release main through the verified fast-forward promotion workflow, not a PR.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  console.log(checkPullRequestRoute(event, {
    eventName: process.env.GITHUB_EVENT_NAME,
    repository: process.env.GITHUB_REPOSITORY,
  }));
}
