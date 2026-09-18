# Move-forward — decision brief (what we actually need now)

Written by ZCode, 2026-09-18. Research brief against primary sources (code at this
worktree, forge issues #16/#17/#19, certification evidence, release-store ops docs,
upstream GitHub). No paid row was run; no model/API call was made.

## Decision brief

**The practical answer.** The two engineering blockers that defined this project this
morning are already gone. Windows owned-process supervision is **implemented and
drilled** (job-object keeper, `cli/src/agent/native/supervisor.ts`; 3/3 containment
drills in `supervision-win32.test.ts`), and the free certification rows **N00–N04 now
PASS with real-server captures on both win32 and Linux/WSL2**
(`evidence/zk16-{win32,linux}/certify-capture.json`, forge #16 comment 2026-09-18
22:06). What we need to move forward is, in order:

1. **Two inputs only Cody can give** — this is now the true critical path:
   - **Log in to ZCode** on the certification config home (Windows `~\.zcode` or a
     WSL one — pick one and say which). N05 (model readback) is free but needs an
     authenticated profile; without it nothing downstream reads back a model.
   - **The paid-row opt-in with limits** (model list, ≤3 turns/row, ~20–30 small
     turns total, hard stop — already drafted in `PAID-ROWS-DECISION.md`). N07–N18
     are hard-refused in code until it is recorded (`tools/certify.mjs:58-63`).
2. **A short free-lane engineering list agents can do today** (no Cody input, no
   quota): the N18 protocol-level unsubscribe capture (extend `tools/certify.mjs`,
   whose method allowlist does not yet include it), codec regression fixtures for the
   two captured divergences (`session/requestRuntimePreferences` reverse request;
   `projection.sessionId: "unknown"` — `CAPABILITY_MATRIX.md`), and un-stalling
   `lifecycle.test.ts` on win32 (suite assumptions, not a supervision gap).
3. **A release-path decision (A/B/C)** — needed before production, not before
   certification. Grounded recommendation: **C now, A later** (see Q5).

**Recommended critical path.** Free lane now → Cody login → paid opt-in → paid rows
N07→N18 with codec-per-divergence → flip profile capabilities per the mechanical
enablement rule → profile certified → #17 fidelity matched pairs → real-Discord
native smoke → execute release path → production. #19 (ZS-PHASE) stays gated until a
certified profile exists.

**Causal reason.** Certification is the sole gate for everything downstream: #17
requires ZK-016 ≥ N07; production enablement requires a certified profile
(`native-profile.ts` registry is empty by design — default-off is structural);
#19's gate prefers exactly that certified profile. Since the evening of 2026-09-18,
certification is gated only on **auth + opt-in**, not on engineering.

**Conditions that could change it.** (a) Paid opt-in refused or deferred → the free
lane completes and the project parks honestly default-off. (b) A paid row exposes a
protocol divergence too large to codec quickly → timeline slips, path unchanged.
(c) The keeper containment has one un-drilled corner (brutal kill of the *keeper*
PowerShell process itself — the drills kill the supervisor, and KILL_ON_JOB_CLOSE is
recorded as unverifiable on this build); if audit rejects that corner, supervision
work reopens in a small way. (d) Upstream moved to 0.29.0 today; the longer we wait,
the costlier the release-path rebase.

**Single next action.** Agents: extend `tools/certify.mjs` with the N18
unsubscribe/shutdown capture and add the two codec fixtures — free rows, no gates.
Cody, when you have a minute: log in to ZCode, then record the paid opt-in.

---

## Q1 — Windows owned-process supervision: done, and here is exactly what exists

**Status changed today.** The PLATFORM_UNCERTIFIED gate is no longer raised. The
refusal was removed in commit `f9ca8516` and replaced by the ordinary fingerprint
checks with an explanatory comment: `cli/src/agent/native/process.ts:46-50`
("Windows supervision is implemented (supervisor job object with a kill-on-close
keeper). The gate is now the ordinary fingerprint checks below; capability still
comes from certification rows."). The remaining structural refusal is
`RUNTIME_UNCERTIFIED` in `zcode-backend.ts:293` — the not-yet-certified profile
gate, correct and wanted.

Minor drift found: the doc comment at `zcode-backend.ts:166-171` still says
"(POSIX-only; win32 refuses with PLATFORM_UNCERTIFIED)" — stale after `f9ca8516`;
one-line comment fix, worth folding into the free lane.

**What the POSIX implementation relies on** (for contrast): the supervisor spawns
the native child `detached` (`supervisor.ts:260-266`, `detached: !isWin`), which on
POSIX makes it a session/process-group leader (Node docs:
https://nodejs.org/api/child_process.html — "the child process will be made the
leader of a new process group and session… See setsid(2)"), and signals the whole
group via negative-pid `process.kill(-pid)` (`supervisor.ts:167-183`).

**What Windows parity required and got** — a ~300-line single module
(`cli/src/agent/native/supervisor.ts`, 297 lines) plus a 237-line drill suite:

- A PowerShell **keeper** subprocess holds a Job Object via P/Invoke
  (`CreateJobObject`/`SetInformationJobObject`/`AssignProcessToJobObject`/
  `TerminateJobObject`) — `supervisor.ts:22-62`.
- Containment is **ACTIVE, not close-based**: keeper stdin `EOF` (supervisor death),
  `EXIT`, or `KILL` all end in `TerminateJobObject`, which kills every assigned
  process and descendant — `supervisor.ts:45-48,59`. `KILL_ON_JOB_CLOSE`
  (limit flag 0x2000, `supervisor.ts:40-41`) is set best-effort but explicitly
  never trusted — header comment `supervisor.ts:1-8`.
- The native child is assigned to the job **before** the supervisor reports
  `ready`; if assignment fails the launch is refused outright rather than owned
  unsupervised — `supervisor.ts:282-293`.
- A watchdog kills the direct child and exits 70 if the keeper dies while the child
  lives — `supervisor.ts:110-117`. Clean stop = SIGTERM → grace → SIGKILL → keeper
  `KILL` → confirm dead or exit 70 — `supervisor.ts:184-208`.
- Liveness on win32 uses `process.kill(pid, 0)` with ESRCH discrimination
  (`supervisor.ts:167-174`) — no `/proc` anywhere. Node semantics make this
  necessary: on Windows there are **no POSIX process groups**, `detached` just lets
  the child outlive the parent, all signals coerce to forceful kill, and
  `subprocess.kill()` reaches only the direct child (Node child_process docs,
  https://nodejs.org/api/child_process.html). Tree-kill therefore needs OS
  containment (Job Objects), exactly what the keeper provides.

**Tests.** `supervision-win32.test.ts` 3/3: clean stop kills the tree including a
grandchild (lines 98-147); **brutal supervisor death** (`taskkill /F`, no stop
message) still contains the tree (149-202); grandchild observability via
`Win32_Process` (204-236). `native-core.test.ts` 19/19; preflight error codes are
preserved through `startOwnedRuntime` (`process.ts:187-195`).

**Residual risk spots (honest list).**
1. The drills kill the *supervisor*; nothing drills brutal kill of the *keeper*
   PowerShell itself. On this build KILL_ON_JOB_CLOSE is unverifiable, so
   keeper-brutal-death containment is theoretically open. A `taskkill /F` keeper
   drill would close it (or document it as accepted).
2. The keeper depends on Windows PowerShell 5.1 + `Add-Type` compilation at startup
   — tests note keeper startup adds seconds per launch
   (`lifecycle.test.ts:33,48,152`).
3. `lifecycle.test.ts` full backend-vs-fake-server scenarios still skip on win32 —
   explicitly a suite-assumption follow-up, *not* a supervision gap
   (`lifecycle.test.ts:23-27`; `CAPABILITY_MATRIX.md` records it the same way).

**Scope verdict for the ledger:** this was the feared "new platform module" item; it
landed as one new ~300-line supervisor module + drills in commit `f9ca8516`
(pushed: `gitea feat/zcode-integration` = `f9ca8516`). Remaining supervision work is
drill-hardening only.

## Q2 — WSL certification path: valid Linux evidence, with named limits

**What was actually run.** `evidence/zk16-linux/certify-capture.json` records
`host.platform: "linux"`, `host.node v20.20.2` (WSL system node), and profile
executable `/home/cody/zk-cert/node-v24.15.0-linux-x64/bin/node` — a pinned Linux
node v24 tarball (system node 20 lacks `node:sqlite`; forge #16 comment 2026-09-18
22:06). The entry is `/mnt/c/Users/Cody/AppData/Local/Programs/ZCode/resources/glm/zcode.cjs`
— **the same Windows desktop bundle**, mounted via /mnt/c, run under Linux node.
Environment: `HOME=/home/cody`, `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=/mnt/c/...`.
N01–N04 PASS, `stop: {ok: true}`. N00's Linux column: WSL node24 pinned runtime
(`CAPABILITY_MATRIX.md`).

**Is it certifiable Linux evidence?** Yes for what it covers — because
`certify.mjs` itself executed *inside* WSL (the capture's host platform is linux),
the **supervisor and the runtime both lived on the Linux side**. POSIX
process-group supervision, NDJSON protocol behavior, and schema shapes were
exercised under a real Linux kernel. This was **not** a `wsl.exe` relay from a
Windows host, and production never needs one: the mechanical rule is per-OS columns
("a Linux pass does not enable Windows" — `NATIVE_CERTIFICATION_CHECKLIST.md`
§Mechanical enablement rule; N18: "Certify separately on every claimed OS",
line 43). Windows production kimaki uses the win32 column (job-object keeper); the
Linux column stands on its own.

**What it does NOT certify (name these on any Linux claim):**
1. **WSL2 ≠ all Linux.** What is certified is WSL2 Ubuntu. A bare-metal or server
   Linux deployment would need its own rows.
2. **The fingerprint is the win32-built bundle** (`bundleMeta: platform win32-x64`,
   source `apps/zcode-cli/packages/cli/dist/zcode.cjs` —
   `native-profiles/win-cody-zcode-cjs.json`). It is portable CJS and N01–N04 prove
   it launches and speaks the protocol under Linux node, but a Linux-native ZCode
   distribution — if one exists — is a different fingerprint needing its own
   N00/N01+ rows. On this machine the only npm form is `zcode-acp-server@0.19.0`,
   which is the ACP **bridge** layer with no `app-server` subcommand
   (`evidence/zk16-n00-inventory.md`); official docs describe installation on
   desktop platforms (research bundle `zcode-subrouter-opencode-research.md:237`,
   citing https://zcode.z.ai/en/docs/install). **A dedicated Linux install form:
   UNVERIFIED.**
3. **Separate config home / session store.** The Linux run's `HOME=/home/cody`
   implies its native config home is `/home/cody/.zcode`, disjoint from Windows
   `~\.zcode` (inferred from the environment in the capture; storage layout inside
   the runtime not directly inspected — inference, flagged as such). Sessions and
   login state are per-config-home: N05 on Linux would need its own ZCode login.
4. **A hypothetical `wsl.exe`-relay production mode** (Windows kimaki supervising a
   Linux tree through a relay) was **not** built and would need its own launch
   profile and rows; killing `wsl.exe` does not reliably map to killing the Linux
   process tree (UNVERIFIED — and moot, since no current plan needs it).

**What a WSL/Linux profile manifest needs** (mirrors the win32 manifest):
executable sha256 (the pinned `/home/cody/zk-cert/...` node), entry sha256 (same
zcode.cjs hash), args `[entry, app-server]`, environment (`HOME`,
`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`), and the recorded discovery that the
app-server exits without `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` and needs `HOME`
(profile manifest notes; forge #16 comment 3195).

## Q3 — Paid rows opt-in: a pure human decision, cost is small

`PAID-ROWS-DECISION.md` already asks Cody for exactly three things when opting in
(lines 47-52): **which model(s)** may be used, a **turn cap per row** (proposal ≤3
turns/row, **~20–30 small turns total** across N07–N18 on disposable sentinel
repos), and a **hard stop** if any row exceeds its cap. The code enforces the gate
independently of the docs: rows outside the free allowlist are refused
(`tools/certify.mjs:11-25,58-63`), and no certified profile exists to route through
anyway (`native-profile.ts:1-5` — empty registry, default-off structural).

**Cost scale — ESTIMATE, order of magnitude only.** The checklist's paid rows are
small by construction: "disposable repository and a uniquely named sentinel task"
(N07), one tool action (N08), one interaction (N09), one guide (N10), one stop
(N11), compact (N13), fork (N14), one image (N15), restart/resume (N16–N17)
(`NATIVE_CERTIFICATION_CHECKLIST.md` table). At ≤3 turns/row and ~20–30 turns
total, each turn being a small sentinel prompt with modest context, a realistic
total is on the order of **10^5–10^6 tokens end to end** — i.e. a small fraction of
one ordinary coding-agent working session. Against a Z.AI plan quota this is
noise; against API credit it is roughly single-digit dollars for GLM-class pricing.
This is an estimate, not a measurement; the caps exist precisely so it cannot
run away.

Also needed from Cody but **not** paid: an authenticated config home (N05 is free
but reads back nothing while logged out — `CAPABILITY_MATRIX.md` N05 row,
"re-run when Cody opts in"). Logging in is a credential action only Cody can do.

## Q4 — What #17 and #19 need

**#17 (ZK-017, fidelity matched pairs).** Requires ZK-016 ≥ N07 (forge #17 body;
ticket Status "BLOCKED"). The full 6-step matched-pair protocol is already written
into the ticket (identical binary/task/workspace/credentials/model/preferences per
pair; direct vs bridged; divergences fixed in the bridge, never by weakening
direct-run semantics; 3–5 small sentinel tasks). Nothing else is missing — it
executes the day paid rows certify. Forge label `stalled` is accurate.

**#19 (ZS-PHASE).** Gate: "core boundary stable, host-independent tests green, no
Kimaki/Discord leakage into the core, ZK host tickets complete, preferably a basic
native profile certified" (forge #19 body; `tickets/ZS-PHASE-subrouter.md`). Check
against the code:

- **Boundary is clean and test-enforced**: `native-boundary.test.ts:14-37` (H30)
  asserts no `cli/src/agent/native/` module imports host modules, anything above
  `native/`, or host dependencies (discord.js/drizzle/opencode/db/config). Green
  (native-core 19/19 at `f9ca8516`).
- **Discord imports exist in `cli/src/agent/` but not in the core**:
  `interaction-bridge.ts:19`, `message-ingest.ts:7`, `renderer.ts` import
  discord.js — that is the **host adapter layer**, which `SHARED_RUNTIME_MAP.md`
  explicitly assigns to the host ("zcode-backend/coordinator/store … must not enter
  the shared native package"; ZS-002 targets `cli/src/agent/native/` "or extracted
  shared location"). **No current violation of the #19 gate.**
- Host tickets ZK-001..015 + ZK-018 closed. "Preferably a basic native profile
  certified": free rows N01–N04 are captured but the profile is `certified: false`
  (`native-profiles/win-cody-zcode-cjs.json`).
- One stale research row: `SHARED_RUNTIME_MAP.md` (process/supervisor row) still
  says the OS implementation is "Linux-tested POSIX … do not promise Windows" —
  superseded by `f9ca8516`. Update when the map is next touched, not urgent.

**Recommendation on the gate:** keep #19 closed until a profile is certified.
`SHARED_RUNTIME_MAP.md` recommendation B says keep the core private "until host
integration **and one native profile are certified**" — publishing or extracting
earlier would freeze unverified codecs. Certification is close; the ordering cost
of waiting is near zero.

## Q5 — Release path A/B/C, grounded in numbers

Facts gathered:

- **Delta size vs upstream baseline 4a36f47e:** 143 files changed,
  +34,917/−2,118 total; the integration slice (cli/src/agent, cli-commands,
  .changeset, tools, docs) is **117 files, +31,797 lines**, almost entirely
  additive (`git diff --stat 4a36f47e..HEAD`). A dist patch expressing this is not
  a patch; it is a parallel build.
- **The patch pipeline is hostile to that.** Auto-update is ON with a staged
  seatbelt that re-applies patches on every upstream release, and the live pass is
  **degrade-open**: a patch whose anchors drift is *skipped and logged*, not fatal
  (`C:/Dev/opencode-kimaki-releases/docs/PATCH-REGISTRY.md`, "The upgrade model").
  A 117-file feature patch would be silently dropped on the first upstream touch —
  capability loss without outage. Option B is the worst fit for this delta.
- **Upstream cadence is fast and already ahead:** 0.27.0 Sep 1 → 0.28.0 Sep 14 →
  **0.29.0 released today, 2026-09-18** (https://github.com/remorses/kimaki/releases).
  0.29.0 touches cli commands, session handling (SQLite queue persistence),
  discord-bot grouping/rendering, and an OpenCode runtime workaround — host files
  this integration also modifies, so a rebase has real (but ordinary) conflicts,
  while the 58-file `cli/src/agent/**` tree is purely additive.
- **Option C is natively supported by the store.** The release transaction model
  (`C:/Dev/opencode-kimaki-releases/docs/KIMAKI-RELEASE-TRANSACTION.md`) already
  provisions *complete isolated release slots* (`Store/releases/<version>-<uuid>/
  node_modules/kimaki`) with a validator and atomic `selection.json` — registering
  a built `feat/zcode-integration` artifact as its own slot is the mechanism
  working as designed, no patch derivation at all.
- **Licensing note for option A:** the integration launches the user's own
  installed ZCode runtime and does not bundle it; the research flagged that ZCode
  runtime redistribution rights are not established ("do not bundle ZCode" —
  `zcode-subrouter-opencode-research.md:61`). A PR upstream should stay
  launch-the-user's-install shaped, which it already is.

**Grounded read:** **C (pinned custom release entry) unblocks production soonest
with least brittleness** — it uses the existing transactional store, has zero patch
surface, and its only cost is version drift until A happens. **A (upstream) remains
the destination** — cleanest long-term, and the fast cadence means an upstreamed
default-off feature ships within days of merge. B should be ruled out for this
delta. Decision stays with Cody (`RELEASE-PATH.md` records the options; decision
field open).

## Q6 — Full move-forward map (dependency-ordered)

Current-position facts first: HEAD `f9ca8516` on `feat/zcode-integration` (pushed
to gitea); supervision implemented + drilled both OS semantics; N00–N04 captured
both OSes; N05 blocked on auth; N06 NOT RUN (third-party registry — only applies if
such a profile is ever certified; likely N/A for the builtin profile); N07–N17
blocked on paid opt-in; N18 PARTIAL (supervision half proven by drills; the
protocol-level unsubscribe capture is still owed). Change set exists
(`.changeset/zcode-native-default-off.md`, minor). Production bot still runs
upstream 0.28.0 from the release store.

Ordered work items (→ means "gates"):

| # | Item | Type | Gates / gated-by |
|---|---|---|---|
| 1 | N18 protocol unsubscribe capture (extend `tools/certify.mjs` allowlist) | free, agents now | → completes the free-row column both OSes |
| 2 | Codec fixtures + regression tests for captured divergences (`requestRuntimePreferences`, `projection.sessionId`) + stale comment fix `zcode-backend.ts:167` | free, agents now | → honest codec basis for paid-row captures |
| 3 | `lifecycle.test.ts` win32 un-stall | free, agents now | → full-suite parity on the primary host |
| 4 | Cody: ZCode login on the chosen certification config home | human action | → N05 (free) both OSes |
| 5 | Cody: paid opt-in + recorded limits (`PAID-ROWS-DECISION.md`) | human decision | → N07–N14, N16–N17 (+N15 if image advertised) |
| 6 | Paid rows N07→N18, codec-per-divergence, per-row capability flip | agents, after 4+5 | → profile certified (mechanical enablement rule) |
| 7 | Profile flip synthetic → native-certified, evidence beside profile | agents, after 6 | → everything user-visible |
| 8 | #17 fidelity matched pairs | agents, after 7 (≥N07) | → parity claims |
| 9 | Real-Discord native smoke test | agents + human-gated guild access (MASTER_PLAN §7) | → production confidence |
| 10 | Release path decision + execution (recommend C now, A later) | Cody decides; agents execute | → production rollout |
| 11 | #19 ZS-PHASE opens; file ZS-001..010 | after 7 (certified profile) | → subrouter phase |

Parallel lanes: 1–3 run now with no gates; 4 and 5 are Cody's two inputs; 10 can be
decided any time (it gates only rollout, not certification).

**Recommendation (one paragraph).** Run the free lane (items 1–3) immediately — it
is small, unblocked, and makes the eventual certified profile's evidence complete.
In the same breath, put the two Cody asks in front of him as a pair (ZCode login +
paid opt-in with the drafted limits), because they are now the only thing between
us and N05→N18. Execute paid rows strictly in checklist order, flipping
capabilities only per passing row, which converges on a certified profile without
any further decisions. The moment the profile is certified, #17's protocol is ready
to execute and #19's gate opens on its own terms. Decide the release path (C now, A
later) before rollout planning but do not let it block certification; upstream's
0.29.0-today cadence argues for rebasing onto 0.29.0 early in the free lane so the
eventual C-slot (or A-PR) is a small step, not a leap.

---

## Decisions still needed from Cody (humans only)

1. **Paid-row opt-in** with recorded limits (models; ≤3 turns/row; ~20–30 turns
   total; hard stop) — drafted in `PAID-ROWS-DECISION.md`, not yet given. Gates
   N07–N18 and therefore #17.
2. **ZCode login** on the certification config home — and which config home
   (Windows `~\.zcode` vs a WSL one) is the certification profile's home. Gates N05.
3. **Release path** A/B/C — documented in `RELEASE-PATH.md`; this brief recommends
   C now / A later. Gates production rollout only.

## Work items agents can start now (no Cody input, no quota)

- N18 protocol-level unsubscribe capture on win32 + WSL (small `tools/certify.mjs`
  extension; `v4/conversation/unsubscribe` is not yet in the method allowlist at
  `certify.mjs:18-25`).
- Codec regression fixtures for the two captured divergences
  (`CAPABILITY_MATRIX.md` "Captured divergences").
- `lifecycle.test.ts` win32 un-stall (suite assumptions).
- Stale-comment fix `zcode-backend.ts:167` (and eventually the
  `SHARED_RUNTIME_MAP.md` process/supervisor row).
- Optional drill: brutal-kill the keeper itself, to close the last containment
  corner (Q1 risk spot 1).

## UNVERIFIED items (flagged, not guessed)

- Whether an official Linux-native ZCode distribution/install form exists (only the
  desktop bundle and the ACP bridge are observed on this machine).
- Keeper-brutal-death containment on this Windows build (KILL_ON_JOB_CLOSE
  unverifiable per `supervisor.ts:1-8`; not drilled).
- WSL-side config-home/session-store isolation — inferred from `HOME` in the
  capture, not inspected inside the runtime.
- Upstream 0.29.0 file-level conflict overlap with this branch (release-scope
  summary only; no rebase attempted).

---

*Written by ZCode 2026-09-18 from primary sources: this worktree at
`f9ca8516` (branch `feat/zcode-integration`, pushed), forge issues #16/#17/#19 with
all comments read, `Research GPT6PRO/NATIVE_CERTIFICATION_CHECKLIST.md`,
`C:/Dev/opencode-kimaki-releases` ops docs, upstream GitHub releases, Node.js
official child_process docs. No paid row run; no model/API call made. Commit:
this file only, on `feat/zcode-integration` per the working contract.*
