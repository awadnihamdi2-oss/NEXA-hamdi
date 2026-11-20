# NEXA RISK REGISTER

| ID | Category | Risk Description | Severity | Likelihood | Mitigation in NEXA GENESIS |
| :--- | :--- | :--- | :--- | :--- | :--- |
| R-01 | Cost / Billing | Automatic fallback silently switches from free model to paid model (`gpt-4o`, `claude-opus`, `gemini-4-carbon`) | Critical | High if unchecked | Hard policy block (`automaticPaidFallback: false`), `:free` + zero-price checks, explicit user approval required |
| R-02 | Security / Secrets | API keys leaked in frontend bundle, logs, or UI inputs | Critical | Medium | Keys read server-side from `process.env` only; zero API key input fields in UI; `keyValueExposed: false` invariant |
| R-03 | Quant / Trading | Simulated strategy accidentally routed to live brokerage / real capital | Critical | Medium | Live execution locked (`NEXA_LIVE_TRADING_ENABLED=false`), paper-trading ledger only, explicit synthetic/sample labeling |
| R-04 | Commerce / Legal | Autonomous outreach or fake non-fiscal invoices sent externally | High | Medium | External actions disabled (`externalActionsEnabled: false`), `DRAFT — NOT A FISCAL INVOICE` watermark, approval gate mandatory |
| R-05 | Prompt Injection | Untrusted web/arXiv text overrides system agent instructions | High | Medium | Delimited untrusted-content wrappers + input sanitization + Zod structured output validation |
| R-06 | Engineering Sandbox | Generated project code executes arbitrary shell commands or escapes workspace | Critical | Medium | Path traversal checks (`path.resolve` containment), command allowlist (`node --check`, `vitest`), execution timeouts |
| R-07 | Epistemic Honesty | Agents fabricate URLs, test passes, metrics, or live API results | High | High | Critic + Fact Verification + QA stages enforce evidence labels; UI never renders fabricated KPIs |
| R-08 | Legacy Data Loss | Overwriting historical files or databases during migration | High | Low | Read-only reference to `/public/assets/aistudio/*`; new isolated `data/nexa_genesis.sqlite3` |
