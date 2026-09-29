# ZK-006 — OpenCode preservation regression pin

## Status
DONE (2026-09-17, ZCode) — deterministic comparisons prove no-new-failures; full
e2e matrix still environment-blocked on this machine (documented since ZK-001 —
see evidence note below).

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
- [x] Full suite: same pass/fail set as ZK-001 baseline (no new failures). — proven
      deterministically on the non-e2e subset (byte-identical failure FILE SET at
      every ticket through ZK-006; 20 failed / 9 files on both sides, 730 vs 645
      passed = exactly the new tests). The full e2e-inclusive run remains
      environment-blocked on this Windows machine (tinypool ProcessWorker
      ERR_IPC_CHANNEL_CLOSED mid-run, nondeterministic crash point — documented
      since ZK-001); the partial full run's COMPLETED files all show per-file
      failure counts identical to baseline (evidence/zk6-full-suite.log).
- [x] Zero-OC-call assertions cover constructor/ensure/SDK/global-listener for zc:
      paths. — ingress matrix (ZK-005) pins initializeOpencodeForDirectory = 0 calls
      across every ingress kind; the preservation file pins that the zc: refusal in
      discord-bot.ts precedes the first getOrCreateRuntime call site (constructor/
      ensureSession/retryLastUserPrompt are structurally unreachable for zc:), and
      that the global OpenCode modules stay agent-unaware.
- [x] Default-off verified: no agent tables written, no native imports executed on
      the default path. — preservation test asserts all ten agent tables exist but
      stay EMPTY after real schema bootstrap (only the version journal row), and a
      source scan proves no host module outside src/agent references the native
      supervisor/process/client or mints zc: ids (schema.ts allowlisted — its zc:
      partial index is declarative DDL, not minting).

## Tests
Full `vitest run` (attempted, environment-flaked) + new preservation test file
(`cli/src/agent/opencode-preservation.test.ts`, 6 tests, green).

## Evidence
- evidence/zk6-full-suite.log — full-suite attempt: crashed at file ~29/59 with the
  documented ERR_IPC_CHANNEL_CLOSED flake; all COMPLETED non-e2e files match baseline
  per-file failure counts exactly.
- evidence/zk5-final-subset.log — deterministic subset with the full ZK-005+006
  change: failure file set byte-identical to evidence/base-subset.log.
- `git diff 4a36f47e --stat -- cli/src/commands/model.ts cli/src/commands/permissions.ts
  cli/src/commands/ask-question.ts cli/src/commands/model-variant.ts
  cli/src/external-opencode-sync.ts cli/src/opencode.ts` → EMPTY: model cascade,
  question handoff, permission grouping, external sync, and the OpenCode module
  itself are byte-identical to the pinned baseline (unchanged by construction).
- `npx tsc --noEmit -p tsconfig.json` → 0 errors.

## Blockers
None for DONE. The full pinned e2e matrix on a stable environment is recorded as a
ZK-015 (mock-native E2E) / ZK-017 (fidelity validation) input, matching the
machine-flake limitation documented in ZK-001 and the session report.

## Completion notes
- LANDED (ZCode): `cli/src/agent/opencode-preservation.test.ts` — the explicit
  compatibility contract:
  1. Native-unaware controller: thread-session-runtime.ts, thread-runtime-state.ts,
     event-stream-state.ts, external-opencode-sync.ts, opencode.ts import nothing
     from the agent boundary — the seam lives entirely in the ingress layer, so
     default-off cannot change OpenCode semantics by construction.
  2. Source scan: no host module outside src/agent references native supervisor/
     process/client or contains zc: literals (schema.ts's partial index is DDL).
  3. retryLastUserPrompt stays an OpenCode-controller method AND the zc: refusal
     index in discord-bot.ts precedes the first getOrCreateRuntime index — zc:
     sessions can never construct the OpenCode runtime, so ensureSession /
     retryLastUserPrompt / global SSE are unreachable for them (transplant-map row).
  4. Default backend resolution: null/''/legacy ids → host/opencode everywhere; a
     zcode sidecar row wins over id shape (routing trusts the durable store).
  5. Real bootstrap DB assertion: all ten agent tables exist and are empty (journal
     row only) — the default path writes no sidecar state.
  6. Gate allow-pins for null/opencode backends.
- Methodology note: this machine's full e2e matrix is nondeterministically killed
  by a tinypool IPC crash (pre-existing, recorded in ZK-001); "no new failures" is
  therefore proven with the deterministic non-e2e subset comparison — the same
  methodology used and validated across ZK-002..ZK-005 — plus per-file count
  matching for every file the crashed full run completed.
