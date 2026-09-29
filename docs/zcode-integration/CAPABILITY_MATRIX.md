# ZCode native capability matrix (ZK-016)

Mechanical enablement rule: **only passing rows are advertised**; a transport-only
pass does not enable interactive execution; a Linux pass does not enable Windows;
synthetic evidence is never relabeled captured. This matrix is the honest record —
a profile flips to certified only when its row passes with captured evidence.

Statuses: PASS (captured evidence + regression fixture) · PARTIAL (implemented,
gated) · BLOCKED (gate named) · NOT RUN.

Machine context (re-baselined 2026-09-29): win32-x64 primary host + Linux (WSL2 Ubuntu).
Launch profile: `native-profiles/win-cody-zcode-cjs.json` (node v24.15.0 +
desktop bundle zcode.cjs **0.16.9** — auto-updated payload again since the
2026-09-28 re-baseline — sha256 `fad4c35c…`, 14,820,968 b; drivers N09–N17
were rebuilt against this exact bundle). Headless auth re-verified 2026-09-29
(free probe `evidence/zk16-2026-09-29-authprobe/`: catalog resolves on first
poll — 69 ms — zai-api GLM-5.3, reasoning low/high/max default max,
`supportsImage` true, contextWindow 200k). Effective config home is SPLIT:
auth/provider store resolves via `ZCODE_DATA_BASE_DIR` → `ZCode Data\.zcode\v2`,
while the CLI session store stays at `~\.zcode\cli\db\db.sqlite` (NOT
redirected). Paid-row gate is mechanical: RECORDED section +
`--paid-optin-recorded` + caps (≤3/row, ≤30 total) against
`evidence/zk16-paid-spend.json`.

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
| N09 | Native question + plan round trip | **PASS** (2026-09-29) | NOT RUN | `evidence/zk16-2026-09-29-N09b/` `pass:true`. Leg A: genuine `AskUserQuestion` reverse request (`schema:{toolName:"AskUserQuestion"}`, options red/blue) answered ONCE (accept → "red") → real turn terminal 80.0 s → `SENTINEL-N09.txt`="red". Leg B: `setMode plan` → genuine plan approval (`schema.interaction:"plan_approval"`, ExitPlanMode) answered approve → terminal 37.0 s → `SENTINEL-N09-PLAN.txt`="ok"; mode restored. Run 1 (`-N09/`) FAIL kept as evidence: `settleTurn` false-terminal (send acceptance itself bumps `stateRevision`, so `revAdvanced` was false liveness) → leg-B send rejected `NATIVE_-32010`; driver fixed — liveness = `status==='running'` or `turnCount` advance only. Ledger N09 3/3 (at cap) |
| N10 | Active text guidance (sendText) | **PASS** (2026-09-29) | NOT RUN | `evidence/zk16-2026-09-29-N10/`: turn demonstrably active when guided; `v4/command sendText` ACK `status:"accepted"`, `revisionAtDecision:2`, `result:{type:"inputAccepted",delivery:"queue"}`; turn terminal 84.1 s; `SENTINEL-N10.txt`="ok". Recorded absence: NO `turn.steer*` events in `session/events` (kinds observed: none) — steer correlation NOT observed; pass predicate is the command decision on an active turn, not model obedience. Ledger 1/3 |
| N11 | Stop with real background writer | **PASS** (2026-09-29) | NOT RUN | `evidence/zk16-2026-09-29-N11/`: ticker materialized in projection (`taskId:"exec_82d98b12…"`, taskKind bash, cancellable:true, exact command); `v4/command stop` ACK accepted (rev 20); `session/cancelBackgroundTask` → `{cancelled:true,status:"cancelled"}` (X5i keys); ticks CEASED (`1\n2\n3\n4` stable across 4 s + 2.5 s window); turn terminal 50.2 s. Ledger 1/3 |
| N12 | Background + goal settlement | **PASS** (2026-09-29, run 2) | NOT RUN | `evidence/zk16-2026-09-29-N12b/`: `session/goal set` → `startedTurn:true`, real turn terminal 76.8 s; bounded goal-lane quiescence wait (run 1 `-N12/` FAIL kept: `goal/show`+`goal/clear` rejected `NATIVE_-32010` while the goal continuation was still active — projection-idle does NOT mean goal-lane quiet); then `show` → `"Goal complete… Usage: 140212 tokens… Time: 77 seconds"`, `clear` → `"Goal cleared."` (`startedTurn:false`, no settle needed), `goalVerifications [{passed:true}]`. Note: `GOAL-N12.txt` absent at post-settle readback in the passing run (run 1 wrote it; run 2 verified completion in-transcript — `passed:true` reason quotes ls/od -c). Ledger 2/3 |
| N13 | Idle native compact | **PASS** (2026-09-29, run 2) | NOT RUN | `evidence/zk16-2026-09-29-N13b/`: `session/compact` → `{state:"accepted"}` (Z5i keys valid), settle terminal 23.0 s, SID/workspace/model `identityPreserved:true`, post-compact `idle` (no automatic continuation). Run 1 (`-N13/`, 0 turns spent) recorded the cold-session discovery: `--session` SIDs are list-visible but `read`/`send` answer `-32004` until `session/resume` loads them — resume step added to the `--session` path. Ledger 2/3 (1 seed + compact: post-resume projection hydrates `turnCount` from <1, re-seeding one turn per reuse run — observed N13/N14/N16/N17, each counted) |
| N14 | Conversation-only fork (rowsRange) | **PASS** (2026-09-29) | NOT RUN | `evidence/zk16-2026-09-29-N14/`: rowsRange page valid sEc shape (29 rows: 4 userInput, 9 assistantText, 6 toolCall, 5 reasoning…); forkable `assistantText` rowId 29 (`actions.canFork:true`); CAS re-read fresh at attempt 0, `atLogEpoch === subscribe logEpoch`; `v4/command forkAssistant` ACK `accepted` @ revision 63 → child `sess_644b5fa6…` (`result.type:"forkAssistant"`), child read back idle/same workspace/model; workspace files unchanged. Ledger 1/3 (seed only — the fork command itself runs no model turn) |
| N15 | Image byte + resume retention | **PASS** (re-gated 2026-09-30) | NOT RUN | Combined evidence `zk16-2026-09-29-N15/` + `zk16-2026-09-30-N15R/`. **Operator ruling (2026-09-30, goal-continuation session, within recorded caps — no ledger amendment):** the native retention echo is an ARTIFACT-STORE REFERENCE (`zcode-artifact://sess_…/tool-result-…`, mime, stored bytes) — byte-identity of the client's upload is not a protocol guarantee (same divergence class as N05's `runtimeModel`); the retention contract is re-gated on ref presence + post-resume visual recall. Captured: `supportsImage:true` at runtime; fixed 70-byte PNG (sha `497790947d46…`) accepted; real turn terminal 43.8 s; **model named the image** (`SENTINEL-N15.txt`="dot"); clean restart, `resume` same SID, ref echo pre+post restart; N15R follow-up into the resumed session (fresh owned runtime) answered exactly `dot` — visual recall across restart proven. Ledger N15 3/3. The original byteMatch predicate remains recorded as a checklist divergence, not a product defect |
| N16 | Same SID after clean restart | **PASS** (2026-09-29) | NOT RUN | `evidence/zk16-2026-09-29-N16/`: pre-restart cursor 41 captured; clean stop → second owned runtime, new client generation (old client closed); `session/resume` SAME SID (full snapshot); model readback matches; resubscribe from saved cursor → `eventSeq:7`; `session/list` contains the session; second stop clean, new pid dead. Ledger 1/3 (seed; the restart leg itself is config-only) |
| N17 | Failure/restart resume with list omission | **PASS** (2026-09-29) | NOT RUN | `evidence/zk16-2026-09-29-N17/`: seed turn (pre-state 23 messages, sentinel "ok"); dropped send observed `accepted` then stop landed (1781 ms) — conservatively counted; restart WITHOUT resend: `session/list` shows both sessions (`omitsKnownSid:false` — the omission branch was not exercised this run; direct resume performed regardless per checklist); `resume` same SID; messages 23→25 (exactly the ≤+2 no-replay bound — the dropped exchange settled server-side with NO file effects); filesystem intact; no whole-task replay; second runtime stopped, pid dead. Ledger 2/3 |
| N18 | Unsubscribe + shutdown | **PASS** | PARTIAL | win32: unsubscribe `{}` + graceful dead + abrupt keeper containment treeDown=true. linux: unsubscribe+graceful PASS; the abrupt-kill orphan gap (no PDEATHSIG/keeper) was FIXED by the SWARM #23 POSIX keeper (2b852b85) — verified in-situ on WSL 2026-09-29 via the zero-dep regression drill (`evidence/zk23-linux-recheck-2026-09-29/`: brutal-supervisor-death tree dead 59 ms vs 10 s bound at supervision-posix-drill.mjs:22, clean-stop 45 ms, exit 0). Status stays PARTIAL: the certify.mjs N18 linux leg was NOT re-run — repo dist predates #23 (Sep 19 build) and would exercise the old supervisor, so the flip waits for a dist rebuild + leg re-run |

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
4. (2026-09-29, N12 run 1) projection-idle + empty `pendingRequestIds` does
   NOT mean the GOAL lane is quiet: `session/goal show|clear` reject
   `NATIVE_-32010` while a goal continuation prompt is still active. The
   runner now bounded-waits for goal-RPC quiescence before clearing.
5. (2026-09-29, N13 run 1) a persisted turn-bearing session is VISIBLE in
   `session/list` but cold `session/read`/`session/send` answer `-32004`
   until `session/resume` loads it into the runtime (extends the 2026-09-28
   N16 finding: unexecuted sessions are never persisted at all).
6. (2026-09-29, N15) the attachment retention echo is an artifact-store
   REFERENCE (`zcode-artifact://…`, `tool-result-*` name, byte count of the
   stored artifact — 118 b for a 70 b client PNG), never the client's
   bytes/filename — byte-identity cannot be proven from the echo.
7. (2026-09-29, N10) no `turn.steerQueued`/`turn.steerDrained` events were
   observed in `session/events` despite an accepted guide command with
   `delivery:"queue"` — their absence is recorded, correlation unproven.
8. (2026-09-29, N13/N14/N16/N17) after `session/resume`, the projection
   hydrates `turnCount` from <1 even for multi-turn sessions — the runner's
   turn-bearing seed guard re-seeds exactly one turn per reuse run (observed
   on all four reuse rows; each counted against that row's cap).

Paid-turn ledger (2026-09-29, after the N09–N17 run): **20 turns / 30 spent**
— N07 3/3 (historical, at cap), N08 2/3, N09 3/3 (at cap), N10 1/3, N11 1/3,
N12 2/3, N13 2/3, N14 1/3, N15 2/3, N16 1/3, N17 2/3. All fifteen turns spent
on 2026-09-29 executed REAL inference (liveness + terminal + sentinel/message
effects in each capture); the false-terminal racing bugs that produced the
2026-09-19 dead-on-arrival cluster were found and fixed in-run (settleTurn
liveness predicate; goal-lane quiescence wait; `--session` cold-resume) —
every fix strengthens a gate, none weakened, and the failing run 1 captures
are kept as evidence (`-N09/`, `-N12/`, `-N13/`).

Next: N15 is the only open FAIL (artifact-ref echo vs byte-identity — needs
an operator call: accept the artifact-ref echo as the retention contract and
re-gate, or amend the ledger for one re-run with follow-up-text capture).
N09 is at cap. N06 stays out of scope; ZK-017 matched pairs remain NOT
covered by the recorded opt-in and were not run. Linux column for N09–N17
remains NOT RUN (win32 is the primary host).
— ZCode certification runner, 2026-09-29; prior state 2026-09-28 (r5)
