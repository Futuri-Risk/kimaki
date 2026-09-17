# ZK-006 — OpenCode preservation regression pin

## Status
TODO

## Objective
Explicitly pin existing OpenCode behavior as a compatibility contract across the
integration: default-off means byte-for-byte semantics, not "tests still pass".

## Why
Mission IMPLEMENT step 4; HOST_INTEGRATION: "Existing OpenCode tests are a compatibility
contract"; AC01/AC13. The e2e suite (deterministic provider, digital discord) is the
strongest pin available locally.

## Dependencies
ZK-003, ZK-005.

## Scope
- Run and record the full existing OpenCode e2e/behavioral suite with the backend seam in
  place but disabled: identical snapshots/results vs baseline.
- Add targeted regression assertions: default backend resolution is opencode everywhere;
  no zc: IDs can reach ensureSession/retryLastUserPrompt/global listener; model cascade,
  question handoff, permission grouping, external sync untouched (source-level assertions
  where behavior tests don't exist).
- Document any pre-existing baseline failures (from ZK-001) as the reference set; this
  ticket requires "no NEW failures", not fixing old Windows-environment ones.

## Explicit non-scope
- No refactors of OpenCode code; no snapshot updates beyond confirming equality.

## Files expected to change
Possibly none (verification ticket) + `cli/src/agent/opencode-preservation.test.ts` (new).

## Implementation notes
- `retryLastUserPrompt` must remain unreachable for zc: sessions (transplant map row).
- Use the repo's deterministic provider + DigitalDiscord e2e conventions.

## Invariants
Existing OpenCode system content, tools, SDK behavior, reducer, global SSE, queues,
questions, permissions, model cascade, external sync, rendering semantics unchanged.

## Acceptance criteria
- [ ] Full suite: same pass/fail set as ZK-001 baseline (no new failures).
- [ ] Zero-OC-call assertions cover constructor/ensure/SDK/global-listener for zc: paths.
- [ ] Default-off verified: no agent tables written, no native imports executed on the
      default path (lazy import).

## Tests
Full `vitest run` + new preservation test file.

## Evidence
(to fill)

## Blockers
None.

## Completion notes
(to fill)
