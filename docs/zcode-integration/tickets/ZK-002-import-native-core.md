# ZK-002 — Import host-independent native core + ported native tests

## Status
DONE (2026-09-17, ZAI) — see completion notes

## Objective
Import the hardened, host-independent native core from the standalone slice into
`cli/src/agent/native/` unchanged in behavior, with its regression tests ported to the
host test runner, and prove the native graph stays host-import-free.

## Why
KIMAKI_TRANSPLANT_MAP: `native/` = KEEP HOST-INDEPENDENT / REUSE AS-IS; SHARED_RUNTIME_MAP
recommendation B (repository-local now). F15/H30/H31 guards must survive the move. The
same core is later consumed by Subrouter (mission SHARED RUNTIME REQUIREMENT).

## Dependencies
ZK-001.

## Scope
- Copy from bundle `cli/src/agent/native/`: types.ts, errors.ts, ndjson.ts, client.ts,
  protocol.ts, model.ts, diagnostics.ts, process.ts, supervisor.ts (+ emitted supervisor
  sibling JS handling per transplant map: supervisor is an internal executable, never
  reexported from a library initializer).
- Port bundle tests that exercise native-only behavior (core, client, ndjson/protocol/
  model/diagnostics/process portions + hardening cases H14/H20/H21/H24/H30/H31/H32/H38/
  H43–H50 where native-scoped) into `cli/src/agent/native/*.test.ts` under vitest.
- Platform-gate Linux-only supervisor/POSIX-group tests (`describe.skipIf(win32)` style)
  with an explicit reason string, not silent deletion.
- Add an isolated strict native-only typecheck script (host package.json script
  `check:native`) mirroring the bundle's isolated check.
- Keep the synthetic fake codec/fixtures in a clearly-marked `test/` scope
  (`allowSynthetic` never enabled by normal setup).

## Explicit non-scope
- No host-shaped files (coordinator/store/backend/projector/renderer/attachments) in this
  ticket. No dist/ copy. No supervisor import from production modules beyond launch.

## Files expected to change
- New: `cli/src/agent/native/*.ts` (9 files), `cli/src/agent/native/*.test.ts`,
  `cli/package.json` (scripts: `check:native`), possibly `cli/vitest.config.ts` (include).
- Nothing existing modified except package.json script additions.

## Implementation notes
- Bundle native files import only Node + siblings (H30); verify with a grep-based
  assertion in the native test ("no import of .. outside native/") to keep the boundary
  enforced in-repo.
- The supervisor is emitted as JS in the bundle (`dist/agent/native/supervisor.js`) and
  launched as a sibling executable — replicate the emission strategy via the host build
  (copy `supervisor.js` as a committed sibling source file, not built output, if that is
  how the bundle ships it; check FILE-INVENTORY and keep behavior identical).
- Node 24 vs bundle Node 22: `node:sqlite` not needed here (that's the adapter, tests-only).

## Invariants
- Zero imports from outside `cli/src/agent/native/` in native modules (except node:*).
- All ported assertions retain original meaning; no test-count games; Linux-only cases
  skipped on Windows with visible reason.
- No synthetic fixture escapes into production paths.

## Acceptance criteria
- [ ] `cli/src/agent/native/` contains the 9 modules, behavior-identical to bundle.
- [ ] Ported native tests pass on Windows (Linux-only ones visibly skipped with reason).
- [ ] `npx tsc --noEmit` still passes; `check:native` isolated strict check passes.
- [ ] Native-boundary test (no host imports) passes.
- [ ] Full baseline vitest failures unchanged (no new failures).

## Tests
`npx vitest run src/agent/native` ; `npx tsc --noEmit` ; `npx pnpm check:native`.

## Evidence
Updated here when done: files copied, test counts, skip list.

## Blockers
None expected.

## Completion notes
- Files imported verbatim from the hardened bundle into `cli/src/agent/native/`: client.ts,
  diagnostics.ts, errors.ts, model.ts, ndjson.ts, process.ts, protocol.ts, supervisor.ts,
  types.ts + committed compiled `supervisor.js` sibling (annotated header; needed because
  process.ts spawns './supervisor.js' relative to import.meta.url in tsx/vitest source mode;
  excluded from host tsc via tsconfig exclude to avoid duplicate dist output).
- Tests ported to vitest (node:assert kept, matching repo convention):
  `client.test.ts` (11 client cases + H43/H45/H46), `native-core.test.ts` (NDJSON×6,
  classify, V4 builders×6, runtimeModel, H14, H50-verifyLaunch-half, fingerprint — H14 +
  fingerprint test are Linux-gated with visible skip reason because verifyLaunch's win32
  PLATFORM_UNCERTIFIED gate precedes the arg/hash checks), `native-boundary.test.ts`
  (H30 host-import scan adapted to host layout, supervisor sibling check, H31, H32, H44
  adapted in-process instead of spawnSync per repo rule).
- Results: native suite 36 passed / 2 skipped (win32 gates); `tsc --noEmit` full = 0 errors
  (after also fixing the pre-existing discord-digital-twin missing prisma client via
  `pnpm generate` in that package — generate:sql step of that package still fails on this
  machine (P1013 dev.db URL), harmless: schema.sql is committed); `check:native` isolated
  strict check (incl. exactOptionalPropertyTypes) = exit 0.
- Deliberately NOT ported here: projector/attachments/registry/renderer/store/coordinator
  tests (their modules come with ZK-003/004/007/008/013); H47/H48 sqlite-adapter tests stay
  in the standalone bundle (test-adapter-only defect class, per transplant map).
- Full-suite comparison vs baseline recorded in evidence/zk2-vitest-summary.
