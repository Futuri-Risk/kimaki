# ZCode native capability matrix (ZK-016)

Mechanical enablement rule: **only passing rows are advertised**; a transport-only
pass does not enable interactive execution; a Linux pass does not enable Windows;
synthetic evidence is never relabeled captured. This matrix is the honest record —
a profile flips to certified only when its row passes with captured evidence.

Statuses: PASS (captured evidence + regression fixture) · PARTIAL (implemented,
gated) · BLOCKED (gate named) · NOT RUN.

Machine context (2026-09-18): win32-x64 primary host + Linux (WSL2 Ubuntu).
Owned-process supervision exists on BOTH platforms: POSIX session groups, and —
new — Windows job-object containment via a PowerShell keeper
(`cli/src/agent/native/supervisor.ts`, drills in `supervision-win32.test.ts`).
Launch profile: `native-profiles/win-cody-zcode-cjs.json` (node v24.15.0 +
desktop bundle zcode.cjs 0.16.5, `app-server`). The profile environment must
carry `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` (and `HOME`) — discovered in N01.

| Row | Capability | win32 | linux (WSL2) | Evidence / gate |
|---|---|---|---|---|
| N00 | Static inventory / doctor | **PASS** (static checks; launch now supervised) | **PASS** (WSL node24 pinned runtime) | `evidence/zk16-n00-*`; `evidence/zk16-{linux,win32}/certify-capture.json` |
| N01 | Startup/readiness (read-only) | **PASS** | **PASS** | `evidence/zk16-win32/`, `evidence/zk16-linux/` — real session/list `{"sessions":[]}`, startup/storageState notifications |
| N02 | Create + durable bind | **PASS** | **PASS** | Real `session/create` → `sess_*` id, full snapshot schema (messages/projection/protocol/runtime/session/settings/slashCommands/todos/todoGroups) |
| N03 | Read state | **PASS** | **PASS** | Real `session/read` schema captured both OSes |
| N04 | Subscribe before first task | **PASS** | **PASS** | Legacy cursor `{eventSeq:0}` + V4 ack `{subscriptionId, logEpoch, mode:snapshot}` + `v4/conversation/frame` (wireVersion 3) observed |
| N05 | Model/reasoning readback | BLOCKED (auth) | BLOCKED (auth) | Honest skip: no advertised model in readback while the profile is unauthenticated; needs a logged-in config home — re-run when Cody opts in |
| N06 | Third-party registry | NOT RUN | NOT RUN | Out of slice; needs its own certification flow |
| N07 | First paid text/tool turn | BLOCKED (paid gate) | BLOCKED (paid gate) | **Requires recorded Cody opt-in + cost limits** (PAID-ROWS-DECISION.md). Not requested, not run |
| N08–N14, N16–N17 | Interactions/controls/fork/restart | BLOCKED (paid gate) | BLOCKED (paid gate) | Each needs one or more real model turns → behind N07 |
| N15 | Image byte + resume retention | NOT RUN | NOT RUN | Not advertised (`imageCapability: false` until certified) |
| N18 | Unsubscribe + shutdown | PARTIAL | PARTIAL | Owned-process stop verified by supervision drills (clean + brutal death, both OS semantics); the protocol-level unsubscribe row still needs its capture (free, queued next) |

Captured divergences (codec follow-ups): the real server sends a reverse
`session/requestRuntimePreferences {sessionId, scope:"runtime-materialization"}`
after create (the synthetic fixture never modeled it — host adapter TODO), and
the N02 result carries `projection.sessionId: "unknown"` while the true id is at
`result.session.sessionId`. Both recorded in the captures; fixtures to be added
with the codec work.

Known open item: `lifecycle.test.ts` (full backend-vs-fake-server scenarios)
still skips on win32 — supervision itself is proven by
`supervision-win32.test.ts` (3/3); the suite's win32 stalls are a tracked
follow-up, not a supervision gap.

What unblocks the rest: N05+ need an authenticated (logged-in) native config
home; N07+ additionally need Cody's recorded paid opt-in with model/cost limits.
— ZCode 2026-09-18
