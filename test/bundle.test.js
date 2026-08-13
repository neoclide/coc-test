import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { bundleTests, buildExtensionModules } from '../lib/bundle.js'
import {
  createModuleRegistry,
  extensionBundlePath,
  EXTENSION_BUNDLE_SPECIFIER_PREFIX,
  MODULE_REGISTRY_KEY,
  MODULE_SPECIFIER_PREFIX,
  registerProjectModuleHooks,
  removeModuleRegistry,
} from '../lib/project-modules.js'
import { findProject } from '../lib/project.js'

const require = createRequire(import.meta.url)

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coc-test-bundle-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.mkdir(path.join(root, 'node_modules', 'fake-lib'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'node_modules', 'fake-lib', 'index.js'),
    'module.exports = { pkg: true }\n',
  )
  await fs.writeFile(
    path.join(root, 'src', 'index.ts'),
    [
      "import { workspace } from 'coc.nvim'",
      "import { helper, store } from './helper'",
      "import { shared } from './shared.js'",
      "import { pkg } from 'fake-lib'",
      'export const getHelper = () => helper',
      'export const getShared = () => shared',
      'export const getStore = () => store',
      'export const getPkg = () => pkg',
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
  assert.equal(project.extensionRoot, path.join(root, '.coc-test-virtual', 'extension'))
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

test('buildExtensionModules returns bundle code instead of writing a bundle file', async t => {
  const root = await createFixture(t)
  const project = findProject(root)
  const build = await buildExtensionModules({
    projectRoot: project.root,
    entryFile: project.entryFile,
    packageJson: project.packageJson,
  })

  assert.equal(build.mainFile, path.join(build.extensionRoot, 'index.js'))
  assert.equal(build.entryRoot, path.join(root, 'src'))

  const code = build.code
  const helper = path.join(root, 'src', 'helper.ts')
  const shared = path.join(root, 'src', 'shared.ts')
  // The registry is populated for every scanned module except the entry.
  assert.ok(code.includes(helper))
  assert.ok(code.includes(shared))
  assert.ok(code.includes(MODULE_REGISTRY_KEY))
  // Internal modules are bundled into the single output file.
  assert.match(code, /H" \+ shared/)
  // External dependencies stay un-bundled.
  assert.match(code, /require\(["']fake-lib["']\)/)
  // `coc.nvim` is rewritten to the shared global instead of a bare require.
  assert.ok(code.includes('__coc_test_coc_exports__'))
  assert.doesNotMatch(code, /require\(["']coc\.nvim["']\)/)

  // No bundle file is written; the bundle code is served from memory.
  await assert.rejects(fs.access(extensionBundlePath(build.extensionRoot)))
  // The on-disk main is a one-line loader for the in-memory bundle code.
  const stub = await fs.readFile(build.mainFile, 'utf8')
  assert.equal(
    stub,
    `module.exports = require(${JSON.stringify(`${EXTENSION_BUNDLE_SPECIFIER_PREFIX}${extensionBundlePath(build.extensionRoot)}`)})\n`,
  )

  assert.deepEqual(build.watchFiles, [
    helper,
    path.join(root, 'src', 'index.ts'),
    shared,
  ])

  const pkg = JSON.parse(await fs.readFile(path.join(build.extensionRoot, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'coc-test-bundle-fixture')
  assert.equal(pkg.main, 'index.js')
  assert.deepEqual(pkg.engines, { coc: '>=0.0.1' })
})

test('bundleTests rewrites relative project imports to registry specifiers', async t => {
  const root = await createFixture(t)
  const project = findProject(root)
  const build = await buildExtensionModules({
    projectRoot: project.root,
    entryFile: project.entryFile,
    packageJson: project.packageJson,
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
  const entry = path.posix.join('src', 'index.ts')
  assert.ok(bundle.code.includes(`${MODULE_SPECIFIER_PREFIX}${helper}`))
  assert.ok(bundle.code.includes(`${MODULE_SPECIFIER_PREFIX}${entry}`))
  // Project modules are not inlined into the test bundle.
  assert.doesNotMatch(bundle.code, /H' \+ shared/)
  assert.doesNotMatch(bundle.code, /require\(["']fake-lib["']\)/)
})

test('module hooks serve registry instances for project module specifiers', async t => {
  const root = await createFixture(t)
  const entry = path.join(root, 'src', 'index.ts')
  const store = path.join(root, 'src', 'store.ts')
  const registry = { [store]: { store: { n: 42 } } }
  globalThis[MODULE_REGISTRY_KEY] = registry
  globalThis.__coc_test_extension_exports__ = { activate() {} }
  t.after(() => {
    delete globalThis[MODULE_REGISTRY_KEY]
    delete globalThis.__coc_test_extension_exports__
  })

  const hooks = registerProjectModuleHooks({
    projectRoot: root,
    entryFile: entry,
    extensionRoot: path.join(root, '.coc-test-virtual', 'extension'),
    extensionCode: 'module.exports = {}\n',
  })
  t.after(() => hooks.deregister())

  const modulePath = path.join(root, 'consumer.cjs')
  await fs.writeFile(
    modulePath,
    `module.exports = {
  store: require(${JSON.stringify(`${MODULE_SPECIFIER_PREFIX}src/store.ts`)}),
  extension: require(${JSON.stringify(`${MODULE_SPECIFIER_PREFIX}src/index.ts`)}),
}\n`,
  )
  const loaded = require(modulePath)
  assert.equal(loaded.store, registry[store])
  assert.equal(loaded.extension, globalThis.__coc_test_extension_exports__)
})

test('module hooks serve the shared extension bundle code', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coc-test-bundle-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const extensionRoot = path.join(root, 'extension')
  const virtual = extensionBundlePath(extensionRoot)
  const entry = path.join(root, 'src', 'index.ts')
  const hooks = registerProjectModuleHooks({
    projectRoot: root,
    entryFile: entry,
    extensionRoot,
    extensionCode: "module.exports = { value: 42, coc: globalThis.__coc_test_coc_exports__ }\n",
  })
  t.after(() => hooks.deregister())

  const loader = path.join(root, 'loader.cjs')
  await fs.writeFile(
    loader,
    `module.exports = require(${JSON.stringify(`${EXTENSION_BUNDLE_SPECIFIER_PREFIX}${virtual}`)})\n`,
  )
  const loaded = require(loader)
  assert.equal(loaded.value, 42)
  assert.equal(loaded.coc, globalThis.__coc_test_coc_exports__)
})

test('module registry helpers create and remove the shared registry', t => {
  delete globalThis[MODULE_REGISTRY_KEY]
  createModuleRegistry()
  assert.ok(globalThis[MODULE_REGISTRY_KEY])
  removeModuleRegistry()
  assert.equal(globalThis[MODULE_REGISTRY_KEY], undefined)
})
