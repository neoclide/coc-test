import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'

export type InitPrompt = (message: string) => Promise<string>

export interface InitOutput {
  write(value: string): unknown
  isTTY?: boolean
}

export interface InitializeProjectOptions {
  root?: string
  prompt: InitPrompt
  output?: InitOutput
  commandExists?: (command: string) => Promise<boolean>
  color?: boolean
}

interface PackageJson extends Record<string, unknown> {
  main?: string
  packageManager?: string
  scripts?: Record<string, unknown>
  'coc-test'?: unknown
}

export async function initialize(): Promise<void> {
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    await initializeProject({ prompt: message => readline.question(message) })
  } finally {
    readline.close()
  }
}

export async function initializeProject(options: InitializeProjectOptions): Promise<void> {
  const root = path.resolve(options.root ?? process.cwd())
  const output = options.output ?? process.stdout
  const ansi = createAnsi(output, options.color)
  const commandExists = options.commandExists ?? executableExists
  const packageJsonFile = path.join(root, 'package.json')
  const packageJson = await readPackageJson(packageJsonFile)

  output.write(`${ansi.bold(ansi.cyan('Checking editors...'))}\n`)
  const [hasVim, hasNvim] = await Promise.all([
    commandExists(process.env.VIM_COMMAND ?? 'vim'),
    commandExists(process.env.NVIM_COMMAND ?? 'nvim'),
  ])
  output.write(`  ${hasVim ? ansi.green('✓') : ansi.red('✗')} Vim${hasVim ? '' : ansi.dim(' (not found)')}\n`)
  output.write(`  ${hasNvim ? ansi.green('✓') : ansi.red('✗')} Neovim${hasNvim ? '' : ansi.dim(' (not found)')}\n`)
  if (!hasVim && !hasNvim) {
    output.write(`${ansi.yellow('! Install Vim or Neovim before running integration tests.')}\n`)
  }

  let packageChanged = false
  if (!isRecord(packageJson['coc-test'])) {
    if (await confirm(options.prompt, output, 'Add the "coc-test" configuration to package.json?', true, ansi)) {
      packageJson['coc-test'] = { 'user-settings': {} }
      packageChanged = true
    }
  } else {
    output.write(`${ansi.dim('package.json already contains "coc-test" configuration.')}\n`)
  }

  const filename = await askTestFilename(options.prompt, output, ansi)
  const relativeTestFile = path.posix.join('test', filename)
  const testFile = path.join(root, 'test', filename)
  const mainFile = resolveMainFile(root, packageJson)

  let createTest = true
  if (await fileExists(testFile)) {
    createTest = await confirm(options.prompt, output, `${relativeTestFile} already exists. Overwrite it?`, false, ansi)
  }
  if (createTest) {
    await fs.mkdir(path.dirname(testFile), { recursive: true })
    await fs.writeFile(testFile, testTemplate(testFile, mainFile), 'utf8')
    output.write(`${ansi.green('✓')} Created ${ansi.bold(relativeTestFile)}\n`)
  }

  const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {}
  if (typeof scripts.test !== 'string') {
    if (await confirm(options.prompt, output, 'Add a test script to package.json?', true, ansi)) {
      scripts.test = `coc-test ${quoteShellArgument(relativeTestFile)}`
      packageJson.scripts = scripts
      packageChanged = true
    }
  } else {
    output.write(`${ansi.dim('package.json already contains a test script; it was left unchanged.')}\n`)
  }

  if (packageChanged) {
    await fs.writeFile(packageJsonFile, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8')
    output.write(`${ansi.green('✓')} Updated ${ansi.bold('package.json')}\n`)
  }

  const workflowFilename = await askWorkflowFilename(options.prompt, output, ansi)
  const relativeWorkflowFile = path.posix.join('.github', 'workflows', workflowFilename)
  if (await confirm(
    options.prompt,
    output,
    `Create ${relativeWorkflowFile} for Vim and Neovim?`,
    false,
    ansi,
  )) {
    const workflowFile = path.join(root, '.github', 'workflows', workflowFilename)
    let createWorkflow = true
    if (await fileExists(workflowFile)) {
      createWorkflow = await confirm(options.prompt, output, `${relativeWorkflowFile} exists. Overwrite it?`, false, ansi)
    }
    if (createWorkflow) {
      await fs.mkdir(path.dirname(workflowFile), { recursive: true })
      await fs.writeFile(
        workflowFile,
        workflowTemplate(
          detectPackageManager(root, packageJson),
          relativeTestFile,
          typeof scripts.build === 'string',
          root,
        ),
        'utf8',
      )
      output.write(`${ansi.green('✓')} Created ${ansi.bold(relativeWorkflowFile)}\n`)
    }
  }

  output.write(`\n${ansi.green(ansi.bold('✓ coc-test setup complete.'))}\n`)
}

async function readPackageJson(filename: string): Promise<PackageJson> {
  try {
    return JSON.parse(await fs.readFile(filename, 'utf8')) as PackageJson
  } catch (error) {
    throw new Error(`Unable to read ${filename}: ${errorMessage(error)}`, { cause: error })
  }
}

async function executableExists(command: string): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(command, ['--version'], { stdio: 'ignore' })
    let settled = false
    const done = (found: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(found)
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      done(false)
    }, 3_000)
    child.once('error', () => done(false))
    child.once('exit', code => done(code === 0))
  })
}

async function confirm(
  prompt: InitPrompt,
  output: InitOutput,
  message: string,
  defaultValue: boolean,
  ansi: Ansi,
): Promise<boolean> {
  const suffix = defaultValue ? ' (Y/n) ' : ' (y/N) '
  while (true) {
    const answer = (await prompt(`${ansi.cyan('?')} ${ansi.bold(message)}${ansi.dim(suffix)}`)).trim().toLowerCase()
    if (!answer) return defaultValue
    if (answer === 'y' || answer === 'yes') return true
    if (answer === 'n' || answer === 'no') return false
    output.write(`${ansi.red('✗')} ${ansi.red('Please answer yes or no.')}\n`)
  }
}

async function askTestFilename(
  prompt: InitPrompt,
  output: InitOutput,
  ansi: Ansi,
): Promise<string> {
  while (true) {
    const message = `${ansi.cyan('?')} ${ansi.bold('Test filename inside test/')}${ansi.dim(' (test.ts): ')}`
    const answer = (await prompt(message)).trim()
    try {
      return validateTestFilename(answer || 'test.ts')
    } catch (error) {
      output.write(`${ansi.red('✗')} ${ansi.red(errorMessage(error))}\n`)
    }
  }
}

async function askWorkflowFilename(
  prompt: InitPrompt,
  output: InitOutput,
  ansi: Ansi,
): Promise<string> {
  while (true) {
    const message = `${ansi.cyan('?')} ${ansi.bold('GitHub Actions workflow filename')}${ansi.dim(' (test.yml): ')}`
    const answer = (await prompt(message)).trim()
    try {
      return validateWorkflowFilename(answer || 'test.yml')
    } catch (error) {
      output.write(`${ansi.red('✗')} ${ansi.red(errorMessage(error))}\n`)
    }
  }
}

function validateTestFilename(filename: string): string {
  if (filename === '.' || filename === '..' || path.basename(filename) !== filename || filename.includes('\\')) {
    throw new Error('Test filename must be a filename inside test/, not a path.')
  }
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(filename)) {
    throw new Error('Test filename must use a JavaScript or TypeScript extension.')
  }
  return filename
}

function validateWorkflowFilename(filename: string): string {
  if (filename === '.' || filename === '..' || path.basename(filename) !== filename || filename.includes('\\')) {
    throw new Error('Workflow filename must be a filename, not a path.')
  }
  if (!/\.ya?ml$/i.test(filename)) {
    throw new Error('Workflow filename must use a .yml or .yaml extension.')
  }
  return filename
}

function resolveMainFile(root: string, packageJson: PackageJson): string {
  return path.resolve(root, typeof packageJson.main === 'string' ? packageJson.main : 'index.js')
}

function testTemplate(testFile: string, mainFile: string): string {
  let extensionImport = path.relative(path.dirname(testFile), mainFile).replaceAll(path.sep, '/')
  if (!extensionImport.startsWith('.')) extensionImport = `./${extensionImport}`
  return `import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { commands, workspace } from 'coc.nvim'
import extension from ${JSON.stringify(extensionImport)}

beforeEach(async () => {
  await workspace.nvim.command('enew!')
})

describe('extension', () => {
  it('loads the extension exports', () => {
    assert.ok(extension)
  })

  it('communicates with Vim or Neovim', async () => {
    assert.equal(await workspace.nvim.eval('1 + 1'), 2)
  })

  it('provides coc.nvim test APIs', () => {
    assert.equal(typeof commands.executeCommand, 'function')
    assert.equal(typeof workspace.nvim.command, 'function')
  })
})
`
}

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

function detectPackageManager(root: string, packageJson: PackageJson): PackageManager {
  const declared = packageJson.packageManager?.split('@')[0]
  if (declared === 'npm' || declared === 'pnpm' || declared === 'yarn' || declared === 'bun') return declared
  if (existsSync(path.join(root, 'bun.lock')) || existsSync(path.join(root, 'bun.lockb'))) return 'bun'
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(path.join(root, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

function workflowTemplate(manager: PackageManager, testFile: string, hasBuild: boolean, root: string): string {
  const managerSetup = manager === 'bun'
    ? '      - uses: oven-sh/setup-bun@v2\n'
    : manager === 'pnpm'
      ? '      - uses: pnpm/action-setup@v4\n'
      : manager === 'yarn'
        ? '      - run: corepack enable\n'
        : ''
  const install = installCommand(manager, root)
  const runBuild = manager === 'npm' ? 'npm run build' : `${manager} run build`
  const execute = manager === 'bun'
    ? `bunx --no-install coc-test --\${{ matrix.editor }} ${quoteShellArgument(testFile)}`
    : manager === 'pnpm'
      ? `pnpm exec coc-test --\${{ matrix.editor }} ${quoteShellArgument(testFile)}`
      : manager === 'yarn'
        ? `yarn coc-test --\${{ matrix.editor }} ${quoteShellArgument(testFile)}`
        : `npx --no-install coc-test --\${{ matrix.editor }} ${quoteShellArgument(testFile)}`
  const buildStep = hasBuild ? `      - name: Build extension\n        run: ${runBuild}\n` : ''
  const cache = manager === 'bun' ? '' : `\n          cache: ${manager}`
  return `name: test

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        editor: [nvim, vim]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22${cache}
${managerSetup}      - name: Install dependencies
        run: ${install}
      - name: Install Vim and Neovim
        run: |
          sudo apt-get update
          sudo apt-get install -y vim neovim
${buildStep}      - name: Run integration tests
        run: ${execute}
`
}

function installCommand(manager: PackageManager, root: string): string {
  if (manager === 'npm') return existsSync(path.join(root, 'package-lock.json')) ? 'npm ci' : 'npm install'
  if (manager === 'bun') {
    return existsSync(path.join(root, 'bun.lock')) || existsSync(path.join(root, 'bun.lockb'))
      ? 'bun install --frozen-lockfile'
      : 'bun install'
  }
  if (manager === 'pnpm') {
    return existsSync(path.join(root, 'pnpm-lock.yaml')) ? 'pnpm install --frozen-lockfile' : 'pnpm install'
  }
  return existsSync(path.join(root, 'yarn.lock')) ? 'yarn install --frozen-lockfile' : 'yarn install'
}

function quoteShellArgument(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function fileExists(filename: string): Promise<boolean> {
  try {
    await fs.access(filename)
    return true
  } catch {
    return false
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface Ansi {
  bold(value: string): string
  dim(value: string): string
  red(value: string): string
  green(value: string): string
  yellow(value: string): string
  cyan(value: string): string
}

function createAnsi(output: InitOutput, override?: boolean): Ansi {
  const forceColor = process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0'
  const enabled = override ?? (process.env.NO_COLOR === undefined && (output.isTTY === true || forceColor))
  const color = (code: number, value: string): string => enabled ? `\x1b[${code}m${value}\x1b[0m` : value
  return {
    bold: value => color(1, value),
    dim: value => color(2, value),
    red: value => color(31, value),
    green: value => color(32, value),
    yellow: value => color(33, value),
    cyan: value => color(36, value),
  }
}
