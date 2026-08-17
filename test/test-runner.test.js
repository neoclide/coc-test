import assert from 'node:assert/strict'
import test from 'node:test'
import { getTestConcurrency } from '../lib/test-runner.js'

test('runs one test child at a time in CI', () => {
  assert.equal(getTestConcurrency(2, true, 4), 1)
})

test('limits local test children to the number of bundles', () => {
  assert.equal(getTestConcurrency(1, false, 4), 1)
  assert.equal(getTestConcurrency(2, false, 4), 2)
  assert.equal(getTestConcurrency(10, false, 4), 3)
})
