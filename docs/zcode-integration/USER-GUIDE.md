# ZCode native backend — user guide (ZK-018)

Status: **default-off**. The ZCode native backend exists in the code but is not
enabled for anyone. OpenCode remains the only backend until a native profile is
explicitly registered AND its capabilities are certified. This guide is the
honest state sheet. — ZCode 2026-09-18

## What works today (all free, no model calls)

- `kimaki zcode doctor <node> <entry> <workspace>` — static launch-profile
  inventory: absolute/canonical path checks, workspace separation, SHA-256
  fingerprints of the node executable and the entry script, the supported
  `<node> <entry> app-server` argument form, environment safety. Read-only:
  never launches the native server, never certifies. Exit 0 when the static
  checks pass (the Windows launch gate is reported as `BLOCKED`, not failure).
- `kimaki zcode status` — prints the registered-profile/capability state. With
  no profile registered (the default) it says exactly that: OFF, all zcode
  routes refuse visibly, OpenCode unaffected.
- `node tools/doctor.mjs <node> <entry> <workspace>` — same inventory as a
  repo tool (requires `pnpm --filter kimaki build`).

## What is certified today

Nothing. `CAPABILITY_MATRIX.md` is the single source of truth: N00 is recorded
as PARTIAL (static inventory PASS; Windows launch gate) and N01–N18 are BLOCKED
— on this machine by the Windows owned-process gate, and N07+ additionally by
the paid-row opt-in gate (`PAID-ROWS-DECISION.md`). No parity or capability
claim may be made beyond that matrix.

## How a native profile would be turned on (later, not now)

1. Certification rows pass with captured evidence (checklist N00→N18, in order).
2. A profile manifest with `enabled: true` + exact fingerprints is registered
   (`registerNativeProfile`) — the registry is empty by default and there is no
   config file that flips it, so enabling is a deliberate code/state act.
3. Only capabilities whose rows passed are advertised in that profile.

Until all three: every `zc:` thread creation, native message, `/btw` fork on a
native session, and native control refuses with an explicit error — never a
silent fallback to OpenCode.

## Windows status

Native process ownership on Windows is not implemented, by design
(`PLATFORM_UNCERTIFIED` in `cli/src/agent/native/process.ts`). Doctor reports it
honestly; no capability is enabled from a hash match alone. Linux certification
would not change the Windows state (mechanical enablement rule).

## Where things live

- Capability truth: `docs/zcode-integration/CAPABILITY_MATRIX.md`
- Launch profile record: `docs/zcode-integration/native-profiles/`
- Evidence: `docs/zcode-integration/evidence/` (zk16-* = certification)
- Paid-row decision: `docs/zcode-integration/PAID-ROWS-DECISION.md`
- Release path: `docs/zcode-integration/RELEASE-PATH.md`
