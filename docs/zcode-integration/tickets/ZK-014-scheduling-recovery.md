# ZK-014 — Scheduling/restart/recovery integration

## Status
TODO

## Objective
Scheduled tasks and restarts preserve backend/native binding with dedupe across
restarts; recovery from uncertain states is explicit and never auto-replays.

## Why
AC29 MISSING row; G08; mission IMPLEMENT scheduling safety.

## Dependencies
ZK-007.

## Scope
- task-runner: scheduled wake produces Input with source=schedule + dedupe id; backend
  binding frozen in the thread intent before async workspace allocation (AC04).
- Sleep claim/consume ordering preserved on zc: threads (discord-bot sleep wake).
- Restart: bot restart reattaches native controllers from durable sidecar; same SID
  resume; unknown SEND_INTENT stays unknown with visible recovery state (no auto resend);
  crash windows per FAULT_MATRIX handled conservatively.
- `kimaki send --session <zc:>` CLI path resolves through the same admission.

## Explicit non-scope
- New scheduler features; retry policies beyond conservative refusal.

## Files expected to change
`cli/src/task-runner.ts`, `cli/src/discord-bot.ts` (wake), `cli/src/agent/coordinator.ts`
(recovery), CLI send session resolution.

## Invariants
Same scheduled wake never double-submits across restart; unknown delivery never retried;
failed resume never silently fresh-creates.

## Acceptance criteria
- [ ] Schedule wake dedupe test across simulated restart (store-level).
- [ ] Recovery: unknown intent surfaces locked/uncertain state; no second native task.
- [ ] tsc + baseline unchanged.

## Tests
Store/coordinator recovery tests (ported SIGKILL-intent semantics) + task-runner tests.

## Evidence
(to fill)

## Blockers
None.

## Completion notes
(to fill)
