import path from 'node:path'
import fg from 'fast-glob'

export async function resolveTestFiles(patterns: string[], projectRoot: string): Promise<string[]> {
  const matches = await fg(patterns, {
    cwd: projectRoot,
    absolute: true,
    onlyFiles: true,
    unique: true,
    followSymbolicLinks: false,
  })
  const files = matches
    .map(file => path.resolve(file))
    .filter(file => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file))
    .sort()
  if (files.length === 0) throw new Error(`No JavaScript or TypeScript test files matched: ${patterns.join(', ')}`)
  return files
}
