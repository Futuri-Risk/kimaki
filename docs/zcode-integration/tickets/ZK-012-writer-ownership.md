# ZK-012 — Writer/worktree/process ownership fencing

## Status
DONE

## Objective
Fence all managed writers against the native workspace lease: `!` shell, merge/delete,
worktree provisioning, background native tasks; reuse Kimaki Git core; never fall back to
repo root; keep native-home ownership while a process is resident.

## Why
AC26/AC27; G04/G08; mission IMPLEMENT step 6; transplant map (no standalone Git executor).

## Dependencies
ZK-007.

## Scope
- Lease checks before `!` shell, merge-worktree, worktree delete/provision on threads
  with a native binding; refuse concurrent second writer (conservative, cap remains 1).
- Worktree provisioning via `git-worktree-core.ts` primitives with explicit
  branch-collision and setup-trust policy; pending setup never falls back to root.
- Native-home lease: sticky while process resident; explicit serialized idle-owner
  retirement/transfer is NOT implemented — keep safe refusal (G04 stays conservative).
- Runtime sweeper: idle sweep cannot dispose a native runtime during
  background/goal/control work; teardown awaited; uncertainty keeps lease.

## Explicit non-scope
- Automatic lease takeover, PID/heartbeat recovery protocol, process pool (gated).
- Windows native process supervision (stays disabled).

## Files expected to change
`cli/src/worktrees.ts`, `cli/src/commands/new-worktree.ts`, merge/delete handlers in
`discord-bot.ts`/commands, `cli/src/runtime-idle-sweeper.ts`, `cli/src/agent/store.ts`
(lease queries).

## Invariants
Two managed writers never concurrently mutate one working tree; no root fallback;
ownership outlives uncertain process death (recovery lock).

## Acceptance criteria
- [x] Writer-fence tests: second writer refused during active native operation.
- [x] Worktree setup failure ⇒ explicit error, never repo-root execution.
- [x] Sweeper cannot remove ownership during background/goal (fake-native test).
- [x] OpenCode-only threads: worktree behavior byte-identical (baseline tests).

## Tests
`cli/src/agent/workspace-fence.test.ts` — 15 tests (5 new + coordinator suite via
shared harness): active-turn lease refuses shell/delete/merge BEFORE any git call,
canonical matching (separators/trailing slash/case cannot bypass), no-lease =
no refusal, idle-sweep veto (active/uncertain keeps runtime, quiet sweeps, non-native
always sweeps), and source-order pins for all five fence sites.

## Evidence
`docs/zcode-integration/evidence/zk12-subset.log` — non-e2e subset: 20 failed / 847
passed / 12 skipped; failing file set byte-identical to base-subset.log (worktrees /
markdown baselines unchanged = OpenCode-only worktree behavior byte-identical). tsc 0
errors. Post-format fence suite 15/15.

## Blockers
None.

## Completion notes
Delivered 2026-09-18 by ZCode (session sess_c9526de2-64fc-4ae3-bf30-1a3bda206f32).

- New `agent/workspace-fence.ts`: `nativeWorkspaceWriter` (read-only lease projection,
  canonicalized matching so separator/case variants cannot bypass), `writerFenceRefusal`
  (visible refusal naming the owning session), `nativeDisposalAllowed` (idle-sweep veto:
  native sessions with any non-terminal — including uncertain — operation keep their
  runtime and ownership).
- Fenced writers, each BEFORE any write runs (source-order pinned): `!` shell in the
  thread branch (visible reply refusal), `deleteWorktree` (returns Error), `mergeWorktree`
  (returns GitCommandError), `createWorktreeInBackground` (returns Error BEFORE the
  pending row is written — a fenced thread never carries a pending workspace that could
  fall back to the repo root). Leases only ever exist for native sessions, so
  OpenCode-only threads are unaffected by construction (and the byte-identical
  worktrees/markdown baselines prove it).
- Sweeper: `disposeInactiveRuntimes` gained an optional async `shouldDispose` veto
  (its only caller is the sweeper); the sweeper passes `nativeDisposalAllowed`.
  Background/goal/control work and uncertainty keep the lease; quiet threads sweep as
  before.
- Native-home lease: sticky while a process is resident (the coordinator already holds
  `home:` leases; retirement/transfer stays the conservative safe refusal per G04).
  Windows native process supervision remains disabled (PLATFORM_UNCERTIFIED).
