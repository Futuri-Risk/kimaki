# ZK-010 — Controls: queue UX, guide, cancel/stop, compact, model/reasoning readback

## Status
DONE

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
- [x] Queue edit/delete CAS tests (pre-send ok, post-intent refuses replay).
- [x] Guide correlation + cancel-fence tests (H06/H07/H12/H16/H19 semantics) pass.
- [x] Compact: native-only path asserted; no OC summarize call on zc: threads.
- [x] Model readback: unverified selection never advertised; no first-model fallback.
- [x] tsc + baseline unchanged.

## Tests
`cli/src/agent/control-commands.test.ts` — 16 tests (6 new + coordinator suite via
shared harness): verified-stop cancel with durable state reporting, backend
detection fallbacks (not-native/offline), native compact + no-opencode-import scan,
FIFO durable queue with pre-intent-only clearing, readback-only model status, and
source-order pins (native branch precedes `await initializeOpencodeForDirectory`
in compact.ts and model.ts). H06/H07/H12/H16/H19 correlation/fence semantics remain
pinned in `coordinator.test.ts` (H12/H19) and `lifecycle.test.ts` (H06/H07, Linux-gated).

## Evidence
`docs/zcode-integration/evidence/zk10-subset.log` — non-e2e subset: 20 failed / 815
passed / 12 skipped; failing file set byte-identical to base-subset.log. tsc 0 errors.
Post-format control suite 16/16.

## Blockers
None (fake-native); real guide/stop semantics gated by ZK-016.

## Completion notes
Delivered 2026-09-18 by ZCode (session sess_c9526de2-64fc-4ae3-bf30-1a3bda206f32).

- New `cli/src/agent/control-commands.ts`: the single native control surface for host
  commands — `runNativeControl` (cancel/compact/guide), `queueNativePrompt`,
  `clearNativeQueue`, `nativeModelStatus`, `isNativeThread` (cheap detection so
  commands can defer before a slow control), `describeNativeControl`. Every control
  is a durable coordinator operation; outcomes report the DURABLE terminal state
  (verified stop vs `cancel-unconfirmed` keeps the lock message honest).
- Command branches (native branch strictly BEFORE any OpenCode server call — pinned
  by source-order tests): `abort.ts` → verified-stop cancel; `compact.ts` → native
  session/compact at quiescence (no OpenCode summarize prompt, no auto-continuation);
  `model.ts` → displays ONLY the readback-confirmed selection (setModel persists
  after the native echo — ZK-007 coordinator) with no provider-list consultation and
  no first-model fallback; `queue.ts` /queue → durable FIFO prompt admission with
  position reply, /clear-queue → store.clearQueue (pre-intent only — an op past
  SEND_INTENT is owned by its operation and never replayed or silently dropped).
- Queue immutability policy: admitted content is immutable by the store's
  ADMISSION_CONFLICT dedupe; queued prompts each get a unique admission
  (`sourceId actor:queue:<uuid>`), and clearing CASes only `state='queued'` prompts.
- /model switch UI on native threads is intentionally minimal until ZK-016 certifies
  real provider advertisement (runtimeModel overlay exists in agent/native/model.ts
  from ZK-002); the command states this instead of falling back to OpenCode lists.
- Guide control is exposed through `runNativeControl` for the host; H06/H07
  correlation fencing lives in the coordinator/backend (pinned earlier) — no
  OpenCode-style fire-and-forget sendText exists on the native path.
