# Kimaki × ZCode integration — session report (2026-09-17, ZAI via ZCode)

Branch `feat/zcode-integration` in worktree `C:\Dev\kimaki-zcode` (fork repo
`C:\Dev\kimaki`, not pushed anywhere). Commits: `1ba9ee1f` (plan/ZK-001), `42fd4fb4`
(ZK-002/003), `3fc31398` (ZK-004), `d159fef7` (ZK-005 partial).

## 1. Overall status

**M0 complete, M1 complete, M3's persistence core complete; M2 partially advanced.**
The hardened native core is imported and host-independent inside the real tree, the
default-off backend boundary exists with fail-closed `zc:` semantics, the full durable
sidecar runs on the real Drizzle/libSQL stack behind a pre-DDL integrity gate, and the
highest-risk ingress bypass (existing-thread OpenCode enrichment) is split by backend.
M4+ (fake-native E2E through real Kimaki) not yet reached.

## 2. Ticket summary

| ID | Title | Status | Tests | Blocker |
|----|-------|--------|-------|---------|
| ZK-001 | Baseline + drift + environment | DONE | evidence files | — |
| ZK-002 | Import native core + ported tests | DONE | 36 pass / 2 gated | — |
| ZK-003 | Backend registry + boundary seam | DONE | 8/8 | — |
| ZK-004 | Durable sidecar (Drizzle/libSQL + gate) | DONE | 29 new, all pass | — |
| ZK-005 | Ingress normalization/routing | IN_PROGRESS | 2/2 (slice) | remaining scope in ticket |
| ZK-006..ZK-014 | Preservation, wiring, renderer, interactions, controls, btw, writers, attachments, scheduling | TODO | — | none external; next in DAG |
| ZK-015 | Real-host mock-native E2E | TODO | — | ZK-005..010 |
| ZK-016 | Native certification N00–N18 | TODO | — | live gate: real launch profile + paid opt-in |
| ZK-017/018 | Fidelity validation / release gates | TODO | — | ZK-016 / release decisions |
| ZS-* | Subrouter phase | GATED | — | by design (mission gate) |

## 3. Completed implementation (running now)

```
cli/src/agent/native/   9 host-independent modules + committed supervisor.js sibling
cli/src/agent/registry.ts  backend resolution (default opencode; zc: fail-closed),
                           requireCommand guard, receiver-preserving seam
cli/src/agent/errors.ts    single host error boundary (native reexport)
cli/src/agent/sql.ts       SqlClient port + raw-libSQL adapter
cli/src/agent/schema-gate.ts  pre-DDL version/integrity gate, finalize, v1→v2 conversion
cli/src/agent/store.ts     durable admission/CAS/leases/interactions/outbox (ported)
cli/src/agent/types.ts     host-shaped contracts
cli/src/schema.ts (+159 DDL lines)  ten agent_* tables through the real generator
cli/src/db.ts              gate wiring before generic bootstrap; getRawDbClient()
cli/src/message-preprocessing.ts  resolvePreprocessBackendPlan split (ZK-005 slice)
```

## 4. Files changed

By ticket — see `git log --stat 4a36f47e..feat/zcode-integration`; grouped detail in
each `tickets/ZK-00X-*.md` completion note. No existing Kimaki table/ID/behavior changed
beyond the additive schema and the gated enrichment block.

## 5. Test results

Exact commands (in `cli/`, Node 24.15.0 / pnpm 9.15.9 / Windows 10):

- `npx tsc --noEmit` → **0 errors** (baseline had 9 pre-existing errors from the
  discord-digital-twin missing prisma client; fixed by `pnpm generate` there — its
  generate:sql step still fails P1013 on this machine, harmless, schema.sql committed).
- `NODE_ENV=test npx vitest run src/agent/...` → **73 tests: 71 pass / 2 skip**
  (win32 platform gates, visible reasons).
- Non-e2e full subset, clean tree vs with-changes (identical filters):
  baseline **20 failed / 645 passed / 3 skipped** → with all session work
  **20-21 failed / 717 passed / 5 skipped**; failing-file set identical except one
  hrana-server flake that passes 1/1 in isolation with changes present.
  All pre-existing failures are Windows-environment e2e/unit issues catalogued in
  `evidence/baseline-vitest-failures.txt` (9 non-e2e files) — not fixed, per mission.
- Hardened bundle on this machine: checksums 262/262 OK, tsc OK, suite 88 pass /
  82 fail on Windows (by-design PLATFORM_UNCERTIFIED gate + POSIX fixtures); original
  134/134 stands from its Linux environment (evidence/bundle-validation-windows.md).
- Native (vendor) tests: none run — ZK-016 gate not reached. Discord live: none.

## 6. Native certification

N00–N18: **none attempted** (live gate). zcode-acp-server@0.19.0 + ZCode desktop exist
on this machine; the certified `<node> <entry> app-server` launch profile must be
discovered/recorded at N00 before any row can pass. No capability advertised.

## 7. OpenCode regression status

**Unchanged by construction and by measurement.** Default is OpenCode everywhere; no
code path constructs anything ZCode unless a `zc:` sidecar exists (nothing creates one
yet). Measured: non-e2e failure sets byte-identical to the clean baseline across
ZK-002→ZK-005 slices. The full pinned e2e matrix re-run (ZK-006) is still TODO — this
machine's parallel e2e suite is environment-flaky (tinypool worker crashes), recorded
with logs.

## 8. Kimaki feature matrix (host integration view)

sessions PARTIAL (sidecar+persistence, no controller) · resume PARTIAL (store-level
same-SID semantics, no host restart wiring) · text/reasoning/tools NOT TESTED (renderer
is ZK-008) · interactions NOT TESTED (ZK-009) · queue PARTIAL (durable FIFO store-level)
· guide NOT TESTED · cancel PARTIAL (store fences only) · compact NOT TESTED · btw
PARTIAL (routing refusal only) · model NOT TESTED · attachments NOT TESTED · diff
UNCHANGED (host Git path untouched) · worktrees UNCHANGED (ZK-012 pending) · scheduling
NOT TESTED · restart PARTIAL (recover() store-level) · usage NOT TESTED. Native-view:
all N-rows NOT TESTED except N00-class static tooling existence.

## 9. Shared runtime status

**Host-independent and enforced.** Native graph imports only node:* + siblings; H30
boundary test scans the modules in-repo; isolated strict typecheck (`pnpm check:native`)
green; supervisor kept as internal executable (never reexported). Suitable for Subrouter
consumption later per SHARED_RUNTIME_MAP conditions; no package publication done.

## 10. Subrouter status

Not started (gated by design). Existing reference: one-shot ACP relay in
`opencode-kimaki-releases` (different layer — adapter-mediated, not the owned native
core). ZS tickets prepared in `tickets/ZS-PHASE-subrouter.md`.

## 11. Remaining tickets

ZK-005 (remaining ingress surfaces — precisely bounded in its ticket), ZK-006, ZK-007,
ZK-008, ZK-009, ZK-010, ZK-011, ZK-012, ZK-013, ZK-014, ZK-015, ZK-016, ZK-017, ZK-018,
then ZS-001…010. Each ticket file is self-sufficient (scope, invariants, acceptance,
files, tests).

## 12. External blockers

- ZK-016+: real ZCode launch-profile discovery + explicit paid-call opt-in (Cody).
- Release path to the deployed bot (release-store patch contract vs npm build) —
  Cody decision, documented in ZK-018.
- Windows native process supervision intentionally disabled (design, not a blocker).
- This machine's e2e suite flakiness (pre-existing) limits full-matrix local proof;
  deterministic non-e2e comparisons used instead.

## 13. Review hotspots

`agent/schema-gate.ts` semantic validation (vs the retired exact-DDL comparator),
`agent/sql.ts` remote-COMMIT uncertainty surface, `db.ts` gate ordering,
`agent/store.ts` transaction port onto libsql transactions, `message-preprocessing.ts`
backendPlan gating, `native/supervisor.js` mirror-sync rule when editing supervisor.ts.

## 14. Next action

Continue ZK-005 remaining scope (discord-bot `!`/`.btw` dispatch + interaction-handler
capability checks + ingress zero-OC matrix test), then ZK-006 (pinned preservation run),
then ZK-007 (coordinator/backend adaptation onto store+registry — the largest remaining
rock). Keep committing per ticket; update MASTER_PLAN statuses as each lands.
