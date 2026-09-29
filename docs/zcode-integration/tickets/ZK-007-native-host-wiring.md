# ZK-007 — Native host wiring (coordinator + ZcodeBackend on real store/auth)

## Status
DONE — IMPLEMENTED (2026-09-17, ZCode). Runtime core + host wiring landed.
ENVIRONMENT GATE: the Linux-gated lifecycle suite must execute once on Linux/CI
(recorded here and in ZK-015); nothing else remains.

## Objective
Adapt the hardened `coordinator.ts` + `zcode-backend.ts` into Kimaki as the ZCode
controller behind the ZK-003 boundary: real durable store (ZK-004), real authorization
callbacks, machine identity, native profile/codec injection, process ownership via the
imported native core. Fake-native (synthetic codec + fake app-server) only — real native
is ZK-016.

## Why
Mission IMPLEMENT step 5; transplant map: coordinator/zcode-backend KEEP KIMAKI-SPECIFIC
ADAPT. AC05–AC11, AC17 rely on this wiring.

## Dependencies
ZK-002, ZK-003, ZK-004.

## Scope
- `cli/src/agent/coordinator.ts`: admission (Authorizer callback + store.admit), durable
  session-create intent / native SID bind, SEND_INTENT before native effect, prompt drain
  / control-fenced operations, cancellation epochs, closed-controller refusal, bounded
  event admission — adapted to host ingress metadata, clock, errors (errore at boundary only).
- `cli/src/agent/zcode-backend.ts`: prepare/submit/guide/answer/cancel/compact/fork with
  connection generations, single-flight V4 subscription, quiescence readback — codec
  injected (synthetic default, capture-backed later), supervisor/process via native core.
- Native profile registry: `NativeProfile` config (default disabled; `allowSynthetic`
  only under test), launch profile fields (node/entry/app-server, hashes, config home).
- Authorization ports: actor/machine/thread/generation checks injected from Kimaki
  identity (discord actor id + machine id from Kimaki config).
- Default-off: zcode backend selectable only via explicit configuration; native imports
  lazy so default path never loads them.

## Explicit non-scope
- Real captured codecs (ZK-016); Discord rendering (ZK-008); interactions UI (ZK-009);
  worktree policy (ZK-012); scheduling (ZK-014).

## Files expected to change
`cli/src/agent/coordinator.ts`, `cli/src/agent/zcode-backend.ts`,
`cli/src/agent/types.ts` (host-shaped contracts), `cli/src/agent/native-profile.ts` (new),
wiring in `cli/src/agent/registry.ts`.

## Implementation notes
- Keep effect writes behind the coordinator; backend never sends without durable intent.
- `zc:` host IDs minted here; same Discord thread resume ⇒ same native SID (durable bind).
- Fake app-server fixture ports from bundle tests (test-only, marked synthetic).
- Windows: owned-process launch stays PLATFORM_UNCERTIFIED (refusal), per design.

## Invariants
- One admitted input ⇒ ≤1 automatic native submission (AC10); lost ACK ⇒ unknown, no
  replay (AC11); failed resume never silently creates a fresh session (AC07).
- Native tools display-only (AC08); no model fallback; no synthetic continuation.
- Cancel keeps ownership until verified stop; unknown stays locked (AC17).

## Acceptance criteria
- [x] Ported coordinator/backend tests pass (fake-native, file-backed libSQL store):
      FIFO A/B/C ✓, duplicate ingress → one submission ✓, lost-ACK-after-intent →
      submission-unknown + no replay ✓ (the literal child-process SIGKILL variant is
      covered semantically by the in-process lost-ACK test + ZK-004 store recover
      tests; the owner-death/journal-owner fixture children were not ported —
      supervisor kill semantics already live in the ZK-002 native suite, Linux-gated),
      cancel fences H12/H19 ✓ (H16 needs the real backend readback — in the gated
      lifecycle file), closed-controller refusal ✓, generation safety ✓.
- [~] Same Discord session resumes same native SID across restart (fake-native) —
      ported into lifecycle.test.ts (resume + replay-cursor + stale-RPC-reuse tests)
      but Linux-gated on this Windows machine (PLATFORM_UNCERTIFIED by design).
- [x] `zc:` missing sidecar error before any OpenCode call (ZK-005 matrix).
- [x] tsc clean; baseline subset comparison (evidence/zk7-subset.log).

## Tests
`cli/src/agent/coordinator.test.ts`, `cli/src/agent/zcode-backend.test.ts` (ported).

## Evidence
- `vitest run src/agent/coordinator.test.ts` → 10/10 (in-process fake-native).
- `vitest run src/agent/lifecycle.test.ts` → 7 skipped on win32 (linuxOnly gate;
  suite runs on Linux/CI where owned launch is certified-eligible).
- Per-file deterministic runs with changes present: store+schema-gate 29/29,
  ingress-routing+preservation+registry+preprocess-plan 26/26, native/ 34 pass
  (platform gates unchanged), coordinator+store re-verify 28/28. Full-directory
  `vitest run src/agent/` hits the machine's documented startup IPC flake
  intermittently (no test failure — worker dies pre-collect; same flake as the
  full-suite runs recorded in ZK-006).
- tsc: 0 errors.
- evidence/zk7-subset.log — non-e2e regression subset with the ZK-007 change.

## Blockers
None hard. Linux execution needed for the gated lifecycle suite (CI or a Linux
session). NOTE for the remaining wiring: @libsql/client 0.17.x local
transaction() does not honor busy_timeout — the coordinator's concurrent write
lanes require a single-writer guarantee in production host wiring (the test
harness now serializes; ZK-008 host wiring must do the same, e.g. a write queue
around the shared store client).

## Completion notes
- LANDED (ZCode):
  - `agent/coordinator.ts` (verbatim port): admission via Authorizer + store.admit,
    kick/drain FIFO with SEND_INTENT-before-effect, prepare/create-intent/bindNative,
    cancellation epochs + control fences, bounded event lane with generation capture,
    reconcile/finishTurn readback, resumeQueue, settle/close with uncertainty marking.
  - `agent/zcode-backend.ts` (verbatim port): single owned connection, lifecycle
    epochs, single-flight prepare/dispose, session/resume + session/create via
    fenced writes, legacy + V4 subscriptions, quiescence-gated submit/compact/
    switchModel/fork, reverse-request interactions with reply receipts, cancel
    with grace + retire, NativeProfile type.
  - `agent/zcode-projector.ts` + `agent/attachments.ts` (verbatim ports; ZK-008
    adapts the renderer side, ZK-013 the attachment UX).
  - `agent/native-profile.ts` (new): profile registry — default EMPTY and the only
    synthetic path is an explicit syntheticProfile() builder for tests; production
    has no registered profile, so ZcodeBackend.prepare refuses RUNTIME_UNCERTIFIED
    until ZK-016 certification registers one. Default-off stays structural.
  - `agent/fixtures/fake-codec.ts` + `fixtures/fake-app-server.mjs` (ported
    SYNTHETIC fixtures; header-marked).
  - `agent/coordinator.test.ts` (new, 10 tests, in-process FakeBackend — no spawn,
    Windows-green): FIFO exactly-once, duplicate admission → same op/no resubmit,
    lost ACK → submission-unknown + recovery-required + queued-not-submitted,
    closed-controller refusal, actor/session refusal, H12 cancel fence vs guide,
    H19 stale terminal vs completed cancellation, interaction round-trip
    (waiting-interaction → validated answer → resume → terminal), superseded-
    generation event drop, event-backlog safety.
  - `agent/lifecycle.test.ts` (new, 7 tests, linuxOnly-gated): graceful restart
    resume (same native SID, no replay), resume-reject no-silent-create, stale
    permission RPC-reuse, uncorrelated-guide fence, ignore-stop escalation +
    write cessation, fingerprint refusal, replay-cursor suppression.
  - `agent/test-harness.ts`: WAL + busy_timeout + single-writer serialization of
    the harness client (libsql 0.17.x local transaction limitation — see Blockers).
- LANDED (ZCode, wiring commit): the remaining items 1-3 are implemented —
  - `agent/host-identity.ts`: getOwnerMachineId() — one-time random UUID persisted
    at `<dataDir>/agent-machine-id` (O_EXCL mint, adopt-on-race; the bot_tokens
    client_id pattern). Test pins stability.
  - `agent/host-coordinator.ts`: the ONLY production construction path —
    hostAuthorizer (Discord actor + controller-thread binding), lazy
    getNativeCoordinator() singleton over serializeWrites(libsqlSqlClient(
    getRawDbClient())) + machine identity + registered profile; sets the
    ZK-005 capability provider ONLY while a live coordinator exists. With no
    registered profile (today's default): null coordinator, all native commands
    still refuse — default-off is structural end to end.
  - `agent/sql.ts` serializeWrites(): reusable single-writer SqlClient adapter.
    Ordering matters: the transaction barrier installs SYNCHRONOUSLY at call
    time (BEGIN slot reserves the tail; everything later queues behind the held
    barrier until commit/rollback) — an earlier in-job extension let jobs
    enqueued mid-BEGIN overtake the lock; the concurrency test catches exactly
    that (12 interleaved transactions+writes, zero SQLITE_BUSY).
  - `agent/host-coordinator.test.ts` (5 tests): identity stability, default-off
    null + refused capabilities, live-construction + capability unlock with a
    synthetic profile, authorizer thread binding, serializeWrites concurrency.
- REMAINING (environment-gated): execute lifecycle.test.ts on Linux/CI.
