import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { extractZip } from './unzip.js'
import type { CocInstallation } from './types.js'

function getAuthorizationHeader(): string | undefined {
  let token: string | undefined
  if (process.env.GITHUB_API_TOKEN) {
    token = process.env.GITHUB_API_TOKEN
  } else if (process.env.GH_TOKEN) {
    token = process.env.GH_TOKEN
  } else if (process.env.GITHUB_TOKEN) {
    token = process.env.GITHUB_TOKEN
  }
  return typeof token === 'string' ? `Bearer ${token}` : undefined
}

// const authorizationHeader = getAuthorizationHeader()

function createGitHubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'coc-test',
    'X-GitHub-Api-Version': '2022-11-28',
  }

  return headers
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

  try {
    await pipeline(
      response.body,
      fs.createWriteStream(temporaryPath, {
        flags: 'wx',
      }),
    )

    await fsPromises.rm(outputPath, {
      force: true,
    })

    await fsPromises.rename(temporaryPath, outputPath)
  } catch (error) {
    await fsPromises.rm(temporaryPath, {
      force: true,
    })
    throw error
  }
}

export async function isValidRoot(dir: string): Promise<boolean> {
  const files = ['build/index.js', 'plugin/coc.vim', 'src/__tests__/vimrc']
  for (let file of files) {
    let entry = path.join(dir, file)
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
  let targetDirectory = path.join(os.tmpdir(), `coc-nvim-${versionOrHash}`)

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
