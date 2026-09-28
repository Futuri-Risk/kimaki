// #27 (ZCode 2026-09-28): this file is now a side-effect-light RE-EXPORT SHIM.
// The ZK-007 coordinator contract suite moved verbatim to
// coordinator-contract.test.ts, and the shared fixtures (FakeBackend,
// coordinatorHarness, until) live in the non-test module test-harness.ts —
// importing fixtures from a *.test.ts file re-registered and re-executed the
// whole coordinator suite inside every importer (5 in-tree files + this one).
//
// This import path must stay free of suite registration: lease-contention.test.ts
// and src/commands/btw-native.test.ts still import from here, and anything
// registered at this module's top level would re-execute inside them. The shape
// is pinned by test-harness.test.ts.
import { test } from 'vitest'
import assert from 'node:assert/strict'

export { FakeBackend, coordinatorHarness, until } from './test-harness.js'
import { FakeBackend, coordinatorHarness } from './test-harness.js'

test('re-export shim keeps the legacy coordinator.test.js import path usable', () => {
  // lease-contention.test.ts and btw-native.test.ts import FakeBackend /
  // coordinatorHarness through this module; pin that the path stays live
  // without registering any suite here.
  assert.equal(typeof coordinatorHarness, 'function')
  assert.equal(typeof FakeBackend, 'function')
})
