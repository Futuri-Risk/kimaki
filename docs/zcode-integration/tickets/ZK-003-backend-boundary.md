# ZK-003 — Default-off backend registry + typed controller boundary

## Status
DONE (2026-09-17, ZAI) — minimal slice; see completion notes and deviations

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
- Landed: `cli/src/agent/errors.ts` (single host boundary reexporting native error
  contracts) and `cli/src/agent/registry.ts` (BackendId, `zc:` prefix guard,
  `resolveBackend` with injected SidecarLookup — store dependency inverted until ZK-004,
  `requireCommand` capability guard, `OpenCodeBackend<T>` receiver-preserving seam).
- Deviation from original scope: `thread-session-runtime.ts` was NOT modified in this
  ticket. The selector lives in `agent/registry.ts` and is invoked from ingress sites in
  ZK-005 — this keeps the real runtime byte-identical for default-off and avoids touching
  the 5094-line controller before the ingress audit. The typed controller union lands with
  the ZCode controller itself (ZK-007).
- Default-off is structural: without a sidecar every ID resolves to `opencode`; `zc:` IDs
  without a sidecar fail closed (SESSION_SIDECAR_MISSING, never OpenCode fallback).
- Tests (`cli/src/agent/registry.test.ts`): backend identity fallback / missing-zc
  failure, prefix detection, capability guard (unknown commands + capability=false),
  receiver preservation, missing-method failure. 8/8 pass; tsc clean.
- Full-suite comparison vs baseline: see evidence/zk2-vitest-full.log analysis in
  ZK-002 completion notes.
