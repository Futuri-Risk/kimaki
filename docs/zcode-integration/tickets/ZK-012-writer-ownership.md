# ZK-012 — Writer/worktree/process ownership fencing

## Status
TODO

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
- [ ] Writer-fence tests: second writer refused during active native operation.
- [ ] Worktree setup failure ⇒ explicit error, never repo-root execution.
- [ ] Sweeper cannot remove ownership during background/goal (fake-native test).
- [ ] OpenCode-only threads: worktree behavior byte-identical (baseline tests).

## Tests
New fence tests + existing worktree tests regression.

## Evidence
(to fill)

## Blockers
None.

## Completion notes
(to fill)
