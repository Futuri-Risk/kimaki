# ZK-016 auth-readiness probe — certification config home (N05 gate)

By ZCode session zk016-paid-cert-1, 2026-09-18 (evening). Commissioned by the
orchestration session's correction: "probe, don't gate" — do not assume
AUTH_REQUIRED without testing the existing credential. Classification of the
files below: captured probe records; no credential values read or stored
(structure-only inspection of config JSON, key names only).

## Probe results (all free — session/create + read only, zero model turns)

1. **Default home (`C:\Users\Cody\.zcode`), existing credential.**
   `v2/credentials.json` EXISTS (Sep 3 20:04, 2957 bytes). Owned headless
   launch (node v24.15.0 + zcode.cjs 0.16.5 app-server, `HOME=C:\Users\Cody`,
   builtin provider config env set) creates sessions fine, but
   `settings.model` = `{available: []}`, no `current` — polled for 12s
   (11 reads) in `evidence/zk16-win32-n05-probe/certify-capture.json`.
   stderr silent. Both `--surface desktop` and `--surface terminal`:
   identical empty catalog (diagnostic probe, not a certification capture).

2. **Desktop home override (`ZCODE_DATA_BASE_DIR=C:\Filen\...\ZCode Data\.zcode`).**
   That home holds a FRESH `v2/credentials.json` (Sep 17 09:53) — the desktop
   app's own (it runs agent sessions on GLM today, so the credential works for
   the desktop runtime). Headless probe with the override
   (`evidence/zk16-win32-n05-auth/certify-capture.json`): STILL
   `{available: [], no current}` across the 12s poll. The desktop-side
   credential does not materialize a model catalog for the headless app-server
   either.

3. **WSL (`HOME=/home/cody`).** No `~/.zcode/v2/credentials.json` exists at
   all. Definitively unauthenticated.

4. **Structure-only config inspection (key names, never values).**
   - The desktop's provider store is `ZCode Data\.zcode\v2\config.json`
     → `provider["builtin:zai-coding-plan"]` etc. with `options.apiKey`,
     `enabled`, `models {GLM-5.3, GLM-5.3-Flash}`, some with
     `systemDisabledReason`. This is the DESKTOP app's store.
   - The headless CLI reads a different chain: user config default
     `<home>/.zcode/cli/config.json` (bundle literal `TZr="~/.zcode/cli"`,
     `nativeConfigDir: ".zcode/cli"`), plus workspace-level
     `<workspace>/.zcode/config.json`. `C:\Users\Cody\.zcode\cli\config.json`
     exists and contains ONLY `mcp.servers` — no provider section. The Filen
     home has no `cli/config.json` at all.
   - Protocol surface of bundle 0.16.5 (grep): there is NO
     `workspace/updateProviderRegistry` method (checklist N06's named method
     does not exist in this bundle) and no workspace-settings RPC; provider
     materialization for headless sessions is done by the interactive login
     flow (`zcode login` — "Sign in with Z.AI OAuth for model access") and/or
     the desktop app, not by any protocol method this runner may call.
   - Builtin template (resources/config/provider/zcode-builtin.json, a shipped
     resource): template `zai-api` = Z.ai Coding Plan, anthropic-messages API,
     `builtinModelIds: [GLM-5.3, GLM-5.3-Flash]` — these are the advertised
     models once an access materializes. This matches the RECORDED paid-rows
     model scope.

## Verdict

N05 is **AUTH_REQUIRED (headless login), not merely assumed**: an existing
Sep-3 credential plus a fresh desktop credential both fail to produce an
advertised model in the headless app-server, and the protocol offers no
provider-materialization method. The bounded poll is now part of the runner,
so the row will pass mechanically the moment a model is advertised.

## The ONE manual step for Cody (exact)

In any Windows terminal:

```
"C:\Program Files\nodejs\node.exe" "C:\Users\Cody\AppData\Local\Programs\ZCode\resources\glm\zcode.cjs" login
```

Complete the Z.AI OAuth browser flow. This writes the CLI-visible shared
credential into `C:\Users\Cody\.zcode\v2\credentials.json` and materializes
the GLM coding-plan models for headless app-server sessions. (If he prefers
the certification home to be the desktop's data dir instead, prefix the
command with `set ZCODE_DATA_BASE_DIR=C:\Filen\Reference\Tech\AI\Claude\ZCode Data\.zcode`
— but the default `~\.zcode` is the recommended certification home and the
profile manifest already describes it.) Alternative: a `zcode login` inside a
WSL terminal is needed for the Linux column (no WSL credential exists).

After login completes, tell any session to re-run `tools/certify.mjs --rows
N02,N05` — no other change is needed; if models advertise, N05 executes
setModel + readback and the paid rows unlock under the recorded caps.

## Notes

- No credentials were copied, moved, or written anywhere by these probes; the
  runner's `--env` values are paths only. Config files were inspected for
  structure (key names, string lengths) only.
- The win32 probe captures contain redacted paths per the allowlisted
  redaction policy; session ids are disposable sentinel values.
- Paid-turn spend so far: **0** (`evidence/zk16-paid-spend.json` intentionally
  absent — no ledger is created until a first accepted session/send).
