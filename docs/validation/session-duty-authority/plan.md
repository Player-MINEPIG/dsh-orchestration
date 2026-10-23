# Session duties and central authority

## Authorized outcome

An ordinary session on an authorized device can register or attach a central project from its real local workspace, create and bind a parent task, dispatch a child, query the authoritative state, receive the child's durable result in the original session after restart, and settle the parent. The central host need not own the session directory. New deployment configurations keep device execution disabled unless explicitly enabled. Legacy configurations without deployment fields preserve their historical execution policy, including the omitted-role default. Remote central unavailability never creates a second task authority.

## Checklist

- [x] Read the Principles section of poteto-mode and repository development/CI instructions.
- [x] Phase A. Frame. Verify deployed source/packages, refs, WIP and structural coupling.
- [x] Phase B. Design the workflow. Resolve the configuration compatibility and authenticated session command contracts before product edits.
- [x] Phase C. Run the loop. Implement the smallest verified unit at a time.
- [x] Separate central hosting/connection from local execution configuration, preserving old grants and pause behavior.
- [x] Extend central project/session commands and dispatcher lifecycle, keeping node/session/cwd provenance and project scope checks.
- [x] Decouple durable origin returns from workload execution and cover offline recovery/idempotency.
- [x] Replace role-based UI capability gates with central task center/local activity and verify real UI.
- [x] Run current check suites locally on macOS (Linux PR gates remain pending) and isolated native/authenticated integration.
- [x] Phase D. Keep the audit trail. Record design decisions and evidence as work lands.
- [x] Independent GPT-6.1-Sol High review; fix concrete findings and reverify affected behavior.
- [x] Phase E. Verify and hand back. Inspect final diff and refs; report coverage and limits. No PR, merge, release, deployment, production-state or model-default changes.

## Baseline

Main checkout remains main f318fcb4f8513720a1366351ddd5f7dc6e30727d with ten pre-existing tracked .scratch deletions untouched. Worktree /private/tmp/dsh-session-duty-authority, branch codex/session-duty-authority, starts at origin/dev 7ca2d01c23aa43c01f552ceddf21f3fcc8ca7309. PR14 checks 39979294983 and 39979295082 succeeded. AWS and MBP actually contain version 0.2.51 from candidate 4dffbe39a5dd8888c0190cc29888eaf6d2492b95; all 334 package files match tarball SHA256 fff0bf79108ef1d8aa80fda754efd3010aeb5179917ebf9675935237d3f0f0f0. Full CI 39976548605 succeeded. Candidate remains in dev and contains main; no formal release/tag.

## Rigor and scope

This is a cross-cutting authority/permissions change across configuration, native host, authenticated transport, project/session binding, durable returns and UI. Use behavior integration tests with real ledgers and isolated DSH hosts, negative authorization cases, existing suite gates, and independent review. Do not replace this with a role-label change. Existing persistence for execution recovery and outbox is allowed; it cannot authorize local management writes on a remote client.

The coordinator chat owns product direction and PR work. Two read-only explorers traced authority/role and session/return paths. Implementation stays in this worktree. Independent reviewers receive the actual diff after implementation.
