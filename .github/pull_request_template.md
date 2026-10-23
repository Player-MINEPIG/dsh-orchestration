## Change and verification

Describe the resulting behavior, relevant checks, and any limits.

## Route

Choose the route: feature → dev, dev → main promotion, or main → dev sync.

## Real-device acceptance for dev → main

Complete this section before promoting a runtime release. For other routes, state why it does not apply. Follow [the development workflow](https://github.com/Player-MINEPIG/dsh-orchestration/blob/main/docs/DEVELOPMENT.md).

- Tested dev commit SHA:
- PR head SHA, confirmed equal to the tested SHA:
- Package filenames and SHA-256 checksums:
- Device, OS, installed version, checks, results, and evidence for each intended device:
- Untested devices or unresolved failures:
- User's explicit confirmation and evidence link:
- Confirmation that dev stayed frozen and main did not advance after acceptance:
- Merge method for a long-lived branch PR: merge commit.
