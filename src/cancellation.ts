/** Stop waiting after cancellation without abandoning the eventual promise handlers. */
export function waitWithCancellation<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  graceMs = 0,
): Promise<T> {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      timer = setTimeout(() => {
        cleanup()
        const error = new Error('Test run cancelled.')
        error.name = 'AbortError'
        reject(error)
      }, graceMs)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    promise.then(value => {
      cleanup()
      resolve(value)
    }, error => {
      cleanup()
      reject(error)
    })
  })
}
