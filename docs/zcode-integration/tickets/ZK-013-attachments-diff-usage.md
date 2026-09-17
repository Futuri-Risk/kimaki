# ZK-013 — Attachments + diff + usage

## Status
TODO

## Objective
Adapt the hardened attachment staging into Kimaki's real download/transcode pipeline with
durable records; keep /diff host-owned; add scoped native usage accounting without
fabricated zeros.

## Why
AC22/AC25/X07; G08; transplant map: attachments MERGE INTO EXISTING host pipeline.

## Dependencies
ZK-007.

## Scope
- `cli/src/agent/attachments.ts` adapted: keep path/byte/hash/native-image guards
  (H13/H33/H34 semantics); reuse host `message-formatting.ts` attachment pipeline for
  download/staging; durable agent_attachments records with retention; revalidation
  before native read.
- Image capability: base64 payload for certified image profiles only (fail closed
  otherwise; missing optional localPath ≠ defect).
- `/diff`: unchanged host Git/critique path; ensure bound working directory resolution
  works for zc: threads (resolveWorkingDirectory) — no second diff executor.
- Usage: scoped accounting from native usage data when provided; unknown ⇒ "unknown",
  never 0; wire into footer/usage display minimally.

## Explicit non-scope
- Critique.work semantics changes; cost dashboards.

## Files expected to change
`cli/src/agent/attachments.ts`, `cli/src/message-formatting.ts` (seam only),
`cli/src/commands/diff.ts` (cwd resolution only), usage plumbing in projector/renderer.

## Invariants
Staging retains path ownership, byte bounds (growth race), hash verification; secrets
never staged/logged; unknown usage never displayed as zero.

## Acceptance criteria
- [ ] Attachment staging tests ported + passing (path guards, bounds, dedupe names).
- [ ] /diff on zc: thread resolves bound cwd (test) with no native patch replay.
- [ ] Usage: unknown case displays unknown (test).
- [ ] tsc + baseline unchanged.

## Tests
Ported attachment tests + diff cwd test.

## Evidence
(to fill)

## Blockers
Real native image semantics need capture (N15) — image capability stays off until then.

## Completion notes
(to fill)
