# Verify physical task result returns

`task-return-physical-smoke.sh` verifies the installed task package on AWS and MBP. It creates an isolated AWS project and ordinary coordinator session, calls the public task tools, and sends one child to the actual MBP native executor over signed HTTP through a temporary SSH tunnel. The child waits four seconds so AWS can record a pending state before the original AWS session cold-resumes and submits the parent result.

The default run replaces only the external LLM with a scripted adapter. DSH Loader, AgentLoop, public tools, leases, signed transport, SQLite ledgers, session persistence, and result delivery use each host's installed modules. The evidence checks distinct physical hostnames and exactly two Tasks, two Runs, one Attempt, and one returned result event.

Both hosts must already have the release being verified. The script installs no packages and changes no production listener, profile, model default, or business data. It writes fresh temporary fixture directories and creates an Ed25519 key solely for this fixture. Cleanup removes the private key and closes its SSH tunnel. Result JSON files remain for inspection.

Run from the repository root after deployment:

```sh
bash scripts/validation/task-return-physical-smoke.sh
```

The defaults use SSH alias `aws-vps`, the existing `web` profiles, and the currently installed CLI dependency graph. Override these environment variables when needed:

- `AWS_HOST`, `AWS_PROFILE`, `AWS_NODE`, and `AWS_RUNTIME_ENTRY`
- `MBP_PROFILE`, `MBP_NODE`, and `MBP_RUNTIME_ENTRY`
- `EXPECTED_VERSION`, which defaults to `0.2.40`

To test a real small model starting from a natural-language request, run:

```sh
REAL_COORDINATOR=1 bash scripts/validation/task-return-physical-smoke.sh
```

This mode explicitly selects AWS's configured `magpie` provider and `deepseek/deepseek-flash` model for the isolated coordinator. It loads that provider's existing settings and necessary credential into fixture memory, limits the coordinator to fourteen steps, and permits only the fixture's task tools. It does not change host defaults. The MBP child LLM remains scripted, and the evidence labels both model boundaries. No credential values are exported.

The runner prints the local `physical-evidence.json` path. That file links the AWS and MBP result records, including installed package versions, source and resumed session IDs, actual MBP execution cwd, pending observations, final reports, and Run and Attempt counts. The corresponding AWS fixture remains under the printed `/tmp` directory. A failed run leaves a failed result record and signals its temporary gateway to stop.

`task-return-host-smoke.mjs` also exposes `coordinator` and `executor` modes for controlled manual runs. `--task-package` and `--allow-same-host` support development checks. Runs using the latter are explicitly marked as non-physical and are not accepted by the physical runner.
