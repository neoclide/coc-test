import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadCocModule, removeCocTestDirs } from '../lib/coc.js'

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

test('writes user settings to an isolated config home and cleans it up', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coc-test-coc-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'build'), { recursive: true })
  const entryFile = path.join(root, 'build', 'index.js')
  await fs.writeFile(entryFile, 'module.exports = { attach() {}, loadExtension() {} }\n')
  const installation = {
    version: 'local',
    root,
    entryFile,
    vimrc: path.join(root, 'src', '__tests__', 'vimrc'),
  }
  const saved = {
    config: process.env.COC_VIMCONFIG,
    data: process.env.COC_DATA_HOME,
    runtime: process.env.XDG_RUNTIME_DIR,
  }
  try {
    const userConfig = { 'yaml.enable': true }
    const coc = loadCocModule(installation, 'nvim', userConfig)
    assert.equal(typeof coc.attach, 'function')

    const configHome = process.env.COC_VIMCONFIG
    assert.ok(configHome.startsWith(os.tmpdir()))
    assert.notEqual(configHome, path.dirname(installation.vimrc))
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(configHome, 'coc-settings.json'), 'utf8')),
      userConfig,
    )
    // The shared installation directory is never modified.
    await assert.rejects(fs.access(path.join(root, 'src', '__tests__', 'coc-settings.json')))

    // Cleanup removes both isolated directories.
    const dataHome = process.env.COC_DATA_HOME
    await fs.access(dataHome)
    removeCocTestDirs()
    await assert.rejects(fs.access(configHome))
    await assert.rejects(fs.access(dataHome))
  } finally {
    restoreEnv('COC_VIMCONFIG', saved.config)
    restoreEnv('COC_DATA_HOME', saved.data)
    restoreEnv('XDG_RUNTIME_DIR', saved.runtime)
    removeCocTestDirs()
  }
})

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}
