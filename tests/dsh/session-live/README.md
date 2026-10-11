# Session-activated collaboration acceptance

Use a fresh `.runtime` directory and the existing `recursive-live/prepare.mjs` read-only profile preparation. Set `DSH_RECURSIVE_RUNTIME`, `DSH_RECURSIVE_CODEX_HOME`, `DSH_RECURSIVE_ENDPOINT=http://100.123.230.75:43971/commands`, and host-owned `DSH_TEST_CODEX_CLI` explicitly. Preparation refuses an existing profile. Run local processes under the generated `readonly-test.sb` to keep the default DSH/PV directories and Codex credential reference read-only.

Deploy only built package assets and these scripts into a fresh VPS test directory. `coordinator.mjs` starts an empty central task ledger on the Tailscale address and registers the isolated MBP executor. It creates no test tasks itself. SSH is only a file deployment/log inspection channel, never a tunnel. Runtime test calls use bound Tailscale sockets.

All same-node UI, conversation and worker clients share `conversation-remote.sqlite`; independent sequence stores for one authenticated node are invalid. Keep failed attempt evidence separately before starting a fresh `DSH_TEST_SESSION_ID`.

1. Start `coordinator.mjs` on the VPS and `worker.mjs` on MBP. The worker advertises its configured official Codex route through an authenticated heartbeat.
2. Run `conversation.mjs start` on MBP. An actual official slash command activates the session without invoking a model. A subsequent natural-language user request asks the real DSH model for two Codex tasks; the bundled collaboration skill and tool schemas drive dispatch and progress reporting.
3. Wait for both real Codex runs to settle. Run `conversation.mjs resume` in a separate process with the same isolated local state and persisted session. The skill must be present without reactivation; the agent queries prior tasks and submits their real results without creating duplicates.
4. Create `worker.stop` under the isolated runtime to flush wire evidence and shut down the worker after quiescence. Check exactly two official Codex thread/start responses for `gpt-6-luna` / `low` and completed turns.
5. Use `runtime-live/host.mjs` with fresh VPS/MBP UI profiles on Tailscale ports 43980/43981. Inspect the original sidebar's project panel for session identity, project status, task reports and executor read-only scope. Invoke `/project` in an isolated UI session too. Use built `dist/project-page.html`, never the raw template with its vendor placeholder.

`conversation-sessions` and evidence contain test-only prompts/results. Credentials are read-only references and are never printed. Historical packet intake remains a separate regression path. The accepted run and exact observed outcomes are recorded in the final HTML report, not inferred from this recipe.
