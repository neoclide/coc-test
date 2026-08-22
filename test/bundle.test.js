import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { bundleTests, buildExtensionModules } from '../lib/bundle.js'
import {
  assertModuleHooksAvailable,
  createModuleRegistry,
  MODULE_HOOKS_REQUIRED_MESSAGE,
  MODULE_REGISTRY_KEY,
  removeModuleRegistry,
} from '../lib/project-modules.js'
import { findProject } from '../lib/project.js'
import { runSetup } from '../lib/setup.js'

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coc-test-bundle-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.mkdir(path.join(root, 'node_modules', 'fake-lib'), { recursive: true })
  await fs.mkdir(path.join(root, 'node_modules', 'esm-only'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'node_modules', 'fake-lib', 'index.js'),
    'module.exports = { pkg: true }\n',
  )
  await fs.writeFile(
    path.join(root, 'node_modules', 'esm-only', 'package.json'),
    JSON.stringify({ name: 'esm-only', type: 'module', exports: './index.js' }),
  )
  await fs.writeFile(
    path.join(root, 'node_modules', 'esm-only', 'index.js'),
    'export const esmValue = "esm dependency marker"\n',
  )
  await fs.writeFile(
    path.join(root, 'src', 'index.ts'),
    [
      "import { workspace } from 'coc.nvim'",
      "import { helper, store } from './helper'",
      "import { shared } from './shared.js'",
      "import { pkg } from 'fake-lib'",
      "import { esmValue } from 'esm-only'",
      'export const getHelper = () => helper',
      'export const getShared = () => shared',
      'export const getStore = () => store',
      'export const getPkg = () => pkg',
      'export const getEsmValue = () => esmValue',
      'export const isCocReady = () => !!workspace',
    ].join('\n') + '\n',
  )
  await fs.writeFile(
    path.join(root, 'src', 'helper.ts'),
    [
      "import { shared } from './shared.js'",
      "export const helper = 'H' + shared",
      'export const store = { n: 1 }',
    ].join('\n') + '\n',
  )
  await fs.writeFile(path.join(root, 'src', 'shared.ts'), 'export const shared = 7\n')
  await fs.writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({
      name: 'coc-test-bundle-fixture',
      version: '1.0.0',
      main: 'lib/index.js',
      engines: { coc: '>=0.0.1' },
      'coc-test': { entryFile: 'src/index.ts' },
    }, null, 2)}\n`,
  )
  return root
}

test('findProject resolves entryFile without requiring the main file', async t => {
  const root = await createFixture(t)
  const project = findProject(root)

  assert.equal(project.entryFile, path.join(root, 'src', 'index.ts'))
  assert.equal(project.mainFile, path.join(root, 'lib', 'index.js'))
})

test('findProject rejects a missing coc-test entryFile', async t => {
  const root = await createFixture(t)
  await fs.writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ 'coc-test': { entryFile: 'src/missing.ts' } }, null, 2)}\n`,
  )

  assert.throws(() => findProject(root), /coc-test entryFile does not exist/)
})

test('findProject resolves a relative setup module inside the extension', async t => {
  const root = await createFixture(t)
  await fs.mkdir(path.join(root, 'scripts'))
  await fs.writeFile(path.join(root, 'scripts', 'setup.mjs'), '')
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    'coc-test': { setup: 'scripts/setup.mjs' },
    main: 'src/index.ts',
  }))

  const project = findProject(root)
  assert.equal(project.setupFile, path.join(root, 'scripts', 'setup.mjs'))
})

test('findProject validates setup paths and file types', async t => {
  const root = await createFixture(t)
  const packageJson = path.join(root, 'package.json')
  await fs.writeFile(packageJson, JSON.stringify({ 'coc-test': { setup: '../setup.mjs' } }))
  assert.throws(() => findProject(root), /coc-test setup must be inside the extension root/)

  await fs.writeFile(packageJson, JSON.stringify({ 'coc-test': { setup: '/tmp/setup.mjs' } }))
  assert.throws(() => findProject(root), /coc-test setup must be a relative path/)

  await fs.writeFile(path.join(root, 'scripts.txt'), '')
  await fs.writeFile(packageJson, JSON.stringify({ 'coc-test': { setup: 'scripts.txt' } }))
  assert.throws(() => findProject(root), /coc-test setup must be a .js, .cjs, or .mjs file/)
})

for (const extension of ['js', 'cjs', 'mjs']) {
  test(`runs ${extension} setup modules`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coc-test-setup-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const setup = path.join(root, `setup.${extension}`)
    if (extension === 'js') await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}\n')
    const source = extension === 'cjs'
      ? 'module.exports = globalThis.__coc_test_setup_ran__ = (globalThis.__coc_test_setup_ran__ ?? 0) + 1\n'
      : 'await Promise.resolve()\nglobalThis.__coc_test_setup_ran__ = (globalThis.__coc_test_setup_ran__ ?? 0) + 1\n'
    await fs.writeFile(setup, source)
    delete globalThis.__coc_test_setup_ran__
    await runSetup(setup)
    assert.equal(globalThis.__coc_test_setup_ran__, 1)
    delete globalThis.__coc_test_setup_ran__
  })
}

test('buildExtensionModules returns bundle code without writing extension files', async t => {
  const root = await createFixture(t)
  const project = findProject(root)
  const build = await buildExtensionModules({
    projectRoot: project.root,
    entryFile: project.entryFile,
  })

  assert.equal(build.entryFile, path.join(root, 'src', 'index.ts'))
  assert.equal(build.entryRoot, path.join(root, 'src'))
  assert.equal(build.target, 'commonjs')

  const code = build.code
  const helper = path.join(root, 'src', 'helper.ts')
  const shared = path.join(root, 'src', 'shared.ts')
  // The registry is populated for every scanned module except the entry.
  assert.ok(code.includes(helper))
  assert.ok(code.includes(shared))
  assert.ok(code.includes(MODULE_REGISTRY_KEY))
  // Internal modules are bundled into the single output file.
  assert.match(code, /H" \+ shared/)
  // Package dependencies are bundled by default.
  assert.match(code, /esm dependency marker/)
  assert.doesNotMatch(code, /require\(["']fake-lib["']\)/)
  // `coc.nvim` is rewritten to the shared global instead of a bare require.
  assert.ok(code.includes('__coc_test_coc_exports__'))
  assert.doesNotMatch(code, /require\(["']coc\.nvim["']\)/)

  // No bundle file or generated package.json is written; the extension root is
  // the project itself and its real package.json is reused by coc.nvim.
  await assert.rejects(fs.access(path.join(root, '.coc-test-virtual')))
  await assert.rejects(fs.access(path.join(root, 'index.bundle.js')))

  assert.deepEqual(build.watchFiles, [
    helper,
    path.join(root, 'src', 'index.ts'),
    shared,
  ])
})

test('keeps configured externals outside an ESM extension bundle', async t => {
  const root = await createFixture(t)
  const entryFile = path.join(root, 'src', 'index.ts')
  const build = await buildExtensionModules({
    projectRoot: root,
    entryFile,
    target: 'esm',
    externals: ['fake-lib', 'esm-only'],
  })

  assert.equal(build.target, 'esm')
  assert.match(build.code, /from ["']fake-lib["']/)
  assert.match(build.code, /from ["']esm-only["']/)
  assert.doesNotMatch(build.code, /esm dependency marker/)
})

test('findProject validates entryFile bundle options', async t => {
  const root = await createFixture(t)
  const packageJson = path.join(root, 'package.json')
  await fs.writeFile(packageJson, JSON.stringify({
    'coc-test': { entryFile: 'src/index.ts', target: 'esm', externals: ['fake-lib'] },
  }))
  const project = findProject(root)
  assert.equal(project.config.target, 'esm')
  assert.deepEqual(project.config.externals, ['fake-lib'])

  await fs.writeFile(packageJson, JSON.stringify({ 'coc-test': { entryFile: 'src/index.ts', target: 'cjs' } }))
  assert.throws(() => findProject(root), /coc-test target must be "commonjs" or "esm"/)

  await fs.writeFile(packageJson, JSON.stringify({ 'coc-test': { entryFile: 'src/index.ts', externals: ['fake-lib', ''] } }))
  assert.throws(() => findProject(root), /coc-test externals must be an array of non-empty strings/)
})

test('bundleTests rewrites relative project imports to registry specifiers', async t => {
  const root = await createFixture(t)
  const project = findProject(root)
  const build = await buildExtensionModules({
    projectRoot: project.root,
    entryFile: project.entryFile,
  })
  const testFile = path.join(root, 'test', 'sample.test.ts')
  await fs.mkdir(path.dirname(testFile), { recursive: true })
  await fs.writeFile(
    testFile,
    [
      "import { store } from '../src/helper.ts'",
      "import { getStore } from '../src/index.ts'",
      'export const same = store === getStore()',
    ].join('\n') + '\n',
  )

  const [bundle] = await bundleTests([testFile], {
    projectRoot: project.root,
    projectMain: project.mainFile,
    cocEntry: path.join(root, 'build', 'index.js'),
    entryFile: project.entryFile,
    entryRoot: build.entryRoot,
  })

  const helper = path.posix.join('src', 'helper.ts')
  assert.ok(bundle.code.includes('__coc_test_modules__'))
  assert.ok(bundle.code.includes(helper))
  assert.ok(bundle.code.includes('__coc_test_extension_exports__'))
  assert.doesNotMatch(bundle.code, /require\(["']coc-test-module:/)
  // Project module source is not inlined into the test bundle.
  assert.doesNotMatch(bundle.code, /H' \+ shared/)
  assert.doesNotMatch(bundle.code, /require\(["']fake-lib["']\)/)
})

test('module registry helpers create and remove the shared registry', t => {
  delete globalThis[MODULE_REGISTRY_KEY]
  createModuleRegistry()
  assert.ok(globalThis[MODULE_REGISTRY_KEY])
  removeModuleRegistry()
  assert.equal(globalThis[MODULE_REGISTRY_KEY], undefined)
})

test('reports an actionable error when synchronous module hooks are unavailable', () => {
  assert.throws(
    () => assertModuleHooksAvailable(null),
    error => error instanceof Error && error.message === MODULE_HOOKS_REQUIRED_MESSAGE,
  )
})
