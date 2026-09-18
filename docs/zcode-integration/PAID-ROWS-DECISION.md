# Paid certification rows — decision needed from Cody (ZK-016)

Written by ZCode, 2026-09-18. Plain-English decision record. Nothing below has
been executed; no paid row has been run.

## What "paid row" means

The native certification checklist (`NATIVE_CERTIFICATION_CHECKLIST`) certifies the
real ZCode runtime one row at a time, N00 → N18. Rows N00–N06 are free: they only
start the server process, list/create/read sessions, subscribe to events and read
back model settings — no model inference. **Row N07 is the first row that sends a
real task to the model** ("first paid text/tool turn"), and every row after it
(permissions, questions, guide, stop, background, compact, fork, image, restart…
N08–N18) also needs one or more real model turns. Real model turns consume your
Z.AI plan quota (or API credit, depending on how the profile authenticates) —
that is why they are called **paid rows** and why the checklist hard-requires
explicit opt-in plus recorded model/cost limits before any of them runs.

Note: ZK-015 (mock-native E2E) contains **no paid rows** — it runs a fake
app-server, which is exactly why it exists. The paid-row gate lives in ZK-016.
The forge ticket bodies mention it under ZK-016 ("Requires explicit Cody opt-in
before any paid row (N07+)").

## Current status (2026-09-18)

On this machine paid rows are **doubly blocked**, so there was nothing to opt
into yet:

1. **Windows gate (technical):** every certification row N01+ launches the native
   server as an *owned, supervised child process*. Windows process supervision is
   deliberately not implemented (`PLATFORM_UNCERTIFIED` — an invariant, not a
   bug), so certification cannot proceed on this machine as-is.
2. **Paid gate (this decision):** even with the platform solved, N07+ will not
   run without your recorded opt-in and cost limits.

## What I need from you (when you want certification to proceed)

- **Option A — Windows first (stay on this box):** a new ticket implements and
  tests Windows owned-process supervision, then certification rows run locally.
  You opt into paid rows with a cost cap after that lands.
- **Option B — Linux certification host:** run N01–N18 on a Linux box (supervision
  already works there), record evidence, and keep Windows disabled until it is
  certified separately (a Linux pass does not enable Windows — mechanical rule).
- **Option C — defer:** native ZCode stays default-off with the honest capability
  matrix; nothing is spent.

Independent of A/B/C, when you do opt in, the recorded limits should be:
- which model(s) may be used for certification turns,
- a turn cap per row (proposal: ≤3 turns per row, ~20–30 small turns total
  across N07–N18 on disposable sentinel tasks — small-token tasks, exact cost
  depends on your plan's quota/API pricing),
- a hard stop if any row exceeds its cap.

## Where the gates live

- Checklist rule: "Before any paid row, obtain explicit local opt-in and record
  model/cost limits."
- Code: no certified profile is registered anywhere — `native-profile.ts` registry
  is empty by default; `ZcodeBackend.prepare` refuses with `RUNTIME_UNCERTIFIED`.
- Matrix: `CAPABILITY_MATRIX.md` (N07+ BLOCKED, double gate).
