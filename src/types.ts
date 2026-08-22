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
  /** Setup module to run before the extension is loaded. Relative to the extension root. */
  setup?: string
  /** Dependencies to leave external when bundling `entryFile`; passed to esbuild's `external` option. */
  externals?: string[]
  /** Output module format for the `entryFile` bundle. Defaults to CommonJS. */
  target?: ExtensionTarget
}

export type ExtensionTarget = 'commonjs' | 'esm'

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
  /** Absolute path of the configured `coc-test.setup`, when set. */
  setupFile?: string
  /** Bundled extension code produced by the parent process, loaded through the coc.nvim `sourceCode` option. */
  extensionCode?: string
}

export interface ExtensionLoadOptions {
  sourceCode?: string
  sourceFormat?: 'commonjs' | 'module'
  sourceFilename?: string
  extensionRoot?: string
}

export interface CocModule {
  exports: unknown
  dispose?: () => void
  attach(options: { proc: ChildProcess } | { reader: NodeJS.ReadableStream; writer: NodeJS.WritableStream }): CocPlugin
  loadExtension(filename: string, active: boolean, options?: ExtensionLoadOptions): Promise<{ _exports: unknown }>
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
