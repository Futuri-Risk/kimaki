// ZCode native-profile terminal commands (ZK-018). Static and read-only:
// doctor inventories a launch profile without launching or certifying it,
// status prints the capability state (default-off until a certified profile
// is registered). No paid probes of any kind. — ZCode 2026-09-18

import { goke } from 'goke'
import { createLogger, LogPrefix } from '../logger.js'
import { runDoctorInventory } from '../agent/native/doctor.js'
import { registeredNativeProfiles } from '../agent/native-profile.js'
import { EXIT_NO_RESTART } from '../cli-runner.js'

const cliLogger = createLogger(LogPrefix.CLI)
const cli = goke()

cli
  .command(
    'zcode doctor <executable> <entry> <workspace>',
    'Static ZCode native launch-profile inventory (read-only; never launches or certifies)',
  )
  .action(async (executable: string, entry: string, workspace: string) => {
    try {
      const report = await runDoctorInventory({ executable, entryPath: entry, workspace })
      cliLogger.log(JSON.stringify(report, null, 2))
      process.exit(report.staticInventory === 'PASS' ? 0 : EXIT_NO_RESTART)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command('zcode status', 'Show registered ZCode native profiles and capability state')
  .action(async () => {
    try {
      const profiles = registeredNativeProfiles()
      if (profiles.length === 0) {
        cliLogger.log(
          'ZCode native backend: OFF (default). No native profile is registered; all zcode routes refuse visibly. OpenCode remains the only backend.',
        )
      }
      for (const profile of profiles) {
        cliLogger.log(
          `profile ${profile.id} rev=${profile.revision} enabled=${profile.enabled} allowSynthetic=${profile.allowSynthetic} image=${profile.imageCapability}`,
        )
      }
      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

export default cli
