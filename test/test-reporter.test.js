import assert from 'node:assert/strict'
import test from 'node:test'
import { TestReporter } from '../lib/test-reporter.js'
import { isTestResultPassed } from '../lib/test-protocol.js'

test('prints report details when the final summary fails without a failed test event', () => {
  const sourceFile = '/project/test/extension.test.ts'
  const result = {
    type: 'result',
    sourceFile,
    // node:test can report all individual tests as passed while its final
    // summary fails because of an error outside a test.
    passed: true,
    report: '✔ extension behavior\nlate asynchronous rejection\n',
    stats: {
      tests: 8,
      passed: 8,
      failed: 1,
      skipped: 0,
      todo: 0,
      cancelled: 0,
      durationMs: 10,
    },
  }

  assert.equal(isTestResultPassed(result), false)

  let output = ''
  const originalWrite = process.stdout.write
  process.stdout.write = chunk => {
    output += chunk.toString()
    return true
  }
  try {
    const reporter = new TestReporter([sourceFile], '/project')
    reporter.complete(result)
    reporter.finish([result])
  } finally {
    process.stdout.write = originalWrite
  }

  assert.match(output, /✗ test\/extension\.test\.ts \(8 tests \| 1 failed\)/)
  assert.match(output, /FAIL test\/extension\.test\.ts/)
  assert.match(output, /late asynchronous rejection/)
  assert.match(output, /Test Files  1 failed \(1\)/)
})
