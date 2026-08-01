import { forceExitProcess } from '../../lib/exit.js'

// Keeps the event loop alive so the process cannot exit on its own.
setInterval(() => {}, 1_000)

const mode = process.argv[2] ?? 'lingering'

if (mode === 'no-force') {
  // Return without forcing an exit; the interval keeps the process alive.
} else {
  if (mode === 'large-output') {
    process.stdout.write('x'.repeat(200_000))
  } else {
    process.stdout.write('force-exit-helper\n')
  }
  await forceExitProcess(0)
}
