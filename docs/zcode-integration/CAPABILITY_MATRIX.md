# ZCode native capability matrix (ZK-016)

Mechanical enablement rule: **only passing rows are advertised**; a transport-only
pass does not enable interactive execution; a Linux pass does not enable Windows;
synthetic evidence is never relabeled captured. This matrix is the honest record —
a profile flips to certified only when its row passes with captured evidence.

Statuses: PASS (captured evidence + regression fixture) · PARTIAL (implemented,
gated) · BLOCKED (gate named) · NOT RUN.

Machine context (re-baselined 2026-09-28): win32-x64 primary host + Linux (WSL2 Ubuntu).
Launch profile: `native-profiles/win-cody-zcode-cjs.json` (node v24.15.0 +
desktop bundle zcode.cjs **0.16.9**, sha256 `b1df2ef3…`, 14,820,819 b —
re-baselined 2026-09-28 after the desktop auto-updated off 0.16.5/`da61b066…`;
per zk16-n07-debug/DEBUG-NOTES.md, hash changes invalidate the old pin). Headless
auth re-verified 2026-09-28: model catalog resolves again (zai-api GLM-5.3,
reasoning low/high/max default max, `supportsImage`+`supportsVideo` true,
`contextWindow` 200k in projection / 1M advertised) —
`evidence/zk16-auth-recheck-20260928{,b}/`. Effective config home is SPLIT:
auth/provider store resolves via `ZCODE_DATA_BASE_DIR` → `ZCode Data\.zcode\v2`
(fresh credential 2026-09-19 11:30, Cody login; the `~\.zcode\v2\setting.json`
`dataBaseDir` value is the base — the bundle appends `.zcode`), while the CLI
session store stays at `~\.zcode\cli\db\db.sqlite` (NOT redirected). Paid-row
gate is mechanical: RECORDED section + `--paid-optin-recorded` + caps
(≤3/row, ≤30 total) against `evidence/zk16-paid-spend.json`.

| Row | Capability | win32 | linux (WSL2) | Evidence / gate |
|---|---|---|---|---|
| N00 | Static inventory / doctor | **PASS** (re-baselined 2026-09-28 on bundle 0.16.9) | **PASS** | `evidence/zk16-n00-*` + re-baseline `evidence/zk16-n00-r5-doctor-output.json` (doctor staticInventory PASS 6/6, platform-support BLOCKED = standing WINDOWS-SUPERVISED note; entry `b1df2ef3…`/14,820,819 b, `--version` → 0.16.9) |
| N01 | Startup/readiness | **PASS** | **PASS** | `evidence/zk16-win32-free2/`, `zk16-linux-free2/` |
| N02 | Create + durable bind | **PASS** | **PASS** | Real `session/create` → `sess_*`, full snapshot schema |
| N03 | Read state | **PASS** | **PASS** | Real `session/read` schema both OSes |
| N04 | Subscribe before first task | **PASS** | **PASS** | Legacy cursor + V4 ack `{ack:{subscriptionId, logEpoch, mode}}` + frames (wireVersion 3) |
| N05 | Model/reasoning readback | **PASS** | NOT RUN (no WSL credential) | `evidence/zk16-win32-n05/`: catalog resolves (zai-api GLM-5.3, reasoning low/high/max default max, **supportsImage true**); setModel `{sessionId, model:{providerId, modelId, options:{reasoningLevel}}, persistAsWorkspaceLastUsed}` → exact readback. Divergence: checklist's `runtimeModel` param does NOT exist in bundle 0.16.5 (`.strict()` → -32602); captured 2026-09-19 |
| N06 | Third-party registry | NOT RUN (out of scope; method absent in bundle) | NOT RUN | matrix |
| N07 | First paid text/tool turn | **PASS** (r5, 2026-09-28) | BLOCKED (behind win32) | `evidence/zk16-win32-n07n08-r5/`: accepted `session/send` → REAL GLM-5.3/max turn — liveness 423 ms, terminal at 33.6 s, readback `turnCount 1`, `contextUsed 19966/200000`, `totalTokenCount 39855`, `currentTurnId turn_3256b144…`; sentinel `SENTINEL-N07.txt` written containing `ok` via one `interaction/requestPermission` answered allow-ONCE (no `permissionUpdates`). The 2026-09-19 dead-on-arrival cluster is CONFIRMED FIXED by the two-stage settle (projection-lag fix, zk16-n07-debug). Ledger N07 now 3/3 — at cap, no further N07 sends |
| N08 | Permission denial + explicit allow-once | **PASS** (r5, 2026-09-28) | NOT RUN (behind win32) | `evidence/zk16-win32-n07n08-r5/` `pass:true`. Deny leg: real turn (terminal 10.4 s), one `interaction/requestPermission` (Write, `riskLevel medium`) answered `decision:"deny"` → NO file. Allow leg: real turn (23.2 s), fresh request answered `decision:"allow"` allow-once → `SENTINEL-N08-ALLOW.txt` written containing `ok`. Full captured option schema now includes `permissionUpdates` (`addRules` for `allow_project`) — recorded, deliberately unused. Ledger N08 2/3 |
| N09–N12, N14, N15, N17 | Interactions/controls/fork/image/failure-restart | NOT RUN (drivers fail closed until their shapes are captured; turns now proven runnable post-N07) | NOT RUN | `evidence/zk16-win32-paid-gates/` — every row records CAPTURE_SCHEMA_PENDING with its named prerequisite. N15 note: image IS advertised (`supportsImage: true`) so the row is runnable once turns execute |
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

Paid-turn ledger (2026-09-28, after r5): **5 turns / 30 spent** — N07 3/3 (at
cap: 2 from r2-era accounting + 1 real turn in r5; hard stop verified — the
runner exits 2 CAP_EXCEEDED), N08 2/3 (both real r5 turns). r5 = 3 real GLM
turns, all executed (liveness + terminal + token accounting + sentinel
effects), zero dead-on-arrival.

Next: N09 (native question/plan round trip) per checklist order, then N10+;
N07 is capped (no further sends without an operator ledger amendment). Rows
beyond N08 remain NOT RUN.
— ZCode certification runner, 2026-09-28 (r5); prior state 2026-09-19
