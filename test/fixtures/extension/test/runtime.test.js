import assert from 'node:assert/strict'
import test from 'node:test'
import {workspace} from 'coc.nvim'
import extension from '../index.js'
import { state } from '../src/state.ts'

test('provides isolated coc.nvim and extension exports', () => {
  assert.ok(workspace)
  assert.equal(typeof extension.activate, 'function')
  assert.equal(extension.childPid, process.pid)
  assert.notEqual(process.pid, process.ppid)
  assert.equal(extension.getState(), state)
  assert.equal(extension.esmDependencyValue, 3)
})
