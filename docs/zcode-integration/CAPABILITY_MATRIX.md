# ZCode native capability matrix (ZK-016)

Mechanical enablement rule: **only passing rows are advertised**; a transport-only
pass does not enable interactive execution; a Linux pass does not enable Windows;
synthetic evidence is never relabeled captured. This matrix is the honest record —
a profile flips to certified only when its row passes with captured evidence.

Statuses: PASS (captured evidence + regression fixture) · PARTIAL (implemented,
environment-gated) · BLOCKED (gate named) · NOT RUN.

Machine context: win32-x64, profile `win-cody-zcode-cjs` (see
`native-profiles/win-cody-zcode-cjs.json` + `evidence/zk16-n00-inventory.md`).

| Row | Capability | Status | Evidence / gate |
|---|---|---|---|
| N00 | Static inventory / doctor | **PARTIAL — IMPLEMENTED, ENVIRONMENT GATE** | Static checks all PASS (`evidence/zk16-n00-doctor-output.json`); launch certification BLOCKED: win32 owned-process supervision unimplemented (PLATFORM_UNCERTIFIED) |
| N01 | Startup/readiness (read-only) | BLOCKED | Requires owned private-stdio launch → win32 environment gate |
| N02 | Create + durable bind | BLOCKED | Same owned-launch gate |
| N03 | Read state | BLOCKED | Same owned-launch gate |
| N04 | Subscribe before first task | BLOCKED | Same owned-launch gate |
| N05 | Model/reasoning readback | BLOCKED | Same owned-launch gate |
| N06 | Third-party registry | NOT RUN | Out of slice (no third-party profile); needs own certification flow |
| N07 | First paid text/tool turn | BLOCKED (double gate) | win32 owned-launch gate **+ explicit Cody opt-in + cost limits** (see `PAID-ROWS-DECISION.md`). Not requested, not run |
| N08 | Permission deny / allow-once | BLOCKED | N07 gates + owned launch |
| N09 | Question/plan round-trip | BLOCKED | N07 gates + owned launch |
| N10 | Active text guidance | BLOCKED | N07 gates + owned launch |
| N11 | Stop with background writer | BLOCKED | N07 gates + owned launch |
| N12 | Background/goal settlement | BLOCKED | N07 gates + owned launch |
| N13 | Idle native compact | BLOCKED | N07 gates + owned launch |
| N14 | Conversation-only fork | BLOCKED | N07 gates + owned launch (+ captured rowsRange schema) |
| N15 | Image byte + resume retention | NOT RUN | Not advertised (`imageCapability: false` until certified) |
| N16 | Same SID after clean restart | BLOCKED | N07 gates + owned launch |
| N17 | Lost-ACK / fork omission | BLOCKED | N07 gates + owned launch |
| N18 | Unsubscribe + shutdown | BLOCKED | Owned-launch gate (per-OS certification required) |

Codec/fixtures: no captured divergences exist yet (no native run has been performed
on any certification row). Synthetic fixtures in `cli/src/agent/fixtures/` remain
labeled synthetic and certify nothing.

What unblocks the matrix: (a) Windows process supervision implemented + tested
(owned launch on win32), or a Linux certification host; then (b) for N07+ only,
recorded Cody opt-in with model/cost limits. — ZCode 2026-09-18
