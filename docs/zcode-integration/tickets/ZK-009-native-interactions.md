# ZK-009 — Native interactions: questions/permissions/components

## Status
TODO

## Objective
Wire native permission/question/plan reverse requests to real authorized Discord user
responses with one-use opaque interaction IDs, generation binding, and no reuse of
OpenCode permission handlers.

## Why
G07: actor/machine/thread/generation checks injected, not implemented; AC23/AC24.
Mission invariants: no autoapprove, no LLM-answered questions, answers never converted to
ordinary session/send.

## Dependencies
ZK-007, ZK-008.

## Scope
- Interaction identity: fresh opaque UUID per native request, bound to exactly one
  outstanding native RPC + connection generation; one-use consume; repeated numeric
  native IDs get fresh opaque IDs (v2 semantics, H25/H26).
- Discord component surface (buttons/menus/modals via existing helpers; custom_id ≤100
  chars — store only the short id, resolve server-side).
- Wrong actor/thread/generation/duplicate-component denial; stale components cannot
  answer a new RPC.
- Permission policy: deny/allow-once per request (no always/pattern grouping on the
  native side — that stays OpenCode-only); explicit user answer required.
- Question forms: structured answers from captured schemas once available; unknown schema
  fails closed (feature visibly disabled until certified).

## Explicit non-scope
- OpenCode permission_once/always/reject handlers; plan-approval UX beyond schema plumbing.

## Files expected to change
`cli/src/agent/interaction-bridge.ts` (new), `cli/src/interaction-handler.ts` (routing),
`cli/src/commands/permissions.ts` + `ask-question.ts` (native branches), store interaction
consumption (from ZK-004).

## Implementation notes
- Answer replies go to the ORIGINAL native RPC id via codec.answer, never session/send.
- One-use consume must survive component double-fire (Discord can redeliver).

## Invariants
AC23/AC24 + mission interaction invariants (see MASTER_PLAN §3.7).

## Acceptance criteria
- [ ] Wrong actor/generation/stale-component denial tests pass.
- [ ] One-use consume: second component fire denied.
- [ ] Reused numeric native ID ⇒ new opaque UI token; old token cannot answer (H25/H26).
- [ ] No autoapprove path exists for native requests (negative test).
- [ ] tsc + baseline unchanged.

## Tests
`cli/src/agent/interaction-bridge.test.ts` (ported lifecycle/interaction cases + new).

## Evidence
(to fill)

## Blockers
Real plan/multiselect schemas need capture (ZK-016) — fail-closed stubs until then.

## Completion notes
(to fill)
