import fs from 'node:fs'
import path from 'node:path'
import type { CocTestConfig, ExtensionTarget, ProjectInfo } from './types.js'

export function findProject(startDirectory = process.cwd()): ProjectInfo {
  let directory = path.resolve(startDirectory)

  while (true) {
    const packageJsonPath = path.join(directory, 'package.json')
    if (fs.existsSync(packageJsonPath) && fs.statSync(packageJsonPath).isFile()) {
      const packageJson = readJson(packageJsonPath)
      const config = resolveConfig(packageJson['coc-test'])
      const entryFile = resolveEntryFile(directory, config.entryFile)
      const main = typeof packageJson.main === 'string' ? packageJson.main : 'index.js'
      const mainFile = path.resolve(directory, main)
      if (entryFile) {
        if (!fs.existsSync(entryFile) || !fs.statSync(entryFile).isFile()) {
          throw new Error(`coc-test entryFile does not exist: ${entryFile}`)
        }
      } else if (!fs.existsSync(mainFile) || !fs.statSync(mainFile).isFile()) {
        throw new Error(`Extension main file does not exist: ${mainFile}`)
      }
      return {
        root: directory,
        packageJsonPath,
        packageJson,
        mainFile,
        config,
        entryFile,
      }
    }

    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }

  throw new Error(`Could not find package.json from ${startDirectory} or its parents.`)
}

function resolveConfig(value: unknown): CocTestConfig {
  if (!isRecord(value)) return {}
  const config = value as CocTestConfig
  const target = resolveTarget(config.target)
  const externals = resolveExternals(config.externals)
  return { ...config, target, externals }
}

function resolveTarget(value: unknown): ExtensionTarget | undefined {
  if (value === undefined) return undefined
  if (value === 'commonjs' || value === 'esm') return value
  throw new Error('coc-test target must be "commonjs" or "esm".')
}

function resolveExternals(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item)) {
    throw new Error('coc-test externals must be an array of non-empty strings.')
  }
  return value
}

function resolveEntryFile(root: string, value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value) {
    throw new Error('coc-test entryFile must be a non-empty string.')
  }
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value)
  if (!isInside(resolved, root)) {
    throw new Error(`coc-test entryFile must be inside the extension root: ${resolved}`)
  }
  return resolved
}

function readJson(filename: string): ProjectInfo['packageJson'] {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8')) as ProjectInfo['packageJson']
  } catch (error) {
    throw new Error(`Failed to read ${filename}: ${errorMessage(error)}`, { cause: error })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInside(file: string, root: string): boolean {
  const normalizedRoot = path.resolve(root)
  const normalizedFile = path.resolve(file)
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}${path.sep}`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
