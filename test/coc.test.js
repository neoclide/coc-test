import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadCocModule } from '../lib/coc.js'

test('reports the entry file path when requiring coc.nvim fails', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coc-test-coc-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'build'), { recursive: true })
  const entryFile = path.join(root, 'build', 'index.js')
  await fs.writeFile(entryFile, "throw new Error('boom')\n")

  await assert.rejects(
    async () => loadCocModule(
      {
        version: 'local',
        root,
        entryFile,
        vimrc: path.join(root, 'src', '__tests__', 'vimrc'),
      },
      'nvim',
    ),
    error => {
      assert.match(error.message, /Failed to require coc\.nvim entry .*build.index\.js/)
      assert.ok(!error.message.includes('[object Object]'))
      return true
    },
  )
})
