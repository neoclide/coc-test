import { bundleTests } from './bundle.js'
import { downloadRelease, useCocDirectory } from './download.js'
import { resolveTestFiles } from './files.js'
import { findProject } from './project.js'
import { runTests } from './test-runner.js'
import { watchTests } from './watch.js'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { CliOptions } from './types.js'

export async function execute(options: CliOptions): Promise<number> {
  const project = findProject()
  const cocPath = options.cocPath ?? process.env.COC_TEST_COC_PATH
  const installation = cocPath
    ? await useCocDirectory(cocPath)
    : await downloadRelease(options.cocVersion, options.forceDownload)
  const userConfig = project.config['user-settings']
  if (userConfig) {
    const configRoot = path.dirname(installation.vimrc)
    const file = path.join(configRoot, 'coc-settings.json')
    writeFileSync(file, JSON.stringify(userConfig, null, 2), 'utf8')
  }
  process.stdout.write(`Using coc.nvim from ${installation.root}\n`)

  const testFiles = await resolveTestFiles(options.files, project.root)
  const bundleOptions = {
    projectRoot: project.root,
    projectMain: project.mainFile,
    cocEntry: installation.entryFile,
  }
  if (options.watch) {
    return await watchTests({
      testFiles,
      bundleOptions,
      testNamePattern: options.testNamePattern,
      editor: options.editor,
      installation,
      project,
    })
  }
  const bundles = await bundleTests(testFiles, {
    ...bundleOptions,
  })
  const passed = await runTests({
    bundles,
    testNamePattern: options.testNamePattern,
    editor: options.editor,
    installation,
    project,
  })
  return passed ? 0 : 1
}
