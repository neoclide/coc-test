import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { downloadFile, DownloadProgress, getCocReleaseInfo } from '../lib/download.js'

for (const { name, ghToken, githubToken, token } of [
  { name: 'omit authorization when tokens are unset' },
  { name: 'omit authorization when tokens are empty', ghToken: '', githubToken: '' },
  { name: 'use GITHUB_TOKEN', githubToken: 'test-github-token', token: 'test-github-token' },
  { name: 'use GH_TOKEN', ghToken: 'test-gh-token', token: 'test-gh-token' },
  { name: 'prefer GH_TOKEN', ghToken: 'test-gh-token', githubToken: 'test-github-token', token: 'test-gh-token' },
  { name: 'fall back from empty GH_TOKEN', ghToken: '', githubToken: 'test-github-token', token: 'test-github-token' },
]) {
  test(`GitHub requests ${name}`, async t => {
    for (const [key, value] of [['GH_TOKEN', ghToken], ['GITHUB_TOKEN', githubToken]]) {
      const originalValue = process.env[key]
      t.after(() => {
        if (originalValue === undefined) delete process.env[key]
        else process.env[key] = originalValue
      })
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }

    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coc-test-download-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const sha = 'a'.repeat(40)
    const fetchMock = t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.deepEqual(options.headers, {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'coc-test',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      })
      return url.endsWith('/git/ref/heads/release')
        ? Response.json({ object: { type: 'commit', sha } })
        : new Response('archive')
    })

    const release = await getCocReleaseInfo()
    const destination = path.join(root, 'coc.zip')
    await downloadFile(release.zipUrl, destination)
    assert.equal(fetchMock.mock.callCount(), 2)
    assert.equal(await fs.readFile(destination, 'utf8'), 'archive')
  })
}

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
