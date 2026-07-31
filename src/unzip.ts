import { unzip } from 'fflate'
import fs from 'node:fs/promises'
import path from 'node:path'

function unzipAsync(
  data: Uint8Array,
): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(data, (error, entries) => {
      if (error) {
        reject(error)
        return
      }

      resolve(entries)
    })
  })
}

export async function extractZip(
  zipFile: string,
  extractDir: string,
  concurrency = 16,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError(
      `concurrency must be a positive integer, got ${concurrency}`,
    )
  }

  const root = path.resolve(extractDir)
  const archive = await fs.readFile(zipFile)

  await fs.mkdir(root, {
    recursive: true,
  })

  const entries = Object.entries(await unzipAsync(archive))
  let index = 0

  async function worker(): Promise<void> {
    while (true) {
      const current = index++

      if (current >= entries.length) {
        return
      }

      const [entryName, content] = entries[current]
      const outputPath = resolveZipEntry(root, entryName)

      if (entryName.endsWith('/')) {
        await fs.mkdir(outputPath, {
          recursive: true,
        })
        continue
      }

      await fs.mkdir(path.dirname(outputPath), {
        recursive: true,
      })

      await fs.writeFile(outputPath, content)
    }
  }

  const workerCount = Math.min(
    concurrency,
    entries.length,
  )

  await Promise.all(
    Array.from(
      { length: workerCount },
      () => worker(),
    ),
  )
}

function resolveZipEntry(
  root: string,
  entryName: string,
): string {
  if (
    entryName.startsWith('/') ||
    entryName.startsWith('\\') ||
    /^[a-zA-Z]:[\\/]/.test(entryName)
  ) {
    throw new Error(`Unsafe absolute ZIP entry: ${entryName}`)
  }

  const outputPath = path.resolve(
    root,
    ...entryName.split('/'),
  )

  const relative = path.relative(root, outputPath)

  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Unsafe ZIP entry path: ${entryName}`)
  }

  return outputPath
}
