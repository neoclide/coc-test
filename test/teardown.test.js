import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { waitForExtensionUnload } from '../lib/teardown.js'

test('bounds extension unload without external cancellation', async () => {
  const controller = new AbortController()
  await assert.rejects(waitForExtensionUnload(new Promise(() => {}), controller.signal, 10),
    /Timed out waiting for extension unload after 10 ms/)
  assert.equal(controller.signal.aborted, false)
})

test('allows normal unload to finish and preserves unload errors', async () => {
  const controller = new AbortController()
  await waitForExtensionUnload(delay(10), controller.signal, 100)
  const error = new Error('fixture unload error')
  await assert.rejects(waitForExtensionUnload(Promise.reject(error), controller.signal, 100), error)
})

test('cancellation keeps its shorter grace period', async () => {
  await assert.rejects(waitForExtensionUnload(new Promise(() => {}), AbortSignal.abort(), 2000),
    { name: 'AbortError' })
})

test('observes late unload cleanup and rejection after the ordinary deadline', async () => {
  let release
  let completed = false
  const unload = new Promise(resolve => { release = resolve }).then(() => {
    completed = true
    throw new Error('late unload rejection')
  })
  await assert.rejects(waitForExtensionUnload(unload, new AbortController().signal, 10),
    /Timed out waiting for extension unload/)
  release()
  await delay(0)
  assert.equal(completed, true)
})
