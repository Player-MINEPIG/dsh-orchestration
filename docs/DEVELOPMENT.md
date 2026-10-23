# Develop and release through dev

Keep the primary checkout on `main`. Use an isolated worktree for development. `dev` collects reviewed changes and is the candidate branch for real-device acceptance. `main` contains accepted releases. The default branch remains `main`.

## Start a feature

1. Fetch and prune remote refs. Inspect the current checkout, all worktrees you need, and existing WIP. Preserve changes before switching branches.
2. Compare `origin/dev`, `origin/main`, and the deployed source commit. Record the deployed package version and checksum. If deployed source is uncommitted, recover and record that baseline first.
3. Read the current requirements and [CI commands](CI.md). Create a new `codex/` branch and independent worktree from the latest verified `origin/dev`.
4. Implement and verify the change using GPT-6.1-Sol with High reasoning, as required by [AGENTS.md](../AGENTS.md). Record checks that passed and any limits.
5. Open a feature PR to `dev`. Review its diff and wait for every required check before merging. Feature PRs may use squash or merge.

Both long-lived branches require PRs, the product checks, `PR flow`, an up-to-date head, and resolved conversations. Approval count is zero to support a single maintainer. The rules include administrators and prohibit force pushes and deletion. Rebase merging is disabled.

## Accept a candidate on real devices

1. Freeze changes to `dev` and record its full commit SHA. Create the `dev` → `main` PR from the same repository.
2. Build the release package from that exact SHA. Record each archive's filename and SHA-256 checksum in the PR.
3. Run the agreed acceptance checks on the intended real devices. Record each device, OS, installed version, package checksum, checks, results, and evidence. Report failures and untested devices explicitly.
4. Ask the user to confirm the recorded results and promotion to `main`. Link or quote the user's explicit confirmation in the PR. CI success and an agent's report do not substitute for this confirmation.
5. Recheck that the PR head equals the tested SHA, `main` has not advanced, and all required checks passed. If `dev`, `main`, or the package changes, update the candidate and repeat acceptance before promotion.

Keep `dev` frozen until promotion completes. A new head invalidates the earlier acceptance record even if the version number stays the same. A historical waiver for a process-only bootstrap does not waive acceptance for a later runtime release.

## Promote and synchronize

1. Merge the accepted `dev` → `main` PR using **Create a merge commit**. This preserves the tested dev commit as an ancestor. Do not squash or rebase a long-lived branch promotion.
2. Verify all required checks on the merged promotion PR. Confirm that the integrated `main` tree equals the tested dev tree. Report the accepted dev SHA and the integrated main SHA separately. Pushes do not trigger CI; use the product workflow's manual dispatch when additional verification is needed.
3. Open a `main` → `dev` PR and use **Create a merge commit** after its checks pass. This syncs the promotion commit back into `dev` and keeps the next candidate up to date. If GitHub reports no changes, inspect both commit ancestry and file differences, and report the result before choosing another sync path.
4. Fetch the merged refs. Fast-forward the primary `main` checkout to the verified `origin/main`. Report branch names, HEADs, PRs, CI results, acceptance evidence, and WIP locations.

The strict check does not require direct pushes to either branch. A feature branch first merges the current `dev` if needed. A candidate first receives changes from `main` through a `main` → `dev` PR. After promotion, the new main commit contains the accepted dev head, so the reverse sync PR preserves ancestry without rewriting either branch.

Repository settings allow both squash and merge because GitHub's setting applies repository-wide. Select squash or merge for feature PRs and merge for long-lived branch PRs. `PR flow` checks branch routing; choosing the merge method and confirming real-device acceptance remain maintainer responsibilities. There is no deployment automation in this workflow.
