import fs, { type FSWatcher } from 'node:fs'
import path from 'node:path'
import { bundleTests, buildExtensionModules, collectExtensionWatchFiles, type BundleOptions, type TestBundle } from './bundle.js'
import { runTests, type RunTestsOptions } from './test-runner.js'

export interface WatchTestsOptions extends Omit<RunTestsOptions, 'bundles' | 'signal'> {
  testFiles: string[]
  bundleOptions: BundleOptions
}

/** Run affected tests until the process receives SIGINT or SIGTERM. */
export async function watchTests(options: WatchTestsOptions): Promise<number> {
  const testFiles = options.testFiles.map(normalize)
  const bundles = new Map<string, TestBundle>()
  const refreshExtensionBuild = async (): Promise<string[]> => {
    const entryFile = options.project.config.entryFile
    if (entryFile) {
      const build = await buildExtensionModules({
        projectRoot: options.project.root,
        entryFile,
        packageJson: options.project.packageJson,
      })
      options.bundleOptions = { ...options.bundleOptions, entryFile: build.entryFile, entryRoot: build.entryRoot }
      options.project = { ...options.project, extensionRoot: build.extensionRoot, extensionCode: build.code }
      return build.watchFiles
    }
    return collectExtensionWatchFiles(options.bundleOptions)
  }
  let extensionFiles = await refreshExtensionBuild()
  let index = new FileChangeIndex(testFiles, bundles.values(), extensionFiles)
  const watcher = new ProjectFileWatcher(changedFiles => onFilesChanged(changedFiles))
  watcher.update(index.watchFiles)

  const pending = new Set(testFiles)
  let extensionDirty = false
  let active: { files: string[]; controller: AbortController } | undefined
  let wake: (() => void) | undefined
  let stopped = false
  let exitCode = 0

  const notify = (): void => {
    wake?.()
    wake = undefined
  }

  function onFilesChanged(changedFiles: string[]): void {
    const affected = new Set<string>()
    for (const changedFile of changedFiles) {
      if (index.isExtensionFile(changedFile)) extensionDirty = true
      for (const testFile of index.affectedTests(changedFile)) affected.add(testFile)
    }
    if (affected.size === 0) return

    for (const file of affected) pending.add(file)
    if (active) {
      // runTests owns all children in this round. Preserve every interrupted test
      // and wait for its child/editor teardown before starting the replacement run.
      for (const file of active.files) pending.add(file)
      active.controller.abort()
    }
    notify()
  }

  const stop = (code: number): void => {
    stopped = true
    exitCode = code
    active?.controller.abort()
    watcher.close()
    notify()
  }
  const onSigint = (): void => stop(130)
  const onSigterm = (): void => stop(143)
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)

  try {
    while (!stopped) {
      if (pending.size === 0) {
        process.stdout.write('\nWatching for file changes...\n')
        await new Promise<void>(resolve => { wake = resolve })
        continue
      }

      const files = [...pending].sort()
      pending.clear()

      if (extensionDirty) {
        extensionDirty = false
        try {
          extensionFiles = await refreshExtensionBuild()
        } catch (error) {
          exitCode = 1
          printBuildError(
            options.project.root,
            options.project.config.entryFile ?? options.bundleOptions.projectMain,
            error,
          )
        }
      }

      const runnable: TestBundle[] = []
      for (const file of files) {
        try {
          const [bundle] = await bundleTests([file], options.bundleOptions)
          bundles.set(file, bundle)
          runnable.push(bundle)
        } catch (error) {
          exitCode = 1
          printBuildError(options.project.root, file, error)
        }
      }

      index = new FileChangeIndex(testFiles, bundles.values(), extensionFiles)
      watcher.update(index.watchFiles)
      if (stopped) break

      // A change received while bundling invalidates this whole round.
      if (pending.size > 0) {
        for (const file of files) pending.add(file)
        continue
      }
      if (runnable.length === 0) continue

      const controller = new AbortController()
      active = { files: runnable.map(bundle => bundle.sourceFile), controller }
      try {
        const passed = await runTests({
          ...options,
          bundles: runnable,
          signal: controller.signal,
        })
        exitCode = passed ? 0 : 1
      } catch (error) {
        if (!isAbortError(error)) throw error
      } finally {
        active = undefined
      }
    }
  } finally {
    active?.controller.abort()
    watcher.close()
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }

  return exitCode
}

/** Maps a changed dependency to its tests; extension changes always affect all tests. */
export class FileChangeIndex {
  readonly watchFiles: string[]
  private readonly tests: string[]
  private readonly testsByFile = new Map<string, Set<string>>()
  private readonly extensionFiles: Set<string>

  constructor(testFiles: string[], bundles: Iterable<TestBundle>, extensionFiles: string[]) {
    this.tests = testFiles.map(normalize)
    this.extensionFiles = new Set(extensionFiles.map(normalize))
    for (const testFile of this.tests) this.add(testFile, testFile)
    for (const bundle of bundles) {
      for (const file of bundle.watchFiles) this.add(file, bundle.sourceFile)
    }
    this.watchFiles = [...new Set([
      ...this.tests,
      ...this.extensionFiles,
      ...this.testsByFile.keys(),
    ])]
  }

  affectedTests(file: string): string[] {
    const normalized = normalize(file)
    if (this.extensionFiles.has(normalized)) return this.tests
    return [...(this.testsByFile.get(normalized) ?? [])]
  }

  isExtensionFile(file: string): boolean {
    return this.extensionFiles.has(normalize(file))
  }

  private add(file: string, testFile: string): void {
    const normalized = normalize(file)
    const tests = this.testsByFile.get(normalized) ?? new Set<string>()
    tests.add(normalize(testFile))
    this.testsByFile.set(normalized, tests)
  }
}

class ProjectFileWatcher {
  private watchers = new Map<string, FSWatcher>()
  private watchedFiles = new Set<string>()
  private changedFiles = new Set<string>()
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly onChange: (files: string[]) => void) {}

  update(files: string[]): void {
    this.watchedFiles = new Set(files.map(normalize))
    const directories = new Set([...this.watchedFiles].map(file => path.dirname(file)))
    for (const [directory, watcher] of this.watchers) {
      if (directories.has(directory)) continue
      watcher.close()
      this.watchers.delete(directory)
    }
    for (const directory of directories) {
      if (this.watchers.has(directory)) continue
      try {
        const watcher = fs.watch(directory, (event, filename) => {
          if (event !== 'change' && event !== 'rename') return
          if (filename === null) {
            for (const file of this.watchedFiles) {
              if (path.dirname(file) === directory) this.queue(file)
            }
          } else {
            const file = normalize(path.join(directory, filename.toString()))
            if (this.watchedFiles.has(file)) this.queue(file)
          }
        })
        watcher.on('error', error => {
          process.stderr.write(`coc-test watch error (${directory}): ${error.message}\n`)
        })
        this.watchers.set(directory, watcher)
      } catch (error) {
        process.stderr.write(`coc-test cannot watch ${directory}: ${errorMessage(error)}\n`)
      }
    }
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }

  private queue(file: string): void {
    this.changedFiles.add(file)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      const files = [...this.changedFiles]
      this.changedFiles.clear()
      this.onChange(files)
    }, 60)
  }
}

function printBuildError(projectRoot: string, file: string, error: unknown): void {
  const displayName = path.relative(projectRoot, file) || path.basename(file)
  process.stderr.write(`\nFAIL ${displayName}\n${errorMessage(error)}\n`)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function normalize(file: string): string {
  return path.resolve(file)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}
