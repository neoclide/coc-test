import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { initializeProject } from '../lib/init.js'

test('initializes a complete coc-test project', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coc-test-init-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'lib'))
  await fs.writeFile(path.join(root, 'lib', 'index.js'), 'exports.activate = () => {}\n')
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'example-extension',
    main: 'lib/index.js',
    packageManager: 'npm@10.0.0',
    scripts: { build: 'tsc' },
  }))

  const answers = ['maybe', '', '', '', 'integration.yml', 'y']
  let output = ''
  await initializeProject({
    root,
    prompt: async () => answers.shift() ?? '',
    output: { isTTY: true, write: value => { output += value; return true } },
    commandExists: async command => command === 'vim',
    color: true,
  })

  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  assert.deepEqual(packageJson['coc-test'], { 'user-settings': {} })
  assert.equal(packageJson.scripts.test, 'coc-test test/test.ts')

  const testSource = await fs.readFile(path.join(root, 'test', 'test.ts'), 'utf8')
  assert.match(testSource, /from "\.\.\/lib\/index\.js"/)
  assert.match(testSource, /beforeEach/)
  assert.match(testSource, /commands\.executeCommand/)
  assert.match(testSource, /workspace\.nvim\.eval/)

  const workflow = await fs.readFile(path.join(root, '.github', 'workflows', 'integration.yml'), 'utf8')
  assert.match(workflow, /editor: \[nvim, vim\]/)
  assert.match(workflow, /actions\/setup-node@v4/)
  assert.match(workflow, /npm install/)
  assert.match(workflow, /npm run build/)
  assert.match(workflow, /npx --no-install coc-test --\$\{\{ matrix\.editor \}\} test\/test\.ts/)
  assert.match(output, /\x1b\[/)
  const plainOutput = stripAnsi(output)
  assert.match(plainOutput, /✓ Vim/)
  assert.match(plainOutput, /✗ Neovim/)
  assert.match(plainOutput, /Please answer yes or no/)
})

test('does not overwrite an existing test or script without permission', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coc-test-init-existing-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'test'))
  await fs.writeFile(path.join(root, 'test', 'custom.js'), '// keep\n')
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    main: 'index.js',
    'coc-test': {},
    scripts: { test: 'existing-test' },
  }))

  const answers = ['custom.js', 'n', '', 'n']
  await initializeProject({
    root,
    prompt: async () => answers.shift() ?? '',
    output: { write: () => true },
    commandExists: async () => true,
  })

  assert.equal(await fs.readFile(path.join(root, 'test', 'custom.js'), 'utf8'), '// keep\n')
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  assert.equal(packageJson.scripts.test, 'existing-test')
  await assert.rejects(fs.access(path.join(root, '.github', 'workflows', 'test.yml')))
})

test('prompts again for a test filename outside the test directory', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coc-test-init-invalid-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ 'coc-test': {}, scripts: {} }))

  const answers = ['../outside.ts', 'valid.ts', 'n', '', 'n']
  let output = ''
  await initializeProject({
    root,
    prompt: async () => answers.shift() ?? 'n',
    output: { write: value => { output += value; return true } },
    commandExists: async () => true,
  })
  assert.match(output, /filename inside test/)
  await fs.access(path.join(root, 'test', 'valid.ts'))
})

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, '')
}
