// #27 fixture spawned by test-harness.test.ts — NOT a test file.
// Creates a real store harness outside vitest (no onTestFinished context: the
// harness's exit-sweep backstop owns cleanup), prints the temp root, and exits.
// The parent test asserts the root is gone after this process dies, proving the
// sweep actually removes dirs rather than deferring them forever.
import { createStoreHarness } from './test-harness.js'

const h = await createStoreHarness()
const session = await h.store.session(h.session.id)
if (session?.id !== 'zc:session-1') {
  console.error('fixture: session fixture missing from the template copy')
  process.exit(2)
}
console.log(`ROOT:${h.root}`)
