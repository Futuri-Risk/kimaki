# ZK-018 — Doctor/config/docs/release gates

## Status
TODO

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
(to fill)

## Blockers
Release-path execution needs Cody's decision (documented, not executed).

## Completion notes
(to fill)
