import type { Writable } from 'node:stream'

const FLUSH_TIMEOUT_MS = 1_000

/**
 * Terminate the process immediately, but only after pending stdout/stderr
 * writes are flushed so piped output is not truncated by `--force-exit`.
 */
export async function forceExitProcess(exitCode: number): Promise<void> {
  process.exitCode = exitCode
  await Promise.all([flushStream(process.stdout), flushStream(process.stderr)])
  process.exit(exitCode)
}

function flushStream(stream: Writable): Promise<void> {
  if (stream.destroyed || stream.writableEnded || !stream.writableNeedDrain) {
    return Promise.resolve()
  }
  return new Promise(resolve => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.off('drain', onDrain)
      stream.off('error', onError)
      resolve()
    }
    const onDrain = (): void => done()
    const onError = (): void => done()
    const timer = setTimeout(done, FLUSH_TIMEOUT_MS)
    stream.once('drain', onDrain)
    stream.once('error', onError)
  })
}
