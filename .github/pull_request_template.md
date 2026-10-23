## Change and verification

Describe the resulting behavior, checks, and remaining limits. Open feature PRs to `dev`.

## Release impact

State whether this changes an installed package, and identify any device checks needed before release. Ordinary feature PRs do not bump versions; a formal release preparation PR uses npm to update the relevant package versions and lock before full CI. A feature PR does not authorize a release or claim device acceptance.

Release candidates use full CI, its retained tarballs, a short summary, detailed device record and explicit user confirmation through the [release workflow](https://github.com/Player-MINEPIG/dsh-orchestration/blob/main/docs/DEVELOPMENT.md). Detailed records are stored in Actions artifacts; the tag contains only the short summary and CI link. `main` is fast-forwarded to that exact candidate with its tested package version tag; do not open a promotion PR.
