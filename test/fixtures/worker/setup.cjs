const coc = require(process.env.COC_TEST_WORKER_COC_ENTRY)
let activated = false
// The extension runs in a VM with a restricted process facade. Keep IPC in the
// host setup module, while the Worker and its subscription belong to the extension.
coc.exports.workspace.workerFixture = {
  send: message => {
    if (message.phase === 'activated') activated = true
    process.send({ type: 'fixture', ...message })
  },
  waitForRelease: () => new Promise(resolve => {
    const release = message => {
      if (message.type !== 'release-activation') return
      process.off('message', release)
      resolve()
    }
    process.on('message', release)
  }),
}
if (process.env.COC_TEST_WORKER_CASE.endsWith('unload-error')) {
  // Fault injection after real unload, to exercise cleanup error reporting.
  const manager = coc.exports.extensions.manager
  const unload = manager.unloadExtension.bind(manager)
  manager.unloadExtension = async (...args) => {
    await unload(...args)
    if (activated) throw new Error('fixture unload rejection')
  }
}

const nvim = coc.exports.workspace.nvim
const quit = nvim.quit.bind(nvim)
nvim.quit = () => {
  process.send({ type: 'fixture', phase: 'editor-closing' })
  if (process.env.COC_TEST_WORKER_CASE === 'quit-abort-pending') return new Promise(() => {})
  return quit()
}
