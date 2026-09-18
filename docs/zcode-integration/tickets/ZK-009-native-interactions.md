# ZK-009 — Native interactions: questions/permissions/components

## Status
DONE

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
- [x] Wrong actor/generation/stale-component denial tests pass.
- [x] One-use consume: second component fire denied.
- [x] Reused numeric native ID ⇒ new opaque UI token; old token cannot answer (H25/H26).
- [x] No autoapprove path exists for native requests (negative test).
- [x] tsc + baseline unchanged.

## Tests
`cli/src/agent/interaction-bridge.test.ts` — 23 tests (13 new + 10 coordinator suite re-run
through the shared harness import): codec round-trips/garbage, fail-closed schema shaping
(7 unsupported cases), permission/question/plan round-trips over the REAL coordinator,
double-fire, wrong actor, foreign thread/unknown ids, H25/H26, no-autoapprove (negative),
expired-at-consume, question collection-until-complete.

## Evidence
`docs/zcode-integration/evidence/zk9-subset.log` — non-e2e subset: 20 failed / 799 passed /
12 skipped; failing file set byte-identical to base-subset.log. tsc 0 errors. Post-format
bridge suite 23/23; touched suites (bridge/coordinator/host-coordinator/preservation/ingress)
56/56.

## Blockers
Real plan/multiselect schemas need capture (ZK-016) — fail-closed stubs until then (the
`unsupported` view renders a visible notice with NO answerable component).

## Completion notes
Delivered 2026-09-18 by ZCode (session sess_c9526de2-64fc-4ae3-bf30-1a3bda206f32).

- `agent/interaction-bridge.ts` (new): prompt-view shaping + `zci:` custom-id codec (≤100
  chars; question ids that do not fit fail closed) + `InteractionBridge` over the REAL
  coordinator + `createDiscordInteractionPorts` adapter (buttons/selects, NOTIFY flags,
  allowedMentions parse:[]) + `handleNativeInteractionComponent` ingress helper.
- **Answers are one native RPC reply, never session/send**: bridge → `coordinator.ingest(
  kind:'answer')` → codec validation → durable one-use consume (thread+generation+pending+
  unexpired CAS) → backend.answer to the ORIGINAL RPC id. Ingest acceptance ≠ success: the
  bridge settles and reads the op's terminal state; non-completed → `ANSWER_REJECTED`.
- **Question semantics discovered**: the native codec answers the WHOLE question RPC at
  once (every question must have a value), so the bridge collects per-question select fires
  (`submitted:false` until complete) and submits ONE answer — mirroring the OpenCode
  ask-question collect-then-reply flow. Options double as Discord select values so what a
  user picks is byte-identical to what the codec validates; duplicate/oversized options or
  non-fitting question ids fail closed.
- **H25/H26 + admission identity discovery**: `agent_operations` has a UNIQUE
  (session, source, source_id, kind) index — a second answer by the same actor in one
  session collided (ADMISSION_CONFLICT/SQLITE_CONSTRAINT). Fixed at the identity layer:
  answer ops use `sourceId = actorId:interactionId`, so every fresh opaque token is a
  distinct operation and dedupe stays exact for double-fires. Store file untouched.
- No autoapprove and NO timeout auto-answer: an expired request simply stays unanswered
  (negative test). This deliberately diverges from OpenCode permissions' TTL auto-reject —
  an automatic answer is an answer.
- Additive backend seam: `ZcodeBackend.onHostEvent` — an independent, error-isolated
  observer tap (the coordinator owns the single `onEvent` slot). host-coordinator wires
  `backend.onHostEvent → bridge.handleNativeEvent` behind the default-off coordinator.
- Routing: `interaction-handler.ts` routes `zci:` buttons AND select menus to
  `handleNativeInteractionComponent` (resolves the channel's session, refuses non-native
  channels and absent coordinator visibly). `commands/permissions.ts` + `ask-question.ts`
  needed NO changes: every OpenCode component entry (permission_once/always/reject,
  ask_question:) is already gate-refused on native sessions at the single ingress policy
  point (ZK-005 `RUNTIME_COMPONENT_COMMANDS`), and adding duplicate guards there would be
  dead code.
- Known race (documented in code): a component fired in the milliseconds before the
  coordinator's event lane persists a fresh interaction gets ANSWER_REJECTED; the prompt
  stays offered and a retry works. Humanly unreachable; self-healing.
