# ZK-001 — Real repository baseline + drift report + environment record

## Status
DONE (2026-09-17, ZAI)

## Objective
Pin the actual integration base, record environment/toolchain facts, establish the
pre-change baseline (typecheck + full test suite + SQL generation) and the drift between
the researched baseline and what exists on this machine.

## Why
Mission FIRST TASK + CHECK REPOSITORY DRIFT; REVIEW_FINDINGS "Next step" requires a
prepared real Kimaki checkout. Everything else depends on knowing the true base.

## Dependencies
None.

## Scope
- Worktree `C:\Dev\kimaki-zcode` at `4a36f47e45bf4778f682c145d98c8511adb272b1`
  (= upstream remorses/kimaki main, kimaki 0.28.0 — the exact researched baseline).
- `npx -y pnpm@9.15.9 install --frozen-lockfile` (lock preserved); submodules initialized.
- Baseline `tsc --noEmit`, full `vitest run`, `generate:sql` diff check.
- Drift record: fork vs upstream vs deployed release-store reality.

## Explicit non-scope
- No modification of the main checkout `C:\Dev\kimaki`, its dirty `gateway-proxy`
  submodule, or any fork branch.
- No pushes to any remote. No dependency upgrades.

## Files expected to change
None in source (docs/evidence only): `docs/zcode-integration/MASTER_PLAN.md`,
`docs/zcode-integration/evidence/*`.

## Implementation notes
- Fork `main` = merge-base `cbab945c` + 1 commit (0.23.1); upstream/main = +167 commits
  (0.28.0). Deployed bot = release-store 0.28.0 + managed dist patches
  (`C:\Dev\opencode-kimaki-releases`, forge `projects/opencode-glm.git`).
- Upstream 0.28.0 persistence: Drizzle ORM + `@libsql/client`; `src/schema.sql` generated
  via `pnpm generate:sql` (drizzle-kit export). The fork's AGENTS.md (Prisma-era) is stale.
- Toolchain: Node v24.15.0, pnpm 9.15.9 (pinned via npx), bun 1.3.14, Windows 10 x64,
  zcode-acp-server@0.19.0 global, ZCode desktop installed.

## Invariants
- Tree stays pristine 4a36f47e before ZK-002; no user changes overwritten.

## Acceptance criteria
- [x] Worktree exists at exact baseline commit, clean status.
- [x] Dependencies installed with pinned pnpm, lockfile unchanged.
- [x] `tsc --noEmit` exit 0.
- [x] Full vitest run executed; results + failure list recorded in evidence/.
- [x] `generate:sql` produces no diff on pristine tree.
- [x] Drift + environment facts recorded in MASTER_PLAN §1.

## Tests
`npx tsc --noEmit`; `NODE_ENV=test npx vitest run --reporter=basic`;
`npx pnpm generate:sql && git diff --exit-code src/schema.sql`.

## Evidence
- evidence/baseline-vitest-full.log (+ baseline-vitest-failures.txt)
- evidence/baseline-tsc.log (exit 0)
- Hardened bundle validation on this machine: evidence/bundle-validation-windows.md

## Blockers
None.

## Completion notes
- Baseline: tsc PASS; vitest 628 passed / 15 failed / 3 skipped (44 files failing — most
  file-level failures are Windows-environment issues; catalogued, not fixed, per mission
  "record pre-existing failures separately"). Details in evidence.
- Bundle suite on Windows: see evidence/bundle-validation-windows.md (Linux-only POSIX
  cases + timing-sensitive cases differ; core 134-case claim verified on original
  environment per bundle VALIDATION.md, not fully reproducible on Windows).
- generate:sql verified clean (see evidence/baseline-generate-sql.log if present).
