# Develop on dev, deploy to devices, and release an exact commit

Keep the primary checkout on `dev` and fast-forward it only to verified `origin/dev`. Develop in isolated worktrees from `dev`. Feature PRs enter `dev`; accepted releases fast-forward `main` to the exact tested dev commit and create an annotated version tag. The repository default branch remains `main`. GitHub workflows do not deploy to devices or change their runtime configuration. Agent-operated device deployment follows the ordinary deployment procedure below.

## Start a feature

1. Fetch and prune remote refs. Inspect the checkout and relevant worktrees. Preserve existing WIP before switching branches.
2. Compare `origin/dev`, `origin/main`, and the deployed source commit. Record deployed versions and checksums. For documentation-only work, use the latest verified deployment record and honor any exclusion of production access. Recover and commit any deployed source that is missing from Git before developing.
3. Read the current requirements and [CI commands](CI.md). Create a new `codex/` branch and independent worktree from the latest verified `origin/dev`.
4. Implement and verify using GPT-6.1-Sol with High reasoning, as required by [AGENTS.md](../AGENTS.md). Record results and limits.
5. Open a PR to `dev`, review its diff and wait for all required checks. Feature PRs may use squash or merge; rebase merging is disabled.

`dev` requires an up-to-date PR, resolved conversations, `PR flow`, and the Linux Core, Native DSH, UI (UTC), and Installed packages checks. Approval count is zero for a single maintainer. `main` instead requires the `Full CI` and `Release approved` commit statuses from GitHub Actions (app 15368). Administrators are included; both branches prohibit force pushes and deletion. Do not open a release PR to `main` or disable these gates to publish.

The server enforces the required statuses and ref protections; the trusted controller enforces the exact fast-forward and tag transaction. Classic branch protection does not restrict updates to this script. An owner could still select a different merge method for an already approved head in GitHub's UI. Do not do that: a passing status is not permission to create a different main commit.

## Deploy to devices

Treat requests such as “deploy from GitHub” or “update the machines” as ordinary deployment. A formal release requires an explicit release request. Ordinary deployment keeps package versions, `main`, and tags unchanged unless the user separately requests version preparation or release.

Once an update has passed its applicable gates and entered `dev`, automatically attempt ordinary deployment to `aws-vps`, `MBP`, and `PC_AU`, or the targets the user specifies. This standing authorization does not require another deployment question. An explicit exclusion such as “这次不用部署” takes priority for that update and excludes production preflight as well as installation.

Reuse the exact GitHub package the user selected or an existing verified artifact for the intended source. Record its source SHA, package version, and SHA-256 checksum. If a suitable artifact is missing, obtain one with only the build and verification needed for that package. Do not create a version preparation PR or require full release verification merely to deploy. If the available workflow runs broader checks to produce the artifact, report that tooling limit without adding release steps. Keep the selected bytes fixed across devices. Do not build a deployment package from uncommitted local source.

Proceed independently on each node. Idle nodes can deploy in parallel while busy or unavailable nodes are reported as skipped or deferred. Do not wait indefinitely or create a scheduled retry without a user request. When the nodes are online, the package is ready, and no activity blocks installation, aim to finish the normal deployment path within five minutes. Report any concrete delay rather than promising an unconditional deadline.

1. **Check activity once.** Reuse available authenticated status and deployment entry points. Inspect running sessions and jobs on that node, plus its fresh execution leases. Historical `uncertain` records, stale leases, and idle approval inboxes alone do not establish active work. Preserve the existing configuration and recovery data, and identify the previous package or rollback location. If real work is running, skip or defer that node. Never interrupt, cancel, or force-restart work to finish a deployment.
2. **Install through the official plugin manager.** Use its supported bundle installation and HMR path with the selected package. If a restart is required, proceed only at an established safe idle point. Keep runtime model choices, credentials, other plugins, and business task state unchanged. If the installed package matches the selected source SHA and package checksum, report the node as current instead of reinstalling it. Version equality alone is insufficient.
3. **Confirm the result briefly.** Check the installed version and package identity, the affected plugin entries' active state, and connection heartbeat where applicable. Record each node's result, any existing warning or unresolved failure, and its rollback location. Then stop.

The existing `session/list`, `session/projections`, plugin inventory, and ledger APIs are status sources. The repository does not currently provide a unified deployment preflight command. Reuse a known compatible entry point when available. If one is missing, report the limit and keep any necessary inspection bounded rather than building a new deployment framework during the update.

Expand validation only when the change or a specific anomaly requires it. Ordinary deployment does not require another temporary cross-platform feature acceptance suite, paid model calls, or record-by-record business database comparisons. Preserve existing recovery data rather than changing old task states to make a check pass.

Keeping a source tarball in a persistent directory helps future repair, reinstallation, and rollback. An installed plugin executes its `node_modules` files and continues running if the source tarball is deleted. Archive persistence is not a deployment completion gate. Do not repeat installation solely to relocate the original tarball.

The remaining sections apply only to a user-requested formal release.

## Prepare versions once per release

Several feature PRs may accumulate on `dev` without changing package versions. When preparing a formal release, open a separate preparation PR from the latest dev baseline and choose the next unused task-system version. Use npm to update the workspace manifest and generated root lock together:

```sh
NEXT_VERSION=0.2.51  # Example only: choose the actual next release version.
npm version "$NEXT_VERSION" --workspace @dsh-task/task-system --no-git-tag-version --ignore-scripts
```

Review both `packages/task-system/package.json` and `package-lock.json`. This command does not commit or create a tag. Do not edit generated lock versions by hand. If another published package changed, update that workspace's version as appropriate with the same npm command, for example `--workspace dsh-jev-plugin`; do not bump every workspace indiscriminately.

Merge the preparation PR after its Linux checks pass. The version change must already be in the candidate **before** full CI and real-device acceptance. Promotion derives `v<task-system version>` from the tested manifest and never edits source or versions. A tag that already exists cannot be overwritten.

## Verify a release candidate

1. Record the full `origin/dev` SHA. It must contain current `origin/main`.
2. In **Actions → Current product checks → Run workflow**, select branch `dev`, operation `verify`, and that exact `candidate_sha`. Leave promotion inputs empty. The workflow refuses a SHA that is not the dev head when verification starts.
3. Wait for the full Linux/macOS workflow to succeed. Record its run ID. `Full CI` is written only after every suite and the candidate artifact upload succeed.
4. Download `release-candidate-<SHA>-<run ID>-<attempt>`. Its `candidate.json`, distribution receipts and `packages/` archives bind the tested commit, package versions and SHA-256 checksums. Use these exact archives for acceptance. Do not rebuild or repack them.

Candidate artifacts expire after 30 days. An expired or unsuccessful verification cannot authorize promotion; run verification again and test its preserved package bytes. A successful PR run alone is not full release verification. The workflow also refuses verification dispatched on a feature branch or `main`.

`dev` may continue advancing after verification. Keep the candidate fixed: it must remain an ancestor of `dev` and must contain current `main`. New source or package bytes require new verification and acceptance. If `main` advances beyond this candidate, choose and verify a new candidate rather than rewinding it.

## Record real-device acceptance

Install the preserved archives on the intended real devices and run the agreed checks. Record the device/OS, exact installed package checksums, check results and evidence. Include all intended devices and report missing coverage or failures. Ask the user to explicitly confirm these results and release of this exact candidate and tag.

Promotion takes three ordinary text inputs; do not copy SHA/hash/package objects into a JSON form:

- `acceptance_summary`: a short, single-line result, at most 240 UTF-8 bytes. This is the only acceptance text in the permanent tag.
- `acceptance_record`: the intended device scope, OS, actual checks/results, failures or untested scope, and evidence. Limit: 40,000 UTF-8 bytes.
- `user_confirmation`: the actual user's explicit confirmation quote or evidence link for this candidate and release. Limit: 8,000 UTF-8 bytes.

Check `confirm` only after the real checks and user confirmation exist. The controller automatically combines these texts with the verified candidate manifest, package hashes, operator identity and promotion run/attempt. It stores `release-record.json` and the exact `tag-message.txt` in `release-record-<SHA>-<promotion run ID>-<attempt>`, retained for **90 days**. Upload and server-side artifact metadata validation must succeed before a release approval status or ref push. Download and retain the record separately if longer retention is needed; tag text remains available after the artifact expires.

The Actions manual form has no file upload. A concise sentence or semicolon-separated report works in the UI; the dispatch API can supply multiline text in JSON inputs. Input lengths remain bounded, and artifact data must contain no secrets. These text fields and the checkbox are maintainer declarations: CI cannot independently prove physical-device testing or authenticate an external conversation. Agents still need the user's actual confirmation; an empty, invented or misleading report is not acceptable.

## Fast-forward and tag

1. Select branch **main** when manually running the same workflow. Choose `promote`; supply the candidate SHA, successful `verification_run_id`, the three text fields above, and explicit `confirm`. No tag or acceptance JSON needs to be entered.
2. The derived tag is `v` followed by the tested `@dsh-task/task-system` version, for example `v0.2.51`. Its target is the tested SHA. Prepare versions on `dev` before verification, not during promotion.
3. The trusted main controller reads candidate manifests as data. It validates the successful same-repository dev dispatch and attempt, immutable artifact, package bytes, acceptance record, current ancestry and tag. It uploads the detailed record, confirms its immutable artifact ID/name/run/attempt/digest through GitHub, writes `Release approved`, then pushes `main` and the annotated tag in one ordinary `git push --atomic` transaction. It never force pushes. The tag body contains only the short summary and Full CI link; detailed records stay in Actions artifacts. The approval status links to that promotion run, where its record can be downloaded.
4. Verify both remote refs and the workflow result. Retrying the same candidate, summary and Full CI link converges, even from another promotion run. Each attempt keeps its own detailed artifact. An existing tag with a different target or body is rejected; retrying does not rewrite its original record or tag. Version tags matching `v*` prohibit updates and deletion. A concurrent incompatible main update or tag creation makes the atomic push fail without partially changing refs.
5. Fetch and only fast-forward the primary `dev` checkout to verified `origin/dev`. Report main/dev SHAs, tag, CI run, device evidence and WIP locations.

`main` now identifies the tested commit itself. It remains in `dev` history, so no main-to-dev synchronization PR is needed. There is no automatic release on a PR merge, push, or CI success.

### If the bot cannot push workflow-file changes

The workflow uses the existing `GITHUB_TOKEN`; no new secret or bypass identity is required. GitHub may reject a token push that includes `.github/workflows` changes. The first real release of such a change is the authority on this permission; successful status creation or the owner-driven initialization does not prove bot workflow-write permission.

Use the owner fallback only when the promotion log shows a **push permission rejection after all validation passed**, both required GitHub Actions statuses are successful on that exact candidate, and the `release-record-<SHA>-<promotion run ID>-<attempt>` artifact contains both `release-record.json` and `tag-message.txt`. A failed check, invalid receipt or missing confirmation never qualifies. Preserve the failed run and use its exact tag-message file; do not reconstruct the tag or acceptance record.

From a clean checkout of trusted `main`, with those two downloaded files in the current directory:

```sh
set -e
git fetch origin main dev
candidate=$(node -p "JSON.parse(require('fs').readFileSync('release-record.json')).manifest.candidateSha")
tag=$(node -p "'v' + JSON.parse(require('fs').readFileSync('release-record.json')).manifest.taskSystemVersion")
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
git tag --cleanup=verbatim -a "$tag" "$candidate" -F tag-message.txt
git push --atomic origin "$candidate:refs/heads/main" "refs/tags/$tag:refs/tags/$tag"
```

Use the owner's existing authorized Git credential. Branch/status gates and immutable tag rules still apply; never use `--force`, delete a tag, or relax protection. Confirm that the resulting annotated tag points to the tested SHA and has exactly the downloaded tag-message text. `--cleanup=verbatim` preserves summaries starting with `#`. If either ref changed meanwhile, stop and inspect rather than retrying with altered inputs.
