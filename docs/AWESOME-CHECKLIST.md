# Open-source and awesome-dsh-plugin readiness

The deliverable remains private. This checklist is preparation, not a promise of public-list acceptance.

- Each listed candidate must contain runtime code, a shipped dsh.bundle patch and an independently useful DSH-host composition
- Task System, Typed Decisions, Remote Execution and Feishu Channel have explicit interfaces and their own lifecycle/configuration/tests; templates, profiles, types and the dashboard are not represented as extra dependency-only plugins
- Stateful DSH/Cordis packages are declared as peers with pinned tested development versions; built ESM and declarations are included in tarballs
- Run actual pinned DSH install, boot and remove tests, not only config dumps or a fake SDK process
- Review the final private repository and exact pushed commit’s CI; add the dsh-plugin topic and accurate distinct descriptions
- The repository must be at least one day old when the list checks it
- Monorepo subpackage entries are supported by the inspected list rules, with at most three entries per submission PR
- Private source cannot be assumed publicly inspectable or installable by the list’s review workflow
- Public repository visibility, npm publication and an awesome-list PR each require later authorization

Rules source inspected at awesome-dsh-plugin/awesome-dsh-plugin commit e483a501cec7d7446e84990e234ae0def7898c3b. DSH validation target is 0.2.0-rc.2, commit 639ed015397290b3745d163aafe02ffee4aa3f84. An actual remote repository and its CI remain separate from local code/test completion.
