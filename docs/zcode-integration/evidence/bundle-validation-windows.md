# Hardened bundle validation on this machine (Windows) — ZAI 2026-09-17

Bundle: `Research GPT6PRO/kimaki-zcode-hardened-2026-09-17.zip` extracted to
`ZCode Kimaki/work/kimaki-zcode-implementation/` (project folder).

## Checks

- SHA256SUMS: **262/262 OK** (`sha256sum -c SHA256SUMS`).
- `npm install` (typescript 5.8.3 + @types/node 25.1.0 only): OK.
- `npm run check` (tsc -p tsconfig.json --noEmit): **PASS**.
- `node --test --test-concurrency=1 tests/*.test.mjs` (compiled dist): **88 pass / 82 fail**
  on Windows (Node v24.15.0). Original environment claim (134/134, Node 22/Linux-class)
  per bundle `audit/VALIDATION.md` — not reproduced here.

## Cause of the Windows failures (by design, not defects)

- The owned-runtime launcher (`native/process.ts: verifyLaunch`) throws
  `PLATFORM_UNCERTIFIED` on win32 — Windows native process ownership is deliberately
  disabled (REVIEW_FINDINGS G05, checklist). Every test that launches the fake app-server
  through the owned launcher therefore fails/times out (~6.1s `until` timeouts) on Windows.
- POSIX path/permission fixtures (traversal/device filenames, writable-root ownership
  checks) behave differently on NTFS/win32.
- The remainder (ndjson/protocol/core/model/errors/client logic) passes.

Implication for ZK-002: port pure-logic tests to run everywhere; gate process-launching
and POSIX-only tests behind an explicit `linuxOnly`/`skipIf(win32)` marker with reason.
The bundle's 134/134 evidence from its original environment remains the authoritative
record for the hardened slice.
