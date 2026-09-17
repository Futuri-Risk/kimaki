# ZK-017 — Direct vs Kimaki-bridged fidelity validation

## Status
TODO

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
(to fill)

## Blockers
ZK-016 ≥N07; explicit opt-in.

## Completion notes
(to fill)
