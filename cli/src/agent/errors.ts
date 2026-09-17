/** One host boundary for agent errors: native contracts reexported for host imports.
 * Conversion to Kimaki logging/errore conventions happens only at the outermost
 * controller edge, never inside the native graph. — ZK-003, ZAI 2026-09-17 */
export * from './native/errors.js'
