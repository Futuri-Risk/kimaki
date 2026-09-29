# ZK-017 — Direct vs Kimaki-bridged fidelity validation

## Status
BLOCKED — requires ZK-016 >=N07 (paid rows). Protocol below is ready to execute when the gates open; no runs performed. — ZCode 2026-09-18

## Objective
Compare direct ZCode runs with Kimaki-bridged runs on matched binary/task/workspace/
credentials/model/reasoning/preferences; record results as the honest basis for any
parity claim (no benchmark claims without this).

## Why
AC35; checklist final section; mission M8.

## Dependencies
ZK-016 (≥N07 certified).

## Scope
- Matched-pair runs (direct desktop/CLI vs through Kimaki), identical disposable repo +
  task set; compare outputs, behavior, settings readback evidence.
- Document deltas; fix bridged divergences that violate invariants (never "fix" by
  weakening direct-run semantics).

## Explicit non-scope
- Performance benchmarking methodology changes; marketing claims.

## Files expected to change
Docs/evidence only (+ fixes if divergences found).

## Acceptance criteria
- [ ] Matched-pair evidence recorded for at least the certified capability set.
- [ ] No unexplained behavioral divergence in advertised capabilities.

## Tests
N/A (evidence artifact).

## Evidence
None yet (blocked). Matched-pair protocol (agreed shape, executes only after ZK-016 >=N07):

1. **One identical basis per pair:** same binary+entry hashes, same disposable repo
   (fresh clone per side), same workspace path shape, same credentials/profile,
   same model+effort (exact readback, no fallback), same preferences/mode.
2. **Direct side:** run the task via the native CLI directly (zcode --prompt or
   desktop), capturing terminal outcome + filesystem sentinel + usage readback.
3. **Bridged side:** the same task through Kimaki (Discord message -> native turn),
   same evidence captured from the bridge's durable records.
4. **Task set:** 3-5 small sentinel tasks covering the certified rows only
   (text turn, one tool action, one interaction if certified, one stop).
5. **Comparison record:** per task, side-by-side outcome/files-changed/usage +
   divergence list; every divergence is either fixed in the bridge or documented
   as native semantics — never "fixed" by weakening the direct run.
6. Evidence lands in `evidence/zk17-*.md` with capture dates and profile hashes.

## Blockers
ZK-016 ≥N07; explicit opt-in.

## Completion notes
2026-09-18 (ZCode): protocol written, execution BLOCKED (see Status). This ticket cannot close until paid rows are certified — see PAID-ROWS-DECISION.md and CAPABILITY_MATRIX.md.
