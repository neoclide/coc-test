import { bundleTests, buildExtensionModules, type BundleOptions } from './bundle.js'
import { downloadRelease, useCocDirectory } from './download.js'
import { resolveTestFiles } from './files.js'
import { findProject } from './project.js'
import { assertModuleHooksAvailable } from './project-modules.js'
import { runTests } from './test-runner.js'
import { watchTests } from './watch.js'
import type { CliOptions } from './types.js'

export async function execute(options: CliOptions): Promise<number> {
  const project = findProject()
  // Virtual test bundles use synchronous module hooks.
  // Check before downloading coc.nvim or starting an editor to produce an actionable error.
  assertModuleHooksAvailable()
  const cocPath = options.cocPath ?? process.env.COC_TEST_COC_PATH
  const installation = cocPath
    ? await useCocDirectory(cocPath)
    : await downloadRelease(options.cocVersion, options.forceDownload)
  process.stdout.write(`Using coc.nvim from ${installation.root}\n`)

  const testFiles = await resolveTestFiles(options.files, project.root)
  const bundleOptions: BundleOptions = {
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
  if (project.config.entryFile) {
    const build = await buildExtensionModules({
      projectRoot: project.root,
      entryFile: project.config.entryFile,
      externals: project.config.externals,
      target: project.config.target,
    })
    project.extensionCode = build.code
    bundleOptions.entryFile = build.entryFile
    bundleOptions.entryRoot = build.entryRoot
  }
  const bundles = await bundleTests(testFiles, bundleOptions)
  const passed = await runTests({
    bundles,
    testNamePattern: options.testNamePattern,
    editor: options.editor,
    installation,
    project,
  })
  return passed ? 0 : 1
}
