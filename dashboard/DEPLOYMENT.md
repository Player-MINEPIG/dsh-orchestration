# Private snapshot deployment

Instance-specific URLs, Site identity, deployment receipts and private ledger locations are kept in the operator’s ignored runtime records, not in the reusable source distribution. Use the existing hosting identity when updating a deployment; never create a replacement Site or broaden sharing as a side effect.

Re-export with dashboard/export.mjs into your selected Site checkout's dist directory. Use the existing .openai/hosting.json identity and current Sites workflow; do not register a new Site for an update. The generated output uses the same source frontend, with mode=snapshot and no automatic polling. Keep it owner-private unless the user explicitly changes the audience. No credentials are retained in this file or project.

The deployment is a published **snapshot**. The local live service and future authenticated DSH host mounting remain separate runtime options using the same TaskLedger. The current cloud-browser local-port access and visual rendering limitations are detailed in qa/verification.md. No claim of successful mobile or desktop visual QA is made.
