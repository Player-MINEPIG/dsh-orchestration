# Decision evaluation and calibration

Typed output constrains shape and candidate choices; it does not make a model correct or grant authority. Task acceptance, node/workspace permissions, runtime/tool budgets and mandatory result receipts are checked outside every provider.

Use a labeled replay set for each question family: persist/ignore/attach, executor, provider/model/effort, physical workspace reuse/create and optional narrative reporting. Include Chinese inputs, ambiguous follow-ups, previously observed work, unavailable nodes, unsupported effort, missing workspaces, corrections and ordinary conversation. Split training/calibration/evaluation sets by task/session so the same objective cannot leak across sets.

Report malformed-output rate, abstention, false persistence/omission, wrong attachment, illegal or inconsistent route selection, latency/cost and high-consequence false acceptance separately. Do not convert an uncalibrated model’s self-reported confidence into a risk bound. Default rules and thresholds are operational policy, not measured guarantees.

Jev is a hosted typed judgment API. Its actual wire capabilities and response version are validated. It does not implement a general execution/authorization agent. Native semantic abstain conditions unsupported by the provider are rejected; deterministic downstream checks can still abstain.

Ordinary DSH models use a bounded tool-free call and strict JSON validation. The native adapter distinguishes configured model pins from provider-reported versions because the DSH stream cannot attest a returned version. Token/byte/time/concurrency limits are available; a currency budget must additionally be enforced by the provider/account.

AnyJev-compatible providers must truthfully declare logits or hidden-state readout and calibration provenance. A plain text API is not relabeled as logits. L0 correction does not prove calibrated uncertainty; L1/L2 need their own model/question-specific evidence. The adapter can connect an existing approved service but does not install a separately supervised Python/GPU service.

No live quality/calibration benchmark was performed for this deliverable. Production acceptance should use the user’s real labeled examples and retain receipts to measure changes when models or policies are updated.
