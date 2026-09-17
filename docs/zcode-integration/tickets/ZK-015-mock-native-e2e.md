# ZK-015 — Real-host mock-native E2E matrix

## Status
TODO

## Objective
Prove the whole chain on the real tree with a fake app-server: actual Kimaki coordinator,
real Drizzle/libSQL, real command routing, digital-discord — zero OpenCode on native
routes, exactly one native side effect per admission, restart persistence, generation
safety, cancellation safety, migration correctness, receipt behavior, default-off unchanged.

## Why
Mission IMPLEMENT step 8; HOST_INTEGRATION §8; definition of host-integration complete.

## Dependencies
ZK-005, ZK-006, ZK-007, ZK-008, ZK-009, ZK-010 (ZK-011..014 features included where landed).

## Scope
- E2E file(s) using the repo's e2e conventions (deterministic providers, DigitalDiscord,
  isolated data dirs, snapshot assertions on Discord text).
- Scenarios: native thread create → text/tool turn → footer; queue follow-up FIFO;
  permission deny/allow-once; question round-trip; cancel mid-run; restart → same SID
  resume; duplicate ingress → one submission; migration from old-schema DB; outbox
  receipt on send failure; default-off bot start behaves exactly as OpenCode baseline.
- Assert zero calls into OpenCode SDK/initialization for native routes (spy at the seam).

## Explicit non-scope
- Real native binary (ZK-016); real Discord guild (human-gated).

## Files expected to change
`cli/src/agent/zcode-e2e.test.ts` (new; possibly split per repo's ≤10s/file rule).

## Implementation notes
- Reuse bundle `tests/fixtures/fake-app-server.mjs` as the child fixture (test-only,
  provenance-labeled synthetic).
- Keep files under ~10s; use the repo wait-helper conventions (4s polls, 100ms interval).

## Invariants
All MASTER_PLAN §3 invariants exercised end-to-end.

## Acceptance criteria
- [ ] All listed scenarios pass on Windows-capable subset (owned-process scenarios may be
      Linux-gated; the fake app-server must be spawnable on win32 without the owned
      launcher where the test targets coordinator behavior).
- [ ] Zero-OC-call assertion green; default-off comparison green.
- [ ] Full suite: no new failures vs baseline.

## Tests
The e2e files themselves.

## Evidence
(to fill)

## Blockers
None expected.

## Completion notes
(to fill)
