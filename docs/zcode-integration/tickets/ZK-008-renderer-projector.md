# ZK-008 — Renderer + projector integration with existing Kimaki Discord helpers

## Status
DONE

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
- [x] Projector tests: snapshot/rows deltas, repeated-tail replacement, bounded buffers,
      stale-row non-resurrection (H08/H35 semantics), presentation ≠ completion.
- [x] Renderer tests: split/edit receipt group atomic claim/receipt; uncertain outcome
      stays delivery-unknown and reconciles via lookup.
- [x] tsc + baseline unchanged.

## Tests
`cli/src/agent/zcode-projector.test.ts` (12), `cli/src/agent/renderer.test.ts` (13).

## Evidence
`docs/zcode-integration/evidence/zk8-subset.log` — non-e2e subset: 20 failed / 776 passed
/ 12 skipped, failing file set byte-identical to `evidence/base-subset.log` (20 failed /
645 passed / 3 skipped + prior ZK-005/006/007 additions: +106 tests, +9 skips). tsc 0
errors. Post-format re-run of both new suites: 25/25.

## Blockers
None.

## Completion notes
Delivered 2026-09-18 by ZCode (session sess_c9526de2-64fc-4ae3-bf30-1a3bda206f32). What
was built and the deviations from the naive port:

- `agent/renderer.ts` — `OutboxRenderer` adapted, not copied: delivery is now a
  **message group** (split via the shared `prepareThreadMessageChunks`), and a later
  revision of the same display part **edits the previous group in place** (repeated
  tails replace, never append), extending with new chunk sends when the split grows and
  deleting surplus messages when it shrinks. Receipts store the group as comma-joined
  ids; the exact-revision claim (H01) and no-downgrade receipt (H02) come from the
  ZK-007 store, pinned here through the renderer.
- Reconciliation is a **verified lookup** (`ports.verify` with per-chunk nonce probes
  for fresh sends and id+content probes for edits — Discord edits cannot carry a
  nonce). All chunks must verify before a receipt; a bounded-search miss keeps the row
  delivery-unknown and never authorizes a resend or native task.
- Formatting reuses the host `formatPart` through a small DisplayPart→Part adapter
  (bash input parsed best-effort from the running tool's serialized input so bash
  titles work); file-change parts render with the host `◼︎ ` prefix. Verbosity rules
  are the host's own: `isEssentialToolName`/`isEssentialToolPart`/`HIDDEN_READONLY_TOOLS`
  moved verbatim to `message-formatting.ts` (re-exported from
  `thread-session-runtime.ts` — public API unchanged) so the renderer reuses the exact
  rule without importing the runtime graph.
- Additive seams: `prepareThreadMessageChunks` + `DISCORD_MESSAGE_MAX_LENGTH` in
  `discord-utils.ts` (`sendThreadMessage` refactored to call it — behavior-identical;
  only its split log line now reads the pre-transform length); `suppressOutbox` +
  `sentGroup(threadId, partId, beforeRevision)` on the agent store.
- Store semantics that shaped this: `view()` creates outbox rows only for
  non-streaming live parts, so edit-in-place fires for tool running→done transitions
  and re-emitted done parts; `delivery-unknown` payloads are frozen (coalescing only
  touches pending rows), so reconcile-time chunk recomputation is deterministic.
- Nonces: `discordNonce(outboxId + '#' + chunkIndex)` — sha256 hex, 25 chars, per-chunk.
- Known accepted edges (documented in renderer.ts): verbosity changes between an
  uncertain attempt and its reconcile leave the row unknown (probe mismatch → no
  receipt); host wiring for `flush()` cadence, the real `verify` implementation
  (recent-message fetch), and Discord port adapters is deferred to the interaction/
  wiring tickets (ZK-009+), as planned.
