import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'force-exit-helper.js')

test('force exit terminates a process with a lingering handle', async () => {
  const startedAt = Date.now()
  const { code, stdout } = await runHelper(helper, [], 5_000)
  assert.equal(code, 0)
  assert.match(stdout, /force-exit-helper/)
  assert.ok(Date.now() - startedAt < 4_000)
})

test('force exit drains pending stdout before terminating', async () => {
  const { code, stdout } = await runHelper(helper, ['large-output'], 5_000)
  assert.equal(code, 0)
  assert.equal(stdout.length, 200_000)
})

test('a lingering handle keeps the process alive without force exit', async () => {
  const child = spawn(process.execPath, [helper, 'no-force'], { stdio: 'ignore' })
  try {
    await delay(600)
    assert.equal(child.exitCode, null, 'process should stay alive without force exit')
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
  }
})

function runHelper(helperPath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helperPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`helper did not exit within ${timeoutMs}ms`))
    }, timeoutMs)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
