import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { waitWithCancellation } from '../lib/cancellation.js'

test('preserves resolved values and rejected errors before cancellation', async () => {
  const controller = new AbortController()
  assert.equal(await waitWithCancellation(Promise.resolve(42), controller.signal), 42)
  const error = new Error('fixture failure')
  await assert.rejects(waitWithCancellation(Promise.reject(error), controller.signal), error)
  controller.abort()
})

test('stops waiting for a pending promise when cancelled', async () => {
  const controller = new AbortController()
  const pending = waitWithCancellation(new Promise(() => {}), controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})

test('handles an already cancelled signal', async () => {
  await assert.rejects(waitWithCancellation(new Promise(() => {}), AbortSignal.abort()), { name: 'AbortError' })
})

test('allows cleanup to finish within the cancellation grace period', async () => {
  assert.equal(await waitWithCancellation(delay(10, 42), AbortSignal.abort(), 100), 42)
})

test('preserves late cleanup and handles its rejection after cancellation', async () => {
  let release
  let unloaded = false
  const activation = new Promise(resolve => { release = resolve })
  const cleanup = activation.then(() => {
    unloaded = true
    throw new Error('late unload failure')
  })
  await assert.rejects(waitWithCancellation(cleanup, AbortSignal.abort()), { name: 'AbortError' })
  release()
  await delay(0)
  assert.equal(unloaded, true)
})
