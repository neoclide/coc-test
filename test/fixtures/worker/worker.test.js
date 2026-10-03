const assert = require('node:assert/strict')
const { test } = require('node:test')
const { workspace } = require('coc.nvim')

test('worker extension can use the editor', async () => {
  assert.equal(await workspace.nvim.eval('1 + 1'), 2)
  if (process.env.COC_TEST_WORKER_CASE === 'failure') assert.fail('fixture assertion failure')
  if (process.env.COC_TEST_WORKER_CASE === 'test-abort') {
    const released = workspace.workerFixture.waitForRelease()
    workspace.workerFixture.send({ phase: 'test-started' })
    await released
  }
})
