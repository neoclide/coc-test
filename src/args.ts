import type { CliOptions } from './types.js'

const HELP = `Usage:
  coc-test [options] <files ...>
  coc-test --init

Options:
  <files>                         JavaScript/TypeScript files or glob patterns
  -v, --version                   Show this module's package.json version
  --init                          Create a coc-test setup interactively
  -d, --download                  Force download coc.nvim repo from github.
  -u, --use <version>             Tag version of coc.nvim (latest by default)
  --coc-path <directory>          Use an existing coc.nvim build without downloading
  --test-name-pattern <pattern>   Only run tests whose name matches the pattern
  --nvim                          Run tests on Neovim (default)
  --vim                           Run tests on Vim
  -w, --watch                     Watch files and rerun affected tests
  --force-exit                    Force process exit after tests finish
  -h, --help                      Show this help
`

export interface ParsedArgs {
  action: 'run' | 'help' | 'version' | 'init'
  options?: CliOptions
}

export function helpText(): string {
  return HELP
}

export function parseArgs(argv: string[]): ParsedArgs {
  const files: string[] = []
  let cocVersion: string | undefined
  let cocPath: string | undefined
  let editor: 'nvim' | 'vim' = 'nvim'
  let testNamePattern: string | undefined
  let forceExit = false
  let forceDownload = false
  let watch = false

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const equalsIndex = arg.startsWith('--') ? arg.indexOf('=') : -1
    if (equalsIndex !== -1) {
      const name = arg.slice(0, equalsIndex)
      const value = arg.slice(equalsIndex + 1)
      if (!value) throw new Error(`Missing value for ${name}`)
      if (name === '--use') {
        cocVersion = value
        continue
      }
      if (name === '--coc-path') {
        cocPath = value
        continue
      }
      if (name === '--test-name-pattern') {
        testNamePattern = value
        continue
      }
      throw new Error(`Unknown option: ${name}`)
    }
    if (arg === '-h' || arg === '--help') return { action: 'help' }
    if (arg === '-v' || arg === '--version') return { action: 'version' }
    if (arg === '--init') {
      if (argv.length !== 1) throw new Error('--init cannot be combined with other arguments.')
      return { action: 'init' }
    }
    if (arg === '--nvim') {
      editor = 'nvim'
      continue
    }
    if (arg === '-d' || arg === '--download') {
      forceDownload = true
      continue
    }
    if (arg === '--vim') {
      editor = 'vim'
      continue
    }
    if (arg === '--force-exit') {
      forceExit = true
      continue
    }
    if (arg === '-w' || arg === '--watch') {
      watch = true
      continue
    }
    if (arg === '-u' || arg === '--use') {
      cocVersion = readValue(argv, ++index, arg)
      continue
    }
    if (arg === '--coc-path') {
      cocPath = readValue(argv, ++index, arg)
      continue
    }
    if (arg === '--test-name-pattern') {
      testNamePattern = readValue(argv, ++index, arg)
      continue
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    files.push(arg)
  }

  if (files.length === 0) throw new Error('At least one test file or glob pattern is required.')
  if (cocPath && (cocVersion || forceDownload)) {
    throw new Error('--coc-path cannot be combined with --use or --download.')
  }
  if (testNamePattern) {
    try {
      new RegExp(testNamePattern)
    } catch {
      throw new Error(`Invalid test name pattern: ${testNamePattern}`)
    }
  }
  return {
    action: 'run',
    options: { files, cocVersion, cocPath, editor, testNamePattern, forceExit, forceDownload, watch },
  }
}

function readValue(argv: string[], index: number, option: string): string {
  const value = argv[index]
  if (!value || value.startsWith('-')) throw new Error(`Missing value for ${option}`)
  return value
}
