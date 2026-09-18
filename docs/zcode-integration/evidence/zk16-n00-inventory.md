# ZK-016 N00 — Static inventory record (2026-09-18)

Row N00 of `NATIVE_CERTIFICATION_CHECKLIST` (canonical copy: ZCode Kimaki project,
`Research GPT6PRO/NATIVE_CERTIFICATION_CHECKLIST.md`). Static only — **no native call
was performed by the doctor** (`nativeExecutionPerformed: false`), and nothing is
certified (`certified: false`). Full machine output: `zk16-n00-doctor-output.json`
(private home paths redacted to `~`; hashes are complete).

## Discovered launch profile (this machine, win32-x64)

| Field | Value |
|---|---|
| Executable | `C:\Program Files\nodejs\node.exe` — Node v24.15.0 — sha256 `3331e1ffe19874215472217c5e94f5a0c6d8e18c4ac7111d3937aa0ad5e9b4a5` |
| Entry | `~\AppData\Local\Programs\ZCode\resources\glm\zcode.cjs` — 11,416,833 bytes — sha256 `da61b0663336a65f7cce3dec223678794ccaa58158e304fc0d97b695434a8f01` |
| Args | `[entryPath, "app-server"]` — `app-server` = "Run the ZCode Protocol stdio app server" (verified in `zcode --help`) |
| Entry version | `zcode 0.16.5` (manual `node <entry> --version` probe, recorded as discovery evidence — the doctor itself never spawns the entry) |
| Bundle metadata | `resources/glm/.node-bundle-meta.json`: runtime `electron-node`, platform `win32-x64`, source `apps/zcode-cli/packages/cli/dist/zcode.cjs` |
| Adjacent package.json | none (doctor records the explicit unavailable marker; version evidence above is the manual probe) |
| Disposable workspace | `C:\Dev\zk-n00-disposable` (fresh git repo, created for certification; canonical) |
| Environment | `{}` — no `NODE_OPTIONS`/`NODE_PATH`/loader-injection keys |

## Also present on this machine (recorded, NOT the certified entry)

- `zcode-acp-server@0.19.0` (npm global `~/AppData/Roaming/npm/node_modules/zcode-acp-server`,
  bin `dist/cli.js`): the **ACP-protocol bridge** — a different layer from the native
  ZCode Protocol stdio server. Its CLI surface (`server`, `hub`, `serve`, `repl`) does
  not include an `app-server` subcommand. Reference only; not certified here.
- ZCode desktop install (`~\AppData\Local\Programs\ZCode\ZCode.exe` + `resources\`).

## Native config home identity (markers only, no contents read)

`~\.zcode` exists with markers: `cli/`, `v2/`, `workspace/`, `skills/`, `plugins/`,
`export-log-stage/`, `feedback/`, `plugin-workspace/`. No credential material was
read or recorded.

## Check results

All static checks PASS (paths-absolute, paths-canonical, workspace-separation,
fingerprints, args-shape, environment-safe). Launch profile: **BLOCKED —
PLATFORM_UNCERTIFIED**: native Windows process supervision is not implemented, so
the owned-launch path refuses by design (`cli/src/agent/native/process.ts`). Per the
ticket's implementation notes, Windows owned-process rows stay environment-gated —
**N00 = PARTIAL: IMPLEMENTED, ENVIRONMENT GATE, not DONE**.

## Row consequences (recorded in CAPABILITY_MATRIX.md)

- N01–N06 (owned-launch, unpaid): BLOCKED on win32 by the same environment gate.
- N07–N18: BLOCKED on win32 **and** gated on explicit Cody opt-in + cost limits
  (paid model turns). No paid row was run. — ZCode 2026-09-18
