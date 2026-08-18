import assert from 'node:assert/strict'
import test from 'node:test'
import { getChildExecArgv, getTestConcurrency } from '../lib/test-runner.js'

test('enables source maps and VM modules in test children', () => {
  assert.deepEqual(getChildExecArgv(['--input-type', 'module', '--trace-warnings']), [
    '--trace-warnings',
    '--enable-source-maps',
    '--experimental-vm-modules',
    '--disable-warning=ExperimentalWarning',
  ])
  assert.deepEqual(getChildExecArgv([
    '--enable-source-maps',
    '--experimental-vm-modules',
  ]), [
    '--enable-source-maps',
    '--experimental-vm-modules',
    '--disable-warning=ExperimentalWarning',
  ])
})

test('runs one test child at a time in CI', () => {
  assert.equal(getTestConcurrency(2, true, 4), 1)
})

test('limits local test children to the number of bundles', () => {
  assert.equal(getTestConcurrency(1, false, 4), 1)
  assert.equal(getTestConcurrency(2, false, 4), 2)
  assert.equal(getTestConcurrency(10, false, 4), 3)
})
