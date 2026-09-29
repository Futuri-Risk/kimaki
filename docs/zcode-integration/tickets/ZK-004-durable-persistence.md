# ZK-004 — Durable sidecar persistence on the real Drizzle/libSQL stack

## Status
DONE (2026-09-17, ZAI) — see completion notes and deviations

## Objective
Land the ten-table durable sidecar (`agent_*`) through Kimaki's actual Drizzle schema and
libSQL transactions, with the version/integrity gate ahead of generic DDL, preserving all
existing IDs/tables and the store's CAS/admission/outbox invariants.

## Why
G02: "persistence before effects"; mission IMPLEMENT step 2; F04/F05/F06/F08 fixes must
keep working on the real client. The standalone `sql.ts`/`migration.ts`/`store.ts` were
written against a generic transactional port — must be adapted, not pasted.

## Dependencies
ZK-001 (stack baseline). Independent of ZK-002/003; ZK-007 consumes it.

## Scope
- Add to `cli/src/schema.ts` (Drizzle): agent_schema_versions, agent_sessions,
  agent_backend_defaults, agent_thread_intents, agent_operations, agent_stream_state,
  agent_interactions, agent_attachments, agent_outbox, agent_workspace_leases — column
  names per transplant map table (prototype milliseconds timestamps retained explicitly).
- Regenerate `src/schema.sql` via `pnpm generate:sql`; review diff.
- `cli/src/db.ts`: before generic CREATE IF NOT EXISTS bootstrap, run the agent-schema
  version/integrity gate: fresh DB ⇒ initialize once; existing agent tables without a
  supported version ⇒ refuse (fail closed); unknown persisted operation state ⇒ refuse.
- Port `store.ts` + `sql.ts` onto the Drizzle/libSQL client: transaction port using
  `@libsql/client` batch/transaction; preserve uncertain remote-COMMIT semantics
  (network-lost COMMIT may have committed — never infer rollback).
- Partial unique index for pending interactions only (v2 semantics): a native numeric RPC
  ID may repeat after the prior request closes; history is never deleted.
- Existing `thread_sessions.session_id` stays non-unique; no old table changes.

## Explicit non-scope
- No changes to existing Kimaki tables beyond additive; no Drizzle version bump; no
  standalone DDL string comparator; no scheduler/outbox consumer UI here.

## Files expected to change
`cli/src/schema.ts`, `cli/src/schema.sql` (generated), `cli/src/db.ts`,
`cli/src/agent/store.ts` (adapted from bundle), `cli/src/agent/sql.ts` (port),
`cli/src/agent/migration-conversion.ts` (bundle migration logic, tests-only usage).

## Implementation notes
- libSQL transaction: prefer `client.transaction()` (interactive) with BEGIN/COMMIT via
  the port; on COMMIT error after network loss ⇒ return unknown, caller keeps fences.
- Timestamps: prototype uses epoch-ms; existing Kimaki tables use ISO strings — do not
  feed ms into ISO parsers (transplant map warning).
- Bundle tests for store/migration (H01–H05, H25–H29 + original) port against the real
  client using a temp file DB (and the vitest Hrana isolation pattern from vitest.config).

## Invariants
- Version gate precedes any agent-table CREATE; missing journal = corruption refusal.
- Admission/SEND_INTENT/CAS/cursor/view/outbox updates atomic; receipts only transition
  sending/delivery-unknown; unknown delivery never auto-retries.
- Old DBs (pre-agent tables) keep working: gate initializes cleanly; downgrade refuses
  unsafe state rather than dropping tables.

## Acceptance criteria
- [ ] `pnpm generate:sql` diff reviewed; schema.sql contains the ten agent tables.
- [ ] Fresh-file DB boot: gate initializes version + tables once; concurrent initializers safe.
- [ ] DB with agent tables but missing/unknown version ⇒ boot refuses with clear error.
- [ ] Store tests (ported) pass on file-backed libSQL: admission dedupe, SEND_INTENT,
      CAS transitions, outbox claim/receipt (H01/H02), interaction reuse (H25–H28),
      migration/refusal cases (H04/H05/H29).
- [ ] Existing row/schema compatibility tests still pass (old rows untouched).
- [ ] tsc + baseline unchanged (no new failures).

## Tests
`cli/src/agent/store.test.ts` (ported + adapted); existing schema/db tests.

## Evidence
(to fill)

## Blockers
None.

## Completion notes
- Landed:
  - `cli/src/schema.ts`: ten agent_* tables in Drizzle with explicit CHECK constraints,
    both partial unique indexes (native identity WHERE native_session_id IS NOT NULL;
    interactions pending WHERE state='pending'), composite PKs, self-FK for
    parent_agent_session_id. `src/schema.sql` regenerated via `pnpm generate:sql`
    (+159 lines, additive only) and reviewed.
  - `cli/src/agent/schema-gate.ts`: preBootstrapAgentSchemaGate (version/integrity
    validation BEFORE generic DDL; refuses orphan/unversioned/newer/v1 schemas),
    finalizeAgentSchema (post-bootstrap stamp + validation), validateAgentSchemaIntegrity
    (semantic: 10 tables + required indexes + pending-index partiality), and an explicit
    (not startup-automatic) upgradeAgentSchemaV1ToV2 conversion for standalone-slice DBs.
  - `cli/src/agent/sql.ts`: SqlClient port + `libsqlSqlClient` adapter over the RAW
    @libsql/client connection (never the Drizzle object).
  - `cli/src/agent/store.ts`: verbatim port minus the standalone migrate() (schema
    ownership moved to gate + generated DDL); all admission/CAS/lease/outbox/interaction
    invariants preserved.
  - `cli/src/db.ts`: gate called before the schema.sql statement loop; finalize after it;
    new `getRawDbClient()` export for later store construction.
  - Tests: `schema-gate.test.ts` (fresh/orphan/version-refusal, H04 missing-journal
    refusal, H29 missing-index refusal, H27 history-preserving conversion, H28
    failed-conversion rollback, idempotent bootstrap, legacy-row preservation) and
    `store.test.ts` (18 cases ported to real file-backed libSQL: admission immutability,
    H03 secret escaping, H05 corrupt-state read, queue limits, CAS single-claim,
    restart recovery, interaction generation/one-use/H25+H26 reuse, lease nonce/machine
    isolation, freezeIntent priority, transactional cursor/outbox rollback, snapshot
    replay, coalescing, H01 revision-bound claim, H02 no-receipt-downgrade, zc: fail-closed).
- Results: agent suite 71 passed / 2 platform-gated skips; tsc 0 errors; db.test.ts
  10/10 (real getDb bootstrap with gate); non-e2e subset failure sets IDENTICAL to clean
  baseline (20 failed / 9 files, all pre-existing), +29 new passing tests.
  Evidence: evidence/zk4-subset.log.
- Deviations from ticket text: (1) H47/H48 offline-adapter tests NOT ported (adapter
  class doesn't exist here; real client replaces it — per transplant map). (2) The
  standalone's exact-DDL comparator replaced by semantic validation (transplant map
  explicitly requires this for a different generator). (3) Startup REFUSES v1 rather
  than auto-upgrading (no v1 DBs exist in the wild for kimaki; conversion is an explicit
  function + tests). (4) Bootstrap DDL failures leave no stamp → next boot refuses via
  orphan detection (visible, manual reconcile) instead of transactional rollback of
  CREATE statements — documented limitation.
- Timestamps: agent tables use epoch-ms integers, isolated from the host datetime custom
  type; never fed into ISO parsers.
