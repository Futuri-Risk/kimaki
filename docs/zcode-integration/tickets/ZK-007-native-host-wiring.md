# ZK-007 — Native host wiring (coordinator + ZcodeBackend on real store/auth)

## Status
TODO

## Objective
Adapt the hardened `coordinator.ts` + `zcode-backend.ts` into Kimaki as the ZCode
controller behind the ZK-003 boundary: real durable store (ZK-004), real authorization
callbacks, machine identity, native profile/codec injection, process ownership via the
imported native core. Fake-native (synthetic codec + fake app-server) only — real native
is ZK-016.

## Why
Mission IMPLEMENT step 5; transplant map: coordinator/zcode-backend KEEP KIMAKI-SPECIFIC
ADAPT. AC05–AC11, AC17 rely on this wiring.

## Dependencies
ZK-002, ZK-003, ZK-004.

## Scope
- `cli/src/agent/coordinator.ts`: admission (Authorizer callback + store.admit), durable
  session-create intent / native SID bind, SEND_INTENT before native effect, prompt drain
  / control-fenced operations, cancellation epochs, closed-controller refusal, bounded
  event admission — adapted to host ingress metadata, clock, errors (errore at boundary only).
- `cli/src/agent/zcode-backend.ts`: prepare/submit/guide/answer/cancel/compact/fork with
  connection generations, single-flight V4 subscription, quiescence readback — codec
  injected (synthetic default, capture-backed later), supervisor/process via native core.
- Native profile registry: `NativeProfile` config (default disabled; `allowSynthetic`
  only under test), launch profile fields (node/entry/app-server, hashes, config home).
- Authorization ports: actor/machine/thread/generation checks injected from Kimaki
  identity (discord actor id + machine id from Kimaki config).
- Default-off: zcode backend selectable only via explicit configuration; native imports
  lazy so default path never loads them.

## Explicit non-scope
- Real captured codecs (ZK-016); Discord rendering (ZK-008); interactions UI (ZK-009);
  worktree policy (ZK-012); scheduling (ZK-014).

## Files expected to change
`cli/src/agent/coordinator.ts`, `cli/src/agent/zcode-backend.ts`,
`cli/src/agent/types.ts` (host-shaped contracts), `cli/src/agent/native-profile.ts` (new),
wiring in `cli/src/agent/registry.ts`.

## Implementation notes
- Keep effect writes behind the coordinator; backend never sends without durable intent.
- `zc:` host IDs minted here; same Discord thread resume ⇒ same native SID (durable bind).
- Fake app-server fixture ports from bundle tests (test-only, marked synthetic).
- Windows: owned-process launch stays PLATFORM_UNCERTIFIED (refusal), per design.

## Invariants
- One admitted input ⇒ ≤1 automatic native submission (AC10); lost ACK ⇒ unknown, no
  replay (AC11); failed resume never silently creates a fresh session (AC07).
- Native tools display-only (AC08); no model fallback; no synthetic continuation.
- Cancel keeps ownership until verified stop; unknown stays locked (AC17).

## Acceptance criteria
- [ ] Ported coordinator/backend tests pass (fake-native, file-backed libSQL store):
      FIFO A/B/C, duplicate ingress → one submission, SIGKILL-after-intent recovery,
      cancel fences (H12/H16/H19 semantics), closed-controller refusal, generation safety.
- [ ] Same Discord session resumes same native SID across restart (fake-native).
- [ ] `zc:` missing sidecar error before any OpenCode call.
- [ ] tsc + baseline unchanged.

## Tests
`cli/src/agent/coordinator.test.ts`, `cli/src/agent/zcode-backend.test.ts` (ported).

## Evidence
(to fill)

## Blockers
None (fake-native runs cross-platform for pure paths; owned-launch cases Linux-gated).

## Completion notes
(to fill)
