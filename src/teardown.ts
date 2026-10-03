import { waitWithCancellation } from './cancellation.js'

/** Bound normal teardown as well as cancellation without abandoning late cleanup. */
export async function waitForExtensionUnload(
  unload: Promise<void>,
  signal: AbortSignal,
  timeoutMs = 5_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(
      `Timed out waiting for extension unload after ${timeoutMs} ms.`,
    )), timeoutMs)
  })
  try {
    // The race retains handlers for a late unload rejection. Cancellation still
    // has the shorter grace period needed for the parent's shutdown deadline.
    await waitWithCancellation(Promise.race([unload, timeout]), signal, 500)
  } finally {
    clearTimeout(timer)
  }
}
