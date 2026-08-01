import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { CliOptions, CocInstallation, CocModule } from './types.js'

const require = createRequire(import.meta.url)

export function loadCocModule(installResult: CocInstallation, editor: CliOptions['editor']): CocModule {
  if (editor === 'vim') {
    process.env.VIM_NODE_RPC = '1'
  }
  process.env.COC_TESTER = '1'
  process.env.COC_NVIM = '1'
  process.env.VIMRUNTIME = ''
  process.env.COC_VIMCONFIG = path.dirname(installResult.vimrc)
  const dataHome = cocDataHome()
  process.env.COC_DATA_HOME = dataHome
  process.env.XDG_RUNTIME_DIR = dataHome
  fs.rmSync(dataHome, { recursive: true, force: true })
  fs.mkdirSync(dataHome, { recursive: true })
  try {
    const loaded = require(installResult.entryFile) as Partial<CocModule>
    if (typeof loaded.attach !== 'function') throw new Error('Missing attach export.')
    if (typeof loaded.loadExtension !== 'function') throw new Error('Missing loadExtension export.')
    return Object.assign({}, loaded) as CocModule
  } catch (error) {
    throw new Error(`Failed to require coc.nvim entry ${installResult.entryFile}: ${errorMessage(error)}`, { cause: error })
  }
}

export function removeCocDataHome(): void {
  let dir = path.join(os.tmpdir(), `coc-test-${process.pid}`)
  fs.rmSync(dir, { recursive: true, force: true })
}

function cocDataHome(): string {
  return path.join(os.tmpdir(), `test-data-${process.pid}`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
