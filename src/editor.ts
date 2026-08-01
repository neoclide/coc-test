import * as cp from 'node:child_process'
import crypto from 'node:crypto'
import net, { type Server } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { CocModule, EditorSession, ProjectInfo } from './types.js'

export async function startEditor(
  editor: 'nvim' | 'vim',
  coc: CocModule,
  vimrc: string,
  project: ProjectInfo,
): Promise<EditorSession> {
  return editor === 'vim'
    ? startVim(coc, vimrc, project)
    : startNvim(coc, vimrc, project)
}

async function startNvim(coc: CocModule, vimrc: string, project: ProjectInfo): Promise<EditorSession> {
  const command = process.env.NVIM_COMMAND ?? 'nvim'
  const proc = spawn(command, ['-u', vimrc, '-i', 'NONE', '--embed'], project.root)
  proc.unref()

  try {
    const plugin = coc.attach({ proc })
    plugin.nvim.on('vim_error', error => console.error('Error from nvim:', error))
    await plugin.nvim.uiAttach(160, 80, {})
    plugin.nvim.call('coc#rpc#set_channel', [1], true)
    await plugin.init('')
    return createSession(plugin, proc)
  } catch (error) {
    await terminate(proc)
    throw new Error(`Failed to initialize Neovim using ${command}: ${errorMessage(error)}`, { cause: error })
  }
}

async function startVim(coc: CocModule, vimrc: string, project: ProjectInfo): Promise<EditorSession> {
  const command = process.env.VIM_COMMAND ?? 'vim'
  let server: Server | undefined
  let proc: cp.ChildProcess | undefined

  try {
    server = net.createServer()
    const address = await listen(server)
    const connected = new Promise<ReturnType<CocModule['attach']>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for Vim RPC connection.')), 15_000)
      server!.once('connection', socket => {
        clearTimeout(timer)
        const plugin = coc.attach({ reader: socket, writer: socket })
        plugin.nvim.on('vim_error', error => console.error('Error from vim:', error))
        resolve(plugin)
      })
    })

    proc = spawn(command, ['--clean', '--not-a-term', '-u', vimrc], project.root, {
      ...process.env,
      VIM_NODE_RPC: '1',
      COC_NVIM_REMOTE_ADDRESS: address,
    })
    proc.unref()
    const plugin = await connected
    await plugin.init('')
    return createSession(plugin, proc, server)
  } catch (error) {
    if (server) server.close()
    if (proc) await terminate(proc)
    throw new Error(`Failed to initialize Vim using ${command}: ${errorMessage(error)}`, { cause: error })
  }
}

function spawn(command: string, args: string[], cwd: string, env = process.env): cp.ChildProcess {
  const proc = cp.spawn(command, args, { cwd, env })
  proc.once('error', error => console.error(`Editor process error: ${error.message}`))
  return proc
}

async function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    if (process.platform === 'win32') {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') return reject(new Error('Unable to determine Vim TCP address.'))
        server.unref()
        resolve(`127.0.0.1:${address.port}`)
      })
    } else {
      const socket = path.join(os.tmpdir(), `coc-test-${crypto.randomUUID()}.sock`)
      server.listen(socket, () => {
        server.unref()
        resolve(socket)
      })
    }
  })
}

function createSession(plugin: ReturnType<CocModule['attach']>, proc: cp.ChildProcess, server?: Server): EditorSession {
  let closePromise: Promise<void> | undefined
  return {
    plugin,
    proc,
    server,
    async close() {
      closePromise ??= closeSession(plugin, proc, server)
      await closePromise
    },
  }
}

async function closeSession(
  plugin: ReturnType<CocModule['attach']>,
  proc: cp.ChildProcess,
  server?: Server,
): Promise<void> {
  plugin.dispose()
  try {
    const quitPromise = plugin.nvim.quit?.()
    if (quitPromise) await withTimeout(quitPromise, 2_000, 'Timed out waiting for editor quit.')
  } catch {
    // The editor or its RPC channel may already be closed.
  }
  await terminate(proc)
  if (server) await closeServer(server)
}

function withTimeout<T>(promise: Promise<T>, timeout: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeout)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>(resolve => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, 2_000)
    try {
      server.close(done)
    } catch {
      done()
    }
  })
}

/*
 * Wait for the editor child to really exit before the test process reports completion.
 * Otherwise terminating the test process would also remove the SIGKILL fallback timer.
 */
async function terminate(proc: cp.ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const exited = waitForExit(proc, 2_000)
  proc.kill('SIGTERM')
  if (await exited) return

  if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
  await waitForExit(proc, 2_000)
}

function waitForExit(proc: cp.ChildProcess, timeout: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolve => {
    const timer = setTimeout(() => done(false), timeout)
    const done = (exited: boolean): void => {
      clearTimeout(timer)
      proc.off('exit', onExit)
      resolve(exited)
    }
    const onExit = (): void => done(true)
    proc.once('exit', onExit)
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
