import type { ChildProcess } from 'node:child_process'
import type { Server } from 'node:net'

export interface CliOptions {
  files: string[]
  cocVersion?: string
  cocPath?: string
  editor: 'nvim' | 'vim'
  testNamePattern?: string
  forceExit: boolean
  forceDownload: boolean
  watch: boolean
}

export interface CocTestConfig {
  'user-settings'?: Record<string, unknown>
  entryFile?: string
}

export interface ProjectInfo {
  root: string
  packageJsonPath: string
  packageJson: Record<string, unknown> & {
    main?: string
    name?: string
    'coc-test'?: CocTestConfig
  }
  mainFile: string
  config: CocTestConfig
  /** Absolute path of the configured `coc-test.entryFile`, when set. */
  entryFile?: string
  /** Bundled extension code produced by the parent process, shared by test children. */
  extensionCode?: string
  /** Directory passed to `coc.loadExtension`; points at the bundled entry when `entryFile` is set. */
  extensionRoot: string
}

export interface CocModule {
  exports: unknown
  dispose?: () => void
  attach(options: { proc: ChildProcess } | { reader: NodeJS.ReadableStream; writer: NodeJS.WritableStream }): CocPlugin
  loadExtension(filename: string, active: boolean): Promise<{ _exports: unknown }>
  [key: string]: unknown
}

export interface CocPlugin {
  nvim: {
    uiAttach(width: number, height: number, options: Record<string, unknown>): Promise<unknown>
    call(method: string, args?: unknown[], notify?: boolean): Promise<unknown> | void
    on(event: string, listener: (...args: any[]) => void): void
    quit?(): Promise<void>
  }
  init(arg: string): Promise<void>
  dispose(): void
}

export interface EditorSession {
  plugin: CocPlugin
  proc: ChildProcess
  server?: Server
  close(): Promise<void>
}

export interface CocInstallation {
  version: string
  root: string
  entryFile: string
  vimrc: string
}
