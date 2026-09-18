# ZK-013 — Attachments + diff + usage

## Status
DONE

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
- [x] Attachment staging tests ported + passing (path guards, bounds, dedupe names).
- [x] /diff on zc: thread resolves bound cwd (test) with no native patch replay.
- [x] Usage: unknown case displays unknown (test).
- [x] tsc + baseline unchanged.

## Tests
`cli/src/agent/attachment-pipeline.test.ts` — 7 tests: staging dedupe/bytes/durable
records + retention pruning, bounds and unsafe-path refusals, pipeline
download/stage/record with honest skips (404 + TOO_LARGE), revalidation catching
tampering and escape before any native read, image capability fail-closed +
certified base64 round-trip with exact native keys, usage formatter (never-zero),
/diff host-owned source pin.

## Evidence
`docs/zcode-integration/evidence/zk13-subset.log` — non-e2e subset: 20 failed / 854
passed / 12 skipped; failing file set byte-identical to base-subset.log. tsc 0 errors.
Post-format pipeline suite 7/7.

## Blockers
Real native image semantics need capture (N15) — image capability stays off until then
(`nativeImage(…, imageCapability=false)` throws CAPABILITY_UNSUPPORTED; synthetic
profiles set imageCapability false).

## Completion notes
Delivered 2026-09-18 by ZCode (session sess_c9526de2-64fc-4ae3-bf30-1a3bda206f32).

- `agent/attachment-pipeline.ts` (new): `stageDiscordAttachments` (Discord CDN fetch →
  hardened `stageAttachment` core → durable `agent_attachments` rows; per-file honest
  skips with reason codes), `revalidateAttachment` (path containment + bounded read +
  size + sha256 revalidation before ANY native read — tampered or escaped records yield
  null, never unverifiable bytes), `formatNativeUsage` (strictly validated numbers only;
  anything absent/malformed/stringly is "unknown" — usage is never fabricated as zero),
  plus small helpers.
- Store (additive): `recordAttachment`, `attachmentById` (incl. nativeRef), 
  `pruneAttachments` (retention: unreferenced records only; file cleanup best-effort).
- `/diff`: unchanged host Git/critique path — source-pinned (no OpenCode import; cwd via
  the backend-agnostic `resolveWorkingDirectory`, which reads host workspace tables, so
  zc: threads with bound workspaces resolve identically; no second diff executor and no
  native patch replay path exists).
- **Port adaptation note**: `stageAttachment`'s POSIX mode/uid hygiene is now
  POSIX-conditional — Windows stat() reports fake mode bits (mkdtemp under %TEMP% has no
  POSIX permissions), so there the structural guards (O_EXCL/O_NOFOLLOW, realpath
  containment, hash verification) carry the safety; on POSIX the mode/uid checks are
  exactly the bundle's. Documented in-file.
- Image capability: base64 payload only for certified image profiles
  (imageCapability=true) — fail-closed otherwise (pinned by test).
