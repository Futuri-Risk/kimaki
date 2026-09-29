# ZK-016 N07/N08 debug notes — 2026-09-19 night (ZCode, orchestration session)

What actually happened to the "dead-on-arrival" turns, and what was fixed.

## Root cause of the dead-turn cluster (SOLVED)

**The runner was killing its own turns in infancy.** After an accepted
`session/send`, the session projection lags by ~1-3s (status stays `idle`,
turnCount stays 0 while `context_initialization` runs — verified in the green
log trail: send accepted → projection flips to running ~2.5s later → turn
completes ~45s). The runner's settle-check (`until(...)`) polled the projection
IMMEDIATELY, read the stale idle state, and declared the turn terminal in
<300ms. It then fired the next row's send into the still-running turn
(`session/send rejected: active prompt exists` — correct runtime behavior) and
stopped the owned runtime mid-turn. Result: turns murdered before reaching the
model — genuinely zero inference spent (no model-io rollout files, confirmed).

NOT the cause (each eliminated with evidence):
- Windows supervision (drilled 3/3, launches fine).
- Environment curation (green runs on curated+profile, full env, and bare env).
- Bundle 0.16.5 vs 0.16.9 (deaths and greens on both).
- Electron-vs-node, auth, workspace path form, parent cwd, session/list.

**Fix:** two-stage settle — stage 1 waits for liveness (`status === 'running'`
or `turnCount >= 1`, ≤20s); stage 2 waits for terminal only after liveness.

## Supporting fixes in tools/certify.mjs

1. **N08 permission answering** (row machinery): reverse-request handler for
   `interaction/requestPermission` with policy refuse|deny|allow; answer
   validated against the captured bundle schema (zod `jL`):
   `{decision: 'allow'|'deny'|'escalate'|'modify', reason?}.strict()` — an
   `allow` WITHOUT `permissionUpdates` is allow-ONCE (no persistent grant).
   N07 runs with allow-once; N08 runs deny-leg then allow-leg (2 turns).
2. **advertisedModel() poll** (was a single read racing async catalog
   population, 2-10s after create).

## Independent verification

A standalone probe (this dir, `probe.mjs`) drove the certified owned-launch
path end-to-end **6+ times green** across every suspect composition (env
curations, bundle versions, list-first, runner's exact workspace, entry slash
form, repo-root parent cwd): real GLM turn every time (~40s, tool calls,
permission requests raised). E.g. sess_7daefba1 (0.16.9, runner-exact
conditions): full turn, 49s.

## Other findings

- **Bundle updates under you:** the desktop app auto-updated zcode.cjs twice
  today (0.16.5 → 0.16.9, entry hash da61b066… → 8f5cfccf…). A running
  app-server keeps its loaded code, but certification evidence is
  hash-pinned — re-baseline the profile manifest and re-run affected rows
  after any desktop update. The runner already fingerprints fresh at launch.
- **Headless token expiry:** the fresh login (11:30) resolved the model
  catalog through ~23:43; by 00:00 catalog reads come back empty while the
  desktop app (same credential store) keeps working — the desktop refreshes
  its token, headless apparently does not (or its refresh failed). One fresh
  `zcode login` click should restore it. UNVERIFIED as the exact mechanism.
- N08 sends into a session with a live turn are correctly rejected
  (`active prompt exists`) — rows must strictly serialize turns.
- Ledger: N07 reset 3→0 (Cody-approved, zero inference proven); r2 spent 1
  real turn (N07 2/3). Night runs r3/r4 spent nothing (MODEL_UNAVAILABLE).

## Next session's runbook

1. `zcode login` (fresh headless token).
2. `node tools/certify.mjs --executable <node> --entry <zcode.cjs>
   --workspace <tmp sentinel> --out docs/zcode-integration/evidence/zk16-win32-n07n08-r5
   --rows N07,N08 --paid-optin-recorded --timeout 30000
   --env HOME=... --env ZCODE_DATA_BASE_DIR="C:\Filen\Reference\Tech\AI\Claude\ZCode Data"
   --env ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=...` (see r4 command history)
3. Expect: N07 sentinel written (allow-once), N08 deny-leg no file + allow-leg
   file. Then N09+ (question/plan schemas) per checklist order.
