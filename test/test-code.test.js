import assert from 'node:assert/strict'
import test from 'node:test'
import { injectTeardownHook } from '../lib/test-code.js'

test('separates the teardown hook from a bundle without shifting source-map lines', () => {
  const source = 'var loaded = true\nloaded = false\n'
  const injected = injectTeardownHook(source)

  assert.doesNotThrow(() => new Function(injected))
  assert.equal(injected.split('\n').length, source.split('\n').length)
})
