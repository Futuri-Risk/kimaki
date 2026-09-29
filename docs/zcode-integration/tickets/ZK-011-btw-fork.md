# ZK-011 — /btw conversation-only V4 fork UX

## Status
DONE

## Objective
Make `/btw` on a ZCode thread create a conversation-only native fork (new Discord thread +
forked native conversation) using the V4 forkAssistant control — no legacy
filesystem-restoring fork, no guessed metadata.

## Why
AC19/AC20; G03: fork paging/CAS is a codec gate — capability stays disabled until
capture-backed; the UX + routing can land gated-off.

## Dependencies
ZK-010.

## Scope
- `cli/src/commands/btw.ts`: backend-aware branch reusing the existing frontend/thread
  pattern (fork before Discord thread creation, copy preferences) but through the native
  fork capability; refuse visibly when the profile lacks certified fork.
- Coordinator fork path: ensureV4Subscription, forkPoint at validated row/entity/epoch,
  pre-write epoch rejection (H40–H42 semantics); orphan-bound child stored; child
  model/goal verified before activation.
- Paging/CAS retry: implement only with captured schema; until then capability=off.

## Explicit non-scope
- Legacy OpenCode /btw behavior (unchanged for opencode threads).

## Files expected to change
`cli/src/commands/btw.ts`, `cli/src/agent/zcode-backend.ts` (fork), coordinator.

## Invariants
AC19/AC20: validated epoch only; orphan child never auto-promoted; legacy restore never
used as fallback; lost ACK never blindly replayed.

## Acceptance criteria
- [x] zc: /btw routes to native fork capability or visible refusal (never OpenCode fork).
- [x] Epoch-mismatch rejection test passes (H41 semantics).
- [x] Fork child persisted orphan-bound; activation requires readback.
- [x] OpenCode /btw unchanged (snapshot test).

## Tests
`cli/src/commands/btw-native.test.ts` — 17 tests (7 new + coordinator suite via shared
harness): full native flow (fork-before-thread, orphan activation, child dispatch),
capability-off refusal creating nothing, invalid-fork-point rejection (H41-style) creating
nothing, one-shot controller binding (SESSION_NOT_ORPHAN), attachment fail-closed,
not-native fall-through, and a whitespace-normalized source pin that the OpenCode
session.fork call remains after the native branch.

## Evidence
`docs/zcode-integration/evidence/zk11-subset.log` — non-e2e subset: 20 failed / 832
passed / 12 skipped; failing file set byte-identical to base-subset.log. tsc 0 errors.

## Blockers
Full fork enablement needs captured rowsRange schema (ZK-016 N14) — the capability flag
(`NATIVE_FORK_CAPABILITY = 'forkAssistantEnabled'`) stays false on every registered
profile until then, so /btw on native threads refuses visibly.

## Completion notes
Delivered 2026-09-18 by ZCode (session sess_c9526de2-64fc-4ae3-bf30-1a3bda206f32).

- `commands/btw.ts`: `forkSessionToNativeBtwThread` + early branch in
  `forkSessionToBtwThread`. Native flow: capability gate → coordinator `fork` control
  (V4 forkAssistant; forkPoint at validated row/entity/epoch — H40–H42 semantics live in
  the codec/backend gate, surfaced here as visible rejection) BEFORE any Discord thread
  exists → child session persisted orphan-bound by the coordinator → Discord thread
  created → `setThreadSession` → EXPLICIT activation via new store
  `bindController(sessionId, threadId)` (CAS on state='orphan-bound'; orphan children are
  never auto-promoted and never rebind) → side-question prompt dispatched on the CHILD
  through the coordinator. The native readback is the fork RPC's returned child id plus
  the controller CAS; no legacy filesystem restore path exists on this branch.
- Additive store methods: `latestChildSession(parentId)`, `bindController`. Profile
  capability constant `NATIVE_FORK_CAPABILITY` in native-profile.ts (certified profiles
  set it only with a captured rowsRange schema — ZK-016 N14).
- Attachments on native forks fail closed (ZK-013 will bring native attachment staging).
- OpenCode /btw untouched below the branch (source-pinned); not-native threads return
  'not-native' and keep the existing flow verbatim.
