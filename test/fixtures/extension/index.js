exports.childPid = process.pid

exports.activate = async function () {
  return { activated: true }
}
