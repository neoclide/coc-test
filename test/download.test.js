import assert from 'node:assert/strict'
import test from 'node:test'
import { DownloadProgress } from '../lib/download.js'

test.before(() => {
  process.env.CI = ''
})

test.after(() => {
  delete process.env.CI
})

function createCapture() {
  let value = ''
  return {
    output: { isTTY: true, write: chunk => { value += chunk; return true } },
    get value() {
      return value
    },
  }
}

test('renders percent, bar, and byte counts on a single fixed line', () => {
  const capture = createCapture()
  const progress = new DownloadProgress({
    label: 'Downloading coc.nvim',
    totalBytes: 1024,
    output: capture.output,
  })

  progress.update(512)
  progress.finish()

  assert.match(capture.value, /\r\x1b\[KDownloading coc\.nvim/)
  assert.match(capture.value, /50%/)
  assert.match(capture.value, /\[.{1,20}\]/)
  assert.match(capture.value, /512 B \/ 1\.0 KB/)
  assert.ok(capture.value.endsWith('\n'))
})

test('throttles repeated updates within the render window', () => {
  const capture = createCapture()
  const progress = new DownloadProgress({ label: 'Downloading', totalBytes: 1024, output: capture.output })

  progress.update(100)
  progress.update(200)
  progress.finish()

  const renders = capture.value.split('\r\x1b[K').length - 1
  assert.equal(renders, 2)
})

test('shows bytes without a percent when content length is unknown', () => {
  const capture = createCapture()
  const progress = new DownloadProgress({ label: 'Downloading', totalBytes: undefined, output: capture.output })

  progress.update(2048)
  progress.finish()

  assert.match(capture.value, /2\.0 KB/)
  assert.ok(!capture.value.includes('%'))
})

test('does nothing when the output is not a TTY', () => {
  const capture = createCapture()
  const progress = new DownloadProgress({
    label: 'Downloading',
    totalBytes: 100,
    output: { isTTY: false, write: capture.output.write },
  })

  progress.update(50)
  progress.finish()
  progress.fail()

  assert.equal(capture.value, '')
})

test('clears the progress line on failure', () => {
  const capture = createCapture()
  const progress = new DownloadProgress({ label: 'Downloading', totalBytes: 100, output: capture.output })

  progress.update(50)
  progress.fail()

  assert.ok(capture.value.endsWith('\r\x1b[K'))
  assert.ok(!capture.value.includes('\n'))
})
