import path from 'node:path'
import type { TestProgress, TestResult, TestStats } from './test-protocol.js'

type FileState = 'queued' | 'starting' | 'running' | 'passed' | 'failed'

interface FileRow {
  sourceFile: string
  displayName: string
  state: FileState
  activeTest?: string
  stats: TestStats
  startedAt?: number
  durationMs?: number
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export class TestReporter {
  private readonly rows: FileRow[]
  private readonly rowByFile = new Map<string, FileRow>()
  private readonly interactive = Boolean(process.stdout.isTTY && !process.env.CI)
  private renderedLines = 0
  private spinnerFrame = 0
  private timer: NodeJS.Timeout | undefined
  private readonly startedAt = Date.now()

  constructor(sourceFiles: string[], projectRoot: string) {
    this.rows = sourceFiles.map(sourceFile => ({
      sourceFile,
      displayName: path.relative(projectRoot, sourceFile) || path.basename(sourceFile),
      state: 'queued',
      stats: emptyStats(),
    }))
    for (const row of this.rows) this.rowByFile.set(row.sourceFile, row)
  }

  start(): void {
    if (!this.interactive) return
    this.render()
    this.timer = setInterval(() => {
      if (!this.rows.some(row => row.state === 'starting' || row.state === 'running')) return
      this.spinnerFrame++
      this.render()
    }, 80)
    this.timer.unref()
  }

  update(progress: TestProgress): void {
    const row = this.rowByFile.get(progress.sourceFile)
    if (!row || row.state === 'passed' || row.state === 'failed') return
    row.state = progress.state
    row.activeTest = progress.activeTest
    row.stats = progress.stats
    row.startedAt ??= Date.now()
    if (this.interactive) this.render()
  }

  complete(result: TestResult): void {
    const row = this.rowByFile.get(result.sourceFile)
    if (!row) return
    row.state = result.passed ? 'passed' : 'failed'
    row.activeTest = undefined
    row.stats = result.stats
    row.durationMs = Date.now() - (row.startedAt ?? Date.now())

    if (result.stdout) this.writeOutput('stdout', row.displayName, result.stdout)
    if (result.stderr) this.writeOutput('stderr', row.displayName, result.stderr)
    if (this.interactive) {
      this.render()
    } else {
      process.stdout.write(`${this.formatRow(row)}\n`)
    }
  }

  finish(results: Array<TestResult | undefined>): void {
    if (this.timer) clearInterval(this.timer)
    if (this.interactive) this.render()

    const completed = results.filter((result): result is TestResult => result !== undefined)
    const failures = completed.filter(result => !result.passed)
    if (failures.length > 0) {
      const failedTests = failures.reduce((count, result) => count + result.stats.failed, 0)
      const failureCount = failedTests || failures.length
      process.stdout.write(`\n${this.red(this.bold(`Failed Tests ${failureCount}`))}\n`)
      for (const result of failures) {
        const row = this.rowByFile.get(result.sourceFile)
        const name = row?.displayName ?? result.sourceFile
        process.stdout.write(`\n${this.red(this.bold('FAIL'))} ${this.bold(name)}\n`)
        process.stdout.write(`${failureDetails(result.report)}\n`)
      }
    }

    const passedFiles = completed.length - failures.length
    const stats = completed.reduce((total, result) => addStats(total, result.stats), emptyStats())
    const fileParts = [
      failures.length ? this.red(`${failures.length} failed`) : '',
      passedFiles ? this.green(`${passedFiles} passed`) : '',
    ].filter(Boolean).join(this.dim(' | '))
    const testParts = [
      stats.failed ? this.red(`${stats.failed} failed`) : '',
      stats.passed ? this.green(`${stats.passed} passed`) : '',
      stats.skipped ? this.yellow(`${stats.skipped} skipped`) : '',
      stats.todo ? this.yellow(`${stats.todo} todo`) : '',
    ].filter(Boolean).join(this.dim(' | ')) || this.dim('0 tests')

    process.stdout.write(`\n${this.bold('Test Files')}  ${fileParts} ${this.dim(`(${completed.length})`)}\n`)
    process.stdout.write(`${this.bold('Tests')}       ${testParts} ${this.dim(`(${stats.tests})`)}\n`)
    process.stdout.write(`${this.bold('Duration')}    ${formatDuration(Date.now() - this.startedAt)}\n`)
  }

  abort(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.interactive) this.clearRenderedRows()
  }

  private writeOutput(stream: 'stdout' | 'stderr', displayName: string, output: string): void {
    if (this.interactive) this.clearRenderedRows()
    const heading = stream === 'stderr' ? this.red(stream) : this.dim(stream)
    process.stdout.write(`\n${heading}${this.dim(' |')} ${this.bold(displayName)}\n${output.trimEnd()}\n`)
    if (this.interactive) this.render()
  }

  private render(): void {
    if (!this.interactive) return
    this.clearRenderedRows()
    process.stdout.write(`${this.rows.map(row => this.formatRow(row)).join('\n')}\n`)
    this.renderedLines = this.rows.length
  }

  private clearRenderedRows(): void {
    if (this.renderedLines === 0) return
    process.stdout.write(`\x1b[${this.renderedLines}A\r\x1b[J`)
    this.renderedLines = 0
  }

  private formatRow(row: FileRow): string {
    const stats = formatStats(row.stats)
    const durationText = row.durationMs === undefined ? '' : ` ${formatDuration(row.durationMs)}`
    const columns = this.interactive ? (process.stdout.columns || 100) : Number.POSITIVE_INFINITY
    if (row.state === 'passed' || row.state === 'failed') {
      const name = truncatePath(row.displayName, columns - stats.length - durationText.length - 3)
      const icon = row.state === 'passed' ? this.green('✓') : this.red('✗')
      return `${icon} ${name}${stats}${this.dim(durationText)}`
    }
    if (row.state === 'queued') {
      const suffix = ' [queued]'
      const name = truncatePath(row.displayName, columns - suffix.length - 2)
      return `${this.dim('·')} ${this.dim(name)}${this.dim(suffix)}`
    }
    const spinner = this.yellow(SPINNER[this.spinnerFrame % SPINNER.length])
    const stateText = row.state === 'starting' ? ' starting' : ''
    const activeBudget = row.activeTest ? Math.min(36, Math.max(0, columns - stats.length - stateText.length - 30)) : 0
    const activeText = activeBudget > 4 ? ` › ${truncate(row.activeTest!, activeBudget - 3)}` : ''
    const name = truncatePath(row.displayName, columns - stats.length - activeText.length - stateText.length - 2)
    return `${spinner} ${name}${stats}${this.dim(activeText)}${this.dim(stateText)}`
  }

  private color(code: number, value: string): string {
    return this.interactive ? `\x1b[${code}m${value}\x1b[0m` : value
  }

  private bold(value: string): string { return this.color(1, value) }
  private dim(value: string): string { return this.color(2, value) }
  private red(value: string): string { return this.color(31, value) }
  private green(value: string): string { return this.color(32, value) }
  private yellow(value: string): string { return this.color(33, value) }
}

function emptyStats(): TestStats {
  return { tests: 0, passed: 0, failed: 0, skipped: 0, todo: 0, cancelled: 0, durationMs: 0 }
}

function addStats(left: TestStats, right: TestStats): TestStats {
  return {
    tests: left.tests + right.tests,
    passed: left.passed + right.passed,
    failed: left.failed + right.failed,
    skipped: left.skipped + right.skipped,
    todo: left.todo + right.todo,
    cancelled: left.cancelled + right.cancelled,
    durationMs: left.durationMs + right.durationMs,
  }
}

function formatStats(stats: TestStats): string {
  if (stats.tests === 0 && stats.failed === 0) return ''
  const failed = stats.failed ? ` | ${stats.failed} failed` : ''
  return ` (${stats.tests} test${stats.tests === 1 ? '' : 's'}${failed})`
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1_000).toFixed(2)}s`
}

function failureDetails(report: string): string {
  const marker = '✖ failing tests:\n'
  const index = report.indexOf(marker)
  const details = (index === -1 ? report : report.slice(index + marker.length)).trim()
  return stripErrorProperties(details)
}

/** Remove the object inspection appended after an Error stack by the spec reporter. */
function stripErrorProperties(details: string): string {
  const output: string[] = []
  let skippingProperties = false

  for (const line of details.split('\n')) {
    if (!skippingProperties && /^\s+at .+ \{$/.test(line)) {
      output.push(line.slice(0, -2))
      skippingProperties = true
      continue
    }
    if (skippingProperties) {
      if (line === '  }') skippingProperties = false
      continue
    }
    output.push(line)
  }

  return output.join('\n').trimEnd()
}

function truncate(value: string, maxLength: number): string {
  if (maxLength <= 1) return ''
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`
}

function truncatePath(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  if (maxLength <= 1) return ''
  return `…${value.slice(-(maxLength - 1))}`
}
