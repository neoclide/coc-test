import path from 'node:path'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { run } from 'node:test'
import { spec } from 'node:test/reporters'
import { pathToFileURL } from 'node:url'
import type { TestBundle } from './bundle.js'
import { loadCocModule, removeCocTestDirs } from './coc.js'
import { startEditor } from './editor.js'
import {
  createModuleRegistry,
  registerModuleHooks,
  removeModuleRegistry,
} from './project-modules.js'
import { installRuntimeGlobals } from './runtime-globals.js'
import { injectTeardownHook, TEARDOWN_KEY } from './test-code.js'
import type { CocModule, ProjectInfo } from './types.js'
import type {
  TestChildCommand,
  TestChildData,
  TestProgress,
  TestResult,
  TestStats,
} from './test-protocol.js'

type RuntimeGlobal = typeof globalThis & {
  [TEARDOWN_KEY]?: () => void | Promise<void>
  __coc_test_coc_exports__?: unknown
}

interface RunTestBundleOptions {
  bundle: TestBundle
  testNamePattern?: string
  teardown?: () => void | Promise<void>
  onProgress?: (progress: Omit<TestProgress, 'type' | 'sourceFile'>) => void
  signal?: AbortSignal
}

async function main(data: TestChildData, signal: AbortSignal): Promise<TestResult> {
  let session: Awaited<ReturnType<typeof startEditor>> | undefined
  let closePromise: Promise<void> | undefined
  let restoreGlobals: (() => void) | undefined
  const closeSession = (): Promise<void> => {
    if (!session) return Promise.resolve()
    closePromise ??= Promise.resolve().then(async () => {
      const current = session
      session = undefined
      await current?.close()
    })
    return closePromise
  }
  const onAbort = (): void => { void closeSession() }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    sendProgress(data.bundle.sourceFile, 'starting', emptyStats())
    const coc = loadCocModule(data.installation, data.editor, data.project.config['user-settings'])
    createModuleRegistry()
    if (data.project.entryFile) {
      // The extension bundle reads `coc.nvim` from this global, so it must be
      // published before the extension is loaded.
      ;(globalThis as RuntimeGlobal).__coc_test_coc_exports__ = coc.exports
    }
    session = await startEditor(data.editor, coc, data.installation.vimrc, data.project)
    if (signal.aborted) throw abortError()
    const extension = await loadTestExtension(coc, data.project)
    restoreGlobals = installRuntimeGlobals({
      cocExports: coc.exports,
      extensionExports: extension._exports,
    })
    sendProgress(data.bundle.sourceFile, 'running', emptyStats())

    const result = await runTestBundle({
      bundle: data.bundle,
      testNamePattern: data.testNamePattern,
      teardown: async () => {
        await closeSession()
      },
      signal,
      onProgress: progress => sendProgress(
        data.bundle.sourceFile,
        progress.state,
        progress.stats,
        progress.activeTest,
      ),
    })

    return {
      type: 'result',
      sourceFile: data.bundle.sourceFile,
      ...result,
    }
  } catch (error) {
    return {
      type: 'result',
      sourceFile: data.bundle.sourceFile,
      passed: false,
      report: `coc-test child failed: ${errorMessage(error)}\n`,
      stats: emptyStats(),
    }
  } finally {
    try {
      signal.removeEventListener('abort', onAbort)
      restoreGlobals?.()
      removeModuleRegistry()
      await closeSession()
    } finally {
      removeCocTestDirs()
    }
  }
}

async function loadTestExtension(
  coc: CocModule,
  project: ProjectInfo,
): Promise<{ _exports: unknown }> {
  if (!project.entryFile) return coc.loadExtension(project.root, true)
  const sourceCode = project.extensionCode
  if (typeof sourceCode !== 'string') {
    throw new Error('coc-test extension code is missing; rebuild the extension bundle.')
  }
  return coc.loadExtension(project.root, true, {
    sourceCode,
    sourceFormat: project.config.target === 'esm' ? 'module' : 'commonjs',
    sourceFilename: project.entryFile,
    extensionRoot: project.root,
  })
}

async function runTestBundle(
  options: RunTestBundleOptions,
): Promise<{ passed: boolean; report: string; stats: TestStats }> {
  let failed = false
  let teardownError: unknown
  let teardownPromise: Promise<void> | undefined
  const report = new StringWriter()
  const runtime = globalThis as RuntimeGlobal
  const previousTeardown = runtime[TEARDOWN_KEY]
  const stats = emptyStats()

  const teardownOnce = (): Promise<void> => {
    teardownPromise ??= Promise.resolve()
      .then(() => options.teardown?.())
      .catch(error => {
        teardownError = error
        failed = true
      })
    return teardownPromise
  }

  runtime[TEARDOWN_KEY] = teardownOnce
  const url = pathToFileURL(options.bundle.virtualFile).href
  const hooks = registerVirtualTest(url, injectTeardownHook(options.bundle.code))
  const stream = run({
    files: [options.bundle.virtualFile],
    isolation: 'none',
    concurrency: 1,
    testNamePatterns: options.testNamePattern
      ? [new RegExp(options.testNamePattern)]
      : undefined,
    signal: options.signal,
  })

  stream.on('test:start', data => {
    options.onProgress?.({ state: 'running', activeTest: data.name, stats: { ...stats } })
  })
  stream.on('test:pass', data => {
    stats.tests++
    if (data.skip) stats.skipped++
    else if (data.todo) stats.todo++
    else stats.passed++
    options.onProgress?.({ state: 'running', stats: { ...stats } })
  })
  stream.on('test:fail', () => {
    failed = true
    stats.tests++
    stats.failed++
    options.onProgress?.({ state: 'running', stats: { ...stats } })
  })
  // Keep summary as a fallback; the injected after hook normally releases it first.
  stream.once('test:summary', summary => {
    stats.tests = summary.counts.tests
    stats.passed = summary.counts.passed
    stats.skipped = summary.counts.skipped
    stats.todo = summary.counts.todo
    stats.cancelled = summary.counts.cancelled
    stats.failed = Math.max(0, stats.tests - stats.passed - stats.skipped - stats.todo - stats.cancelled)
    if (!summary.success && stats.failed === 0) stats.failed = 1
    stats.durationMs = summary.duration_ms
    options.onProgress?.({ state: 'running', stats: { ...stats } })
    void teardownOnce()
  })

  try {
    await pipeline(stream, spec(), report)
    await teardownOnce()
    if (teardownError) {
      report.append(`\ncoc-test teardown failed: ${errorMessage(teardownError)}\n`)
    }
    return { passed: !failed, report: report.value, stats }
  } finally {
    await teardownOnce()
    hooks.deregister()
    if (previousTeardown === undefined) {
      delete runtime[TEARDOWN_KEY]
    } else {
      runtime[TEARDOWN_KEY] = previousTeardown
    }
  }
}

function sendProgress(
  sourceFile: string,
  state: TestProgress['state'],
  stats: TestStats,
  activeTest?: string,
): void {
  sendMessage({
    type: 'progress',
    sourceFile,
    state,
    activeTest,
    stats,
  } satisfies TestProgress)
}

function sendMessage(message: TestProgress | TestResult): void {
  if (process.connected && process.send) process.send(message)
}

function emptyStats(): TestStats {
  return {
    tests: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    todo: 0,
    cancelled: 0,
    durationMs: 0,
  }
}

function registerVirtualTest(url: string, source: string) {
  return registerModuleHooks({
    resolve(specifier, context, nextResolve) {
      const resolvedUrl = normalizeSpecifier(specifier)
      if (resolvedUrl === url) return { url, shortCircuit: true }
      return nextResolve(specifier, context)
    },

    load(loadedUrl, context, nextLoad) {
      if (loadedUrl === url) {
        return {
          format: 'commonjs',
          source,
          shortCircuit: true,
        }
      }
      return nextLoad(loadedUrl, context)
    },
  })
}

class StringWriter extends Writable {
  value = ''

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.value += chunk.toString()
    callback()
  }

  append(value: string): void {
    this.value += value
  }
}

function normalizeSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith('file:')) return specifier
  if (!path.isAbsolute(specifier)) return undefined
  return pathToFileURL(specifier).href
}

const command = await receiveCommand()
// The IPC channel must not keep node:test's in-process event loop alive.
process.channel?.unref()
const controller = new AbortController()
const onCommand = (message: unknown): void => {
  if (isCancelCommand(message)) controller.abort()
}
const onSignal = (): void => controller.abort()
process.on('message', onCommand)
process.once('SIGTERM', onSignal)
process.once('SIGINT', onSignal)
const result = await main(command.data, controller.signal)
process.off('message', onCommand)
process.off('SIGTERM', onSignal)
process.off('SIGINT', onSignal)
if (process.connected) await sendResult(result)

function receiveCommand(): Promise<Extract<TestChildCommand, { type: 'run' }>> {
  return new Promise((resolve, reject) => {
    process.once('message', message => {
      if (isRunCommand(message)) resolve(message)
      else reject(new Error('Test child received an invalid run command.'))
    })
    process.once('disconnect', () => reject(new Error('Test parent disconnected before sending a run command.')))
  })
}

function isRunCommand(value: unknown): value is Extract<TestChildCommand, { type: 'run' }> {
  return typeof value === 'object' && value !== null
    && (value as { type?: unknown }).type === 'run'
    && typeof (value as { data?: unknown }).data === 'object'
}

function isCancelCommand(value: unknown): value is Extract<TestChildCommand, { type: 'cancel' }> {
  return typeof value === 'object' && value !== null
    && (value as Partial<TestChildCommand>).type === 'cancel'
}

function sendResult(result: TestResult): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.connected || !process.send) {
      reject(new Error('Test child IPC channel is unavailable.'))
      return
    }
    process.send(result, error => error ? reject(error) : resolve())
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

function abortError(): Error {
  const error = new Error('Test run cancelled.')
  error.name = 'AbortError'
  return error
}
