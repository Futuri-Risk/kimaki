# ZK-008 — Renderer + projector integration with existing Kimaki Discord helpers

## Status
TODO

## Objective
Project native rows/events to Kimaki display parts and deliver output through the
existing formatter/split/send/edit helpers with durable receipt groups and uncertain-REST
reconciliation — no parallel Discord renderer.

## Why
G07: standalone renderer exposes one send receipt, not edit/split groups; transplant map:
renderer ADAPT onto discord-utils; projector stays host-side, OpenCode projector unchanged.

## Dependencies
ZK-007.

## Scope
- `cli/src/agent/zcode-projector.ts` (adapted): native rows → host DisplayPart
  (text/reasoning/tool/shell), stable IDs, bounded buffers; presentation-only — never
  terminal-state inference.
- `cli/src/agent/renderer.ts` (adapted): outbox flush through Kimaki send/split/edit
  helpers (`discord-utils.ts`, `message-formatting.ts`), receipt groups for split/edit,
  exact-revision receipts (H01/H02), delivery-unknown reconciliation via verified lookup
  (nonce lookup miss ≠ non-delivery; never authorizes resend/native task).
- Verbosity rules reused from host (default skips thinking/file-reads/non-sideEffect bash).

## Explicit non-scope
- No changes to OpenCode rendering path; no Components-V2 experiments here.

## Files expected to change
`cli/src/agent/zcode-projector.ts`, `cli/src/agent/renderer.ts`, small ports in
`cli/src/discord-utils.ts` if a seam is needed (additive only).

## Implementation notes
- Discord nonce ≤25 chars (repo rule) — derive stable nonce from delivery id.
- Repeated tails replace rather than append (bundle projector semantics) to match Kimaki
  edit-in-place behavior.

## Invariants
- Receipt describes the exact sent revision; confirmed delivery never downgraded.
- Uncertain REST outcome never triggers a resend or new native task.

## Acceptance criteria
- [ ] Projector tests: snapshot/rows deltas, repeated-tail replacement, bounded buffers,
      stale-row non-resurrection (H08/H35 semantics), presentation ≠ completion.
- [ ] Renderer tests: split/edit receipt group atomic claim/receipt; uncertain outcome
      stays delivery-unknown and reconciles via lookup.
- [ ] tsc + baseline unchanged.

## Tests
`cli/src/agent/zcode-projector.test.ts`, `cli/src/agent/renderer.test.ts` (ported).

## Evidence
(to fill)

## Blockers
None.

## Completion notes
(to fill)
