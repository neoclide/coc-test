import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { fork, spawn } from 'node:child_process'
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
  await runCliCase(installation, project, editor)
  console.log(`Worker teardown (${editor}): ordinary CLI unload timeout passed`)
  for (const scenario of [
    'success', 'failure', 'test-abort', 'activation-abort', 'unload-error',
    'activation-abort-unload-error', 'activation-abort-pending',
    'unload-abort-pending', 'activation-abort-late', 'quit-abort-pending', 'unload-pending',
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
        if ((message.phase === 'unloading' && scenario === 'unload-abort-pending') ||
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
        if (scenario === 'unload-pending') assert.match(result.report, /Timed out waiting for extension unload/)
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

async function runCliCase(installation, project, editor) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-test-unload-'))
  const eventsFile = path.join(directory, 'events.jsonl')
  const events = () => fs.existsSync(eventsFile)
    ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
  const killFixtures = () => {
    for (const pid of new Set(events().flatMap(event => [event.childPid, event.editorPid]).filter(Boolean))) {
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
  }
  try {
    await new Promise((resolve, reject) => {
      const cli = spawn(process.execPath, [path.join(root, 'lib/cli.js'), '--coc-path', installation.root,
        `--${editor}`, 'worker.test.js'], {
        cwd: project.root,
        env: { ...process.env, COC_TEST_WORKER_CASE: 'unload-pending',
          COC_TEST_WORKER_COC_ENTRY: installation.entryFile, COC_TEST_WORKER_EVENTS: eventsFile },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      const timeout = setTimeout(() => {
        cli.kill('SIGKILL')
        killFixtures()
        reject(new Error(`ordinary CLI unload did not exit naturally\n${output}\n${JSON.stringify(events())}`))
      }, 15000)
      cli.stdout.on('data', chunk => { output += chunk })
      cli.stderr.on('data', chunk => { output += chunk })
      cli.once('error', error => { clearTimeout(timeout); reject(error) })
      cli.once('close', (code, signal) => {
        clearTimeout(timeout)
        try {
          assert.equal(signal, null, output)
          assert.equal(code, 1, output)
          assert.match(output, /coc-test teardown failed: Error: Timed out waiting for extension unload/)
          const phases = events()
          assert.deepEqual(phases.filter(event => event.phase === 'disposed').map(event => event.disposals), [1])
          assert.equal(phases.filter(event => event.phase === 'worker-exit').length, 1)
          assert.equal(phases.filter(event => event.phase === 'editor-closing').length, 1)
          assert.deepEqual(phases.filter(event => event.phase === 'child-exit').map(event => event.code), [0],
            'test child must exit naturally without parent signals')
          const editorPid = phases.find(event => event.editorPid)?.editorPid
          assert.ok(editorPid)
          assert.throws(() => process.kill(editorPid, 0), { code: 'ESRCH' }, 'editor must have exited')
          assert.doesNotMatch(output, /UnhandledPromiseRejection|UnhandledRejection/)
          resolve()
        } catch (error) {
          killFixtures()
          reject(error)
        }
      })
    })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
