import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveTestFiles } from '../lib/files.js'

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'extension')

test('resolves JavaScript test files', async () => {
  const files = await resolveTestFiles(['test/*.test.js'], fixtureRoot)
  assert.deepEqual(files.map(file => path.basename(file)), ['editor.test.js', 'runtime.test.js'])
})
