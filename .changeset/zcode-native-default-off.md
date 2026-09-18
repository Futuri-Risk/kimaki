---
"kimaki": minor
---

Add the default-off ZCode native backend foundation: static `zcode doctor` and `zcode status` commands (read-only launch-profile inventory; never launches or certifies the native runtime), Windows owned-process supervision for the native runtime (job-object containment with active termination, drilled for clean shutdown and supervisor-death containment), the native capability matrix and user guide under `docs/zcode-integration/`, and the certification evidence trail (ZK-016 N00–N04 captured on Windows and Linux). No behavior change for existing OpenCode sessions; every ZCode route stays disabled until a certified native profile is explicitly registered.
