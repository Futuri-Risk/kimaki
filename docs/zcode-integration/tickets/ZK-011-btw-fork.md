# ZK-011 — /btw conversation-only V4 fork UX

## Status
TODO

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
- [ ] zc: /btw routes to native fork capability or visible refusal (never OpenCode fork).
- [ ] Epoch-mismatch rejection test passes (H41 semantics).
- [ ] Fork child persisted orphan-bound; activation requires readback.
- [ ] OpenCode /btw unchanged (snapshot test).

## Tests
Ported fork tests + btw command branch tests.

## Evidence
(to fill)

## Blockers
Full fork enablement needs captured rowsRange schema (ZK-016 N14).

## Completion notes
(to fill)
