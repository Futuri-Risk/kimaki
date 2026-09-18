/** ZK-016 N00 runbook artifact: read-only launch-profile fingerprint report.
 * Never native certification or an installer; performs no native call.
 * Imports the BUILT cli (pnpm --filter kimaki build) so the shipped binary
 * and this tool share one implementation. — ZCode 2026-09-18 */
import path from 'node:path'

const args = process.argv.slice(2)
if (args.length !== 3 || !args.every((p) => path.isAbsolute(p))) {
  console.error(
    'Usage: node tools/doctor.mjs /absolute/node /absolute/entry.cjs /absolute/disposable-workspace',
  )
  process.exit(2)
}

let runDoctorInventory
try {
  ;({ runDoctorInventory } = await import('../cli/dist/agent/native/doctor.js'))
} catch {
  console.error('cli/dist not built. Run: pnpm --filter kimaki build')
  process.exit(2)
}

const report = await runDoctorInventory({
  executable: args[0],
  entryPath: args[1],
  workspace: args[2],
})
console.log(JSON.stringify(report, null, 2))
process.exit(report.staticInventory === 'PASS' ? 0 : 1)
