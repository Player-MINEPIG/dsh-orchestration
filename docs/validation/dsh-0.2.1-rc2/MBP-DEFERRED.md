# MBP deferred installation

The runtime is already `0.2.1-rc.2`. The existing authenticated browser at
`http://127.0.0.1:3080/` showed an ongoing generation during this upgrade.
The running task and its manual DSH process were left untouched.

DSH supports profile HMR, but task-system provider disposal cancels its owned
agents. An update therefore waits for all live sessions to stop generating,
all pending input/job queues to empty, and remote execution leases to settle.
A local task-ledger count alone cannot establish that ordinary sessions are idle.
Use the existing authenticated UI; do not obtain login tokens from logs.

The package is staged at:
`/Users/pmp/.dsh/releases/task-system-0.2.24-rc2/dsh-task-task-system-0.2.24.tgz`.
Its SHA256 is
`bb156bb01afd9661ec29ce94a8bf31feb746ada8e52f0d3c8bc95b80e4513bd2`. The full validation record is
`docs/validation/dsh-0.2.1-rc2-compat.json`. Verify the digest before installation. Back up the entire web profile and
SQLite databases before changing the idle host.

The authorized installation command, only after the idle check, is:

```sh
PATH=/opt/homebrew/bin:/Users/pmp/.local/bin:/usr/bin:/bin \
DSH_HOME=/Users/pmp/.dsh \
/opt/homebrew/bin/node /Users/pmp/.local/bin/dsh plugin --profile web add \
  /Users/pmp/.dsh/releases/task-system-0.2.24-rc2/dsh-task-task-system-0.2.24.tgz
```

Verify the installed package version is `0.2.24`, no compatibility exemption
was added, the existing profile settings bytes remain unchanged, and the
native task service, task settings page and existing remote executor connection
load. If HMR reports a restart requirement, preserve the manually started
host's invocation and restart it only while idle. Do not enable or restart the
unloaded launchd service merely to force the update. Runtime model selections,
workflow node models and scheduled task models stay as configured.

The parent chat owns the deferred follow-up and must record its actual outcome;
this playbook is not a claim that the update has already occurred.
