# NEXA EXISTING CAPABILITIES INVENTORY

| Capability | Legacy Provenance | Verified Working Offline? | Missing in Legacy / Implemented in NEXA GENESIS |
| :--- | :--- | :--- | :--- |
| Mission Lifecycle State Machine | `nexa6_core.py` | Yes (8/8 checks) | Expanded to 9 states (`CREATED`, `PLANNED`, `RUNNING`, `AWAITING_APPROVAL`, `REVIEWING`, `COMPLETED`, `FAILED`, `BLOCKED`, `CANCELLED`) + SSE/API tracking |
| Evidence Epistemic Tagging | `nexa6_core.py` | Yes | Expanded with provenance source links, contradiction flagging, and confidence calibration |
| Human Approval Gate | `nexa6_core.py`, `config.json` | Yes | Enforced across paid AI fallback, publishing, external comms, and invoice issuing |
| Artifact SHA-256 Registry | `nexa6_core.py` | Yes | Added preview/download API and integrity verification |
| Multi-DB Bridge Linking | `nexa_bridge_service.py` | Yes (7/7 sandbox tests) | Unified into transactional `bridge_links` with dry-run & execute modes |
| Zero-Price & Modality Filtering | `nexa_multi_ai_engine.py` | Yes (7/7 tests) | Extended across Gemini (`gemini-4-hydrogen`), OpenRouter, Groq, NVIDIA + paid guardrails |
| Auth Failure Circuit-Breaker | `nexa_ai_gateway.py` | Structural only | Full runtime circuit-breaker + cooldown telemetry + no key exposure |
| 5-Agent Sequential Pipeline | `nexa_orchestrator.py` | Yes (5/5 mock tests) | Upgraded to **15 Specialist Agents** with Zod-validated structured outputs |
| Live arXiv Research | Notebook cell 31 | Partial (off-topic physics) | Query extraction + live arXiv Atom parser + contradiction check |
| Live Web Market Search | Notebook cell 31 | **FAILED** (`duckduckgo_search` missing) | Replaced by safe HTTP metadata retrieval + explicit offline/unavailable reporting |
| Quant Research & Backtester | Not implemented (narrative only) | No | Built full deterministic OHLCV validator, indicators, backtester, walk-forward, Monte Carlo, risk engine, paper ledger |
| Software Engineering Studio | Not implemented | No | Built isolated `workspace_projects/` generator, static validator, test runner, snapshot/rollback |
| Voice & Multi-Language UI | `templates/voice.html` stub | No | Built Arabic/Italian/English/French Web Speech STT/TTS + responsive 17-view UI + 3D WebGL core |
