// Vitest configuration for the kimaki discord package.
// Injects KIMAKI_VITEST=1 so config.ts and db.ts auto-isolate from the real
// ~/.kimaki/ database and the running bot's Hrana server.
//
// CPU profiling: set VITEST_CPU_PROF=1 to generate .cpuprofile files in
// ./tmp/cpu-profiles/. Analyze with: node ../profano/dist/cli.js tmp/cpu-profiles/CPU.*.cpuprofile
// Run only one test file at a time to avoid overloading the machine:
//   VITEST_CPU_PROF=1 pnpm test --run src/some-file.test.ts
//
// #28 (ZCode 2026-09-28): two test.projects instead of one global single-fork
// pool. The old `maxForks: 1` serialized every test file — including
// sub-millisecond pure-logic suites and the ~10s collect phase (discord.js et
// al.) — behind the process-spawning e2e lane. Split (note: `projects` is a
// field of `test`, a top-level `projects` key is silently ignored by vitest):
//   - `unit`: everything that is not a `*.e2e.test.ts`, run in parallel forks.
//     Safe since #27's isolation work: forks+isolate gives every file its own
//     fresh process (env mutations cannot cross files), getDataDir() mkdtemps
//     a per-process data dir under KIMAKI_VITEST, the agent harness uses
//     mkdtemp roots / per-PID sweep manifests / a per-worker schema template,
//     and lock ports are hash-derived per key with availability fallback.
//   - `e2e`: the `*.e2e.test.ts` opencode-server suite, still one fork. These
//     boot real OpenCode servers + the digital twin, mutate process env and
//     SQLite, and have timing-sensitive waits (plus startup-time.e2e measures
//     wall clock) — the historically flaky-under-parallelism set. Projects run
//     concurrently, so this lane no longer blocks pure-logic suites.
// Select a lane with `--project=unit` / `--project=e2e`.
// Regression guard: src/vitest-config-structure.test.ts pins this shape.

import { defineConfig } from 'vitest/config'

const cpuProf = process.env.VITEST_CPU_PROF === '1'

// Shared, duplicated into both projects explicitly (root `test.env` is
// inherited by inline projects — verified on vitest 3.2.6 — but KIMAKI_VITEST
// missing a project would mean tests touching the real ~/.kimaki; too cheap
// to risk).
const sharedTest = {
  testTimeout: 8_000,
  hookTimeout: 5_000,
  env: {
    KIMAKI_VITEST: '1',
  },
} as const

export default defineConfig({
  test: {
    ...sharedTest,
    projects: [
      {
        test: {
          ...sharedTest,
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.e2e.test.ts'],
          // Use forked workers (not threads) so any file that mutates
          // process.env cannot race across files — with isolate (default)
          // each file gets its own fresh fork process anyway, parallel or not.
          pool: 'forks',
          poolOptions: {
            forks: {
              // Modest cap, well under the 16-core default: this host also
              // runs the serial e2e lane, other agent sessions, and their
              // node tooling concurrently, and peak memory scales with fork
              // count — 4 forks OOMed system-wide during #28 validation while
              // foreign load held ~90 of ~94 GB commit, 2 survived. Single
              // fork when profiling to keep output manageable.
              maxForks: cpuProf ? 1 : 2,
              execArgv: cpuProf
                ? ['--cpu-prof', '--cpu-prof-dir=tmp/cpu-profiles']
                : [],
            },
          },
        },
      },
      {
        test: {
          ...sharedTest,
          name: 'e2e',
          include: ['src/**/*.e2e.test.ts'],
          pool: 'forks',
          poolOptions: {
            forks: {
              // Hard isolation for the process-spawning e2e suite: one file at
              // a time, deterministic like the pre-#28 config.
              maxForks: 1,
              execArgv: cpuProf
                ? ['--cpu-prof', '--cpu-prof-dir=tmp/cpu-profiles']
                : [],
            },
          },
        },
      },
    ],
  },
})
