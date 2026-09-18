# ZCode native capability matrix (ZK-016)

Mechanical enablement rule: **only passing rows are advertised**; a transport-only
pass does not enable interactive execution; a Linux pass does not enable Windows;
synthetic evidence is never relabeled captured. This matrix is the honest record —
a profile flips to certified only when its row passes with captured evidence.

Statuses: PASS (captured evidence + regression fixture) · PARTIAL (implemented,
gated) · BLOCKED (gate named) · NOT RUN.

Machine context (2026-09-18, evening): win32-x64 primary host + Linux (WSL2
Ubuntu). Owned-process supervision exists on BOTH platforms: POSIX session
groups, and Windows job-object containment via a PowerShell keeper
(`cli/src/agent/native/supervisor.ts`, drills in `supervision-win32.test.ts`).
Launch profile: `native-profiles/win-cody-zcode-cjs.json` (node v24.15.0 +
desktop bundle zcode.cjs 0.16.5, `app-server`). The profile environment must
carry `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` (and `HOME`) — discovered in N01.
Paid-row gate is now MECHANICAL: `tools/certify.mjs` refuses paid rows unless
the RECORDED 2026-09-18 section exists in PAID-ROWS-DECISION.md AND the run
passes `--paid-optin-recorded`; caps (≤3 turns/row, ≤30 total) are enforced
against the persistent ledger `evidence/zk16-paid-spend.json`. **Paid turns
spent so far: 0.**

| Row | Capability | win32 | linux (WSL2) | Evidence / gate |
|---|---|---|---|---|
| N00 | Static inventory / doctor | **PASS** (static checks; launch now supervised) | **PASS** (WSL node24 pinned runtime) | `evidence/zk16-n00-*`; `evidence/zk16-{linux,win32}/certify-capture.json` |
| N01 | Startup/readiness (read-only) | **PASS** | **PASS** | `evidence/zk16-win32-free2/`, `evidence/zk16-linux-free2/` — real session/list over owned private stdio |
| N02 | Create + durable bind | **PASS** | **PASS** | Real `session/create` → `sess_*` id, full snapshot schema (messages/projection/protocol/runtime/session/settings/slashCommands/todos/todoGroups) |
| N03 | Read state | **PASS** | **PASS** | Real `session/read` schema captured both OSes |
| N04 | Subscribe before first task | **PASS** | **PASS** | Legacy cursor `{eventSeq:0}` + V4 ack `{ack:{subscriptionId, logEpoch, mode:snapshot}}` + `v4/conversation/frame` (wireVersion 3) observed |
| N05 | Model/reasoning readback | BLOCKED (AUTH_REQUIRED — headless login) | BLOCKED (no WSL credential) | Probed, not assumed: existing Sep-3 home credential AND fresh desktop credential both yield `settings.model.available: []` in headless app-server (12s poll, both surfaces); no provider-materialization RPC exists in bundle 0.16.5. Full record + exact manual step: `evidence/zk16-auth-probe.md` |
| N06 | Third-party registry | NOT RUN (out of scope per RECORDED opt-in) | NOT RUN | Also: `workspace/updateProviderRegistry` does not exist in bundle 0.16.5 — needs its own certification flow on a later bundle |
| N07 | First paid text/tool turn | BLOCKED (N05 auth) — gate+driver READY | BLOCKED (N05 auth) | `tools/certify.mjs --rows N07 --paid-optin-recorded` verified end to end on a temp sentinel workspace: refuses without flag/sentinel-repo/RECORDED; with gates open records `MODEL_UNAVAILABLE` and spends NO turn (`evidence/zk16-paid-gate-dryrun/`) |
| N08–N14, N16–N17 | Interactions/controls/fork/restart | BLOCKED (behind N07 + captured interaction/fork schemas) | BLOCKED | Runner records `CAPTURE_SCHEMA_PENDING` per row; codec fails closed (captured-codec.ts) until each shape is captured |
| N15 | Image byte + resume retention | NOT RUN | NOT RUN | Only if an image-capable model is advertised after N05 (`imageCapability: false` until certified) |
| N18 | Unsubscribe + shutdown | **PASS** | PARTIAL | win32 (`evidence/zk16-win32-free2/`): `v4/conversation/unsubscribe` → `{}`; graceful stop confirmed native-pid-dead; abrupt supervisor kill → keeper containment treeDown=true. linux (`evidence/zk16-linux-free2/`): unsubscribe `{}` + graceful PASS; abrupt leg exposed a real POSIX gap — brutal supervisor death ORPHANS the native tree (no PDEATHSIG/keeper); probe recorded `orphanedNativeTree` + cleaned up in-evidence. Follow-up: Linux launch-profile hardening (PDEATHSIG/setpriv wrapper) before Linux production claims. Both captures note 1 in-flight `deliveryKind:"initial"` frame post-unsubscribe (recorded as-is) |

Captured divergences (codec fixtures landed this evening): identity is read
from `result.session.sessionId` only — `projection.sessionId` is the cosmetic
value `"unknown"` in every captured frame; the reverse
`session/requestRuntimePreferences {sessionId, scope:"runtime-materialization"}`
(string server id) after create is answered by the bridge from profile
preferences. Pinned by `fixtures/native-captured-zk16.json` +
`captured-codec.ts` + 8/8 tests in `captured-codec.test.ts`.

Known open items: N05 headless login (the single manual step, see
`evidence/zk16-auth-probe.md`); paid rows N07+ after that, in checklist order,
under the mechanical caps; Linux abrupt-stop containment hardening; upstream
0.29.0 rebase deliberately deferred until after certification.

Resolved this evening: the lifecycle.test.ts win32 "stall" was the harness
never creating the fixture repo directory (`verifyLaunch` realpath ENOENT
before any scenario) — fixed in `test-harness.ts`; suite is 7/7 on win32.
— ZCode session zk016-paid-cert-1, 2026-09-18
