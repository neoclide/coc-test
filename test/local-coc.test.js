import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { useCocDirectory } from '../lib/download.js'

test('uses an existing coc.nvim directory without downloading', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coc-test-local-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'build'), { recursive: true })
  await fs.mkdir(path.join(root, 'plugin'), { recursive: true })
  await fs.writeFile(path.join(root, 'build', 'index.js'), 'module.exports = {}\n')
  await fs.writeFile(path.join(root, 'plugin', 'coc.vim'), '')

  const installation = await useCocDirectory(root)
  assert.equal(installation.version, 'local')
  assert.equal(installation.root, root)
  assert.equal(installation.entryFile, path.join(root, 'build', 'index.js'))
  assert.equal(installation.vimrc, path.join(root, 'src', '__tests__', 'vimrc'))
  // The missing test vimrc is created inside the provided directory (original behavior).
  await fs.access(installation.vimrc)
})

test('rejects a directory without a coc.nvim build', async () => {
  await assert.rejects(useCocDirectory('/path/that/does/not/exist'), /Invalid coc\.nvim directory/)
})
