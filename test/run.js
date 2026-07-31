import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const projectRoot = path.join(repositoryRoot, 'test', 'fixtures', 'extension')
const cli = path.join(repositoryRoot, 'lib', 'cli.js')
const options = parseOptions(process.argv.slice(2))

if (!options.cocPath) {
  console.error('Specify coc.nvim with --coc-path <directory> or COC_TEST_COC_PATH.')
  process.exitCode = 2
} else {
  process.exitCode = await runCli(options.cocPath, options.editor)
}

function parseOptions(argv) {
  let cocPath = process.env.COC_TEST_COC_PATH
  let editor = 'nvim'
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--vim') editor = 'vim'
    else if (arg === '--nvim') editor = 'nvim'
    else if (arg === '--coc-path') {
      cocPath = argv[++index]
      if (!cocPath) throw new Error('Missing value for --coc-path')
    } else {
      throw new Error(`Unknown test option: ${arg}`)
    }
  }
  return { cocPath, editor }
}

function runCli(cocPath, editor) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      cli,
      '--coc-path', cocPath,
      `--${editor}`,
      'test/*.test.js',
    ], {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Integration test terminated by ${signal}`))
      else resolve(code ?? 1)
    })
  })
}
