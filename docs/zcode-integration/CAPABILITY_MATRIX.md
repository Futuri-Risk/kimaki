# ZCode native capability matrix (ZK-016)

Mechanical enablement rule: **only passing rows are advertised**; a transport-only
pass does not enable interactive execution; a Linux pass does not enable Windows;
synthetic evidence is never relabeled captured. This matrix is the honest record —
a profile flips to certified only when its row passes with captured evidence.

Statuses: PASS (captured evidence + regression fixture) · PARTIAL (implemented,
gated) · BLOCKED (gate named) · NOT RUN.

Machine context (2026-09-19): win32-x64 primary host + Linux (WSL2 Ubuntu).
Launch profile: `native-profiles/win-cody-zcode-cjs.json` (node v24.15.0 +
desktop bundle zcode.cjs 0.16.5, `app-server`). Effective config home is SPLIT:
auth/provider store resolves via `ZCODE_DATA_BASE_DIR` → `ZCode Data\.zcode\v2`
(fresh credential 2026-09-19 11:30, Cody login; the `~\.zcode\v2\setting.json`
`dataBaseDir` value is the base — the bundle appends `.zcode`), while the CLI
session store stays at `~\.zcode\cli\db\db.sqlite` (NOT redirected). Paid-row
gate is mechanical: RECORDED section + `--paid-optin-recorded` + caps
(≤3/row, ≤30 total) against `evidence/zk16-paid-spend.json`.

| Row | Capability | win32 | linux (WSL2) | Evidence / gate |
|---|---|---|---|---|
| N00 | Static inventory / doctor | **PASS** | **PASS** | `evidence/zk16-n00-*`; certify captures |
| N01 | Startup/readiness | **PASS** | **PASS** | `evidence/zk16-win32-free2/`, `zk16-linux-free2/` |
| N02 | Create + durable bind | **PASS** | **PASS** | Real `session/create` → `sess_*`, full snapshot schema |
| N03 | Read state | **PASS** | **PASS** | Real `session/read` schema both OSes |
| N04 | Subscribe before first task | **PASS** | **PASS** | Legacy cursor + V4 ack `{ack:{subscriptionId, logEpoch, mode}}` + frames (wireVersion 3) |
| N05 | Model/reasoning readback | **PASS** | NOT RUN (no WSL credential) | `evidence/zk16-win32-n05/`: catalog resolves (zai-api GLM-5.3, reasoning low/high/max default max, **supportsImage true**); setModel `{sessionId, model:{providerId, modelId, options:{reasoningLevel}}, persistAsWorkspaceLastUsed}` → exact readback. Divergence: checklist's `runtimeModel` param does NOT exist in bundle 0.16.5 (`.strict()` → -32602); captured 2026-09-19 |
| N06 | Third-party registry | NOT RUN (out of scope; method absent in bundle) | NOT RUN | matrix |
| N07 | First paid text/tool turn | **BLOCKED (CAP_EXCEEDED)** — 3/3 accepted sends, ZERO inference each | BLOCKED (behind win32) | `evidence/zk16-win32-n07/` + ledger. Three distinct hypotheses tried (refused requestRuntimePreferences → answered it; bare env → merged safe host env allowlist); identical signature every time: `accepted:true`, turn dies <300ms, turnCount 0, no model-io rollout. Desktop-vs-headless launch deltas: `--stdio --surface desktop` args, Electron runtime, env details. Needs operator decision before any further send |
| N08–N12, N14, N15, N17 | Interactions/controls/fork/image/failure-restart | NOT RUN (behind N07; drivers fail closed until their shapes are captured) | NOT RUN | `evidence/zk16-win32-paid-gates/` — every row records CAPTURE_SCHEMA_PENDING with its named prerequisite. N15 note: image IS advertised (`supportsImage: true`) so the row is runnable once turns execute |
| N13 | Idle native compact | NOT RUN (needs prior turn context) | NOT RUN | behind N07 |
| N16 | Same SID after clean restart | NOT RUN (needs a sent session) | NOT RUN | `evidence/zk16-win32-n16/`: captured DEFERRED-PERSISTENCE discovery — a config-only session is never persisted (resume → -32004, list omits it); N16 requires a session with an executed turn (post-N07). Turn-free row otherwise |
| N18 | Unsubscribe + shutdown | **PASS** | PARTIAL | win32: unsubscribe `{}` + graceful dead + abrupt keeper containment treeDown=true. linux: unsubscribe+graceful PASS; abrupt supervisor kill ORPHANS the native tree (no PDEATHSIG/keeper) — recorded with in-evidence cleanup; Linux hardening is a named follow-up |

Captured divergences (all pinned in `fixtures/native-captured-zk16.json` +
`captured-codec.ts`, 10/10 tests):
1. identity from `result.session.sessionId` only (`projection.sessionId` is the
   cosmetic `"unknown"` in every frame);
2. reverse `session/requestRuntimePreferences` at create AND at every execution
   materialization — the bridge must answer it from profile preferences
   (refusal = accepted turns execute nothing, proven by N07 run 1);
3. `session/setModel`/`session/send` carry NO `runtimeModel` key on the native
   protocol (checklist vocabulary came from the ACP layer; `.strict()` rejects
   it).

Paid-turn ledger: **3 accepted sends, 0 executed inference** (N07 3/3 — at cap,
hard stop verified: the runner exits 2 CAP_EXCEEDED). 30-turn budget: 3
accepted / 27 unspent.

Next: operator decision on the N07 execution blocker (desktop-vs-headless
launch delta) before any further paid send; then N07 → N18 in checklist order.
— ZCode session zk016-paid-cert-1, 2026-09-19
