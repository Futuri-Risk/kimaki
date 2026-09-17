# ZK-003 — Default-off backend registry + typed controller boundary

## Status
TODO

## Objective
Introduce the capability-aware backend selection seam in front of the real
`ThreadSessionRuntime`, default-off (OpenCode unchanged), so that a session bound to
ZCode never touches OpenCode initialization, and OpenCode sessions never touch native code.

## Why
G01 (REVIEW_FINDINGS): standalone `OpenCodeBackend<T>.call` is a forwarding prototype —
the real extraction wraps the actual runtime. Mission IMPLEMENT-IN-THIS-ORDER step 1.
Transplant map "Smallest safe OpenCode extraction".

## Dependencies
ZK-002 (native core present for types), ZK-001.

## Scope
- `cli/src/agent/registry.ts` (adapted): backend resolution (default `opencode`;
  `zcode` only via explicit default/config for a channel/thread); `zc:` reserved host-ID
  prefix; capability guard `requireCommand` for command routing decisions.
- Backend resolved BEFORE: `getOrCreateRuntime` construction, session ensure,
  preprocessing that initializes OpenCode, SDK setup, global OpenCode listener.
- Typed controller interface covering only public operations actually used by
  ingress/commands (prompt ingestion, abort, queue ops, model change, compact, dispose…);
  OpenCode implementation = thin wrapper preserving method receivers (no destructuring).
- Native controllers keyed by host/native session identity (not Discord thread alone).

## Explicit non-scope
- No behavior change on the OpenCode path; no queue/state logic replacement; no
  ZCodeBackend implementation yet (ZK-007); no UI changes.

## Files expected to change
`cli/src/agent/registry.ts` (new), `cli/src/session-handler/thread-session-runtime.ts`
(minimal: allow selector before construction), `cli/src/discord-bot.ts`,
`cli/src/message-preprocessing.ts` (split OpenCode-enrichment branch — full ingress work
in ZK-005; here only the selection point), `cli/src/config.ts` or `store.ts` (default-off flag).

## Implementation notes
- Keep `getOrCreateRuntime` as the OpenCode controller; add `resolveBackendForIngress`
  called before it. Registry must not import OpenCode SDK.
- Receiver-preservation regression (transplant map): forwarding wrapper keeps `this`.

## Invariants
- Default resolution = `opencode`; no config ⇒ zero new behavior.
- Missing sidecar for a `zc:` ID ⇒ explicit error, never OpenCode fallback (AC05).
- No ZCode path constructs OpenCode client/listener/SDK (test asserts zero calls).

## Acceptance criteria
- [ ] Disabled mode (no config): all existing tests unchanged (ZK-006 pins this).
- [ ] `resolveBackend` returns opencode by default; zcode only when explicitly configured.
- [ ] `zc:` ID with missing sidecar throws before any OpenCode init.
- [ ] Receiver-preservation unit test passes.
- [ ] tsc + baseline vitest unchanged.

## Tests
New `cli/src/agent/registry.test.ts`; baseline suite regression.

## Evidence
(to fill)

## Blockers
None.

## Completion notes
(to fill)
