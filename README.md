# DSH Task Management

Configurable task management mounted inside DeepSeek Harness. Stable tasks retain multiple runs, sessions, reports, revisions and artifacts. Schedules instantiate user-defined templates. The same query contract powers the private WebUI.

Development target: DeepSeek Harness 0.2.0-rc.2, Node 24+. Current implementation is in progress; see package documentation for verified behavior and limitations. Plugins do not install OS services or manage host updates. External supervision belongs to the DSH host.

Packages: task-system (transactional ledger and native tools), typed-decisions (replaceable bounded judgments), remote-execution (authenticated peer protocol). Feishu integration and example task types use these contracts. Private delivery only; publication is a separate decision.
