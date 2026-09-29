# ZK23 linux recheck — 2026-09-29

In-situ WSL verification of the SWARM #23 POSIX keeper on branch
`feat/zcode-integration` (repo C:/Dev/kimaki-zcode, HEAD 5b1132a6, fix commit
2b852b85). Verifier: linux containment verifier subagent (ZCode Kimaki swarm).
Evidence in this directory is the verifier's ONLY writes; CAPABILITY_MATRIX.md
and zk16-paid-spend.json untouched.

## 1. Drill — RAN, GREEN

`wsl -e node /mnt/c/Dev/kimaki-zcode/cli/src/agent/native/supervision-posix-drill.mjs`
(run via git-bash with MSYS path conversion disabled; full capture in
drill-output.txt)

- PASS brutal-supervisor-death — tree dead 59ms (bound 10000ms;
  drill supervision-posix-drill.mjs:22). Pre-fix, #23's commit message
  records orphan >10s.
- PASS clean-stop — tree dead 45ms, supervisor exit 0.
- Exit code 0.

The drill drives the source supervisor
(cli/src/agent/native/supervisor.js, resolved at
supervision-posix-drill.mjs:20), which contains the SWARM #23 POSIX keeper
(KEEPER_JS at supervisor.js:84-115: detached session-of-its-own node keeper;
WATCH <pgid>; stdin EOF -> SIGTERM -> 5s grace -> SIGKILL -> 2s reap).

## 2. N18 linux leg via tools/certify.mjs — NOT RUN (stale dist)

Driver read first, as the ask required:

- N18 is a FREE row (tools/certify.mjs:23), NOT in PAID_ROWS (:27-39). The
  paid gate (:149-182) fires only when a requested row is in PAID_ROWS, so
  `--rows N18` needs NO `--paid-optin-recorded`, and the N18 driver
  (:629-667 + abruptContainmentProbe :415-475) never calls countModelTurn.
  Platform support for linux is present (/proc PPid at :405-410; SIGKILL +
  group-kill cleanup at :439-466). Precedent: zk16-linux-free2 ran N18 on
  WSL 2026-09-18 (free).

Blocked, however, by a stale build. certify.mjs imports its owned runtime
from the REPO BUILD, not source:

  tools/certify.mjs:204  const { fileHash, startOwnedRuntime } = await import('../cli/dist/agent/native/process.js')

- cli/dist/agent/native/supervisor.js — mtime Sep 19 11:44, 9940 bytes. Its
  keeper references are the ZK-016 WINDOWS PowerShell keeper only; grep finds
  no "POSIX twin of KEEPER_PS1" / no SWARM #23 keeper.
- cli/src/agent/native/supervisor.js — mtime Sep 29 02:23, 14005 bytes,
  contains the #23 POSIX keeper (landed 2b852b85, 2026-09-29 02:27 +1000).
- cli/src/agent/native/process.ts mtime Sep 29 12:30 also postdates dist.

So an N18 run today would exercise a PRE-#23 supervisor from dist: the
abrupt leg would orphan the tree (pre-fix behavior), get cleaned up by the
probe (:455-466), and record `orphanedNativeTree: true` — evidence of the
OLD gap, not of the fix. Reporting that as a #23 verification would be
misleading. Refreshing dist needs `pnpm --filter kimaki build`, which writes
outside this evidence directory — prohibited for this ask ("your ONLY
writes"). Not run; skipped and stated, per the ask's own pattern for
unmet preconditions.

Side observation (report-only, no edit made): the abrupt-probe comment at
tools/certify.mjs:452-454 still describes the POSIX containment gap as
current ("a brutally killed supervisor cannot signal the process group, so
the native tree can be orphaned") — stale as of #23 whenever dist is
rebuilt; the probe code itself is outcome-neutral and needs no change.

## 3. Scope compliance

- Branch verified feat/zcode-integration before any check (else: stop).
- CAPABILITY_MATRIX.md: not edited. gateway-proxy/: not touched.
  zk16-paid-spend.json: not touched; no paid rows requested; N17/ZK-017
  matched pairs not run.
- Writes: only this directory (drill-output.txt, report.md).
