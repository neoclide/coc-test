const { Worker } = require('node:worker_threads')
const { workspace } = require('coc.nvim')

exports.activate = async context => {
  const editorPid = await workspace.nvim.call('getpid')
  if (process.env.COC_TEST_WORKER_CASE.startsWith('activation-abort')) {
    const released = workspace.workerFixture.waitForRelease()
    workspace.workerFixture.send({ phase: 'activating', editorPid })
    await released
  }
  const worker = new Worker('setInterval(() => {}, 1000)', { eval: true })
  let disposals = 0
  context.subscriptions.push({ dispose() {
    workspace.workerFixture.send({ phase: 'disposed', disposals: ++disposals })
    void worker.terminate()
  } })
  worker.once('exit', () => workspace.workerFixture.send({ phase: 'worker-exit' }))
  workspace.workerFixture.send({ phase: 'activated', editorPid })
}
