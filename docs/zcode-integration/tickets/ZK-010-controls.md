# ZK-010 — Controls: queue UX, guide, cancel/stop, compact, model/reasoning readback

## Status
TODO

## Objective
Implement the native control surface with durable semantics: host FIFO queue UX
(edit/delete policy via CAS), text guidance, verified stop, native compact, and
model/reasoning selection with explicit readback — never OpenCode-style behaviors.

## Why
AC14–AC18, AC21; transplant map control rows; mission IMPLEMENT steps + invariants
(no retryLastUserPrompt for zc:, no OC summary prompt for compact).

## Dependencies
ZK-007.

## Scope
- Queue: durable pre-send CAS edit/delete (immutable revision policy); post-SEND_INTENT
  edits never replay; user-visible status accurate.
- Guide: sendText with requestedDelivery:"guide" through the V4 publisher; accepted ≠
  applied; correlation via guide operation + generation (H06/H07); attachments refused.
- Cancel/stop: V4 stop + cancelBackgroundTask + readback; ownership retained until
  verified writer cessation; unknown stays locked; supervisor result honored.
- Compact: session/compact at native quiescence; serialized controls; no summary prompt,
  no auto-continuation.
- Model/reasoning: native model overlay builder (native/model.ts), setThoughtLevel with
  advertised values only, readback verification; no fallback mapping; /model on zc:
  threads uses this path — never retryLastUserPrompt.

## Explicit non-scope
- Fork (ZK-011); background/goal settlement beyond stop-safety (ZK-016 N12).

## Files expected to change
`cli/src/agent/coordinator.ts` (controls), `cli/src/commands/compact.ts` (backend branch),
`cli/src/commands/model.ts` (backend branch), queue helpers.

## Implementation notes
- Guide completion must match host session + operation kind + connection generation.
- `/model` on zc: = explicit readback semantics: applied only when native confirms.

## Invariants
AC14–AC18, AC21; MASTER_PLAN §3.4/3.5/3.8.

## Acceptance criteria
- [ ] Queue edit/delete CAS tests (pre-send ok, post-intent refuses replay).
- [ ] Guide correlation + cancel-fence tests (H06/H07/H12/H16/H19 semantics) pass.
- [ ] Compact: native-only path asserted; no OC summarize call on zc: threads.
- [ ] Model readback: unverified selection never advertised; no first-model fallback.
- [ ] tsc + baseline unchanged.

## Tests
Ported control tests + command branch tests.

## Evidence
(to fill)

## Blockers
None (fake-native); real guide/stop semantics gated by ZK-016.

## Completion notes
(to fill)
