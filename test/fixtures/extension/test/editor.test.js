import assert from 'node:assert/strict'
import test from 'node:test'
import { workspace } from 'coc.nvim'

test('communicates with the selected editor', async () => {
  const value = await workspace.nvim.eval('1 + 1')
  assert.equal(value, 2)
})
