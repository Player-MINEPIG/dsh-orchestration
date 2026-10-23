## Change and verification

Describe the resulting behavior, checks, and remaining limits. Open feature PRs to `dev`.

## Release impact

State whether this changes an installed package, and identify any device checks needed before release. A feature PR does not authorize a release or claim device acceptance.

Release candidates use full CI, its retained tarballs, recorded device results and explicit user confirmation through the [release workflow](https://github.com/Player-MINEPIG/dsh-orchestration/blob/main/docs/DEVELOPMENT.md). `main` is fast-forwarded to that exact candidate with a version tag; do not open a promotion PR.
