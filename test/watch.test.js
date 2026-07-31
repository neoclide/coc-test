import assert from 'node:assert/strict'
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

test('collects test and extension watch files from rolldown graphs', async () => {
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
