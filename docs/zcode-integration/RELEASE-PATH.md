# Release path for feat/zcode-integration — options for Cody (ZK-018)

Written by ZCode, 2026-09-18. **Decision document, nothing executed.** The
integration is default-off, so none of these paths changes user behavior until
a certified profile is registered.

## Deployment context (this machine)

The deployed bot does not run from a git checkout. It runs upstream kimaki
**0.28.0** via the release store (`~/.kimaki/release-store/releases/0.28.0-*`),
selected by `selection.json`, with a managed **post-install dist patch
contract** operated from `C:\Dev\opencode-kimaki-releases` (docs 01/04). The
integration branch `feat/zcode-integration` sits on exactly the researched
upstream baseline (4a36f47e, 0.28.0) with the whole ZK-002..016 series stacked
on top.

## Options

**A. Upstream release path (npm).** Merge/PR the integration into the release
line, cut a version (changesets → e.g. 0.29.0), let the release store install
the built package like any other upgrade. Cleanest: the deployed artifact is a
normal build, patches stay small, rollback is version rollback. Slowest:
depends on release cadence and review of a large (default-off) diff.

**B. Release-store dist patch contract (existing mechanism).** Build
`feat/zcode-integration` (`pnpm --filter kimaki build`), express the delta
against the deployed 0.28.0 dist as a managed patch, redeploy through the
existing patch pipeline. Fastest to this machine; but the integration adds many
new modules (`cli/src/agent/**`, native core, new cli-commands), so the dist
patch is large and brittle across future upstream upgrades — every upstream
bump re-derives it.

**C. Pinned custom release entry.** Build the branch once and register the
built artifact as its own release-store entry (like the existing `0.28.0-*`
hash entries), pinning `selection.json` to it. No patch derivation at all;
cost: the deployment permanently diverges from upstream versioning until A
happens, and upstream upgrades need a rebase+rebuild.

## Tradeoff summary

- Lowest risk / slowest: **A**
- Fits existing ops / highest maintenance: **B**
- Fastest honest artifact / version drift: **C**

Because the feature is default-off, A is the natural choice unless you want
local certification experiments sooner (C pairs well with "certify on this
machine first, upstream later"). Decision: **Cody** — record it here when made.
