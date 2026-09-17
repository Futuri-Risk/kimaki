# ZK-005 — Frontend ingress normalization + capability routing

## Status
IN_PROGRESS (2026-09-17, ZAI) — preprocessing slice landed; remaining scope precisely bounded below

## Objective
Route every ingress through the backend/capability policy so a ZCode session never falls
through to an OpenCode path and an OpenCode session never triggers native code, across
all entrypoints.

## Why
G01 host bypasses: `preprocessExistingThreadMessage` initializes OpenCode before voice;
`discord-bot.ts` dispatches `!`/`. btw` before runtime selection; interaction handler has
separate dispatch branches. Mission IMPLEMENT step 3; HOST_INTEGRATION §3.

## Dependencies
ZK-003.

## Scope
- Split the context-enrichment branch in `message-preprocessing.ts` by backend (keep
  text/mention/queue-suffix normalization shared).
- `discord-bot.ts`: `!` shell and `. btw` dispatch resolve backend first; `. btw` on a
  zc: thread routes to native fork capability (ZK-011 wires the capability; here the
  routing + refusal when not yet available); ordinary-message UI dismissal must not
  abort/dismiss a pending native question (answers routed as answers).
- `interaction-handler.ts`: autocomplete, slash, dynamic commands, buttons, menus,
  modals check backend + capability; native permission/question controls get their own
  opaque identity path (UI in ZK-009); machine-ownership preserved.
- Voice side sessions / new-thread helpers: backend-aware runtime selection.
- Scheduled wake + CLI-injected input (`kimaki send` paths, task-runner wake): source
  kinds tagged, backend resolved before runtime.
- Host-owned commands (e.g. /diff) keep host routing (not blanket reject).

## Explicit non-scope
- No OpenCode behavior change when backend=opencode; no ZCode UX features beyond routing.

## Files expected to change
`cli/src/message-preprocessing.ts`, `cli/src/discord-bot.ts`,
`cli/src/interaction-handler.ts`, `cli/src/commands/btw.ts` (dispatch side),
`cli/src/task-runner.ts` (source tagging), voice session helpers.

## Implementation notes
- Registry `requireCommand` from ZK-003 is the single capability dispatcher.
- `enqueueIncoming`/`maybeConvertLeadingCommand` stay OpenCode-side; native input gets
  its own typed conversion — native text must never be parsed as a host command.

## Invariants
- Zero OpenCode SDK/initialization calls on any native route (all ingress kinds).
- Arrival-order ownership (reserveThreadIngress) preserved for voice/attachment cases.
- No native command silently falls to OpenCode on missing capability — visible refusal.

## Acceptance criteria
- [ ] Unit tests: each ingress kind with backend=zcode performs no OpenCode init/SDK call
      (spy/mock assertions), and with backend=opencode behaves exactly as baseline.
- [ ] `.btw`/`!` on zc: thread handled by policy (native/refusal), not OpenCode.
- [ ] Preprocessing split tested (existing-thread zc: branch skips OpenCode enrichment).
- [ ] Baseline vitest unchanged.

## Tests
`cli/src/message-preprocessing.test.ts` (extend), `cli/src/agent/ingress-routing.test.ts`
(new), existing discord-bot/interaction tests.

## Evidence
(to fill)

## Blockers
None.

## Completion notes
- LANDED (commit after 3fc31398): the preprocessExistingThreadMessage split — the G01
  bypass fix. New pure helper `resolvePreprocessBackendPlan(sessionId)` (tested in
  `cli/src/agent/preprocess-backend-plan.test.ts`); zc: sessions now skip the
  OpenCode enrichment block entirely (no `initializeOpencodeForDirectory`, no session
  context, no agent list), get `canForkSession:false` (visible user refusal for voice
  btw), and never enter `routeVoiceSession` (no OpenCode side-session creation /
  getOrCreateRuntime). OpenCode sessions: byte-identical behavior (plan constants).
- REMAINING for DONE (next session, in order):
  1. discord-bot.ts: `!` shell + `. btw` dispatch resolve backend via
     `resolveBackend`+`SidecarLookup` before runtime work; `.btw` on zc: → native fork
     capability or visible refusal; ordinary-message UI dismissal must not abort a
     pending native question (answers routed as answers — needs the ZK-009 bridge, can
     land stubbed-refusal first).
  2. interaction-handler.ts: backend+capability checks in autocomplete/slash/dynamic/
     buttons/menus/modals branches (requireCommand from agent/registry).
  3. preprocessNewSessionMessage / preprocessNewThreadMessage gating once native
     defaults can exist (with ZK-007): consult store.freezeIntent before
     `initializeOpencodeForDirectory` at lines ~418/~521.
  4. task-runner scheduled wake + CLI-injected send: source kinds + backend resolution.
  5. Ingress matrix test: every ingress kind × backend=zcode asserts zero OpenCode
     init/SDK calls (spy on opencode.ts exports via vi.mock).
- Evidence: evidence/zk5-slice-subset.log (failure set identical to baseline except
  hrana-server.test.ts, which passes 1/1 in isolation with the changes present —
  parallel-load flake on this machine, not a regression).
