# ZK-015 — Real-host mock-native E2E matrix

## Status
IN PROGRESS

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
**Wiring slice committed 2026-09-18** (see Completion notes): 17/17 in
`cli/src/agent/message-ingest.test.ts` over the real coordinator with a fake Discord
client; tsc 0 errors; non-e2e subset 20 failed / 885 passed / 12 skipped with the
failing file set byte-identical to base-subset.log
(`docs/zcode-integration/evidence/zk15-wiring-subset.log`).

**Remaining for full close**: the DigitalDiscord e2e file(s) (real bot loop with a
registered synthetic profile + fake-app-server child through the runtime-launcher seam),
zero-OC spy assertion inside the e2e run, and the default-off bot-start comparison.

## Blockers
None expected.

## Completion notes
**Wiring slice (2026-09-18, ZCode sess_c9526de2-64fc-4ae3-bf30-1a3bda206f32):**

- `agent/message-ingest.ts` (new): the single native message admission —
  `ingestNativeThreadMessage` (source discord/cli/schedule with stable sourceKey =
  Discord message id / schedule run key; attachments staged through the hardened
  pipeline into `{attachments}` payloads; fire-and-forget bounded outbox flush),
  `ingestScheduledMessage` (run-keyed schedule admission), `ensureNativeThreadSession`
  (freezeIntent → zcode → `store.createNativeSession` with the profile's certified
  defaultModel — refuses rather than inventing a model; thread binding via
  upsertThreadSession), real Discord renderer ports (nonce sends, edit/delete,
  bounded-recent verify), and the `setNativeDiscordClient` seam (default null = inert).
- `discord-bot.ts`: native thread messages branch AFTER the ZK-005 gate allow and
  BEFORE any runtime construction — sleep wakes still claim their row first; scheduled
  marker messages map to source 'schedule' with `schedule-run:<id>` dedupe keys; CLI
  prompts map to source 'cli'. Bot startup registers the native Discord client and the
  interaction bridge's real thread resolver.
- Store (additive): `createNativeSession` (zc: id, host-resolved workspace binding,
  machine-scoped native home identity, controller = the thread, starts unbound).
  NativeProfile gained optional `defaultModel` (synthetic profiles pin a fixture
  default; certified profiles pin the real one).
- Default-off preserved: without a registered profile, getNativeCoordinator() is null →
  the ZK-005 gate refuses messages visibly and ingestNativeThreadMessage returns
  'offline'; nothing constructs an OpenCode runtime for zc: threads (pinned by test).

**Planned next slice**: DigitalDiscord e2e (real bot + synthetic profile + spawned
fake-app-server via a test runtime-launcher seam that bypasses the win32
PLATFORM_UNCERTIFIED owned launcher — coordinator-behavior scenarios only), zero-OC
spy, default-off comparison, migration-from-old-schema scenario.
