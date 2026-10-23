# Develop on dev; release an exact commit

Keep the primary checkout on `main`. Develop in isolated worktrees from `dev`. Feature PRs enter `dev`; accepted releases fast-forward `main` to the exact tested dev commit and create an annotated version tag. The default branch remains `main`. No workflow deploys to devices or changes their runtime configuration.

## Start a feature

1. Fetch and prune remote refs. Inspect the checkout and relevant worktrees. Preserve existing WIP before switching branches.
2. Compare `origin/dev`, `origin/main`, and the deployed source commit. Record deployed versions and checksums. Recover and commit any deployed source that is missing from Git before developing.
3. Read the current requirements and [CI commands](CI.md). Create a new `codex/` branch and independent worktree from the latest verified `origin/dev`.
4. Implement and verify using GPT-6.1-Sol with High reasoning, as required by [AGENTS.md](../AGENTS.md). Record results and limits.
5. Open a PR to `dev`, review its diff and wait for all required checks. Feature PRs may use squash or merge; rebase merging is disabled.

`dev` requires an up-to-date PR, resolved conversations, `PR flow`, and the Linux Core, Native DSH, UI (UTC), and Installed packages checks. Approval count is zero for a single maintainer. `main` instead requires the `Full CI` and `Release approved` commit statuses from GitHub Actions (app 15368). Administrators are included; both branches prohibit force pushes and deletion. Do not open a release PR to `main` or disable these gates to publish.

The server enforces the required statuses and ref protections; the trusted controller enforces the exact fast-forward and tag transaction. Classic branch protection does not restrict updates to this script. An owner could still select a different merge method for an already approved head in GitHub's UI. Do not do that: a passing status is not permission to create a different main commit.

## Verify a release candidate

1. Record the full `origin/dev` SHA. It must contain current `origin/main`.
2. In **Actions → Current product checks → Run workflow**, select branch `dev`, operation `verify`, and that exact `candidate_sha`. Leave promotion inputs empty. The workflow refuses a SHA that is not the dev head when verification starts.
3. Wait for the full Linux/macOS workflow to succeed. Record its run ID. `Full CI` is written only after every suite and the candidate artifact upload succeed.
4. Download `release-candidate-<SHA>-<run ID>-<attempt>`. Its `candidate.json`, distribution receipts and `packages/` archives bind the tested commit, package versions and SHA-256 checksums. Use these exact archives for acceptance. Do not rebuild or repack them.

Candidate artifacts expire after 30 days. An expired or unsuccessful verification cannot authorize promotion; run verification again and test its preserved package bytes. A successful PR run alone is not full release verification. The workflow also refuses verification dispatched on a feature branch or `main`.

`dev` may continue advancing after verification. Keep the candidate fixed: it must remain an ancestor of `dev` and must contain current `main`. New source or package bytes require new verification and acceptance. If `main` advances beyond this candidate, choose and verify a new candidate rather than rewinding it.

## Record real-device acceptance

Install the preserved archives on the intended real devices and run the agreed checks. Record the device/OS, exact installed package checksums, check results and evidence. Include all intended devices and report missing coverage or failures. Ask the user to explicitly confirm these results and release of this exact candidate and tag.

Prepare `acceptance_json` with the following fields. Copy `packages` unchanged from `candidate.json`, including its array order. For each device, name the packages actually tested using those same hashes; task-system is required on every declared device. Include checks relevant to the candidate. The device scope and evidence must reflect what actually happened.

```json
{
  "schemaVersion": 1,
  "candidateSha": "<40-character tested SHA>",
  "fullCiRunId": 123456,
  "tag": "v<tested task-system version>",
  "packages": ["<copy the package objects from candidate.json>"],
  "devices": [{
    "id": "<device identifier>",
    "platform": "<OS and version>",
    "packages": [{"name": "@dsh-task/task-system", "sha256": "<tested archive hash>"}],
    "checks": [{"name": "<actual check>", "passed": true, "evidence": "<result record or link>"}]
  }],
  "userConfirmation": {
    "by": "<user>",
    "confirmedAt": "<ISO timestamp>",
    "statement": "<explicit confirmation of this candidate and release>",
    "evidence": "<confirmation record or link>"
  }
}
```

This is a shape example, not a valid acceptance record. Do not substitute placeholders or invent a passing check. JSON validation and the workflow's confirmation checkbox are explicit maintainer declarations: CI cannot prove that a physical device was tested or authenticate an external conversation. An agent must obtain the user's actual confirmation before invoking promotion.

## Fast-forward and tag

1. Select branch **main** when manually running the same workflow. Choose `promote`; supply the candidate SHA, successful `verification_run_id`, `tag`, complete `acceptance_json`, and explicit `confirm`.
2. Use `v` followed by the tested `@dsh-task/task-system` version, for example `v0.2.51` for version `0.2.51`. The tag must be new. Bump that package version on `dev` before verifying another release if its tag already exists.
3. The trusted main controller reads candidate manifests as data. It validates the successful same-repository dev dispatch and attempt, immutable artifact, package bytes, acceptance record, current ancestry and tag. It writes `Release approved`, then pushes `main` and the annotated tag in one ordinary `git push --atomic` transaction. It never force pushes. The annotation contains the full candidate manifest and acceptance record.
4. Verify both remote refs and the workflow result. Retrying the same candidate/tag/record converges; an existing tag with different contents is rejected. Version tags matching `v*` prohibit updates and deletion. A concurrent incompatible main update or tag creation makes the atomic push fail without partially changing refs.
5. Fetch and only fast-forward the primary `main` checkout to verified `origin/main`. Report main/dev SHAs, tag, CI run, device evidence and WIP locations.

`main` now identifies the tested commit itself. It remains in `dev` history, so no main-to-dev synchronization PR is needed. There is no automatic release on a PR merge, push, or CI success.

### If the bot cannot push workflow-file changes

The workflow uses the existing `GITHUB_TOKEN`; no new secret or bypass identity is required. GitHub may reject a token push that includes `.github/workflows` changes. The first real release of such a change is the authority on this permission; successful status creation or the owner-driven initialization does not prove bot workflow-write permission.

Use the owner fallback only when the promotion log shows a **push permission rejection after all validation passed**, both required GitHub Actions statuses are successful on that exact candidate, and the `release-record-<SHA>-<promotion run ID>` artifact contains `release-annotation.json`. A failed check, invalid receipt or missing confirmation never qualifies. Preserve the failed run and use its exact annotation; do not rewrite the acceptance record.

From a clean checkout of trusted `main`, with that downloaded annotation in the current directory:

```sh
set -e
git fetch origin main dev
candidate=$(node -p "JSON.parse(require('fs').readFileSync('release-annotation.json')).manifest.candidateSha")
tag=$(node -p "JSON.parse(require('fs').readFileSync('release-annotation.json')).acceptance.tag")
git merge-base --is-ancestor origin/main "$candidate"
git merge-base --is-ancestor "$candidate" origin/dev
if test -n "$(git ls-remote origin "refs/tags/$tag")"; then
  echo "Tag already exists; inspect the original run." >&2
  exit 1
fi
if git show-ref --verify --quiet "refs/tags/$tag"; then
  echo "Local tag already exists; inspect it before continuing." >&2
  exit 1
fi
git tag -a "$tag" "$candidate" -F release-annotation.json
git push --atomic origin "$candidate:refs/heads/main" "refs/tags/$tag:refs/tags/$tag"
```

Use the owner's existing authorized Git credential. Branch/status gates and immutable tag rules still apply; never use `--force`, delete a tag, or relax protection. Confirm that the resulting annotated tag points to the tested SHA and contains the downloaded record. If either ref changed meanwhile, stop and inspect rather than retrying with altered inputs.
