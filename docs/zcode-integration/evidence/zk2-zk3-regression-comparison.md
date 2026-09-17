# ZK-002/ZK-003 regression comparison — ZAI 2026-09-17

Method: full-suite runs on this machine are unstable under parallel e2e load
(tinypool ERR_IPC_CHANNEL_CLOSED worker crashes; 37+ e2e files already fail at
baseline). For a rigorous signal, the deterministic non-e2e subset was run twice
with identical filters (`--exclude "src/**/*.e2e.test.ts" ...`):

- clean tree (changes stashed): 20 failed / 645 passed / 3 skipped (668 tests, 51 files)
- with ZK-002+ZK-003:           20 failed / 687 passed / 5 skipped (712 tests, 55 files)

Failing file sets are byte-identical (9 files: cli-parsing, default-channel-provisioning,
file-edit-log, markdown, message-formatting, project-add, system-message, task-schedule,
worktrees) — all pre-existing Windows-environment failures. Delta = +44 tests from the 4
new agent test files (all passing; 2 visibly skipped on win32 platform gates).

Conclusion: no regressions introduced by the native core import or the backend registry.
Logs: base-subset.log, zk-subset.log.
