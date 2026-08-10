import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { bundleTests, collectExtensionWatchFiles } from '../lib/bundle.js'
import { FileChangeIndex } from '../lib/watch.js'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = path.join(repositoryRoot, 'test', 'fixtures', 'extension')
const editorTest = path.join(fixtureRoot, 'test', 'editor.test.js')
const runtimeTest = path.join(fixtureRoot, 'test', 'runtime.test.js')
const extensionMain = path.join(fixtureRoot, 'index.js')

test('maps test dependencies to their corresponding test files', () => {
  const helper = path.join(fixtureRoot, 'test', 'helper.js')
  const index = new FileChangeIndex(
    [editorTest, runtimeTest],
    [{ sourceFile: editorTest, watchFiles: [editorTest, helper] }],
    [extensionMain],
  )

  assert.deepEqual(index.affectedTests(helper), [editorTest])
  assert.deepEqual(index.affectedTests(runtimeTest), [runtimeTest])
  assert.deepEqual(index.affectedTests(extensionMain), [editorTest, runtimeTest])
})

test('collects test and extension watch files from esbuild graphs', async () => {
  const bundleOptions = {
    projectRoot: fixtureRoot,
    projectMain: extensionMain,
    cocEntry: path.join(fixtureRoot, 'unused-coc-entry.js'),
  }
  const [bundle] = await bundleTests([runtimeTest], bundleOptions)
  const extensionFiles = await collectExtensionWatchFiles(bundleOptions)

  assert.ok(bundle.watchFiles.includes(runtimeTest))
  assert.ok(extensionFiles.includes(extensionMain))
})

test('injects runtime modules and preserves bundle dependency boundaries', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'coc-test-esbuild-'))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const root = path.join(parent, 'extension')
  const testFile = path.join(root, 'test', 'runtime.test.ts')
  const projectMain = path.join(root, 'index.js')
  const cocEntry = path.join(parent, 'coc.cjs')
  const outsideFile = path.join(parent, 'outside.cjs')
  const dependencyFile = path.join(root, 'node_modules', 'local-dependency', 'index.js')

  await writeFiles({
    [projectMain]: 'throw new Error("extension main should be replaced")\n',
    [cocEntry]: 'throw new Error("coc entry should be replaced")\n',
    [outsideFile]: 'module.exports = { source: "outside" }\n',
    [path.join(root, 'node_modules', 'local-dependency', 'package.json')]: JSON.stringify({
      name: 'local-dependency',
      main: 'index.js',
    }),
    [dependencyFile]: 'module.exports = { source: "dependency" }\n',
    [testFile]: `
import { workspace } from 'coc.nvim'
import extension from '../index.js'
import directCoc from '../../coc.cjs'
import dependency from 'local-dependency'
import outside from '../../outside.cjs'
const required = require('coc.nvim')
if (globalThis.__load_missing_optional__) require('missing-optional-dependency')
globalThis.__coc_test_probe__ = { workspace, extension, directCoc, dependency, outside, required }
`,
  })

  const [bundle] = await bundleTests([testFile], { projectRoot: root, projectMain, cocEntry })
  assert.ok(bundle.watchFiles.includes(testFile))
  assert.ok(bundle.watchFiles.includes(dependencyFile))
  assert.ok(!bundle.watchFiles.includes(projectMain))
  assert.ok(!bundle.watchFiles.includes(cocEntry))
  assert.ok(!bundle.watchFiles.includes(outsideFile))
  assert.match(bundle.code, /missing-optional-dependency/)

  const cocExports = { workspace: { marker: true } }
  const extensionExports = { activate() {} }
  const globals = globalThis
  const previous = new Map([
    ['__coc_test_coc_exports__', globals.__coc_test_coc_exports__],
    ['__coc_test_extension_exports__', globals.__coc_test_extension_exports__],
    ['__coc_test_probe__', globals.__coc_test_probe__],
  ])
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete globals[key]
      else globals[key] = value
    }
  })
  delete globals.__coc_test_coc_exports__
  delete globals.__coc_test_extension_exports__
  assert.throws(
    () => executeBundle(bundle),
    /coc-test runtime value is unavailable: coc\.nvim/,
  )

  globals.__coc_test_coc_exports__ = cocExports
  globals.__coc_test_extension_exports__ = extensionExports
  executeBundle(bundle)

  const probe = globals.__coc_test_probe__
  assert.equal(probe.workspace, cocExports.workspace)
  assert.equal(probe.extension, extensionExports)
  assert.equal(probe.directCoc, cocExports)
  assert.equal(probe.required, cocExports)
  assert.equal(probe.dependency.source, 'dependency')
  assert.equal(probe.outside.source, 'outside')

  const sourceMap = inlineSourceMap(bundle.code)
  assert.ok(sourceMap.sources.includes(testFile))
  assert.ok(sourceMap.sources.includes(dependencyFile))
})

test('collects local extension sources but excludes node_modules', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'coc-test-esbuild-'))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const root = path.join(parent, 'extension')
  const projectMain = path.join(root, 'index.js')
  const helperFile = path.join(root, 'helper.js')
  const dependencyFile = path.join(root, 'node_modules', 'local-dependency', 'index.js')

  await writeFiles({
    [projectMain]: `require('./helper.js')\nrequire('local-dependency')\n`,
    [helperFile]: 'module.exports = true\n',
    [path.join(root, 'node_modules', 'local-dependency', 'package.json')]: JSON.stringify({
      name: 'local-dependency',
      main: 'index.js',
    }),
    [dependencyFile]: 'module.exports = true\n',
  })

  const files = await collectExtensionWatchFiles({
    projectRoot: root,
    projectMain,
    cocEntry: path.join(parent, 'unused-coc.cjs'),
  })
  assert.ok(files.includes(projectMain))
  assert.ok(files.includes(helperFile))
  assert.ok(!files.includes(dependencyFile))
})

async function writeFiles(files) {
  await Promise.all(Object.entries(files).map(async ([filename, contents]) => {
    await fs.mkdir(path.dirname(filename), { recursive: true })
    await fs.writeFile(filename, contents)
  }))
}

function inlineSourceMap(code) {
  const match = /sourceMappingURL=data:application\/json[^,]*,([A-Za-z0-9+/=]+)/.exec(code)
  assert.ok(match, 'expected an inline source map')
  return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'))
}

function executeBundle(bundle) {
  const module = { exports: {} }
  new Function('require', 'module', 'exports', bundle.code)(
    createRequire(bundle.virtualFile),
    module,
    module.exports,
  )
  return module.exports
}
