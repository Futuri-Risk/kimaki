# ZS phase — Subrouter × shared native core (GATED — DO NOT START)

Status: GATED. Begin only after: Kimaki native core boundary stable, host-independent
tests green, no Kimaki/Discord leakage into the core, ZK host tickets complete, and
preferably a basic real native profile certified (mission SUBROUTER PHASE).

Planned tickets (derive final set from actual subrouter/ tree at kickoff — it is an
upstream submodule of this monorepo; also reconcile with the existing one-shot ACP relay
in `C:\Dev\opencode-kimaki-releases` (tools/zcode-relay.mjs), which is a reference
implementation of explicit delegation through the ACP adapter — a different layer from
the owned native core; do not duplicate the core):

| ID | Title | Notes |
|----|-------|-------|
| ZS-001 | Subrouter environment/baseline/drift | submodule state, workspace deps, lock |
| ZS-002 | Consume the SAME native core (`cli/src/agent/native/` or extracted shared location) | no second client; package extraction only if both consumers prove the boundary (SHARED_RUNTIME_MAP conditions) |
| ZS-003 | Execution-aware delegation contract | explicit delegated ZCode execution; NEVER a rotating RouterModel; no model failover/retry for side-effectful native tasks |
| ZS-004 | OpenCode delegated tool/frontend path | tool/frontend integration in subrouter's OpenCode layer |
| ZS-005 | Configuration/profile UX | per-route explicit ZCode opt-in; credentials resolved per authorized profile only |
| ZS-006 | Persistence/session correlation | native SID correlation in subrouter stores |
| ZS-007 | Interactions/cancellation/control surface | reuse native interaction identity semantics |
| ZS-008 | Tests/fault handling | fault-matrix subset applied to subrouter paths |
| ZS-009 | Direct vs Subrouter-bridged fidelity | matched-pair evidence |
| ZS-010 | Docs/release/upstream preparation | maintainer decisions |

Architecture per mission: OpenCode → explicit delegated ZCode execution →
Subrouter/OpenCode integration layer → shared native runtime → ZCode. Not:
OpenCode agent loop → "ZCode model" → nested agent loop.

Each ZS ticket gets its own file with the full template when the gate opens.
— ZAI 2026-09-17
