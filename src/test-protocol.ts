import type { TestBundle } from './bundle.js'
import type { CliOptions, CocInstallation, ProjectInfo } from './types.js'

export interface TestChildData {
  bundle: TestBundle
  testNamePattern?: string
  editor: CliOptions['editor']
  installation: CocInstallation
  project: ProjectInfo
}

export type TestChildCommand =
  | { type: 'run'; data: TestChildData }
  | { type: 'cancel' }

export interface TestStats {
  tests: number
  passed: number
  failed: number
  skipped: number
  todo: number
  cancelled: number
  durationMs: number
}

export interface TestProgress {
  type: 'progress'
  sourceFile: string
  state: 'starting' | 'running'
  activeTest?: string
  stats: TestStats
}

export interface TestResult {
  type: 'result'
  sourceFile: string
  passed: boolean
  report: string
  stdout?: string
  stderr?: string
  stats: TestStats
}

export type TestChildMessage = TestProgress | TestResult
