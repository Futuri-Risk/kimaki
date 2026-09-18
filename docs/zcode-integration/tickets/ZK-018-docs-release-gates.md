# ZK-018 — Doctor/config/docs/release gates

## Status
DONE (local deliverables) 2026-09-18 — release-path EXECUTION decision remains with Cody (documented, not executed). — ZCode 2026-09-18

## Objective
Ship the integration safely: doctor command (static, no paid probes), config/docs for
native profiles, capability visibility, changesets, and the release-path notes for this
machine's release-store patch deployment.

## Why
G06/G08/G09; mission M9; repo AGENTS.md conventions (changesets skill for user-facing
changes); deployment reality (release-store + patch contract).

## Dependencies
ZK-015 (and whatever capability state ZK-016 reached).

## Scope
- `tools/doctor.mjs` adapted into a registered Kimaki CLI command: static inventory of
  native profile paths/hashes/capability matrix; `certified: false` unless capture
  evidence exists; no readiness probe that starts a model task.
- Docs: `docs/zcode-integration/` user-facing summary (how to opt in, what is certified,
  what stays disabled; Windows status).
- Changeset entry(ies) per repo convention (default-off feature).
- Release-path note: how feat/zcode-integration would reach the deployed bot (npm build
  vs release-store patch contract) — decision for Cody; document options, don't execute.
- Unsupported capabilities visibly disabled in UI (menus/buttons) — verify.

## Explicit non-scope
- Publishing anything; modifying the release pipeline; enabling native by default.

## Files expected to change
`cli/src/cli-commands/` (doctor registration), docs, `.changeset/`, menus.

## Acceptance criteria
- [ ] Doctor runs read-only and reports honest certified=false until ZK-016 evidence.
- [ ] Changesets present; docs accurate; menus show disabled state for uncertified.
- [ ] Release-path note recorded.

## Tests
Doctor command test (static fixtures).

## Evidence
- Doctor CLI: `kimaki zcode doctor` + `kimaki zcode status` registered (cli-commands/zcode.ts, cli.ts); smoke-tested against the built binary — status prints the default-off state, doctor reports certified=false with the win32 BLOCKED gate. Static tests: `cli/src/agent/native/doctor.test.ts` 7/7.
- Docs: `USER-GUIDE.md` (opt-in/certified/Windows truth), `CAPABILITY_MATRIX.md`, `PAID-ROWS-DECISION.md`, `RELEASE-PATH.md`.
- Changeset: `.changeset/zcode-native-default-off.md` (minor, default-off feature).
- Capability visibility: with no profile registered, `zc:` routing, native interactions and `/btw` on native sessions refuse visibly (pinned by ZK-005/009/011 tests: ingress-gate, interaction-bridge, schema-gate suites); `zcode status` surfaces the OFF state on demand. No menu surface advertises native features while uncertified.

## Blockers
Release-path execution needs Cody's decision (documented, not executed).

## Completion notes
2026-09-18 (ZCode): all local gates shipped. Open item for Cody: pick release
path A/B/C in RELEASE-PATH.md (npm release vs dist-patch contract vs pinned
custom release entry) — documented only, per ticket scope.
