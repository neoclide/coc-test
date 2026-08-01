import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { extractZip } from './unzip.js'
import type { CocInstallation } from './types.js'

function createGitHubHeaders(): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'coc-test',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

async function isFile(filepath: string): Promise<boolean> {
  try {
    return (await fsPromises.stat(filepath)).isFile()
  } catch {
    return false
  }
}

async function findSingleDirectory(directory: string): Promise<string> {
  const entries = await fsPromises.readdir(directory, {
    withFileTypes: true,
  })

  const directories = entries.filter(entry => entry.isDirectory())

  if (directories.length !== 1) {
    throw new Error(
      `Expected one root directory in archive, found ${directories.length}`,
    )
  }

  return path.join(directory, directories[0].name)
}

export async function downloadFile(
  url: string,
  destination: string,
): Promise<void> {
  const outputPath = path.resolve(destination)
  const temporaryPath = `${outputPath}.${process.pid}.tmp`

  await fsPromises.mkdir(path.dirname(outputPath), {
    recursive: true,
  })

  const response = await fetch(url, {
    method: 'GET',
    headers: createGitHubHeaders(),
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
  })

  if (!response.ok) {
    const remaining = response.headers.get('x-ratelimit-remaining')
    const reset = response.headers.get('x-ratelimit-reset')

    let message =
      `Failed to download coc.nvim: ` +
      `${response.status} ${response.statusText}`

    if (remaining !== null) {
      message += `; rate limit remaining: ${remaining}`
    }

    if (reset !== null) {
      const resetTime = new Date(Number(reset) * 1000)

      if (!Number.isNaN(resetTime.getTime())) {
        message += `; resets at: ${resetTime.toISOString()}`
      }
    }

    throw new Error(message)
  }

  if (!response.body) {
    throw new Error('GitHub returned an empty response body')
  }

  const totalBytes = parseContentLength(response.headers.get('content-length'))
  const progress = new DownloadProgress({
    label: 'Downloading coc.nvim',
    totalBytes,
  })
  let receivedBytes = 0
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += chunk.length
      progress.update(receivedBytes)
      callback(null, chunk)
    },
  })

  try {
    await pipeline(
      response.body,
      counter,
      fs.createWriteStream(temporaryPath, {
        flags: 'wx',
      }),
    )
    progress.finish()

    await fsPromises.rm(outputPath, {
      force: true,
    })

    await fsPromises.rename(temporaryPath, outputPath)
  } catch (error) {
    progress.fail()
    await fsPromises.rm(temporaryPath, {
      force: true,
    })
    throw error
  }
}

export interface DownloadProgressOptions {
  label: string
  totalBytes: number | undefined
  output?: { write(value: string): unknown; isTTY?: boolean }
}

const BAR_WIDTH = 20
const MIN_RENDER_INTERVAL_MS = 100

/** Real-time single-line download progress rendered at a fixed position. */
export class DownloadProgress {
  private readonly label: string
  private readonly totalBytes: number | undefined
  private readonly output: { write(value: string): unknown; isTTY?: boolean }
  private readonly interactive: boolean
  private readonly startedAt = Date.now()
  private receivedBytes = 0
  private lastRenderAt = 0

  constructor(options: DownloadProgressOptions) {
    this.label = options.label
    this.totalBytes = options.totalBytes
    this.output = options.output ?? process.stdout
    this.interactive = Boolean(this.output.isTTY === true && !process.env.CI)
  }

  update(receivedBytes: number): void {
    this.receivedBytes = receivedBytes
    this.render(false)
  }

  /** Render the final state and move to a new line. */
  finish(): void {
    if (!this.interactive) return
    this.render(true)
    this.output.write('\n')
  }

  /** Clear the progress line so later output starts on a clean line. */
  fail(): void {
    if (!this.interactive) return
    this.output.write('\r\x1b[K')
  }

  private render(force: boolean): void {
    if (!this.interactive) return
    const now = Date.now()
    if (!force && now - this.lastRenderAt < MIN_RENDER_INTERVAL_MS) return
    this.lastRenderAt = now

    const elapsedSeconds = (now - this.startedAt) / 1000
    const speed = elapsedSeconds > 0 ? this.receivedBytes / elapsedSeconds : 0
    const totalBytes = this.totalBytes
    const hasTotal = totalBytes !== undefined && totalBytes > 0
    const ratio = hasTotal ? Math.min(1, this.receivedBytes / totalBytes) : undefined
    const remainingBytes = hasTotal ? Math.max(0, totalBytes - this.receivedBytes) : undefined
    const etaSeconds = ratio !== undefined && speed > 0 && remainingBytes !== undefined
      ? remainingBytes / speed
      : undefined

    const parts = [
      ratio !== undefined ? renderProgressBar(ratio) : '',
      ratio !== undefined ? `${Math.round(ratio * 100)}%` : '',
      `${formatBytes(this.receivedBytes)}${hasTotal ? ` / ${formatBytes(totalBytes)}` : ''}`,
      speed > 0 ? `${formatBytes(speed)}/s` : '',
      etaSeconds !== undefined ? `eta ${formatDuration(etaSeconds)}` : '',
    ].filter(Boolean)

    this.output.write(`\r\x1b[K${this.label} ${parts.join('  ')}`)
  }
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) return undefined
  const total = Number(value)
  return Number.isFinite(total) && total > 0 ? total : undefined
}

function renderProgressBar(ratio: number): string {
  const filled = Math.round(BAR_WIDTH * Math.max(0, Math.min(1, ratio)))
  return `[${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}]`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && value >= 1024; index++) {
    value /= 1024
    unit = units[index]
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${unit}`
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.max(0, Math.round(seconds % 60))}s`
}

export async function isValidRoot(dir: string): Promise<boolean> {
  const files = ['build/index.js', 'plugin/coc.vim', 'src/__tests__/vimrc']
  for (const file of files) {
    const entry = path.join(dir, file)
    if (!await isFile(entry)) {
      return false
    }
  }
  return true
}

const vimrcContent = `set nocompatible
set hidden
set noswapfile
set nobackup
set tabstop=2
set cmdheight=2
set shiftwidth=2
set updatetime=300
set expandtab
set noshowmode
set shortmess=aFtW
set noruler

let s:dir = expand('<sfile>:h')
let s:root = expand('<sfile>:h:h:h')
let g:coc_node_env = 'test'

execute 'set runtimepath+='.s:root`

function toInstallationInfo(version: string, root: string): CocInstallation {
  const vimrc = path.join(root, 'src', '__tests__', 'vimrc')
  if (!fs.existsSync(vimrc)) {
    fs.mkdirSync(path.dirname(vimrc), { recursive: true })
    fs.writeFileSync(vimrc, vimrcContent, 'utf8')
  }
  return {
    version,
    root,
    entryFile: path.join(root, 'build', 'index.js'),
    vimrc
  }
}

/** Resolve an already-built coc.nvim checkout without performing network access. */
export async function useCocDirectory(directory: string): Promise<CocInstallation> {
  const root = path.resolve(directory)
  const requiredFiles = ['build/index.js', 'plugin/coc.vim']
  for (const file of requiredFiles) {
    const filename = path.join(root, file)
    if (!await isFile(filename)) {
      throw new Error(`Invalid coc.nvim directory, missing: ${filename}`)
    }
  }
  return toInstallationInfo('local', root)
}

export async function downloadRelease(requestedVersion?: string, forceDownload = false): Promise<CocInstallation> {
  let versionOrHash: string
  let downloadUrl: string
  if (requestedVersion) {
    versionOrHash = normalizeTag(requestedVersion)
    downloadUrl = zipballUrl(versionOrHash)
  } else {
    const info = await getCocReleaseInfo()
    versionOrHash = info.hash
    downloadUrl = info.zipUrl
  }
  const targetDirectory = path.join(os.tmpdir(), `coc-nvim-${versionOrHash}`)

  const targetDir = path.resolve(targetDirectory)
  const zipFile = `${targetDir}.zip`

  if (!forceDownload && await isValidRoot(targetDir)) {
    return toInstallationInfo(versionOrHash, targetDir)
  }

  const extractDir = `${targetDir}.${process.pid}.extract`

  await fsPromises.rm(extractDir, {
    recursive: true,
    force: true,
  })

  await downloadFile(downloadUrl, zipFile)

  try {
    await extractZip(zipFile, extractDir)
    const archiveRoot = await findSingleDirectory(extractDir)
    const entryFile = path.join(archiveRoot, 'build', 'index.js')

    if (!(await isFile(entryFile))) {
      throw new Error(
        `Downloaded coc.nvim archive does not contain: ${entryFile}`,
      )
    }

    await fsPromises.rm(targetDir, {
      recursive: true,
      force: true,
    })

    /*
     * 把 GitHub 生成的不固定顶层目录移动成稳定的 targetDir。
     */
    await fsPromises.rename(archiveRoot, targetDir)

    return toInstallationInfo(versionOrHash, targetDir)
  } catch (error) {
    await fsPromises.rm(targetDir, {
      recursive: true,
      force: true,
    })

    throw error
  } finally {
    await Promise.allSettled([
      fsPromises.rm(zipFile, {
        force: true,
      }),
      fsPromises.rm(extractDir, {
        recursive: true,
        force: true,
      }),
    ])
  }
}

function zipballUrl(tag: string): string {
  return `https://api.github.com/repos/neoclide/coc.nvim/zipball/${encodeURIComponent(tag)}`
}

function normalizeTag(version: string): string {
  return version.startsWith('v') ? version : `v${version}`
}

interface GitHubRefResponse {
  ref: string
  object: {
    type: 'commit' | 'tag'
    sha: string
    url: string
  }
}

export interface CocReleaseInfo {
  /** 前 12 位 commit hash，用于目录名和日志。 */
  hash: string

  /** 完整 40 位 commit hash。 */
  fullHash: string

  /** 固定到该 commit 的 ZIP 下载地址。 */
  zipUrl: string
}

export async function getCocReleaseInfo(): Promise<CocReleaseInfo> {
  const apiUrl = 'https://api.github.com/repos/neoclide/coc.nvim/git/ref/heads/release'
  const headers: Record<string, string> = createGitHubHeaders()

  const response = await fetch(apiUrl, {
    headers,
    signal: AbortSignal.timeout(15_000),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')

    throw new Error(
      `Failed to get coc.nvim release ref: ` +
      `${response.status} ${response.statusText}` +
      (body ? `\n${body.slice(0, 500)}` : ''),
    )
  }

  const result = await response.json() as GitHubRefResponse
  const fullHash = result.object.sha

  if (
    result.object.type !== 'commit' ||
    !/^[0-9a-f]{40}$/i.test(fullHash)
  ) {
    throw new Error(
      `Invalid GitHub ref response: ${JSON.stringify(result)}`,
    )
  }

  return {
    hash: fullHash.slice(0, 12),
    fullHash,
    zipUrl: `https://api.github.com/repos/neoclide/coc.nvim/zipball/${fullHash}`,
  }
}
