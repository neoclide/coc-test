import fs from 'node:fs'
import path from 'node:path'
import type { CocTestConfig, ProjectInfo } from './types.js'

export function findProject(startDirectory = process.cwd()): ProjectInfo {
  let directory = path.resolve(startDirectory)

  while (true) {
    const packageJsonPath = path.join(directory, 'package.json')
    if (fs.existsSync(packageJsonPath) && fs.statSync(packageJsonPath).isFile()) {
      const packageJson = readJson(packageJsonPath)
      const main = typeof packageJson.main === 'string' ? packageJson.main : 'index.js'
      const mainFile = path.resolve(directory, main)
      if (!fs.existsSync(mainFile) || !fs.statSync(mainFile).isFile()) {
        throw new Error(`Extension main file does not exist: ${mainFile}`)
      }
      const config = isRecord(packageJson['coc-test']) ? packageJson['coc-test'] as CocTestConfig : {}
      return { root: directory, packageJsonPath, packageJson, mainFile, config }
    }

    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }

  throw new Error(`Could not find package.json from ${startDirectory} or its parents.`)
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
