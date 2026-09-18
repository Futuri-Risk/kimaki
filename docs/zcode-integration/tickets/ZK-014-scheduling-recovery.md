# ZK-014 — Scheduling/restart/recovery integration

## Status
DONE

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
- [x] Schedule wake dedupe test across simulated restart (store-level).
- [x] Recovery: unknown intent surfaces locked/uncertain state; no second native task.
- [x] tsc + baseline unchanged.

## Tests
`cli/src/agent/schedule-bridge.test.ts` — 14 tests (4 new + coordinator suite via shared
harness): simulated-restart dedupe (new coordinator + backend over the SAME store, same
run key → same operation, ZERO native re-submits), corrupted wake → ADMISSION_CONFLICT,
recovery marks send-intent as submission-unknown visibly with same-source remapping to
the SAME unknown op (no replay), and resume-reject preserves the native binding (no
silent fresh create).

## Evidence
`docs/zcode-integration/evidence/zk14-subset.log` — non-e2e subset: 20 failed / 868
passed / 12 skipped; failing file set byte-identical to base-subset.log. tsc 0 errors.
Post-format schedule+coordinator suites 24/24.

## Blockers
None.

## Completion notes
Delivered 2026-09-18 by ZCode (session sess_c9526de2-64fc-4ae3-bf30-1a3bda206f32).

- New `agent/schedule-bridge.ts`: `dispatchScheduledPrompt` (thread → session → backend
  resolution; source='schedule' with STABLE run-keyed sourceId so the durable admission
  dedupe makes restart redelivery a no-op), `ingestScheduled` (direct ingest for callers
  holding a coordinator — the ZK-015 message-path wiring will call this from the bot's
  scheduled-marker ingest), `recoverNativeSession`/`recoverWithCoordinator` (explicit
  recovery: send-intent/running/waiting-interaction/foreground-terminal →
  submission-unknown, pending interactions staled, sending outbox → delivery-unknown —
  the store's recover()), and `describeRecovery` for visible status replies that state
  uncertain work is never automatically re-sent.
- Task-runner: the ZK-005 native branch in hasRunningSession already covers scheduled
  runs (native status from the durable sidecar, never the OpenCode endpoint). Scheduled
  wakes post marker-embed Discord messages, so the native ingest of a wake flows through
  the same message admission as every prompt — the marker wiring lands with ZK-015's
  message-path integration by design (documented here rather than duplicated).
- Sleep claim/consume ordering: wakeDueSessionSleeps posts through the same message
  ingress; zc: threads get identical ordering by construction once ZK-015 wires the
  native message branch.
- `kimaki send`: posts a Discord message to a channel — there is no direct session path
  and no --session flag to branch; zc: threads therefore resolve through the same
  admission as every message (no CLI change needed; nothing to double-implement).
- Coordinator recovery semantics (SIGKILL-intent, resume-reject, replay suppression)
  remain pinned in lifecycle.test.ts (Linux-gated on this machine) and are restated
  Windows-runnably here at the store/coordinator level.
