# NEXA DATABASE AUDIT

## 1. Legacy Databases Discovered in Archive
1. **`NEXA_6_0/data/nexa6.sqlite3` (40,960 bytes)**
   - Tables: `missions` (1), `agent_runs` (1), `evidence` (1), `approvals` (1), `artifacts` (1), `events` (7), `memory` (0).
   - Strengths: Clean foreign-key relations (`mission_id -> missions(id)`), evidence type constraint (`verified`, `hypothesis`, `assumption`, `unknown`), approval gate (`pending`, `approved`, `rejected`), SHA-256 artifact checksums.
   - Gaps: No RBAC/users/sessions, no cost/token accounting, no model/provider provenance columns, no structured mission plans (`PLANNED`, `REVIEWING`, `AWAITING_APPROVAL`, `CANCELLED` states absent).
2. **`NEXA_AUTONOMOUS_COMMERCE_5_0/data/nexa_commerce.sqlite3` (77,824 bytes)**
   - Tables: `approvals` (0), `customers` (1), `events` (3), `interactions` (0), `invoices` (1), `opportunities` (1), `projects` (0), `research` (0), `tasks` (0).
   - Gaps: Siloed SQLite file; lacks explicit mission foreign keys without Bridge ATTACH; invoice schema lacked explicit `DRAFT — NOT A FISCAL INVOICE` enforcement at DB constraint level.
3. **`NEXA_INTEGRATION_BRIDGE_1_0/data/nexa_bridge.sqlite3` (4,096 bytes)**
   - Tables: `bridge_registry`, `bridge_events`, `source_checks`.
   - Strengths: Atomic `BEGIN IMMEDIATE` transactions syncing status between `missions` and `commerce.tasks`.
4. **`nexa_memory.sqlite3` (192,512 bytes)**
   - Unstructured Colab memory dumps with no deduplication, retention policy, or scope separation.

## 2. Unified NEXA GENESIS SQLite Architecture (`data/nexa_genesis.sqlite3`)
All legacy schemas are consolidated into a single WAL-mode SQLite database with strict foreign keys and additive versioned migrations (`schema_migrations`), preserving field-level compatibility with `nexa6`, `commerce`, and `bridge_registry`:
- **Identity & RBAC:** `users`, `sessions` (with roles `admin`, `operator`, `researcher`, `viewer`).
- **Master Kernel & Multi-Agent:** `missions`, `mission_steps`, `agent_runs` (recording `provider`, `model`, `latency_ms`, `tokens_in`, `tokens_out`, `cost_usd`), `approvals`, `artifacts`, `audit_events`, `bridge_links`.
- **Multi-AI Intelligence:** `providers`, `models`, `model_calls`.
- **Research & Memory:** `sources`, `evidence`, `memory_entries` (scoped by `user_preferences`, `project_knowledge`, `mission_history`, `technical_docs`, `verified_facts`, `temporary_context`, `agent_working`), `conversations`, `messages`.
- **Domain Modules:** `quant_datasets`, `quant_strategies`, `quant_backtests`, `quant_paper_orders`, `commerce_opportunities`, `commerce_customers`, `commerce_invoices`, `commerce_sites`, `engineering_projects`, `engineering_snapshots`, `test_runs`.
