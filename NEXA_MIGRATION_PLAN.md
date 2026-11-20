# NEXA MIGRATION PLAN — From Legacy Colab Prototype to NEXA GENESIS Platform

## 1. Migration Strategy
Because historical `/content/drive/MyDrive/NEXA_3` files are archived in `/public/assets/aistudio/*`, all original assets remain completely untouched. NEXA GENESIS implements a clean-room, production-grade TypeScript + Node.js (`v22.23.2`) + React 19 + Express + `node:sqlite` platform that faithfully ports and upgrades every verified legacy invariant while closing all architectural, security, testing, and UX gaps.

## 2. Phased Execution Sequence
1. **Phase 1 — Discovery & Schema Consolidation:** Audit complete; establish unified versioned SQLite schema (`server/db/database.ts`, `server/db/migrations.ts`) with automated backup/export.
2. **Phase 2 — Security, RBAC & Guardrails:** Implement session auth (`admin`, `operator`, `researcher`, `viewer`), rate limiting, prompt-injection delimiters, PII redaction helper, and approval enforcement.
3. **Phase 3 — Multi-AI Gateway, Registry & Router:** Implement `@google/genai` server adapter (`gemini-4-hydrogen` + `User-Agent: 'aistudio-build'`), OpenAI-compatible adapters (OpenRouter, Groq, NVIDIA, OpenAI, Anthropic, DeepSeek, Qwen), deterministic Offline Mock provider for tests, cooldowns, and strict zero-paid-fallback policy.
4. **Phase 4 — Master Kernel & 15-Agent Orchestrator:** Implement state machine, typed 15-agent registry, critic/fact-verification/QA/synthesis stages, evidence classification, and transactional bridge links.
5. **Phase 5 — Research, Knowledge & Segmented Memory:** Implement live arXiv Atom retrieval, knowledge indexing with provenance, and 7-scope versioned memory with user deletion.
6. **Phase 6 — Domain Engines (Quant Lab, Autonomous Commerce, Engineering Studio):**
   - **Quant:** OHLCV validator, indicators, backtester (slippage + fees), walk-forward, out-of-sample, Monte Carlo, sensitivity matrix, risk sizing, paper ledger.
   - **Commerce:** Opportunity scoring, site generator (IMCASO/OMEGA pattern), CRM leads, draft invoices, approval gates.
   - **Engineering:** Sandboxed workspace generator, syntax/test runner, snapshot & rollback.
7. **Phase 7 — Complete Responsive Frontend & 3D Core:** Build Three.js reactive core (`idle`, `listening`, `thinking`, `executing`, `speaking`), multi-language Voice STT/TTS (Arabic, Italian, English, French), and all 17 platform views.
8. **Phase 8 — Automated Verification & Deployment Docs:** Run Vitest unit/integration/E2E suite, `npm run lint`, `npm run build`, live server/browser checks, and publish honest verification & deployment reports.
