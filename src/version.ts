import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function packageVersion(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url))
  while (true) {
    const filename = path.join(directory, 'package.json')
    if (fs.existsSync(filename)) {
      const value = JSON.parse(fs.readFileSync(filename, 'utf8')) as { version?: unknown }
      if (typeof value.version === 'string') return value.version
    }
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error('Unable to locate coc-test package.json.')
}
