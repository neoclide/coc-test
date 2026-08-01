#!/usr/bin/env node
import { helpText, parseArgs } from './args.js'
import { execute } from './main.js'
import { initialize } from './init.js'
import { packageVersion } from './version.js'

async function main(): Promise<void> {
  try {
    const parsed = parseArgs(process.argv.slice(2))
    if (parsed.action === 'help') {
      process.stdout.write(helpText())
      return
    }
    if (parsed.action === 'version') {
      process.stdout.write(`${packageVersion()}\n`)
      return
    }
    if (parsed.action === 'init') {
      await initialize()
      return
    }
    const options = parsed.options!
    const exitCode = await execute(options)
    process.exitCode = exitCode
    if (options.forceExit) process.exit(exitCode)
  } catch (error) {
    console.error(formatError(error))
    process.exitCode = 1
  }
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return `coc-test: ${String(error)}`
  const parts = [`coc-test: ${error.message}`]
  let cause = error.cause
  while (cause instanceof Error) {
    parts.push(`Caused by: ${cause.message}`)
    cause = cause.cause
  }
  return parts.join('\n')
}

await main()
