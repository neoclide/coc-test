import { fork, type ChildProcess } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { finished as streamFinished } from 'node:stream/promises'
import type { TestBundle } from './bundle.js'
import { TestReporter } from './test-reporter.js'
import type { CliOptions, CocInstallation, ProjectInfo } from './types.js'
import {
  isTestResultPassed,
  type TestChildCommand,
  type TestChildData,
  type TestChildMessage,
  type TestProgress,
  type TestResult,
} from './test-protocol.js'

export interface RunTestsOptions {
  bundles: TestBundle[]
  testNamePattern?: string
  editor: CliOptions['editor']
  installation: CocInstallation
  project: ProjectInfo
  signal?: AbortSignal
}

/** Run every test file in its own Node.js child process. */
export async function runTests(options: RunTestsOptions): Promise<boolean> {
  if (options.bundles.length === 0) {
    throw new Error('runTests requires at least one test bundle')
  }

  const reporter = new TestReporter(options.bundles.map(bundle => bundle.sourceFile), options.project.root)
  reporter.start()
  const results = new Array<TestResult | undefined>(options.bundles.length)
  let nextIndex = 0
  const runNext = async (): Promise<void> => {
    while (!options.signal?.aborted && nextIndex < options.bundles.length) {
      const index = nextIndex++
      const result = await runTestChild({
        bundle: options.bundles[index],
        testNamePattern: options.testNamePattern,
        editor: options.editor,
        installation: options.installation,
        project: options.project,
      }, progress => reporter.update(progress), options.signal)
      if (result) {
        results[index] = result
        reporter.complete(result)
      }
    }
  }
  // Each test file starts an editor in a separate child process. Run only one
  // child at a time on CI so editor startup cannot contend with another test.
  const concurrency = getTestConcurrency(options.bundles.length)
  await Promise.all(Array.from({ length: concurrency }, runNext))
  if (options.signal?.aborted) {
    reporter.abort()
    throw abortError()
  }
  reporter.finish(results)

  return results.every(result => result !== undefined && isTestResultPassed(result))
}

export function getTestConcurrency(
  bundleCount: number,
  ci = Boolean(process.env.CI),
  parallelism = availableParallelism(),
): number {
  if (ci) return 1
  return Math.min(bundleCount, Math.max(1, parallelism - 1))
}

function runTestChild(
  data: TestChildData,
  onProgress: (progress: TestProgress) => void,
  signal?: AbortSignal,
): Promise<TestResult | undefined> {
  return new Promise(resolve => {
    const child = fork(new URL('./test-child.js', import.meta.url), [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      execArgv: getChildExecArgv(),
      serialization: 'advanced',
    })
    let settled = false
    let childStdout = ''
    let childStderr = ''
    child.stdout!.on('data', chunk => {
      childStdout += chunk.toString()
    })
    child.stderr!.on('data', chunk => {
      childStderr += chunk.toString()
    })

    const finish = async (result: TestResult | undefined): Promise<void> => {
      if (settled) return
      settled = true
      // The result means the test summary and editor teardown both completed.
      try {
        await releaseChild(child, result === undefined)
        await Promise.all([
          streamFinished(child.stdout!).catch(() => undefined),
          streamFinished(child.stderr!).catch(() => undefined),
        ])
      } catch (error) {
        result = failedChildResult(
          data.bundle.sourceFile,
          new Error(`Failed to release test child process: ${errorMessage(error)}`),
        )
      }
      if (result) {
        result.stdout = childStdout.trimEnd() || undefined
        result.stderr = childStderr.trimEnd() || undefined
      }
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }

    const onAbort = (): void => { void finish(undefined) }
    if (signal?.aborted) {
      void finish(undefined)
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.on('message', (message: TestChildMessage) => {
      if (message?.type === 'progress') onProgress(message)
      else if (message?.type === 'result') void finish(message)
    })
    child.once('error', error => {
      void finish(failedChildResult(data.bundle.sourceFile, error))
    })
    child.once('exit', (code, signal) => {
      if (!settled) {
        void finish(failedChildResult(
          data.bundle.sourceFile,
          new Error(`Test child exited before reporting completion (code ${code}, signal ${signal ?? 'none'}).`),
        ))
      }
    })

    child.send({ type: 'run', data } satisfies TestChildCommand, error => {
      if (error) void finish(failedChildResult(data.bundle.sourceFile, error))
    })
  })
}

function abortError(): Error {
  const error = new Error('Test run was cancelled for a file change.')
  error.name = 'AbortError'
  return error
}

async function releaseChild(child: ChildProcess, cancel: boolean): Promise<void> {
  if (cancel && child.connected) {
    child.send({ type: 'cancel' } satisfies TestChildCommand, () => undefined)
    if (await waitForChildExit(child, 2_000)) return
  } else {
    if (child.connected) child.disconnect()
    if (await waitForChildExit(child, 250)) return
  }

  child.kill('SIGTERM')
  if (await waitForChildExit(child, 2_000)) return

  child.kill('SIGKILL')
  if (!await waitForChildExit(child, 2_000)) {
    throw new Error(`Unable to terminate test child process ${child.pid ?? 'unknown'}.`)
  }
}

function waitForChildExit(child: ChildProcess, timeout: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolve => {
    const timer = setTimeout(() => done(false), timeout)
    const done = (exited: boolean): void => {
      clearTimeout(timer)
      child.off('exit', onExit)
      resolve(exited)
    }
    const onExit = (): void => done(true)
    child.once('exit', onExit)
  })
}

export function getChildExecArgv(execArgv = process.execArgv): string[] {
  const args: string[] = []
  for (let index = 0; index < execArgv.length; index++) {
    const arg = execArgv[index]
    if (arg === '--input-type') {
      index++
      continue
    }
    if (arg.startsWith('--input-type=')) continue
    if (arg === '--no-enable-source-maps') continue
    args.push(arg)
  }
  if (!args.includes('--enable-source-maps')) args.push('--enable-source-maps')
  if (!args.includes('--experimental-vm-modules')) args.push('--experimental-vm-modules')
  if (!args.includes('--no-warnings') && !args.includes('--disable-warning=ExperimentalWarning')) {
    args.push('--disable-warning=ExperimentalWarning')
  }
  return args
}

function failedChildResult(sourceFile: string, error: unknown): TestResult {
  return {
    type: 'result',
    sourceFile,
    passed: false,
    report: `coc-test child failed: ${errorMessage(error)}\n`,
    stats: { tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0, cancelled: 0, durationMs: 0 },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}
