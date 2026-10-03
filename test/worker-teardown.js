import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleTests } from '../lib/bundle.js'
import { useCocDirectory } from '../lib/download.js'
import { findProject } from '../lib/project.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function testWorkerTeardown(cocPath, editor) {
  const installation = await useCocDirectory(cocPath)
  const project = findProject(path.join(root, 'test/fixtures/worker'))
  const [bundle] = await bundleTests([path.join(project.root, 'worker.test.js')], {
    projectRoot: project.root,
    projectMain: project.mainFile,
    cocEntry: installation.entryFile,
  })
  for (const scenario of [
    'success', 'failure', 'test-abort', 'activation-abort', 'unload-error',
    'activation-abort-unload-error', 'activation-abort-pending',
    'unload-abort-pending', 'activation-abort-late', 'quit-abort-pending',
  ]) {
    await runCase({ installation, project, bundle, editor }, scenario)
    console.log(`Worker teardown (${editor}): ${scenario} passed`)
  }
}

function runCase(data, scenario) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(root, 'lib/test-child.js'), [], {
      cwd: data.project.root,
      env: { ...process.env, COC_TEST_WORKER_CASE: scenario, COC_TEST_WORKER_COC_ENTRY: data.installation.entryFile },
      execArgv: ['--enable-source-maps', '--experimental-vm-modules'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const phases = []
    let result
    let output = ''
    let editorPid
    let cancellationTimeout
    const cancel = () => {
      child.send({ type: 'cancel' })
      // Match the parent's final cancellation deadline. Reaching it is a failure.
      cancellationTimeout ??= setTimeout(() => { child.kill('SIGKILL') }, 4000)
    }
    const timeout = setTimeout(() => {
      // Kill only processes started by this fixture; a timeout is always a failure.
      child.kill('SIGKILL')
      if (editorPid) { try { process.kill(editorPid, 'SIGKILL') } catch {} }
      reject(new Error(`${scenario} did not exit naturally\n${output}`))
    }, 15000)
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('message', message => {
      output += JSON.stringify(message) + '\n'
      if (message.type === 'fixture') {
        phases.push(message)
        editorPid ??= message.editorPid
        if (message.phase === 'activating') {
          cancel()
          if (!['activation-abort-pending', 'activation-abort-late'].includes(scenario)) {
            child.send({ type: 'release-activation' })
          }
        }
        if (message.phase === 'editor-closing' && scenario === 'activation-abort-late') {
          child.send({ type: 'release-activation' })
        }
        if (message.phase === 'unloading' ||
          (message.phase === 'editor-closing' && scenario === 'quit-abort-pending')) cancel()
        if (message.phase === 'test-started') {
          cancel()
          child.send({ type: 'release-activation' })
        }
      } else if (message.type === 'result') {
        result = message
      }
    })
    child.once('error', error => {
      clearTimeout(timeout)
      clearTimeout(cancellationTimeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      clearTimeout(cancellationTimeout)
      try {
        assert.equal(signal, null, output)
        assert.equal(code, 0, output)
        assert.ok(result, `missing result: ${output}`)
        assert.equal(result.passed, scenario === 'success', result.report)
        const createdWorker = scenario !== 'activation-abort-pending'
        assert.deepEqual(phases.filter(p => p.phase === 'disposed').map(p => p.disposals), createdWorker ? [1] : [], result.report)
        assert.equal(phases.filter(p => p.phase === 'worker-exit').length, createdWorker ? 1 : 0)
        assert.equal(phases.filter(p => p.phase === 'editor-closing').length, 1, 'editor closure must be reached')
        assert.ok(editorPid)
        assert.throws(() => process.kill(editorPid, 0), { code: 'ESRCH' }, 'editor must have exited')
        if (scenario === 'failure') assert.match(result.report, /fixture assertion failure/)
        if (scenario.endsWith('unload-error')) assert.match(result.report, /fixture unload rejection/)
        assert.doesNotMatch(output, /UnhandledPromiseRejection|UnhandledRejection/)
        resolve()
      } catch (error) {
        if (editorPid) { try { process.kill(editorPid, 'SIGKILL') } catch {} }
        reject(error)
      }
    })
    child.send({ type: 'run', data })
  })
}
