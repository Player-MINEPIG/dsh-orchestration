# Validation records

`0.1.1-checks.json` is the current patch-release record: 428/428 tests, real CLI stages 10/13 and upgrade stages 11/11. It adds explicit exact-address network authentication, safe native error summaries and actual two-host DSH/TCP fixtures. The original `local-checks.json` below remains the 0.1.0 baseline, not a second claim about the new release.

`local-checks.json` records the frozen implementation's local run: 397 tests passed with zero failures/skips, repeated after a fresh dependency install with no prebuilt distribution files. The two runs are repeat verification, not 794 different test cases. Runtime and fixture source files matched across those workspaces.

The optional three comparisons against pinned original validators were actually run, with a synthetic corpus and zero skips. They are separate from the normal suite and do not prove every historical parser or live outcome. `dashboard-dom.log` records 12 synthetic DOM checks using linkedom 0.18.12; this is not a browser layout or visual acceptance result.

Actual pinned DSH CLI installation, host boot, packaged native execution, removal and retained-state records are under `tests/dsh/results/`. Their tarball integrities identify the package bytes tested. Architecture validation and static-image inspection records are under `docs/architecture/`; Git-source and real-browser limitations are separately recorded there.

Production account/hardware/network checks and the exact pushed commit's GitHub CI remain distinct gates. No local test count closes those gates.
