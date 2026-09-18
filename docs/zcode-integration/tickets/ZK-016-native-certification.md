# ZK-016 — Native certification N00–N18 (capture-backed, live gate)

## Status
IN_PROGRESS — N00 recorded 2026-09-18 (PARTIAL: static PASS, win32 launch gate). N01-N18 BLOCKED: win32 owned-process gate; N07+ additionally the paid opt-in gate. — ZCode 2026-09-18

## Objective
Certify the real native runtime per NATIVE_CERTIFICATION_CHECKLIST: exact binary/entry
fingerprints, captured sanitized traces, codec updates + regression fixtures, capability
matrix — enabling only what passes.

## Why
G03/G05/G06; mission NATIVE CERTIFICATION IS A SEPARATE MILESTONE. No capability is
advertised without its row passing.

## Dependencies
ZK-015 + real ZCode launch profile on this machine (zcode-acp-server@0.19.0 and ZCode
desktop exist; the certified `<node> <entry> app-server` launch profile must be
discovered/recorded in N00).

## Scope
- N00 inventory/doctor (no native call): record executable/entry hashes, OS/arch, config
  home identity; launcher must match the supported form exactly.
- N01 readiness (session/list read-only) → N02 create/bind → N03 read → N04 subscribe →
  N05 model/reasoning readback → [N06 registry if third-party profile] → N07 first paid
  text/tool turn (EXPLICIT OPT-IN + cost limits required) → N08 permissions → N09
  questions/plan → N10 guide → N11 stop/background → N12 background/goal → N13 compact →
  N14 fork → N15 image (if advertised) → N16 restart/resume → N17 lost-ACK/fork-omission →
  N18 unsubscribe/shutdown.
- For every divergence: update codec, add captured sanitized fixture + regression test,
  flip profile capability only for the passing row.

## Explicit non-scope
- Enabling capabilities beyond passed rows; benchmark claims (ZK-017 separate).

## Files expected to change
`cli/src/agent/native/protocol.ts` (codec), new capture fixtures dir (sanitized, secrets
absent), profile manifest, doctor command (ZK-018 ties in).

## Implementation notes
- Capture policy: allowlisted redaction, private permissions, no raw credential overlays,
  no unbounded stdio capture. Paid rows need explicit local opt-in recorded first.
- Windows: N-rows requiring owned-process launch remain BLOCKED until Windows
  supervision exists — record as PARTIAL — IMPLEMENTED, ENVIRONMENT GATE, not DONE.

## Invariants
Mechanical enablement rule (checklist §Mechanical enablement rule): only passing rows
advertised; synthetic never relabeled captured.

## Acceptance criteria
- [ ] Evidence manifest per checklist §Required evidence manifest.
- [ ] Capability matrix updated per row with PASS/PARTIAL/BLOCKED + fixture refs.
- [ ] Codec regressions added for each captured divergence.

## Tests
Row-specific; captured-fixture-driven codec tests.

## Evidence
- `evidence/zk16-n00-inventory.md` + `evidence/zk16-n00-doctor-output.json` — N00 static inventory (this machine, win32-x64): node.exe + desktop-bundled zcode.cjs 0.16.5 fingerprints, `app-server` arg form verified, config-home markers.
- `native-profiles/win-cody-zcode-cjs.json` — discovered profile manifest (redacted).
- `CAPABILITY_MATRIX.md` — per-row status with gates.
- Doctor: `tools/doctor.mjs` + `kimaki zcode doctor` (cli-commands/zcode.ts), tests `cli/src/agent/native/doctor.test.ts` (7/7).

## Blockers
Paid-call opt-in for N07+ (Cody); certified launch profile discovery; Windows rows
blocked by design.

## Completion notes
2026-09-18 (ZCode): N00 executed statically — all static checks PASS; launch
certification BLOCKED on win32 (PLATFORM_UNCERTIFIED by design). Discovered
artifacts: entry = ZCode desktop bundle `resources/glm/zcode.cjs` v0.16.5
(`app-server` = ZCode Protocol stdio server); the npm `zcode-acp-server@0.19.0`
present on this machine is the ACP bridge layer, reference only. No paid row
requested or run; opt-in decision doc: `PAID-ROWS-DECISION.md`. Remaining: the
row sequence itself needs either Windows supervision (new ticket) or a Linux
certification host, plus recorded Cody opt-in for N07+.
