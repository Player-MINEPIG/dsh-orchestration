# Executor Agent presets 0.2.47

Execution settings now select from the local DSH `agentPresets.list()` roster. The task plugin uses official `resolve()` and `mount()` for new sessions, records the selected ID, and explicitly rejects missing/broken presets. Existing sessions resume their recorded preset ID. Presets compose scoped plugins; their tools, prompts and permission behavior also depend on the host. The task's provider/model route remains authoritative, and task `allowedTools` can still narrow capabilities.

Saving a preset uses the existing ConfigEditor startup CAS transaction and clears the legacy `executionTools` mask in that same write. The UI displays the current mask and its removal effect. On MBP the new production UI saved `executionAgentPreset: ptc` and `executionTools: null`; every other profile field and persisted node model-default policy remained unchanged. AWS configuration was unchanged. Both hosts run the same 0.2.47 package (325 matching files), with healthy activation. AWS DMC 0.1.8's 47 files were unchanged; MBP had no DMC package. Installation replaced only the task package and CAS-updated its archive reference, without recalculating dependencies.

Validation: build and 39 focused checks passed. Real isolated DSH mounted an official file-tool preset and read a real file; selecting a different preset changed the new session's tools. A preset trying to override provider/model could not change the leased route. A persisted cold session resumed its recorded preset after the executor selection changed. Missing presets and concurrent mask changes reject clearly. Real Chrome saved and reloaded the setting through the official Typert Gateway and ConfigEditor. The old full settings test file has 15 baseline failures, reproduced against the original c4b2ca4 client and tests; these unrelated assertions/stubs were not repaired.

```sh
npm run build --workspace=@dsh-task/task-system
node --test packages/task-system/test/execution-agent-preset.test.mjs packages/task-system/test/startup-settings.test.mjs
node --test --test-name-pattern='selecting the same execution preset' packages/task-system/test/settings.test.mjs
DSH_OFFICIAL_ROOT=/path/to/installed/runtime node tests/settings/executor-agent-preset.browser-host.mjs
```

Production verification created no execution session, task or PR rerun. MBP's installed official PTC declaration includes `dsh-tool-fs` and `dsh-tool-bash`, with no local preset declaration override found. This does not prove production PR/network access. Resume preserves the preset ID, not a frozen historical plugin revision or host tool-mask snapshot; official cold mounting resolves that ID's current available revision.

[release.json](release.json) records package/source hashes, saves, health and rollback directories. [mbp-ptc-declaration.json](mbp-ptc-declaration.json) records the bounded declaration inspection. Browser evidence and screenshots remain in `/private/tmp/dsh-executor-agent-preset/`, including `preset-saved-reloaded.png` and `mbp-preset-saved.png`. Earlier WIP stays in stash commit `2b6330cecdba7eab3a1aab82f081686e2df85f3e`.
