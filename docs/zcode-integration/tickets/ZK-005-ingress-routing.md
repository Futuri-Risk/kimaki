# ZK-005 — Frontend ingress normalization + capability routing

## Status
DONE (2026-09-17, ZCode) — all ingress kinds gated; see completion notes. Item 3
(new-session defaults gating) deliberately folded into ZK-007 where native
defaults first become possible — no host path can mint a zcode default today.

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
- [x] Unit tests: each ingress kind with backend=zcode performs no OpenCode init/SDK call
      (spy/mock assertions), and with backend=opencode behaves exactly as baseline.
- [x] `.btw`/`!` on zc: thread handled by policy (native/refusal), not OpenCode.
- [x] Preprocessing split tested (existing-thread zc: branch skips OpenCode enrichment).
- [x] Baseline vitest unchanged.

## Tests
`cli/src/message-preprocessing.test.ts` (extend), `cli/src/agent/ingress-routing.test.ts`
(new), existing discord-bot/interaction tests.

## Evidence
- evidence/zk5-final-subset.log — full non-e2e subset with the complete ZK-005
  change; failure file set byte-identical to the recorded baseline.
- evidence/zk5-slice-subset.log — earlier preprocessing-slice-only run.
- `npx vitest run src/agent/` → 8 files, 85 passed / 2 skipped (Windows
  platform-gated) including the new 12-test ingress matrix.

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
- LANDED (ZCode, this commit) — remaining scope 1/2/4/5:
  - `agent/host-sidecar.ts` (new): read-only ownership-free sidecar projections —
    `lookupBackendSidecar(sessionId)` (agent_sessions.backend_type) and
    `countActiveNativeOperations(sessionId)` (non-terminal agent_operations count).
    Routing needs WHICH backend owns a session, never WHETHER this machine may drive
    it (that is ZK-008's ownership preflight); the AgentStore stays the only writer.
  - `agent/ingress-gate.ts` (new): single policy point. `resolveIngressBackend`
    (resolveBackend + sidecar lookup; zc: without a sidecar throws
    SESSION_SIDECAR_MISSING — integrity failure, never OpenCode), sync gates
    `gateThreadMessage` (ordinary messages/wakes/CLI prompts on zc: → visible
    NATIVE_RUNTIME_UNAVAILABLE refusal) and `gateThreadCommand` (requireCommand with
    the capability provider seam — `setNativeCapabilityProvider` is ZK-008's hook,
    default `() => false` so every native command is an honest visible refusal
    today), classification sets (`RUNTIME_SLASH_COMMANDS`, `-cmd/-skill/-mcp-prompt/
    -agent` suffixes, `RUNTIME_AUTOCOMPLETE_COMMANDS`, `RUNTIME_COMPONENT_COMMANDS`
    mapping component prefixes → canonical command names), and
    `resolveThreadBackendByChannelId` (thread_sessions → backend via getThreadSession).
    Host-owned interactions (diff, worktrees, projects, tasks, login/credentials,
    uploads, html actions, modals, run-shell-command, screenshare, vscode,
    upgrade) are deliberately NOT classified runtime — they keep host routing.
  - `discord-bot.ts` thread branch: resolves `threadBackend` once before any
    dispatch. `!` shell = host-owned capability (runs in the thread workspace, no
    agent runtime) — stays available on zc: threads with a log line. `.btw` →
    gateThreadCommand('btw') → visible refusal (native fork is ZK-011). CLI-injected
    sends with a `parentSessionId` resolve the PARENT's backend → gateThreadCommand
    ('fork') refusal for zc: parents. Ordinary messages (incl. voice-derived,
    sleep wakes, CLI prompts) → gateThreadMessage refusal BEFORE getOrCreateRuntime
    and before dismissSourceUi — no OpenCode runtime object is ever created for a
    zc: thread, and no OpenCode abort path can fire (native question answers are
    ZK-009's opaque-identity bridge; no native interaction can exist yet).
  - `interaction-handler.ts`: one uniform gate after the machine-ownership check,
    before every branch: runtime-classified slash/autocomplete/component interactions
    resolve the thread backend and refuse visibly (ephemeral reply; autocomplete
    responds empty). Autocomplete feeds for host commands (new-session,
    add/remove-project, worktrees) are not gated.
  - `task-runner.ts` `hasRunningSession`: zc: run rows consult
    countActiveNativeOperations and finalize/finish via the sidecar — the OpenCode
    session.status endpoint is never asked about a native session. Source-kind
    plumbing (sessionStartSource, isSleepWake, isCliInjectedPrompt) already flows
    through ingress payloads; mapping to Input.source ('discord'|'schedule'|'cli')
    happens at native admission (ZK-008).
  - `agent/ingress-routing.test.ts` (new, 12 tests): the ingress matrix — every
    ingress kind × backend=zcode (ordinary message, .btw, runtime slash set,
    autocomplete feeds, components incl. permission/model/fork/action buttons,
    thread-mapping resolution, end-to-end preprocessExistingThreadMessage on a zc:
    thread, scheduled-task zc: concurrency) asserts refusal/gating with ZERO
    initializeOpencodeForDirectory calls (vi.mock spy); baselines (opencode session,
    no session) assert allow; the opencode scheduled-run branch still queries the
    status endpoint (branch selection is backend-driven, not blanket); capability
    seam test proves a ZK-008 provider unlocks exactly the commands it declares.
- ITEM 3 (new-session/preprocessNew* gating): folded into ZK-007. Reason: the gate
  consults agent_thread_intents via store.freezeIntent, which WRITES a row stamped
  with ownerMachineId — the machine-identity decision belongs to ZK-007's minting
  design, and no host path can create a zcode default today (agent_backend_defaults
  has no writer outside tests/store API), so the gate would be dead code. The
  new-session entrypoints (GuildText branch, ThreadCreate marker path, /new-session)
  are recorded in ZK-007's scope.
- Windows platform caveat: the two skipped tests in the agent suite are the
  linuxOnly verifyLaunch cases (PLATFORM_UNCERTIFIED by design, unchanged).
