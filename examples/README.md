# Configurable examples

`custom-task-types.mjs` contains three example template definitions: daily review, game daily and an unrelated equipment check. Each uses the same schema/default/result contract and can be registered with `ledger.updateTemplate`. Configure a schedule with either `intervalMs` or `cron` plus `timeZone`, a stable task ID, an immutable template version, input values, overlap policy and an optional authorized execution route.

A task template is data. It cannot register executable code, access credentials or grant paths/tools. New source readers, normalization logic or renderers should be operator-reviewed host plugins/providers; select their IDs through task configuration. No business name is special-cased in ledger or scheduler code.

These examples preserve reporting patterns, not private account data or fixed personal device names. A missing source produces unknown/partial evidence according to the configured contract. A quota/balance collector is read-only, and net balance movement must not be labeled gross spending. Optional Bitable or database views consume the query interface rather than becoming authoritative task storage.

`host-delegation.AGENTS.md` shows the optional host-level specialist delegation boundary. It is not a required Codex executor plugin.
